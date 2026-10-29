import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  utimes,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalProcessingPersistence } from '../src/processing/local-processing.persistence.js';
import { ProcessingRepository } from '../src/processing/processing.repository.js';
import { BetaMaintenanceService } from '../src/business/beta-maintenance.service.js';
import { LocalArtifactStorage } from '../src/business/artifact-storage.js';
import { AppConfig } from '../src/config/app-config.module.js';
import { validateEnvironment } from '../src/config/environment.js';

const owner = 'a'.repeat(64);
const source = () => ({
  ownerId: owner,
  sourceKey: `sources/${randomUUID()}.epub`,
  sourceHash: 'b'.repeat(64),
  byteSize: 100,
  originalName: 'self-created.epub',
});

describe('public beta bounded local storage', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'epub-public-beta-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('expires metadata atomically and fences a claimed lease before artifact publication, preserving a newer owner', async () => {
    const initial = Date.now();
    let time = initial;
    const persistence = new LocalProcessingPersistence(root, {
      maxRuns: 20,
      ownerActiveLimit: 1,
      retentionMs: 1000,
    });
    const repository = new ProcessingRepository(persistence, () => time);
    const book = await repository.createBook(source());
    const created = await repository.createRun({
      ownerId: owner,
      bookId: book.id,
      operation: 'beautify',
      idempotencyKey: randomUUID(),
      requestHash: 'c'.repeat(64),
      configuration: { theme: 'reader-editorial', ai: false },
      stages: ['process'],
    });
    const payload = (await repository.listDispatchable())[0]!;
    const claimed = await repository.claim(payload, 'test-worker', 30000);
    expect(claimed).not.toBeNull();
    time = initial + 900;
    const fresh = await repository.createBook({
      ...source(),
      ownerId: 'd'.repeat(64),
    });
    const removed = await persistence.pruneExpired(initial + 1001);
    expect(removed.runIds).toEqual([created.run.id]);
    expect(removed.sourceKeys).toEqual([book.sourceKey]);
    expect(await repository.heartbeat(claimed!.lease, 30000)).toBe(false);
    expect(
      await repository.completeStep(
        claimed!.lease,
        {},
        {
          artifacts: [
            {
              storageKey: 'runs/late.epub',
              sha256: 'e'.repeat(64),
              byteSize: 1,
              mediaType: 'application/epub+zip',
              kind: 'export',
            },
          ],
        },
      ),
    ).toBe(false);
    await expect(repository.getBook(owner, book.id)).rejects.toMatchObject({
      code: 'BOOK_NOT_FOUND',
    });
    expect((await repository.getBook('d'.repeat(64), fresh.id)).id).toBe(
      fresh.id,
    );
    expect(await persistence.getRun(created.run.id)).toBeNull();
    await repository.close();
  });

  it('bounds per-owner uploads, total source reservation and globally queued work independently', async () => {
    const persistence = new LocalProcessingPersistence(root, {
      maxRuns: 20,
      ownerActiveLimit: 1,
      ownerBookLimit: 1,
      maxActiveRuns: 1,
      maxSourceBytes: 250,
    });
    const repository = new ProcessingRepository(persistence);
    const first = await repository.createBook(source());
    await expect(repository.createBook(source())).rejects.toMatchObject({
      code: 'OWNER_BOOK_LIMIT',
    });
    const second = await repository.createBook({
      ...source(),
      ownerId: 'd'.repeat(64),
    });
    await expect(
      repository.createBook({ ...source(), ownerId: 'e'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'STORAGE_CAPACITY_EXCEEDED' });
    const runInput = {
      operation: 'beautify',
      requestHash: 'c'.repeat(64),
      configuration: {},
      stages: ['process'],
    };
    await repository.createRun({
      ...runInput,
      bookId: first.id,
      ownerId: first.ownerId,
      idempotencyKey: randomUUID(),
    });
    await expect(
      repository.createRun({
        ...runInput,
        bookId: second.id,
        ownerId: second.ownerId,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'PROCESSING_CAPACITY_EXCEEDED' });
    await repository.close();
  });

  it('refuses to activate public cleanup on an existing private local dataset', async () => {
    const previous = new ProcessingRepository(
      new LocalProcessingPersistence(root),
    );
    const book = await previous.createBook(source());
    await previous.close();
    const beta = new LocalProcessingPersistence(root, {
      maxRuns: 20,
      ownerActiveLimit: 1,
      retentionMs: 3600000,
    });
    await expect(beta.initialize()).rejects.toMatchObject({
      code: 'PUBLIC_BETA_REQUIRES_EMPTY_DIRECTORY',
    });
    expect((await previous.getBook(owner, book.id)).id).toBe(book.id);
  });

  it('deletes expired fixed files and late orphan writes while keeping current source and OS lock files', async () => {
    const env = validateEnvironment({
      NODE_ENV: 'production',
      PROCESSING_ENABLED: true,
      PROCESSING_PUBLIC_BETA_ENABLED: true,
      PROCESSING_DATA_DIR: root,
      EPUBCHECK_JAR_PATH: join(root, 'checker.jar'),
      PROCESSING_ALLOWED_ORIGIN: 'https://epub.example.test',
      PROCESSING_UPLOAD_MAX_MIB: 20,
    });
    const config = { get: (key: keyof typeof env) => env[key] } as AppConfig;
    const persistence = new LocalProcessingPersistence(root, {
      maxRuns: 20,
      ownerActiveLimit: 1,
      retentionMs: 3600000,
    });
    const repository = new ProcessingRepository(persistence);
    const oldSource = source();
    const old = {
      ...oldSource,
      id: randomUUID(),
      createdAt: new Date(Date.now() - 3600001).toISOString(),
      deletedAt: null,
    };
    await persistence.createBook(old);
    const current = await repository.createBook(source());
    const storage = new LocalArtifactStorage(config);
    await mkdir(join(root, 'sources'), { recursive: true });
    await writeFile(storage.path(old.sourceKey), 'old');
    await writeFile(storage.path(current.sourceKey), 'current');
    const lateId = randomUUID();
    await mkdir(storage.path('runs/' + lateId), { recursive: true });
    await writeFile(storage.path(`runs/${lateId}/late.epub`), 'orphan');
    const oldTime = new Date(Date.now() - 300001);
    await utimes(storage.path('runs/' + lateId), oldTime, oldTime);
    const cleanup = new BetaMaintenanceService(config, repository, storage);
    await cleanup.sweep();
    await expect(readFile(storage.path(old.sourceKey))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      readFile(storage.path(`runs/${lateId}/late.epub`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(storage.path(current.sourceKey), 'utf8')).toBe(
      'current',
    );
    expect(
      (await readFile(join(root, 'metadata/state-lock.sqlite'))).length,
    ).toBeGreaterThanOrEqual(0);
    await repository.close();
  });
});
