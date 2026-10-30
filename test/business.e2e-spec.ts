import 'reflect-metadata';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import * as yazl from 'yazl';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/app-config.module.js';
import { validateEnvironment } from '../src/config/environment.js';
import { configureApp } from '../src/setup-app.js';
import { ProcessingRepository } from '../src/processing/processing.repository.js';
import { BusinessProcessingHandler } from '../src/business/processing-handler.js';
import { LocalArtifactStorage } from '../src/business/artifact-storage.js';
import { AiService } from '../src/ai/ai.service.js';
import {
  EpubCheckService,
  assertNoNewFormatErrors,
  type FormatCheck,
} from '../src/business/epubcheck.service.js';

const cleanCheck: FormatCheck = {
  checkerVersion: 'test-double',
  errors: 0,
  warnings: 0,
  fatal: 0,
  errorSignatures: [],
};
const testPaths: string[] = [];

async function appForBusiness(ai = false, budgetMicros = 50000, beta = false) {
  const root = await mkdtemp(join(tmpdir(), 'epub-business-test-'));
  testPaths.push(root);
  const environment = validateEnvironment({
    NODE_ENV: beta ? 'production' : 'test',
    LOG_LEVEL: 'silent',
    PROCESSING_ENABLED: true,
    PROCESSING_DATA_DIR: join(root, 'data'),
    EPUBCHECK_JAR_PATH: join(root, 'test-only.jar'),
    PROCESSING_UPLOAD_MAX_MIB: 1,
    PROCESSING_AI_ENABLED: ai,
    QWEN_ENABLED: ai,
    QWEN_API_KEY: ai ? 'test-placeholder' : '',
    QWEN_BASE_URL: ai ? 'https://example.com/v1' : '',
    QWEN_MODEL: ai ? 'test-model' : '',
    AI_RUN_BUDGET_MICROS: budgetMicros,
    ...(beta
      ? {
          PROCESSING_PUBLIC_BETA_ENABLED: true,
          PROCESSING_ALLOWED_ORIGIN: 'https://epub.example.test',
        }
      : {}),
  });
  const fixture = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AppConfig)
    .useValue({ get: (key: keyof typeof environment) => environment[key] })
    .overrideProvider(EpubCheckService)
    .useValue({ check: vi.fn().mockResolvedValue(cleanCheck) })
    .compile();
  const app = fixture.createNestApplication<NestExpressApplication>({
    bodyParser: false,
  });
  configureApp(app);
  await app.init();
  return { app, root, agent: request.agent(app.getHttpServer()) };
}

async function makeBook(
  root: string,
  brokenReference = false,
  englishBody?: string,
) {
  const file = join(root, `${randomUUID()}.epub`);
  const zip = new yazl.ZipFile();
  const written = pipeline(zip.outputStream, createWriteStream(file));
  const entries = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml':
      '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="text/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'text/book.opf':
      '<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:uuid:7ae2d936-89f0-487a-859e-1c34bd596f2f</dc:identifier><dc:title>自建验证书</dc:title><dc:language>zh-CN</dc:language><meta property="dcterms:modified">2026-10-20T00:00:00Z</meta></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="chapter"/></spine></package>',
    'text/chapter.xhtml': `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>自建验证</title></head><body><h1 id="chapter">第一章</h1><p>这是用于测试的自建文字，不涉及用户书籍。 English spaces stay intact.${brokenReference ? '<a href="missing.xhtml">未找到的引用</a>' : ''}</p></body></html>`,
    'text/nav.xhtml':
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml#chapter">第一章</a></li></ol></nav></body></html>',
  };
  if (englishBody) {
    entries['text/chapter.xhtml'] =
      `<html xmlns="http://www.w3.org/1999/xhtml" lang="en"><head><title>Original English regression</title></head>${englishBody}</html>`;
    entries['text/book.opf'] = entries['text/book.opf'].replace('zh-CN', 'en');
  }
  for (const [name, value] of Object.entries(entries))
    zip.addBuffer(Buffer.from(value), name, { compress: name !== 'mimetype' });
  zip.end();
  await written;
  return file;
}

afterEach(async () => {
  for (const path of testPaths.splice(0))
    await rm(path, { recursive: true, force: true });
});

describe('local EPUB business HTTP boundary', () => {
  it('isolates public beta owners, requires HTTPS proxy and same-origin writes, and blocks old paid surfaces', async () => {
    const { app, root } = await appForBusiness(false, 50000, true);
    const origin = 'https://epub.example.test';
    const publicGet = (path: string) =>
      request(app.getHttpServer())
        .get(path)
        .set('Host', 'epub.example.test')
        .set('X-Forwarded-Proto', 'https');
    const publicPost = (path: string) =>
      request(app.getHttpServer())
        .post(path)
        .set('Host', 'epub.example.test')
        .set('X-Forwarded-Proto', 'https')
        .set('Origin', origin);
    try {
      await request(app.getHttpServer())
        .get('/api/v1/capabilities')
        .set('Host', 'epub.example.test')
        .expect(403);
      await publicPost('/api/v1/uploads')
        .set('Origin', 'https://other.example.test')
        .expect(403);
      await publicPost('/api/v1/uploads').unset('Origin').expect(403);
      await publicGet('/api/v1/capabilities')
        .set('Sec-Fetch-Site', 'cross-site')
        .expect(403);
      const capabilities = await publicGet('/api/v1/capabilities').expect(200);
      expect(capabilities.body.data).toEqual({
        typographyOnly: true,
        feedbackAvailable: false,
        feedbackRetentionHours: null,
        uploadMaxMiB: 1,
        retentionHours: 24,
      });
      const cookieHeader = capabilities.headers[
        'set-cookie'
      ] as unknown as string[];
      expect(cookieHeader[0]).toMatch(
        /^__Host-epub_beta_session=[a-f0-9]{64}; Path=\/; Secure; HttpOnly; SameSite=Strict/,
      );
      const ownerCookie = cookieHeader[0]!.split(';')[0]!;
      const uploaded = await publicPost('/api/v1/uploads')
        .set('Cookie', ownerCookie)
        .attach('file', await makeBook(root))
        .expect(201);
      const bookId = String(uploaded.body.data.bookId);
      const posted = await publicPost(`/api/v1/books/${bookId}/exports`)
        .set('Cookie', ownerCookie)
        .set('Idempotency-Key', randomUUID())
        .send({ theme: 'reader-editorial' })
        .expect(202);
      const runId = String(posted.body.data.id);
      await publicGet(`/api/v1/runs/${runId}`).expect(404);
      await publicPost(`/api/v1/runs/${runId}/cancel`).expect(404);
      await publicGet(`/api/v1/runs/${runId}`)
        .set('Cookie', ownerCookie)
        .expect(200);
      const stored = await app
        .get(ProcessingRepository)
        .persistence.getRun(runId);
      expect(stored?.configuration).toMatchObject({
        theme: 'reader-editorial',
        ai: false,
      });
      expect(stored?.steps.map((step) => step.stage)).toEqual([
        'process',
        'validate',
        'publish',
      ]);
      await publicPost(`/api/v1/books/${bookId}/exports`)
        .set('Cookie', ownerCookie)
        .set('Idempotency-Key', randomUUID())
        .send({ theme: 'reader-first' })
        .expect(403);
      await publicGet(`/api/v1/books/${bookId}/chapters`)
        .set('Cookie', ownerCookie)
        .expect(404);
      const repository = app.get(ProcessingRepository);
      const handler = app.get(BusinessProcessingHandler);
      for (let stage = 0; stage < 3; stage++) {
        const claimed = (await repository.claim(
          (await repository.listDispatchable())[0]!,
          'public-beta-test-worker',
        ))!;
        const output = await handler.handle({
          ...claimed,
          signal: new AbortController().signal,
        });
        expect(
          await repository.completeStep(claimed.lease, output.result, {
            artifacts: output.artifacts,
          }),
        ).toBe(true);
      }
      const done = await publicGet(`/api/v1/runs/${runId}`)
        .set('Cookie', ownerCookie)
        .expect(200);
      expect(done.body.data.status).toBe('SUCCEEDED');
      await publicGet(String(done.body.data.artifacts.epub)).expect(404);
      await publicGet(String(done.body.data.artifacts.epub))
        .set('Cookie', ownerCookie)
        .expect(200);
      for (let index = 1; index < 5; index++)
        await publicPost('/api/v1/uploads')
          .set('Cookie', ownerCookie)
          .attach('file', await makeBook(root))
          .expect(201);
      const limit = await publicPost('/api/v1/uploads')
        .set('Cookie', ownerCookie)
        .attach('file', await makeBook(root))
        .expect(429);
      expect(limit.body.error.code).toBe('OWNER_BOOK_LIMIT');
    } finally {
      await app.close();
    }
  });
  it('does not overwrite or delete immutable storage on duplicate writes', async () => {
    const { app } = await appForBusiness();
    try {
      const storage = app.get(LocalArtifactStorage);
      await storage.storeStream(
        'test/existing.epub',
        Readable.from(Buffer.from('original')),
        100,
      );
      await expect(
        storage.storeStream(
          'test/existing.epub',
          Readable.from(Buffer.from('replacement')),
          100,
        ),
      ).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await readFile(storage.path('test/existing.epub'), 'utf8')).toBe(
        'original',
      );
      await storage.storeJson('test/report.json', { version: 'original' });
      await expect(
        storage.storeJson('test/report.json', { version: 'replacement' }),
      ).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await storage.readJson('test/report.json')).toEqual({
        version: 'original',
      });
    } finally {
      await app.close();
    }
  });

  it('keeps reader-editorial deterministic even when model access is enabled and freezes a distinct recoverable request', async () => {
    const { app, root, agent } = await appForBusiness(true);
    const model = vi.spyOn(app.get(AiService), 'completeStructure');
    try {
      const uploaded = await agent
        .post('/api/v1/uploads')
        .attach('file', await makeBook(root))
        .expect(201);
      const endpoint = `/api/v1/books/${uploaded.body.data.bookId}/exports`;
      await agent
        .post(endpoint)
        .set('Idempotency-Key', randomUUID())
        .send({ theme: 'reader-editorial', ai: true })
        .expect(400);
      const key = randomUUID();
      const created = await agent
        .post(endpoint)
        .set('Idempotency-Key', key)
        .send({ theme: 'reader-editorial' })
        .expect(202);
      const retried = await agent
        .post(endpoint)
        .set('Idempotency-Key', key)
        .send({ theme: 'reader-editorial' })
        .expect(202);
      expect(retried.body.data.id).toBe(created.body.data.id);
      await agent
        .post(endpoint)
        .set('Idempotency-Key', key)
        .send({ theme: 'reader-first' })
        .expect(409);
      const repository = app.get(ProcessingRepository);
      const handler = app.get(BusinessProcessingHandler);
      for (const expectedStage of ['process', 'validate', 'publish']) {
        const claimed = (await repository.claim(
          (await repository.listDispatchable())[0]!,
          'editorial-test',
        ))!;
        expect(claimed.step.stage).toBe(expectedStage);
        expect(claimed.run.configuration).toMatchObject({
          theme: 'reader-editorial',
          typographyProfile: 'editorial-1',
          ai: false,
        });
        const output = await handler.handle({
          ...claimed,
          signal: new AbortController().signal,
        });
        expect(
          await repository.completeStep(claimed.lease, output.result, {
            artifacts: output.artifacts,
          }),
        ).toBe(true);
      }
      const done = await agent
        .get(`/api/v1/runs/${created.body.data.id}`)
        .expect(200);
      expect(done.body.data).toMatchObject({
        status: 'SUCCEEDED',
        totalUnits: 3,
        ai: { status: 'DISABLED' },
        summary: { typography: { profile: 'editorial-1' } },
      });
      expect(model).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('publishes an English book with paragraph and hr separators through the real process, validation and publish handler', async () => {
    const { app, root, agent } = await appForBusiness();
    try {
      const retainedError = {
        ...cleanCheck,
        errors: 1,
        errorSignatures: ['unchanged-source-format-issue'],
      };
      vi.spyOn(app.get(EpubCheckService), 'check').mockResolvedValue(
        retainedError,
      );
      const source =
        '<body class="x-ebookmaker x-ebookmaker-2"><div class="chapter"><h2 id="chapter">Chapter I</h2><p>First original paragraph.</p><p class="asterism">* * *<br/>* *</p><p>A new scene.</p><hr/><p>After a rule.</p></div></body>';
      const uploaded = await agent
        .post('/api/v1/uploads')
        .attach('file', await makeBook(root, false, source))
        .expect(201);
      const created = await agent
        .post(`/api/v1/books/${uploaded.body.data.bookId}/exports`)
        .set('Idempotency-Key', randomUUID())
        .send({ theme: 'reader-editorial' })
        .expect(202);
      const repository = app.get(ProcessingRepository);
      const handler = app.get(BusinessProcessingHandler);
      for (const stage of ['process', 'validate', 'publish']) {
        const claimed = (await repository.claim(
          (await repository.listDispatchable())[0]!,
          'english-separator-test',
        ))!;
        expect(claimed.step.stage).toBe(stage);
        const result = await handler.handle({
          ...claimed,
          signal: new AbortController().signal,
        });
        expect(
          await repository.completeStep(claimed.lease, result.result, {
            artifacts: result.artifacts,
          }),
        ).toBe(true);
      }
      const done = await agent
        .get(`/api/v1/runs/${created.body.data.id}`)
        .expect(200);
      expect(done.body.data.status).toBe('SUCCEEDED');
      expect(done.body.data.summary).toMatchObject({
        formatErrors: 1,
        typography: {
          totalParagraphs: 4,
          styledParagraphs: 4,
          preservedParagraphs: 0,
          styledSeparatorParagraphs: 1,
          roleCounts: { opening: 3, body: 0, separator: 2 },
        },
      });
      expect(done.body.data.warnings).toContain(
        '1 pre-existing source format error(s) remain; this export introduces no new format errors.',
      );
      const downloaded = await agent
        .get(String(done.body.data.artifacts.report))
        .expect(200);
      const report =
        typeof downloaded.body?.summary === 'object'
          ? downloaded.body
          : JSON.parse(downloaded.text);
      expect(report.summary.typography.styledSeparatorParagraphs).toBe(1);
      expect(
        report.engine.documents[0].editorial.styledSeparatorParagraphs,
      ).toBe(1);
      expect(report.engine.typography.roleCounts.separator).toBe(2);
      await agent.get(String(done.body.data.artifacts.epub)).expect(200);
    } finally {
      await app.close();
    }
  });

  it('fails a storage-stream error promptly without exposing its message', async () => {
    const { app, agent } = await appForBusiness();
    try {
      vi.spyOn(
        app.get(LocalArtifactStorage),
        'storeStream',
      ).mockRejectedValueOnce(new Error('private-disk-marker'));
      const failed = await agent
        .post('/api/v1/uploads')
        .attach('file', Buffer.from('PK-fake-content'), 'book.epub')
        .timeout(3000)
        .expect(503);
      expect(failed.body.error.code).toBe('UPLOAD_STORAGE_ERROR');
      expect(JSON.stringify(failed.body)).not.toContain('private-disk-marker');
    } finally {
      await app.close();
    }
  });

  it('runs upload → idempotent background stages → verified private download', async () => {
    const { app, root, agent } = await appForBusiness();
    try {
      const book = await makeBook(root);
      const uploaded = await agent
        .post('/api/v1/uploads')
        .attach('file', book)
        .expect(201);
      expect(uploaded.body.data).toMatchObject({
        byteSize: (await readFile(book)).length,
      });
      const key = randomUUID();
      const endpoint = `/api/v1/books/${uploaded.body.data.bookId}/exports`;
      const created = await agent
        .post(endpoint)
        .set('Idempotency-Key', key)
        .send({ theme: 'reader-first' })
        .expect(202);
      const retried = await agent
        .post(endpoint)
        .set('Idempotency-Key', key)
        .send({ theme: 'reader-first' })
        .expect(202);
      expect(retried.body.data.id).toBe(created.body.data.id);
      expect(created.body.data.artifacts.epub).toBeNull();
      await request(app.getHttpServer())
        .get(`/api/v1/runs/${created.body.data.id}`)
        .expect(404);
      const repository = app.get(ProcessingRepository);
      const handler = app.get(BusinessProcessingHandler);
      for (let stage = 0; stage < 3; stage += 1) {
        const payload = (await repository.listDispatchable())[0]!;
        const claimed = (await repository.claim(payload, 'test-worker'))!;
        const output = await handler.handle({
          ...claimed,
          signal: new AbortController().signal,
        });
        expect(
          await repository.completeStep(claimed.lease, output.result, {
            artifacts: output.artifacts,
          }),
        ).toBe(true);
      }
      const done = await agent
        .get(`/api/v1/runs/${created.body.data.id}`)
        .expect(200);
      expect(done.body.data).toMatchObject({
        status: 'SUCCEEDED',
        completedUnits: 3,
        totalUnits: 3,
        summary: { chapters: 1, bodyBytesPreserved: true, formatErrors: 0 },
      });
      const download = await agent
        .get(done.body.data.artifacts.epub)
        .buffer(true)
        .parse((response, done) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.once('end', () => done(null, Buffer.concat(chunks)));
          response.once('error', done);
        })
        .expect(200);
      expect(download.headers['content-type']).toContain(
        'application/epub+zip',
      );
      expect(download.headers['content-disposition']).toContain('attachment');
      expect(download.body.subarray(0, 2).toString()).toBe('PK');
      await request(app.getHttpServer())
        .get(done.body.data.artifacts.epub)
        .expect(404);
      const report = await agent
        .get(done.body.data.artifacts.report)
        .expect(200);
      expect(report.body).toMatchObject({
        aiUsed: false,
        summary: { bodyBytesPreserved: true },
      });
    } finally {
      await app.close();
    }
  });

  it('rejects invalid upload, oversized file, extra fields and untrusted Origin without saving a book', async () => {
    const { app, root, agent } = await appForBusiness();
    try {
      const bad = await agent
        .post('/api/v1/uploads')
        .attach('file', Buffer.from('private-body-marker'), 'bad.epub')
        .expect(400);
      expect(bad.body.error.code).toBe('INVALID_EPUB');
      expect(JSON.stringify(bad.body)).not.toContain('private-body-marker');
      await agent
        .post('/api/v1/uploads')
        .send({ file: 'not-multipart' })
        .expect(400);
      await agent
        .post('/api/v1/uploads')
        .attach('file', Buffer.alloc(1024 * 1024 + 1), 'big.epub')
        .expect(413);
      await agent
        .post('/api/v1/uploads')
        .field('ownerId', 'someone-else')
        .expect(400);
      await agent
        .post('/api/v1/uploads')
        .set('Origin', 'https://unexpected.example')
        .attach('file', Buffer.from('PK'), 'x.epub')
        .expect(403);
      expect(await readdir(join(root, 'data', 'sources'))).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('adopts a validated AI plan through all stages and reports the single persisted call', async () => {
    const { app, root, agent } = await appForBusiness(true);
    const model = vi
      .spyOn(app.get(AiService), 'completeStructure')
      .mockImplementation((messages) => {
        const input = JSON.parse(
          messages.find((message) => message.role === 'user')!.content,
        ) as { blocks: { id: string }[] };
        return Promise.resolve({
          content: JSON.stringify({
            roles: input.blocks.map((block) => ({
              id: block.id,
              role: 'quote',
            })),
          }),
          finishReason: 'stop',
          usage: { inputTokens: 128, outputTokens: 64, totalTokens: 192 },
        });
      });
    try {
      const book = await makeBook(root);
      const uploaded = (
        await agent.post('/api/v1/uploads').attach('file', book).expect(201)
      ).body.data;
      const key = randomUUID();
      const endpoint = `/api/v1/books/${uploaded.bookId}/exports`;
      const created = (
        await agent
          .post(endpoint)
          .set('Idempotency-Key', key)
          .send({ theme: 'reader-first' })
          .expect(202)
      ).body.data;
      expect(created.ai.status).toBe('PENDING');
      expect(created.totalUnits).toBe(4);
      const repository = app.get(ProcessingRepository);
      for (let index = 0; index < 4; index++) {
        const claimed = (await repository.claim(
          (await repository.listDispatchable())[0]!,
          'test-ai-worker',
        ))!;
        const outcome = await app
          .get(BusinessProcessingHandler)
          .handle({ ...claimed, signal: new AbortController().signal });
        expect(
          await repository.completeStep(claimed.lease, outcome.result, {
            artifacts: outcome.artifacts,
          }),
        ).toBe(true);
      }
      const done = (await agent.get(`/api/v1/runs/${created.id}`).expect(200))
        .body.data;
      expect(done).toMatchObject({
        status: 'SUCCEEDED',
        ai: {
          status: 'APPLIED',
          sampledBlocks: 1,
          appliedBlocks: 1,
          usage: { totalTokens: 192 },
        },
      });
      const report = (await agent.get(done.artifacts.report).expect(200)).body;
      expect(report).toMatchObject({
        aiUsed: true,
        modelCall: { status: 'SUCCEEDED', budgetDisposition: 'SETTLED' },
        summary: { bodyBytesPreserved: true },
        engine: { structure: { planned: true, roleCounts: { quote: 1 } } },
      });
      const retried = (
        await agent
          .post(endpoint)
          .set('Idempotency-Key', key)
          .send({ theme: 'reader-first' })
          .expect(202)
      ).body.data;
      expect(retried.id).toBe(created.id);
      expect(model).toHaveBeenCalledTimes(1);
    } finally {
      model.mockRestore();
      await app.close();
    }
  });

  it('publishes rule output after an invalid AI response without releasing the uncertain cost', async () => {
    const { app, root, agent } = await appForBusiness(true);
    const model = vi
      .spyOn(app.get(AiService), 'completeStructure')
      .mockResolvedValue({ content: '{"roles":[]}', finishReason: 'stop' });
    try {
      const uploaded = (
        await agent
          .post('/api/v1/uploads')
          .attach('file', await makeBook(root))
          .expect(201)
      ).body.data;
      const created = (
        await agent
          .post(`/api/v1/books/${uploaded.bookId}/exports`)
          .set('Idempotency-Key', randomUUID())
          .send({ theme: 'reader-first' })
          .expect(202)
      ).body.data;
      const repository = app.get(ProcessingRepository);
      for (let index = 0; index < 4; index++) {
        const claimed = (await repository.claim(
          (await repository.listDispatchable())[0]!,
          'test-ai-fallback',
        ))!;
        const outcome = await app
          .get(BusinessProcessingHandler)
          .handle({ ...claimed, signal: new AbortController().signal });
        expect(
          await repository.completeStep(claimed.lease, outcome.result, {
            artifacts: outcome.artifacts,
          }),
        ).toBe(true);
      }
      const done = (await agent.get(`/api/v1/runs/${created.id}`).expect(200))
        .body.data;
      expect(done).toMatchObject({
        status: 'SUCCEEDED',
        ai: {
          status: 'FALLBACK',
          reasonCode: 'AI_INVALID_PLAN',
          appliedBlocks: 0,
          estimatedCostMicros: null,
        },
      });
      const report = (await agent.get(done.artifacts.report).expect(200)).body;
      expect(report).toMatchObject({
        aiUsed: false,
        modelCall: { status: 'UNKNOWN', budgetDisposition: 'HELD' },
      });
      expect(model).toHaveBeenCalledTimes(1);
    } finally {
      model.mockRestore();
      await app.close();
    }
  });

  it('blocks a paid call before sending when the run budget cannot cover the reservation', async () => {
    const { app, root, agent } = await appForBusiness(true, 1);
    const model = vi.spyOn(app.get(AiService), 'completeStructure');
    try {
      const uploaded = (
        await agent
          .post('/api/v1/uploads')
          .attach('file', await makeBook(root))
          .expect(201)
      ).body.data;
      await agent
        .post(`/api/v1/books/${uploaded.bookId}/exports`)
        .set('Idempotency-Key', randomUUID())
        .send({ theme: 'reader-first' })
        .expect(202);
      const repository = app.get(ProcessingRepository);
      const claimed = (await repository.claim(
        (await repository.listDispatchable())[0]!,
        'test-budget-worker',
      ))!;
      const outcome = await app
        .get(BusinessProcessingHandler)
        .handle({ ...claimed, signal: new AbortController().signal });
      expect(outcome.result).toMatchObject({
        ai: { status: 'FALLBACK', reasonCode: 'AI_RUN_BUDGET_EXCEEDED' },
        plan: null,
      });
      expect(model).not.toHaveBeenCalled();
    } finally {
      model.mockRestore();
      await app.close();
    }
  });

  it('rejects broken internal resources before making a paid request', async () => {
    const { app, root, agent } = await appForBusiness(true);
    const model = vi.spyOn(app.get(AiService), 'completeStructure');
    try {
      const uploaded = (
        await agent
          .post('/api/v1/uploads')
          .attach('file', await makeBook(root, true))
          .expect(201)
      ).body.data;
      await agent
        .post(`/api/v1/books/${uploaded.bookId}/exports`)
        .set('Idempotency-Key', randomUUID())
        .send({ theme: 'reader-first' })
        .expect(202);
      const repository = app.get(ProcessingRepository);
      const claimed = (await repository.claim(
        (await repository.listDispatchable())[0]!,
        'test-invalid-worker',
      ))!;
      await expect(
        app
          .get(BusinessProcessingHandler)
          .handle({ ...claimed, signal: new AbortController().signal }),
      ).rejects.toMatchObject({ code: 'MISSING_RESOURCE' });
      expect(model).not.toHaveBeenCalled();
    } finally {
      model.mockRestore();
      await app.close();
    }
  });

  it('rejects rebinding authorities even when their Origin matches Host', async () => {
    const { app, agent } = await appForBusiness();
    try {
      for (const host of [
        'attacker.example:3000',
        '127.0.0.1.attacker.example:3000',
        'localhost:99999',
      ]) {
        const rejected = await agent
          .post('/api/v1/uploads')
          .set('Host', host)
          .set('Origin', `http://${host}`)
          .attach('file', Buffer.from('PK'), 'test.epub')
          .expect(403);
        expect(rejected.body.error.code).toBe('LOCAL_ACCESS_ONLY');
        expect(rejected.headers['set-cookie']).toBeUndefined();
      }
    } finally {
      await app.close();
    }
  });

  it('does not publish cancelled work or expose foreign books; rejects conflicting idempotency', async () => {
    const { app, root, agent } = await appForBusiness();
    try {
      const file = await makeBook(root);
      const first = (
        await agent.post('/api/v1/uploads').attach('file', file).expect(201)
      ).body.data;
      const second = (
        await agent.post('/api/v1/uploads').attach('file', file).expect(201)
      ).body.data;
      const key = randomUUID();
      const run = (
        await agent
          .post(`/api/v1/books/${first.bookId}/exports`)
          .set('Idempotency-Key', key)
          .send({ theme: 'reader-first' })
          .expect(202)
      ).body.data;
      await agent
        .post(`/api/v1/books/${second.bookId}/exports`)
        .set('Idempotency-Key', key)
        .send({ theme: 'reader-first' })
        .expect(409);
      await request(app.getHttpServer())
        .post(`/api/v1/books/${first.bookId}/exports`)
        .set('Idempotency-Key', randomUUID())
        .send({ theme: 'reader-first' })
        .expect(404);
      const cancelled = await agent
        .post(`/api/v1/runs/${run.id}/cancel`)
        .expect(200);
      expect(cancelled.body.data.status).toBe('CANCELLED');
      expect(await app.get(ProcessingRepository).listDispatchable()).toEqual(
        [],
      );
    } finally {
      await app.close();
    }
  });
});

describe('format comparison gate', () => {
  it('allows identified pre-existing issues but blocks new/fatal errors', () => {
    const old = { ...cleanCheck, errors: 1, errorSignatures: ['old'] };
    expect(() => assertNoNewFormatErrors(old, old)).not.toThrow();
    expect(() =>
      assertNoNewFormatErrors(old, { ...old, errorSignatures: ['new'] }),
    ).toThrow('VALIDATION_FAILED');
    expect(() =>
      assertNoNewFormatErrors(cleanCheck, { ...cleanCheck, fatal: 1 }),
    ).toThrow('VALIDATION_FAILED');
  });
});
