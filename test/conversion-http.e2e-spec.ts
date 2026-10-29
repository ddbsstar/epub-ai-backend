import 'reflect-metadata';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import * as yazl from 'yazl';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/app-config.module.js';
import { validateEnvironment } from '../src/config/environment.js';
import { configureApp } from '../src/setup-app.js';
import { ConversionWorkerService } from '../src/business/conversion-worker.service.js';
import { ProcessingRepository } from '../src/processing/processing.repository.js';
import { LocalArtifactStorage } from '../src/business/artifact-storage.js';
import {
  conversionHash,
  conversionPricing,
  type ConversionProgress,
} from '../src/business/conversion.types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function epub() {
  const zip = new yazl.ZipFile();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on('data', (b: Buffer) => chunks.push(b));
    zip.outputStream.once('error', reject);
    zip.outputStream.once('end', () => resolve(Buffer.concat(chunks)));
  });
  const entries = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml':
      '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'OPS/book.opf':
      '<package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>测试双章</dc:title></metadata><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="a"/></spine></package>',
    'OPS/a.xhtml':
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>双章</title></head><body><h1 id="one">第一章</h1><p>雨后的山边有一座小石桥。</p><h1 id="two">第二章</h1><p>午后窗边的信纸安静地放着。</p></body></html>',
    'OPS/toc.ncx':
      '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="one"><navLabel><text>第一章</text></navLabel><content src="a.xhtml#one"/></navPoint><navPoint id="two"><navLabel><text>第二章</text></navLabel><content src="a.xhtml#two"/></navPoint></navMap></ncx>',
  };
  for (const [name, value] of Object.entries(entries))
    zip.addBuffer(Buffer.from(value), name, { compress: false });
  zip.end();
  return done;
}
async function fixture(enabled = true, extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'epub-conversion-http-'));
  const env = validateEnvironment({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PROCESSING_ENABLED: true,
    PROCESSING_DATA_DIR: join(root, 'data'),
    EPUBCHECK_JAR_PATH: join(root, 'test.jar'),
    PROCESSING_AI_ENABLED: enabled,
    QWEN_ENABLED: enabled,
    QWEN_API_KEY: enabled ? 'placeholder' : '',
    QWEN_BASE_URL: enabled ? 'https://example.com/v1' : '',
    QWEN_MODEL: enabled ? 'test' : '',
    IMAGE_GENERATION_ENABLED: enabled,
    VISUAL_REVIEW_ENABLED: enabled,
    IMAGE_API_KEY: enabled ? 'placeholder' : '',
    IMAGE_DATA_DIR: join(root, 'images'),
    ILLUSTRATION_BATCH_BUDGET_MICROS: 2000000,
    ...extra,
  });
  let progress: ConversionProgress | null = null;
  const worker = {
    handle: vi.fn(),
    readProgress: vi.fn(async () => progress),
    readBookArtPlan: vi.fn(async () => null),
  };
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AppConfig)
    .useValue({ get: (key: keyof typeof env) => env[key] })
    .overrideProvider(ConversionWorkerService)
    .useValue(worker)
    .compile();
  const app = module.createNestApplication<NestExpressApplication>({
    bodyParser: false,
  });
  configureApp(app);
  await app.init();
  cleanups.push(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const agent = request.agent(app.getHttpServer());
  const uploaded = await agent
    .post('/api/v1/uploads')
    .attach('file', await epub(), 'test.epub')
    .expect(201);
  const bookId = uploaded.body.data.bookId as string;
  const catalog = await agent
    .get(`/api/v1/books/${bookId}/chapters`)
    .expect(200);
  const data = catalog.body.data as {
    catalogId: string;
    sourceSha256: string;
    visualReview: { enabled: boolean; description: string };
    chapters: Array<{
      id: string;
      index: number;
      title: string;
      selectable: boolean;
      scope?: 'section' | 'chapter';
      sectionId?: string;
      parentChapterTitle?: string;
      boundaryKind?: string;
    }>;
    pricing: {
      enabled: boolean;
      perChapterUpperMicros: number;
      maxBudgetMicros: number;
      budgetEnforced: boolean;
      bookArtUpperMicros: number;
      perChapterReviewUpperMicros?: number;
    };
  };
  const input = {
    catalogId: data.catalogId,
    chapterIds: data.chapters.filter((ch) => ch.selectable).map((ch) => ch.id),
    maxCostMicros:
      data.chapters.filter((ch) => ch.selectable).length *
        data.pricing.perChapterUpperMicros +
      data.pricing.bookArtUpperMicros,
  };
  return {
    app,
    agent,
    bookId,
    data,
    input,
    worker,
    repository: app.get(ProcessingRepository),
    storage: app.get(LocalArtifactStorage),
    setProgress: (next: ConversionProgress) => {
      progress = next;
    },
  };
}
const header = { 'Idempotency-Key': 'conversion-request-0001' };
const passedReview = {
  status: 'PASSED' as const,
  summary: '画面符合要求',
  checks: (
    ['source', 'people', 'style', 'composition', 'artifacts'] as const
  ).map((aspect) => ({ aspect, result: 'PASS' as const, reason: '符合要求' })),
};
describe('owned multi-chapter conversion HTTP', () => {
  it('lists the real free catalog before any model configuration or task creation', async () => {
    const f = await fixture(false);
    expect(
      f.data.chapters.filter((ch) => !ch.selectable).map((ch) => ch.title),
    ).toEqual(['第一章', '第二章']);
    expect(f.data.chapters.filter((ch) => ch.selectable)).toHaveLength(2);
    expect(
      f.data.chapters
        .filter((ch) => ch.selectable)
        .every((ch) => ch.scope === 'section' && ch.id === ch.sectionId),
    ).toBe(true);
    expect(f.data.pricing.enabled).toBe(false);
    expect(await f.repository.listDispatchable()).toEqual([]);
    expect(f.worker.handle).not.toHaveBeenCalled();
    await f.agent
      .post(`/api/v1/books/${f.bookId}/illustration-conversions`)
      .set(header)
      .send(f.input)
      .expect(503);
    expect(await f.repository.listDispatchable()).toEqual([]);
  });
  it('canonically deduplicates reordered selections and changed browser keys, with read-only recovery', async () => {
    const f = await fixture();
    const path = `/api/v1/books/${f.bookId}/illustration-conversions`;
    const a = await f.agent.post(path).set(header).send(f.input).expect(202);
    const b = await f.agent
      .post(path)
      .set('Idempotency-Key', 'conversion-request-0002')
      .send({ ...f.input, chapterIds: [...f.input.chapterIds].reverse() })
      .expect(202);
    expect(b.body.data.id).toBe(a.body.data.id);
    expect(a.body.data.chapters).toHaveLength(2);
    expect(a.body.data.budget.upperBoundMicros).toBe(f.input.maxCostMicros);
    await f.agent
      .get(`${path}/lookup`)
      .query({ requestKey: 'conversion-request-0001' })
      .expect(200)
      .expect((r) => {
        expect(r.body.data.id).toBe(a.body.data.id);
      });
    expect(await f.repository.listDispatchable()).toHaveLength(1);
    expect(f.worker.handle).not.toHaveBeenCalled();
  });
  it('creates a new versioned subsection operation for the same book and selection while keeping the old failed run readable', async () => {
    const f = await fixture();
    const book = (await f.repository.persistence.getBook(f.bookId))!;
    const selection = {
      catalogId: f.data.catalogId,
      sourceSha256: book.sourceHash,
      title: '测试双章',
      chapters: f.data.chapters
        .filter((chapter) => chapter.selectable)
        .map((chapter) => ({
          id: chapter.id,
          index: chapter.index,
          title: chapter.title,
          scope: 'section',
          sectionId: chapter.sectionId,
          parentChapterTitle: chapter.parentChapterTitle,
          placementMode: 'content-inline-v2',
        })),
    };
    const selectionKey = `conversion-selections/${book.id}/${conversionHash(selection)}.json`;
    const reference = await f.storage.storeJson(selectionKey, selection);
    const legacyHash = conversionHash({
      ownerId: book.ownerId,
      bookId: book.id,
      sourceHash: book.sourceHash,
      catalogId: f.data.catalogId,
      chapterIds: f.input.chapterIds,
      maxCostMicros: f.input.maxCostMicros,
      styleVersion: 'literary-v1',
      pipelineVersion: 'subsection-inline-4',
    });
    const oldPricing = conversionPricing(
      f.app.get(AppConfig),
      'subsection-inline-4',
    );
    const legacy = await f.repository.createRun({
      ownerId: book.ownerId,
      bookId: book.id,
      operation: 'illustration-conversion',
      idempotencyKey: `conversion:${legacyHash}`,
      requestHash: legacyHash,
      configuration: {
        catalogId: f.data.catalogId,
        sourceHash: book.sourceHash,
        selectionKey,
        selectionHash: reference.sha256,
        selectionByteSize: reference.byteSize,
        maxCostMicros: f.input.maxCostMicros,
        upperBoundMicros: 1000000,
        ...oldPricing,
        styleVersion: 'literary-v1',
        pipelineVersion: 'subsection-inline-4',
      },
      stages: ['convert', 'assemble'],
    });
    const [payload] = await f.repository.listDispatchable();
    const claimed = (await f.repository.claim(
      payload!,
      'isolated-test',
      30000,
    ))!;
    await f.repository.failStep(claimed.lease, 'CONVERSION_NO_IMAGES');
    const oldSnapshot = JSON.stringify(
      await f.repository.getRun(book.ownerId, legacy.run.id),
    );
    const created = await f.agent
      .post(`/api/v1/books/${book.id}/illustration-conversions`)
      .set(header)
      .send(f.input)
      .expect(202);
    expect(created.body.data.id).not.toBe(legacy.run.id);
    const current = await f.repository.getRun(
      book.ownerId,
      created.body.data.id as string,
    );
    expect(current.configuration).toMatchObject({
      pipelineVersion: 'subsection-inline-9',
      styleVersion: 'book-art-v1',
      bookArtPolicyVersion: 'book-art-direction-1',
      imageReviewMode: 'disabled',
      planningPolicy: 'content-people-1',
      bookArtUpperMicros: f.data.pricing.bookArtUpperMicros,
    });
    expect(current.configuration).not.toHaveProperty(
      'visualReviewPolicyVersion',
    );
    expect(created.body.data.imageReview.enabled).toBe(false);
    expect(current.steps.map((step) => step.stage)).toEqual([
      'art-plan',
      'convert',
      'assemble',
    ]);
    expect(created.body.data.artDirection).toBeUndefined();
    expect(created.body.data.bookArtPlan).toBeUndefined();
    expect(
      (current.configuration as { pricingHash: string }).pricingHash,
    ).not.toBe(oldPricing.pricingHash);
    await f.agent
      .get(`/api/v1/illustration-conversions/${legacy.run.id}`)
      .expect(200)
      .expect((r) => {
        expect(r.body.data.status).toBe('FAILED');
        expect(r.body.data.artDirection).toBeUndefined();
      });
    expect(
      JSON.stringify(await f.repository.getRun(book.ownerId, legacy.run.id)),
    ).toBe(oldSnapshot);
    expect(f.worker.handle).not.toHaveBeenCalled();
  });

  it('rejects duplicate, foreign and altered catalog IDs, under-budget and reused changed request keys before a paid job', async () => {
    const f = await fixture();
    const path = `/api/v1/books/${f.bookId}/illustration-conversions`;
    await f.agent
      .post(path)
      .set(header)
      .send({
        ...f.input,
        chapterIds: [f.input.chapterIds[0], f.input.chapterIds[0]],
      })
      .expect(400);
    await f.agent
      .post(path)
      .set(header)
      .send({ ...f.input, chapterIds: ['a'.repeat(64)] })
      .expect(409);
    await f.agent
      .post(path)
      .set(header)
      .send({ ...f.input, catalogId: 'b'.repeat(64) })
      .expect(409);
    await f.agent
      .post(path)
      .set('Idempotency-Key', 'under-budget-request')
      .send({ ...f.input, maxCostMicros: 1 })
      .expect(409);
    expect(await f.repository.listDispatchable()).toHaveLength(0);
    await f.agent.post(path).set(header).send(f.input).expect(202);
    await f.agent
      .post(path)
      .set(header)
      .send({ ...f.input, chapterIds: [f.input.chapterIds[0]] })
      .expect(409);
  });
  it('removes monetary admission caps only when explicitly configured, keeping real subsection selection', async () => {
    const f = await fixture(true, {
      BUDGET_LIMITS_ENABLED: false,
      ILLUSTRATION_BATCH_BUDGET_MICROS: 1,
    });
    expect(f.data.pricing.budgetEnforced).toBe(false);
    const created = await f.agent
      .post(`/api/v1/books/${f.bookId}/illustration-conversions`)
      .set(header)
      .send({ ...f.input, maxCostMicros: 1 })
      .expect(202);
    expect(created.body.data.budget.enforced).toBe(false);
    expect(created.body.data.budget.upperBoundMicros).toBe(
      f.input.maxCostMicros,
    );
    expect(
      created.body.data.chapters.every(
        (ch: { scope: string }) => ch.scope === 'section',
      ),
    ).toBe(true);
    expect(f.worker.handle).not.toHaveBeenCalled();
    await f.agent
      .post(`/api/v1/books/${f.bookId}/illustration-conversions`)
      .set('Idempotency-Key', 'invalid-parent-row')
      .send({ ...f.input, chapterIds: [f.data.chapters[0]!.id] })
      .expect(409);
  });

  it('does not expose catalogs, batches or image previews to another owner or hostile origin', async () => {
    const f = await fixture();
    const created = await f.agent
      .post(`/api/v1/books/${f.bookId}/illustration-conversions`)
      .set(header)
      .send(f.input)
      .expect(202);
    await request(f.app.getHttpServer())
      .get(`/api/v1/books/${f.bookId}/chapters`)
      .expect(404);
    await request(f.app.getHttpServer())
      .get(`/api/v1/illustration-conversions/${created.body.data.id}`)
      .expect(404);
    await f.agent
      .get(`/api/v1/books/${f.bookId}/chapters`)
      .set('Origin', 'https://hostile.example')
      .expect(403);
  });
  it('serves hash-verified progress images privately and blocks a changed image', async () => {
    const f = await fixture();
    const created = await f.agent
      .post(`/api/v1/books/${f.bookId}/illustration-conversions`)
      .set(header)
      .send(f.input)
      .expect(202);
    const id = created.body.data.id as string;
    const ch = f.data.chapters.find((entry) => entry.selectable)!;
    const key = `conversion-assets/${'a'.repeat(64)}/${'b'.repeat(64)}.png`;
    const meta = await f.storage.storeStream(
      key,
      Readable.from(Buffer.from('private-png')),
      100,
    );
    f.setProgress({
      schemaVersion: 1,
      sourceSha256: f.data.sourceSha256,
      catalogId: f.data.catalogId,
      chapters: f.data.chapters
        .filter((entry) => entry.selectable)
        .map((c) => ({
          id: c.id,
          index: c.index,
          title: c.title,
          scope: 'section' as const,
          sectionId: c.sectionId,
          parentChapterTitle: c.parentChapterTitle,
          placementMode: 'content-inline-v2' as const,
          status: c.id === ch.id ? 'SUCCEEDED' : 'WAITING',
          errorCode: null,
          image:
            c.id === ch.id
              ? {
                  storageKey: key,
                  ...meta,
                  width: 1,
                  height: 1,
                  callId: '0209bdbb-c19a-4b41-9ca3-6a01675d8a7b',
                }
              : null,
          anchor: null,
          alt: null,
        })),
    });
    const imagePath = `/api/v1/illustration-conversions/${id}/chapters/${ch.id}/image`;
    await f.agent
      .get(imagePath)
      .expect(200)
      .expect('content-type', /image\/png/)
      .expect('cache-control', /no-store/);
    await request(f.app.getHttpServer()).get(imagePath).expect(404);
    await writeFile(f.storage.path(key), Buffer.from('changed-png'));
    await f.agent.get(imagePath).expect(409);
  });
  it('admits new unreviewed conversions without visual configuration or visual-review costs', async () => {
    const f = await fixture(true, { VISUAL_REVIEW_ENABLED: false });
    expect(f.data.pricing.enabled).toBe(true);
    expect(f.data.visualReview.enabled).toBe(false);
    expect(f.data.pricing.perChapterReviewUpperMicros).toBeUndefined();
    expect(f.data.pricing.perChapterUpperMicros).toBe(500000);
    const created = await f.agent
      .post(`/api/v1/books/${f.bookId}/illustration-conversions`)
      .set(header)
      .send(f.input)
      .expect(202);
    expect(created.body.data.imageReview).toEqual(f.data.visualReview);
    expect(await f.repository.listDispatchable()).toHaveLength(1);
    expect(f.worker.handle).not.toHaveBeenCalled();
  });
  it('exposes safe rejection reasons and a report-only completion without leaking private review references', async () => {
    const f = await fixture();
    const created = await f.agent
      .post(`/api/v1/books/${f.bookId}/illustration-conversions`)
      .set(header)
      .send(f.input)
      .expect(202);
    const id = created.body.data.id as string;
    // An isolated historical V8 fixture exercises read compatibility; no real
    // persisted task is migrated from or to the new policy.
    await f.repository.persistence.mutateRun(id, (run) => {
      if (
        !run.configuration ||
        typeof run.configuration !== 'object' ||
        Array.isArray(run.configuration)
      )
        throw new Error('Expected isolated conversion configuration');
      const configuration = { ...run.configuration };
      delete configuration.imageReviewMode;
      run.configuration = {
        ...configuration,
        pipelineVersion: 'subsection-inline-8',
        visualReviewPolicyVersion: 'visual-review-1',
      };
      return { result: null, mutation: { run } };
    });
    const rejectedReview = {
      ...passedReview,
      status: 'REJECTED' as const,
      summary: '图片加入了无依据人物',
      checks: passedReview.checks.map((check, index) => ({
        ...check,
        result: index === 0 ? ('FAIL' as const) : ('PASS' as const),
      })),
    };
    f.setProgress({
      schemaVersion: 1,
      sourceSha256: f.data.sourceSha256,
      catalogId: f.data.catalogId,
      chapters: f.data.chapters
        .filter((chapter) => chapter.selectable)
        .map((chapter) => ({
          id: chapter.id,
          index: chapter.index,
          title: chapter.title,
          scope: 'section',
          sectionId: chapter.sectionId,
          parentChapterTitle: chapter.parentChapterTitle,
          placementMode: 'content-inline-v2',
          status: 'REJECTED',
          errorCode: 'VISUAL_REVIEW_REJECTED',
          image: null,
          anchor: null,
          alt: null,
          sourcePlanHash: 'c'.repeat(64),
          visualReview: rejectedReview,
          visualReviewReference: {
            storageKey: `runs/${id}/private-review.json`,
            sha256: 'd'.repeat(64),
            byteSize: 1000,
          },
        })),
    });
    const book = (await f.repository.persistence.getBook(f.bookId))!;
    const reportKey = `runs/${id}/quality-report.json`;
    const description = await f.storage.storeJson(reportKey, {
      insertedIllustrations: 0,
    });
    for (let index = 0; index < 3; index += 1) {
      const [payload] = await f.repository.listDispatchable();
      const claimed = (await f.repository.claim(payload!, 'test', 30000))!;
      await f.repository.completeStep(
        claimed.lease,
        {},
        {
          artifacts:
            index === 2
              ? [
                  {
                    storageKey: reportKey,
                    ...description,
                    mediaType: 'application/json',
                    kind: 'report',
                  },
                ]
              : undefined,
        },
      );
    }
    expect((await f.repository.getRun(book.ownerId, id)).status).toBe(
      'SUCCEEDED',
    );
    const result = await f.agent
      .get(`/api/v1/illustration-conversions/${id}`)
      .expect(200);
    expect(result.body.data).toMatchObject({
      status: 'SUCCEEDED',
      partial: true,
      counts: { completed: 2, succeeded: 0, rejected: 2 },
      artifacts: { epub: null },
    });
    expect(result.body.data.artifacts.report).toMatch(
      /^\/api\/v1\/artifacts\//,
    );
    expect(result.body.data.chapters[0]).toMatchObject({
      status: 'REJECTED',
      imageUrl: null,
      visualReview: rejectedReview,
    });
    expect(JSON.stringify(result.body.data)).not.toContain('private-review');
    expect(result.body.data.chapters[0].sourcePlanHash).toBeUndefined();
    await f.agent
      .get(
        `/api/v1/illustration-conversions/${id}/chapters/${f.input.chapterIds[0]}/image`,
      )
      .expect(404);
    expect(f.worker.handle).not.toHaveBeenCalled();
  });
});
