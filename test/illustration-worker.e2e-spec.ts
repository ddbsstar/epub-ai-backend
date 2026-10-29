import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { validateEnvironment } from '../src/config/environment.js';
import type { AppConfig } from '../src/config/app-config.module.js';
import { ProcessingRepository } from '../src/processing/processing.repository.js';
import { LocalProcessingPersistence } from '../src/processing/local-processing.persistence.js';
import { ProcessingError } from '../src/processing/processing.types.js';
import { LocalArtifactStorage } from '../src/business/artifact-storage.js';
import {
  IllustrationWorkerService,
  type IllustrationCliRunner,
} from '../src/business/illustration-worker.service.js';

const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(invalidPlan = false) {
  const root = await mkdtemp(join(tmpdir(), 'epub-illustration-worker-'));
  const env = validateEnvironment({
    NODE_ENV: 'test',
    PROCESSING_ENABLED: true,
    PROCESSING_AI_ENABLED: true,
    QWEN_ENABLED: true,
    QWEN_API_KEY: 'placeholder',
    QWEN_BASE_URL: 'https://example.com/v1',
    QWEN_MODEL: 'test',
    IMAGE_GENERATION_ENABLED: true,
    IMAGE_API_KEY: 'placeholder',
    IMAGE_DATA_DIR: join(root, 'images'),
    PROCESSING_DATA_DIR: join(root, 'data'),
    EPUBCHECK_JAR_PATH: join(root, 'check.jar'),
  });
  const config = { get: (key: keyof typeof env) => env[key] } as AppConfig;
  const persistence = new LocalProcessingPersistence(env.PROCESSING_DATA_DIR);
  await persistence.initialize();
  cleanups.push(async () => {
    await persistence.close();
    await rm(root, { recursive: true, force: true });
  });
  const repository = new ProcessingRepository(persistence);
  const storage = new LocalArtifactStorage(config);
  const described = await storage.storeStream(
    'sources/book.epub',
    Readable.from(Buffer.from('PK-private-fixture')),
    100,
  );
  const book = await repository.createBook({
    ownerId: 'owner',
    sourceKey: 'sources/book.epub',
    sourceHash: described.sha256,
    byteSize: described.byteSize,
    originalName: 'book.epub',
  });
  const { run } = await repository.createRun({
    ownerId: 'owner',
    bookId: book.id,
    operation: 'illustration-plan',
    idempotencyKey: 'plan-key',
    requestHash: 'a'.repeat(64),
    configuration: { chapterIndex: 0, sceneDirection: '无人环境' },
    stages: ['illustration-plan'],
  });
  const claim = (await repository.claim(
    {
      payloadVersion: 1,
      runId: run.id,
      stepId: run.steps[0]!.id,
      dispatchGeneration: 1,
    },
    'test-worker',
    30000,
  ))!;
  const runner: IllustrationCliRunner = {
    run: vi.fn(async (input) => {
      const req = JSON.parse(await readFile(input.requestPath, 'utf8')) as {
        sourcePath: string;
        outputDirectory: string;
        textStateDirectory: string;
      };
      const plan = {
        sourceSha256: book.sourceHash,
        chapterId: 'chapter-1',
        coverage: 'COMPLETE',
        summary: '雪晨环境',
        emotionalReading: '安静',
        facts: [{ text: '雪晨有鸟', sourceBlockIds: ['b'.repeat(64)] }],
        anchorId: 'c'.repeat(64),
        concept: '以留白表现雪晨',
        imagePrompt: '无人雪景和鸟群',
        alt: '雪景',
        schemaVersion: 1,
        decision: 'ILLUSTRATE',
      };
      const keys = [
        'sourceSha256',
        'chapterId',
        'coverage',
        'summary',
        'emotionalReading',
        'facts',
        'anchorId',
        'concept',
        'imagePrompt',
        'alt',
      ] as const;
      const fingerprint = hash(
        Object.fromEntries(keys.map((key) => [key, plan[key]])),
      );
      await mkdir(req.outputDirectory, { recursive: true });
      await writeFile(
        join(req.outputDirectory, 'plan.json'),
        JSON.stringify(plan),
      );
      await writeFile(
        join(req.outputDirectory, 'stage-receipt.json'),
        JSON.stringify({
          stage: 'plan',
          sourceSha256: book.sourceHash,
          chapterId: 'chapter-1',
          chapterTitle: '第一章',
          sourcePlanHash: invalidPlan ? '0'.repeat(64) : fingerprint,
          planPath: join(req.outputDirectory, 'plan.json'),
        }),
      );
    }),
  };
  const worker = new IllustrationWorkerService(
    config,
    storage,
    repository,
    runner,
  );
  return {
    root,
    book,
    run,
    claim,
    config,
    storage,
    repository,
    runner,
    worker,
  };
}
describe('illustration Worker private boundary', () => {
  it('uses a stable plan workspace and globally shared separate text ledger, publishing only a bounded plan', async () => {
    const f = await fixture();
    const output = await f.worker.handle({
      ...f.claim,
      signal: new AbortController().signal,
    });
    const call = vi.mocked(f.runner.run).mock.calls[0]![0];
    const req = JSON.parse(await readFile(call.requestPath, 'utf8')) as Record<
      string,
      string
    >;
    expect(req.operationId).toBe(f.run.id);
    expect(req.textStateDirectory).toBe(
      join(f.root, 'data', 'illustration-text-state'),
    );
    expect(req.outputDirectory).toContain(f.run.id);
    expect(call.until).toBe('plan');
    expect(call.environment.QWEN_API_KEY).toBe('placeholder');
    expect(call.requestPath).not.toContain('placeholder');
    expect(
      await f.repository.completeStep(f.claim.lease, output.result, {
        artifacts: output.artifacts,
      }),
    ).toBe(true);
    const safe = await f.worker.getPlanData(f.run);
    expect(safe).toMatchObject({
      chapterTitle: '第一章',
      prompt: '无人雪景和鸟群',
      chapterIndex: 0,
    });
    expect(safe).not.toHaveProperty('facts');
    expect(safe).not.toHaveProperty('modelCalls');
    expect(output.artifacts).toHaveLength(1);
    expect(output.artifacts![0]!.kind).toBe('illustration-plan');
  });
  it('rejects a changed source before launching a paid-capable child', async () => {
    const f = await fixture();
    await writeFile(f.storage.path(f.book.sourceKey), 'changed');
    await expect(
      f.worker.handle({ ...f.claim, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(f.runner.run).not.toHaveBeenCalled();
  });
  it('rejects an unbound received plan instead of publishing it', async () => {
    const f = await fixture(true);
    await expect(
      f.worker.handle({ ...f.claim, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'ILLUSTRATION_PLAN_INVALID' });
    expect((await f.repository.getRun('owner', f.run.id)).artifactIds).toEqual(
      [],
    );
  });
  it('honors cancellation/fencing and keeps an unknown paid outcome from being relabelled successful', async () => {
    const f = await fixture();
    await f.repository.requestCancel('owner', f.run.id);
    await expect(
      f.worker.handle({ ...f.claim, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'STALE_PROCESSING_LEASE' });
    expect(f.runner.run).not.toHaveBeenCalled();
    const g = await fixture();
    vi.mocked(g.runner.run).mockRejectedValue(
      new ProcessingError('AI_UNKNOWN_OUTCOME'),
    );
    await expect(
      g.worker.handle({ ...g.claim, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'AI_UNKNOWN_OUTCOME' });
    expect(g.runner.run).toHaveBeenCalledTimes(1);
    expect((await g.repository.getRun('owner', g.run.id)).artifactIds).toEqual(
      [],
    );
  });
});
