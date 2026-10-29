import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalProcessingPersistence } from '../src/processing/local-processing.persistence.js';
import {
  ProcessingRepository,
  validateStepPayload,
} from '../src/processing/processing.repository.js';
import {
  ProcessingWorkerService,
  dispatchProcessingStep,
} from '../src/processing/processing-worker.service.js';
import type { AppConfig } from '../src/config/app-config.module.js';
import type { PinoLogger } from 'nestjs-pino';
import type {
  ProcessingBook,
  ProcessingRun,
} from '../src/processing/processing.types.js';

describe('durable Phase A processing', () => {
  let directory: string;
  let persistence: LocalProcessingPersistence;
  let repository: ProcessingRepository;
  let now: number;
  let book: ProcessingBook;
  const artifact = {
    storageKey: 'attempts/output.epub',
    sha256: 'b'.repeat(64),
    byteSize: 1024,
    mediaType: 'application/epub+zip',
    kind: 'export',
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'epub-processing-test-'));
    persistence = new LocalProcessingPersistence(directory);
    now = Date.now();
    repository = new ProcessingRepository(persistence, () => now);
    book = await repository.createBook({
      ownerId: 'owner-a',
      sourceKey: 'sources/test.epub',
      sourceHash: 'a'.repeat(64),
      byteSize: 2048,
      originalName: 'test.epub',
    });
  });
  afterEach(async () => {
    await repository.close();
    await rm(directory, { recursive: true, force: true });
  });

  const createInput = (book: ProcessingBook) => ({
    ownerId: book.ownerId,
    bookId: book.id,
    operation: 'beautify',
    idempotencyKey: 'request-1',
    requestHash: 'c'.repeat(64),
    configuration: { theme: 'reader-first/v1' },
    stages: ['process', 'validate', 'publish'],
  });
  async function create(): Promise<ProcessingRun> {
    return (await repository.createRun(createInput(book))).run;
  }

  it('atomically deduplicates concurrent API requests and rejects changed requests', async () => {
    const other = new ProcessingRepository(
      new LocalProcessingPersistence(directory),
    );
    const results = await Promise.all([
      repository.createRun(createInput(book)),
      other.createRun(createInput(book)),
    ]);
    expect(results[0].run.id).toBe(results[1].run.id);
    expect(
      results
        .map((result) => result.reused)
        .sort((a, b) => Number(a) - Number(b)),
    ).toEqual([false, true]);
    await expect(
      repository.createRun({
        ...createInput(book),
        requestHash: 'd'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      repository.getRun('different-owner', results[0].run.id),
    ).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
  });

  it('enforces owner admission under cross-instance contention', async () => {
    const other = new ProcessingRepository(
      new LocalProcessingPersistence(directory),
    );
    const outcomes = await Promise.allSettled([
      repository.createRun(createInput(book)),
      other.createRun({ ...createInput(book), idempotencyKey: 'request-2' }),
    ]);
    expect(
      outcomes.filter((value) => value.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      outcomes.filter((value) => value.status === 'rejected'),
    ).toHaveLength(1);
  });

  it('persists checkpoint and next step together across repository restart', async () => {
    const run = await create();
    const [payload] = await repository.listDispatchable();
    expect(payload.stepId).toBe(run.steps[0].id);
    const claimed = (await repository.claim(payload, 'worker-a'))!;
    expect(await repository.claim(payload, 'worker-b')).toBeNull();
    expect(
      await repository.completeStep(claimed.lease, {
        outputKey: 'attempts/layout.epub',
      }),
    ).toBe(true);
    const restarted = new ProcessingRepository(
      new LocalProcessingPersistence(directory),
      () => now,
    );
    const snapshot = await restarted.getRun(book.ownerId, run.id);
    expect(snapshot.steps[0].result).toEqual({
      outputKey: 'attempts/layout.epub',
    });
    expect(snapshot.completedUnits).toBe(1);
    expect(snapshot.stage).toBe('validate');
    expect((await restarted.listDispatchable())[0].stepId).toBe(
      run.steps[1].id,
    );
    expect(await restarted.completeStep(claimed.lease, null)).toBe(false);
  });

  it('recovers expired leases with a new generation and fences stale publication', async () => {
    await create();
    const [original] = await repository.listDispatchable();
    const oldClaim = (await repository.claim(original, 'worker-a', 1000))!;
    now += 1001;
    expect(await repository.recoverExpired()).toBe(1);
    const [replacement] = await repository.listDispatchable();
    expect(replacement.dispatchGeneration).toBe(2);
    expect(await repository.claim(original, 'worker-a')).toBeNull();
    const newClaim = (await repository.claim(replacement, 'worker-b'))!;
    expect(await repository.heartbeat(oldClaim.lease)).toBe(false);
    expect(await repository.completeStep(oldClaim.lease, {})).toBe(false);
    expect(
      await repository.completeStep(newClaim.lease, { recovered: true }),
    ).toBe(true);
  });

  it('cancels queued runs immediately and running runs before publication', async () => {
    const first = await create();
    expect(
      (await repository.requestCancel(book.ownerId, first.id)).status,
    ).toBe('CANCELLED');
    const next = (
      await repository.createRun({
        ...createInput(book),
        idempotencyKey: 'request-2',
        stages: ['publish'],
      })
    ).run;
    const claim = (await repository.claim(
      (await repository.listDispatchable())[0],
      'worker-a',
    ))!;
    expect((await repository.requestCancel(book.ownerId, next.id)).status).toBe(
      'RUNNING',
    );
    expect(
      await repository.completeStep(claim.lease, {}, { artifacts: [artifact] }),
    ).toBe(false);
    const cancelled = await repository.getRun(book.ownerId, next.id);
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.artifactIds).toEqual([]);
  });

  it('atomically publishes all final artifacts only once', async () => {
    const run = (
      await repository.createRun({ ...createInput(book), stages: ['publish'] })
    ).run;
    const claim = (await repository.claim(
      (await repository.listDispatchable())[0],
      'worker-a',
    ))!;
    const report = {
      ...artifact,
      storageKey: 'attempts/report.json',
      mediaType: 'application/json',
      kind: 'report',
    };
    expect(
      await repository.completeStep(
        claim.lease,
        { passed: true },
        { artifacts: [artifact, report] },
      ),
    ).toBe(true);
    expect(
      await repository.completeStep(claim.lease, {}, { artifacts: [artifact] }),
    ).toBe(false);
    const snapshot = await repository.getRun(book.ownerId, run.id);
    expect(snapshot.status).toBe('SUCCEEDED');
    expect(snapshot.artifactIds).toHaveLength(2);
    const published = await repository.getArtifact(
      book.ownerId,
      snapshot.artifactIds[0],
    );
    expect(published.storageKey).toBe(artifact.storageKey);
    await expect(
      repository.getArtifact('wrong-owner', published.id),
    ).rejects.toMatchObject({ code: 'ARTIFACT_NOT_FOUND' });
  });

  it('stops repeated crash recovery after the bounded attempt limit', async () => {
    const run = await create();
    for (let index = 0; index < 3; index += 1) {
      await repository.claim(
        (await repository.listDispatchable())[0],
        'worker-a',
        1000,
      );
      now += 1001;
      await repository.recoverExpired();
    }
    const failed = await repository.getRun(book.ownerId, run.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.errorCode).toBe('RECOVERY_LIMIT_EXCEEDED');
  });

  it('keeps the local worker lock exclusive between instances', async () => {
    const release = await persistence.acquireWorkerLock();
    await expect(
      new LocalProcessingPersistence(directory).acquireWorkerLock(),
    ).rejects.toMatchObject({ code: 'LOCAL_WORKER_ALREADY_RUNNING' });
    await release();
    const releaseRecovered = await persistence.acquireWorkerLock();
    await releaseRecovered();
  });

  it('reclaims the kernel worker lock after killing its owner process', async () => {
    const moduleUrl = new URL(
      '../src/processing/sqlite-file-lock.ts',
      import.meta.url,
    ).href;
    const script = `import { acquireSqliteFileLock } from ${JSON.stringify(moduleUrl)}; await acquireSqliteFileLock(${JSON.stringify(join(directory, 'metadata', 'worker-lock.sqlite'))},0); process.stdout.write('locked'); setInterval(()=>{},1000);`;
    const child = spawn(
      process.execPath,
      ['--input-type=module', '--eval', script],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    try {
      await Promise.race([
        once(child.stdout, 'data'),
        once(child, 'exit').then(() => {
          throw new Error('Lock owner exited too early');
        }),
      ]);
      await expect(persistence.acquireWorkerLock()).rejects.toMatchObject({
        code: 'LOCAL_WORKER_ALREADY_RUNNING',
      });
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      const release = await persistence.acquireWorkerLock();
      await release();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
  });

  it.each(['failed', 'completed'])(
    'advances a still-pending generation shadowed by a %s Redis record',
    async (state) => {
      await create();
      const [payload] = await repository.listDispatchable();
      const queue = {
        getJob: vi.fn().mockResolvedValue({ getState: async () => state }),
        add: vi.fn().mockResolvedValue(undefined),
      };
      await dispatchProcessingStep(repository, queue, payload);
      expect(queue.add).toHaveBeenCalledWith(
        'processing-step-v1',
        { ...payload, dispatchGeneration: 2 },
        expect.objectContaining({ jobId: `s-${payload.stepId}-d2` }),
      );
      expect(await repository.advanceDispatchGeneration(payload)).toBeNull();
      const [next] = await repository.listDispatchable();
      expect(next.dispatchGeneration).toBe(2);
      expect(await repository.claim(payload, 'old-delivery')).toBeNull();
      expect(await repository.claim(next, 'new-delivery')).not.toBeNull();
    },
  );

  it('does not advance running, cancelled, or stale steps during redis repair', async () => {
    const run = await create();
    const [payload] = await repository.listDispatchable();
    const claim = (await repository.claim(payload, 'worker-a'))!;
    expect(await repository.advanceDispatchGeneration(payload)).toBeNull();
    await repository.requestCancel(book.ownerId, run.id);
    await repository.failStep(claim.lease, 'CANCELLED');
    expect(await repository.advanceDispatchGeneration(payload)).toBeNull();
  });

  it('does not replace a redis job that is still waiting or active', async () => {
    await create();
    const [payload] = await repository.listDispatchable();
    const queue = {
      getJob: vi.fn().mockResolvedValue({ getState: async () => 'active' }),
      add: vi.fn(),
    };
    await dispatchProcessingStep(repository, queue, payload);
    expect(queue.add).not.toHaveBeenCalled();
    expect((await repository.listDispatchable())[0].dispatchGeneration).toBe(1);
  });

  it('rejects book content and unknown keys in queue payloads', () => {
    expect(() =>
      validateStepPayload({
        payloadVersion: 1,
        runId: 'a'.repeat(36),
        stepId: 'b'.repeat(36),
        dispatchGeneration: 1,
        bookText: 'private',
      }),
    ).toThrow('INVALID_STEP_PAYLOAD');
  });

  it('runs the actual local worker through all stages without Redis or AI', async () => {
    const run = await create();
    const settings: Record<string, unknown> = {
      PROCESSING_ENABLED: true,
      PROCESSING_REPOSITORY: 'local',
      PROCESSING_POLL_MS: 5,
      PROCESSING_LEASE_MS: 30000,
    };
    const worker = new ProcessingWorkerService(
      { get: (key: string) => settings[key] } as AppConfig,
      repository,
      { info: vi.fn(), warn: vi.fn() } as unknown as PinoLogger,
    );
    const handled: string[] = [];
    const running = worker.run(async ({ step, book: source }) => {
      expect(source.sourceHash).toBe(book.sourceHash);
      handled.push(step.stage);
      return {
        result: { stage: step.stage },
        ...(step.stage === 'publish' ? { artifacts: [artifact] } : {}),
      };
    });
    try {
      for (let index = 0; index < 300; index += 1) {
        if (
          (await repository.getRun(book.ownerId, run.id)).status === 'SUCCEEDED'
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect((await repository.getRun(book.ownerId, run.id)).status).toBe(
        'SUCCEEDED',
      );
      expect(handled).toEqual(['process', 'validate', 'publish']);
    } finally {
      await worker.stop();
      await running;
    }
    const persisted = JSON.parse(
      await readFile(join(directory, 'metadata', 'state.json'), 'utf8'),
    ) as { version: number };
    expect(persisted.version).toBe(1);
  });
});
