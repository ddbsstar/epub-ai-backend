import 'reflect-metadata';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/app-config.module.js';
import { validateEnvironment } from '../src/config/environment.js';
import { configureApp } from '../src/setup-app.js';
import { ProcessingRepository } from '../src/processing/processing.repository.js';
import { LocalArtifactStorage } from '../src/business/artifact-storage.js';
import { IllustrationWorkerService } from '../src/business/illustration-worker.service.js';
import type { ProcessingRun } from '../src/processing/processing.types.js';

const paths: string[] = [];
const apps: NestExpressApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const path of paths.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function fixture(enabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'epub-illustration-http-'));
  paths.push(root);
  const environment = validateEnvironment({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PROCESSING_ENABLED: true,
    PROCESSING_DATA_DIR: join(root, 'data'),
    EPUBCHECK_JAR_PATH: join(root, 'test.jar'),
    PROCESSING_AI_ENABLED: enabled,
    QWEN_ENABLED: enabled,
    QWEN_API_KEY: enabled ? 'placeholder' : '',
    QWEN_BASE_URL: enabled ? 'https://example.com/v1' : '',
    QWEN_MODEL: enabled ? 'test-model' : '',
    IMAGE_GENERATION_ENABLED: enabled,
    IMAGE_API_KEY: enabled ? 'placeholder' : '',
    IMAGE_DATA_DIR: join(root, 'images'),
  });
  const planReader = vi.fn(async (run: ProcessingRun) => ({
    chapterIndex: 0,
    chapterTitle: '第一章',
    concept: '雪晨的留白',
    prompt: '原方案雪景',
    alt: '雪景',
    sourcePlanHash: 'a'.repeat(64),
    sourceSha256: run.requestHash,
  }));
  const runner = vi.fn();
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AppConfig)
    .useValue({ get: (key: keyof typeof environment) => environment[key] })
    .overrideProvider(IllustrationWorkerService)
    .useValue({ getPlanData: planReader, handle: runner })
    .compile();
  const app = module.createNestApplication<NestExpressApplication>({
    bodyParser: false,
  });
  configureApp(app);
  await app.init();
  apps.push(app);
  const agent = request.agent(app.getHttpServer());
  const repository = app.get(ProcessingRepository);
  const storage = app.get(LocalArtifactStorage);
  const upload = await agent
    .post('/api/v1/uploads')
    .attach(
      'file',
      Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        Buffer.from('private-test'),
      ]),
      'book.epub',
    )
    .expect(201);
  return {
    root,
    app,
    agent,
    repository,
    storage,
    bookId: upload.body.data.bookId as string,
    planReader,
    runner,
  };
}
async function complete(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  image = false,
) {
  const run = (await f.repository.persistence.getRun(id))!;
  const step = run.steps[0]!;
  const claim = (await f.repository.claim(
    {
      payloadVersion: 1,
      runId: id,
      stepId: step.id,
      dispatchGeneration: step.dispatchGeneration,
    },
    'test-worker',
    30000,
  ))!;
  const entries = image
    ? [
        {
          kind: 'export',
          mediaType: 'application/epub+zip',
          key: `runs/${id}/book.epub`,
          bytes: Buffer.from('PK-illustrated-test'),
        },
        {
          kind: 'report',
          mediaType: 'application/json',
          key: `runs/${id}/report.json`,
          bytes: Buffer.from('{}'),
        },
        {
          kind: 'illustration',
          mediaType: 'image/png',
          key: `runs/${id}/image.png`,
          bytes: Buffer.from('test-png-asset'),
        },
      ]
    : [
        {
          kind: 'illustration-plan',
          mediaType: 'application/json',
          key: `runs/${id}/plan.json`,
          bytes: Buffer.from('{}'),
        },
      ];
  const artifacts = [];
  for (const entry of entries)
    artifacts.push({
      kind: entry.kind,
      mediaType: entry.mediaType,
      storageKey: entry.key,
      ...(await f.storage.storeStream(
        entry.key,
        Readable.from(entry.bytes),
        1000,
      )),
    });
  expect(
    await f.repository.completeStep(
      claim.lease,
      { published: true },
      { artifacts },
    ),
  ).toBe(true);
}
const header = { 'Idempotency-Key': 'test-request-0001' };
describe('owned chapter illustration HTTP workflow', () => {
  it('keeps the feature opt-in and does not start work from GET', async () => {
    const f = await fixture(false);
    await f.agent
      .post(`/api/v1/books/${f.bookId}/illustrations/plan`)
      .set(header)
      .send({ chapterIndex: 0 })
      .expect(503);
    expect(f.runner).not.toHaveBeenCalled();
  });
  it('rejects extra fields, foreign books and hostile origins before queuing', async () => {
    const f = await fixture();
    await f.agent
      .post(`/api/v1/books/${f.bookId}/illustrations/plan`)
      .set(header)
      .send({ chapterIndex: 0, sourcePath: 'C:/private.epub' })
      .expect(400);
    await request(f.app.getHttpServer())
      .post(`/api/v1/books/${f.bookId}/illustrations/plan`)
      .set(header)
      .send({ chapterIndex: 0 })
      .expect(404);
    await f.agent
      .post(`/api/v1/books/${f.bookId}/illustrations/plan`)
      .set(header)
      .set('Origin', 'https://hostile.example')
      .send({ chapterIndex: 0 })
      .expect(403);
    expect(f.runner).not.toHaveBeenCalled();
  });
  it('uses one canonical plan per owned chapter even if browser keys change', async () => {
    const f = await fixture();
    const a = await f.agent
      .post(`/api/v1/books/${f.bookId}/illustrations/plan`)
      .set(header)
      .send({ chapterIndex: 0 })
      .expect(202);
    const b = await f.agent
      .post(`/api/v1/books/${f.bookId}/illustrations/plan`)
      .set('Idempotency-Key', 'another-browser-0002')
      .send({ chapterIndex: 0 })
      .expect(202);
    expect(a.body.data.id).toBe(b.body.data.id);
    expect(a.body.data.artifacts.image).toBeNull();
    await f.agent.get(`/api/v1/illustrations/${a.body.data.id}`).expect(200);
    expect(f.runner).not.toHaveBeenCalled();
  });
  it('rejects generation before the plan is complete and rejects overlong or invalid XML alt', async () => {
    const f = await fixture();
    const response = await f.agent
      .post(`/api/v1/books/${f.bookId}/illustrations/plan`)
      .set(header)
      .send({ chapterIndex: 0 })
      .expect(202);
    const id = response.body.data.id;
    await f.agent
      .post(`/api/v1/illustrations/${id}/generate`)
      .set(header)
      .send({ prompt: '雪景', alt: '雪景' })
      .expect(409);
    await complete(f, id);
    await f.agent
      .post(`/api/v1/illustrations/${id}/generate`)
      .set(header)
      .send({ prompt: '雪'.repeat(801), alt: '雪景' })
      .expect(400);
    await f.agent
      .post(`/api/v1/illustrations/${id}/generate`)
      .set(header)
      .send({ prompt: '雪景', alt: 'bad\u0000' })
      .expect(400);
    expect(f.runner).not.toHaveBeenCalled();
  });
  it('binds one export to its plan, stores only private review references and recovers its ID with GET', async () => {
    const f = await fixture();
    const response = await f.agent
      .post(`/api/v1/books/${f.bookId}/illustrations/plan`)
      .set(header)
      .send({ chapterIndex: 0 })
      .expect(202);
    const planId = response.body.data.id;
    await complete(f, planId);
    const input = { prompt: '用户确认的私有雪景描述', alt: '山谷雪景' };
    const a = await f.agent
      .post(`/api/v1/illustrations/${planId}/generate`)
      .set(header)
      .send(input)
      .expect(202);
    const b = await f.agent
      .post(`/api/v1/illustrations/${planId}/generate`)
      .set('Idempotency-Key', 'different-key-0002')
      .send(input)
      .expect(202);
    expect(a.body.data.id).toBe(b.body.data.id);
    expect(a.body.data.prompt).toBe(input.prompt);
    const resumed = await f.agent
      .get(`/api/v1/illustrations/${planId}`)
      .expect(200);
    expect(resumed.body.data.exportId).toBe(a.body.data.id);
    await f.agent
      .post(`/api/v1/illustrations/${planId}/generate`)
      .set(header)
      .send({ ...input, prompt: '不同画面' })
      .expect(409);
    const metadata = await readFile(
      join(f.root, 'data/metadata/state.json'),
      'utf8',
    );
    expect(metadata).not.toContain(input.prompt);
    expect(f.runner).not.toHaveBeenCalled();
  });
  it('serves only completed owned PNG artifacts inline and blocks changed bytes', async () => {
    const f = await fixture();
    const p = await f.agent
      .post(`/api/v1/books/${f.bookId}/illustrations/plan`)
      .set(header)
      .send({ chapterIndex: 0 })
      .expect(202);
    const planId = p.body.data.id;
    await complete(f, planId);
    const e = await f.agent
      .post(`/api/v1/illustrations/${planId}/generate`)
      .set(header)
      .send({ prompt: '雪景', alt: '雪山' })
      .expect(202);
    await complete(f, e.body.data.id, true);
    const viewed = await f.agent
      .get(`/api/v1/illustrations/${e.body.data.id}`)
      .expect(200);
    const image = viewed.body.data.artifacts.image;
    const downloaded = await f.agent.get(image).expect(200);
    expect(downloaded.headers['content-type']).toContain('image/png');
    expect(downloaded.headers['content-disposition']).toBe('inline');
    expect(downloaded.headers['cache-control']).toBe('no-store');
    expect(downloaded.headers['x-content-type-options']).toBe('nosniff');
    await request(f.app.getHttpServer()).get(image).expect(404);
    expect(f.runner).not.toHaveBeenCalled();
  });
});
