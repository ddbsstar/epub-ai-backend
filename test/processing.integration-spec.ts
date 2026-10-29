import { randomUUID } from 'node:crypto';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaProcessingPersistence } from '../src/processing/prisma-processing.persistence.js';
import { ProcessingRepository } from '../src/processing/processing.repository.js';
import type {
  ProcessingArtifact,
  ProcessingBook,
  ProcessingRun,
  StepPayload,
} from '../src/processing/processing.types.js';

/** No .env loading, migrations, schema changes, Redis connections, or broad
 * cleanup. CI/operators must apply the reviewed migration before opting in. */
function isolatedDatabaseUrl(): string {
  try {
    const database = new URL(process.env.DATABASE_URL ?? '');
    const redis = new URL(process.env.REDIS_URL ?? '');
    if (
      database.protocol !== 'mysql:' ||
      database.hostname !== '127.0.0.1' ||
      database.port !== '3307' ||
      !/^\/[a-zA-Z0-9_]{1,64}$/.test(database.pathname) ||
      database.search ||
      database.hash ||
      redis.protocol !== 'redis:' ||
      redis.hostname !== '127.0.0.1' ||
      redis.port !== '6380' ||
      redis.search ||
      redis.hash ||
      !['', '/'].includes(redis.pathname)
    )
      throw new Error('Invalid isolated target');
    database.searchParams.set('connectionLimit', '4');
    database.searchParams.set('connectTimeout', '1500');
    database.searchParams.set('acquireTimeout', '1500');
    return database.toString();
  } catch {
    throw new Error(
      'Processing integration requires explicit isolated MySQL 127.0.0.1:3307 and Redis 127.0.0.1:6380 URLs.',
    );
  }
}

/** Recovery must scan only this random test owner. Other pre-existing rows are
 * neither recovered nor deleted even on an explicitly opted-in local database. */
class OwnerScopedPersistence extends PrismaProcessingPersistence {
  constructor(
    private readonly testClient: PrismaClient,
    private readonly testOwner: string,
    ownerActiveLimit = 1,
  ) {
    super(testClient, { maxRuns: 1000000, ownerActiveLimit });
  }
  override async listActive(limit: number): Promise<ProcessingRun[]> {
    const rows = await this.testClient.processingRun.findMany({
      where: { ownerId: this.testOwner, status: { in: ['QUEUED', 'RUNNING'] } },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
    return rows.map(
      (row) => structuredClone(row.record) as unknown as ProcessingRun,
    );
  }
}

describe.runIf(process.env.RUN_INFRA_INTEGRATION === 'true')(
  'Isolated MySQL processing transactions',
  () => {
    let client: PrismaClient | undefined;
    let persistence: OwnerScopedPersistence;
    let repository: ProcessingRepository;
    let book: ProcessingBook;
    let ownerId: string;
    let now: number;
    const artifact = {
      storageKey: 'attempts/integration-output.epub',
      sha256: 'a'.repeat(64),
      byteSize: 1024,
      mediaType: 'application/epub+zip',
      kind: 'export',
    };
    const ownedRows = () => ({ ownerId });
    const payload = (run: ProcessingRun, stage = 0): StepPayload => ({
      payloadVersion: 1,
      runId: run.id,
      stepId: run.steps[stage].id,
      dispatchGeneration: run.steps[stage].dispatchGeneration,
    });
    const input = (
      key = 'integration-request-1',
      stages = ['process', 'validate', 'publish'],
    ) => ({
      ownerId,
      bookId: book.id,
      operation: 'beautify',
      idempotencyKey: key,
      requestHash: 'b'.repeat(64),
      configuration: { theme: 'reader-first/v1' },
      stages,
    });

    beforeAll(async () => {
      // The guard runs before adapter/client construction and never logs credentials.
      const url = isolatedDatabaseUrl();
      client = new PrismaClient({ adapter: new PrismaMariaDb(url) });
      await client.$connect();
      expect(
        await client.processingAdmissionLock.findUnique({
          where: { id: 'global' },
        }),
      ).not.toBeNull();
    }, 15000);

    beforeEach(async () => {
      ownerId = `processing-it-${randomUUID()}`;
      now = Date.now();
      persistence = new OwnerScopedPersistence(client!, ownerId);
      repository = new ProcessingRepository(persistence, () => now);
      book = await repository.createBook({
        ownerId,
        sourceKey: `sources/${randomUUID()}.epub`,
        sourceHash: 'c'.repeat(64),
        byteSize: 2048,
        originalName: 'integration.epub',
      });
    });

    afterEach(async () => {
      if (!client || !ownerId) return;
      // Only this test's exact random owner; leave admission seed and all other rows.
      await client.processingArtifact.deleteMany({ where: ownedRows() });
      await client.processingRun.deleteMany({ where: ownedRows() });
      await client.processingBook.deleteMany({ where: ownedRows() });
    });

    afterAll(async () => {
      await client?.$disconnect();
    });

    it('serializes concurrent matching idempotency keys and rejects changed requests', async () => {
      const second = new ProcessingRepository(
        new OwnerScopedPersistence(client!, ownerId),
        () => now,
      );
      const [left, right] = await Promise.all([
        repository.createRun(input()),
        second.createRun(input()),
      ]);
      expect(left.run.id).toBe(right.run.id);
      expect([left.reused, right.reused].filter(Boolean)).toHaveLength(1);
      expect(await client!.processingRun.count({ where: ownedRows() })).toBe(1);
      await expect(
        second.createRun({ ...input(), requestHash: 'd'.repeat(64) }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    });

    it('admits only one active run for an owner under concurrent transactions', async () => {
      const second = new ProcessingRepository(
        new OwnerScopedPersistence(client!, ownerId),
        () => now,
      );
      const outcomes = await Promise.allSettled([
        repository.createRun(input('first')),
        second.createRun(input('second')),
      ]);
      expect(
        outcomes.filter((value) => value.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        outcomes.filter((value) => value.status === 'rejected'),
      ).toHaveLength(1);
      expect(await client!.processingRun.count({ where: ownedRows() })).toBe(1);
    });

    it('recovers a lease with fencing and atomically persists checkpoint plus next stage', async () => {
      const run = (await repository.createRun(input())).run;
      const old = (await repository.claim(payload(run), 'old-worker', 1000))!;
      now += 1001;
      expect(await repository.recoverExpired()).toBe(1);
      const recovered = await repository.getRun(ownerId, run.id);
      expect(recovered.steps[0].dispatchGeneration).toBe(2);
      expect(await repository.claim(payload(run), 'old-worker')).toBeNull();
      const current = (await repository.claim(
        payload(recovered),
        'new-worker',
      ))!;
      expect(
        await repository.completeStep(old.lease, { shouldNotAppear: true }),
      ).toBe(false);
      expect(await repository.heartbeat(old.lease)).toBe(false);
      expect(
        await repository.completeStep(current.lease, {
          outputKey: 'attempts/rendered.epub',
        }),
      ).toBe(true);
      const restarted = new ProcessingRepository(
        new OwnerScopedPersistence(client!, ownerId),
        () => now,
      );
      const snapshot = await restarted.getRun(ownerId, run.id);
      expect(snapshot.completedUnits).toBe(1);
      expect(snapshot.stage).toBe('validate');
      expect(snapshot.steps[0].result).toEqual({
        outputKey: 'attempts/rendered.epub',
      });
      expect((await restarted.listDispatchable())[0].stepId).toBe(
        run.steps[1].id,
      );
    });

    it('rolls back partial artifact publication and publishes validated artifacts once', async () => {
      const run = (
        await repository.createRun(input('publish-once', ['publish']))
      ).run;
      const claim = (await repository.claim(payload(run), 'publisher'))!;
      const duplicate: ProcessingArtifact = {
        ...artifact,
        id: randomUUID(),
        ownerId,
        bookId: book.id,
        runId: run.id,
        createdAt: new Date(now).toISOString(),
      };
      // Force the second INSERT to fail after the run UPDATE and first INSERT.
      await expect(
        persistence.mutateRun(run.id, (current) => ({
          result: true,
          mutation: {
            run: { ...current, status: 'SUCCEEDED' },
            artifacts: [duplicate, duplicate],
          },
        })),
      ).rejects.toBeDefined();
      expect((await repository.getRun(ownerId, run.id)).status).toBe('RUNNING');
      expect(
        await client!.processingArtifact.count({ where: ownedRows() }),
      ).toBe(0);
      const report = {
        ...artifact,
        storageKey: 'attempts/integration-report.json',
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
        await repository.completeStep(
          claim.lease,
          {},
          { artifacts: [artifact] },
        ),
      ).toBe(false);
      const published = await repository.getRun(ownerId, run.id);
      expect(published.status).toBe('SUCCEEDED');
      expect(published.artifactIds).toHaveLength(2);
      expect(
        await client!.processingArtifact.count({ where: ownedRows() }),
      ).toBe(2);
      expect(
        (await repository.getArtifact(ownerId, published.artifactIds[0]))
          .storageKey,
      ).toBe(artifact.storageKey);
    });

    it('commits cancellation instead of a competing final publication', async () => {
      const run = (
        await repository.createRun(input('cancel-publication', ['publish']))
      ).run;
      const claim = (await repository.claim(payload(run), 'publisher'))!;
      expect((await repository.requestCancel(ownerId, run.id)).status).toBe(
        'RUNNING',
      );
      expect(
        await repository.completeStep(
          claim.lease,
          {},
          { artifacts: [artifact] },
        ),
      ).toBe(false);
      expect((await repository.getRun(ownerId, run.id)).status).toBe(
        'CANCELLED',
      );
      expect(
        await client!.processingArtifact.count({ where: ownedRows() }),
      ).toBe(0);
      const queued = (await repository.createRun(input('cancel-queued'))).run;
      expect((await repository.requestCancel(ownerId, queued.id)).status).toBe(
        'CANCELLED',
      );
      expect(await repository.claim(payload(queued), 'late-worker')).toBeNull();
    });

    it('preserves case-sensitive idempotency keys from the reviewed migration', async () => {
      const lessRestricted = new ProcessingRepository(
        new OwnerScopedPersistence(client!, ownerId, 2),
        () => now,
      );
      const first = await lessRestricted.createRun(input('case-key'));
      const second = await lessRestricted.createRun(input('Case-Key'));
      expect(first.run.id).not.toBe(second.run.id);
      expect(await client!.processingRun.count({ where: ownedRows() })).toBe(2);
    });
  },
);
