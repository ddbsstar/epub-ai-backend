import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  readdir,
  truncate,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/app-config.module.js';
import { validateEnvironment } from '../src/config/environment.js';
import { configureApp } from '../src/setup-app.js';
import { LocalFeedbackPersistence } from '../src/business/feedback-persistence.js';
import { FeedbackService } from '../src/business/feedback.service.js';

const paths: string[] = [];
const payload = {
  category: 'typography',
  reader: 'kindle',
  deliveryRoute: 'usb',
  rating: 'better',
};
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'epub-feedback-'));
  paths.push(root);
  return root;
}
async function application(root: string, enabled = true, processing = true) {
  const env = validateEnvironment({
    NODE_ENV: processing ? 'production' : 'test',
    LOG_LEVEL: 'silent',
    SWAGGER_ENABLED: false,
    PROCESSING_ENABLED: processing,
    PROCESSING_PUBLIC_BETA_ENABLED: processing,
    PROCESSING_FEEDBACK_ENABLED: enabled,
    PROCESSING_DATA_DIR: root,
    PROCESSING_UPLOAD_MAX_MIB: 1,
    PROCESSING_ALLOWED_ORIGIN: 'https://epub.example.test',
    EPUBCHECK_JAR_PATH: join(root, 'test-only.jar'),
  });
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AppConfig)
    .useValue({ get: (key: keyof typeof env) => env[key] })
    .compile();
  const app = module.createNestApplication<NestExpressApplication>({
    bodyParser: false,
  });
  configureApp(app);
  await app.init();
  return app;
}
const get = (app: NestExpressApplication, path = '/api/v1/capabilities') =>
  request(app.getHttpServer())
    .get(path)
    .set('Host', 'epub.example.test')
    .set('X-Forwarded-Proto', 'https');
const post = (
  app: NestExpressApplication,
  cookie: string,
  key: string = randomUUID(),
) =>
  request(app.getHttpServer())
    .post('/api/v1/feedback')
    .set('Host', 'epub.example.test')
    .set('X-Forwarded-Proto', 'https')
    .set('Origin', 'https://epub.example.test')
    .set('Cookie', cookie)
    .set('Idempotency-Key', key);
async function cookie(app: NestExpressApplication) {
  const r = await get(app).expect(200);
  return (r.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
}
afterEach(async () => {
  for (const path of paths.splice(0))
    await rm(path, { recursive: true, force: true });
});

describe('private feedback HTTP boundary', () => {
  it('defaults feedback off and rejects enabling unsupported adapters or disabled processing', () => {
    expect(validateEnvironment({}).PROCESSING_FEEDBACK_ENABLED).toBe(false);
    expect(() =>
      validateEnvironment({ PROCESSING_FEEDBACK_ENABLED: true }),
    ).toThrow();
    expect(() =>
      validateEnvironment({
        PROCESSING_FEEDBACK_ENABLED: true,
        PROCESSING_REPOSITORY: 'mysql',
      }),
    ).toThrow();
  });
  it('persists only user-chosen fields and a private scoped receipt across application restarts', async () => {
    const root = await directory();
    let app = await application(root);
    const key = randomUUID();
    let receipt: unknown;
    try {
      const caps = await get(app).expect(200);
      expect(caps.body.data).toMatchObject({
        feedbackAvailable: true,
        feedbackRetentionHours: 24,
      });
      const session = (
        caps.headers['set-cookie'] as unknown as string[]
      )[0]!.split(';')[0]!;
      const chosen = {
        ...payload,
        requestId: 'user-chosen-123',
        description: 'A deliberately submitted short note.',
      };
      const created = await post(app, session, key)
        .set('User-Agent', 'private-UA-marker')
        .send(chosen)
        .expect(201);
      receipt = created.body.data;
      expect(Object.keys(created.body.data).sort()).toEqual([
        'expiresAt',
        'receiptId',
      ]);
      expect(created.body.data.receiptId).toMatch(/^[a-f0-9-]{36}$/u);
      const state = JSON.parse(
        await readFile(join(root, 'feedback/state.json'), 'utf8'),
      );
      expect(state.records).toHaveLength(1);
      expect(state.records[0].payload).toEqual(chosen);
      for (const omitted of [
        session.split('=')[1]!,
        key,
        'private-UA-marker',
        'epub.example.test',
        'bookId',
        'originalName',
      ])
        expect(JSON.stringify(state)).not.toContain(omitted);
      expect(created.text).not.toContain(chosen.description);
      await app.close();
      app = await application(root);
      expect(
        (await post(app, session, key).send(chosen).expect(201)).body.data,
      ).toEqual(receipt);
      await post(app, session, key)
        .send({ ...chosen, rating: 'worse' })
        .expect(409);
      const another = await cookie(app);
      expect(
        (await post(app, another, key).send(chosen).expect(201)).body.data
          .receiptId,
      ).not.toEqual(created.body.data.receiptId);
      await get(app, '/api/v1/feedback').expect(404);
      await get(app, `/api/v1/feedback/${created.body.data.receiptId}`).expect(
        404,
      );
    } finally {
      await app.close();
    }
  });

  it('enforces owner quotas after idempotent replay and isolates fresh anonymous sessions', async () => {
    const root = await directory();
    const app = await application(root);
    try {
      const session = await cookie(app);
      const key = randomUUID();
      const first = (await post(app, session, key).send(payload).expect(201))
        .body.data;
      for (let i = 1; i < 5; i++)
        await post(app, session).send(payload).expect(201);
      expect(
        (await post(app, session).send(payload).expect(429)).body.error.code,
      ).toBe('FEEDBACK_OWNER_LIMIT');
      expect(
        (await post(app, session, key).send(payload).expect(201)).body.data,
      ).toEqual(first);
      await post(app, await cookie(app))
        .send(payload)
        .expect(201);
    } finally {
      await app.close();
    }
  });

  it('rejects foreign/missing origin, unknown fields, invalid enums, idempotency and oversized bodies without storing rejected input', async () => {
    const root = await directory();
    const app = await application(root);
    try {
      const session = await cookie(app);
      await post(app, session)
        .set('Origin', 'https://foreign.test')
        .send(payload)
        .expect(403);
      await post(app, session).unset('Origin').send(payload).expect(403);
      await post(app, session)
        .set('Sec-Fetch-Site', 'cross-site')
        .send(payload)
        .expect(403);
      for (const bad of [
        { ...payload, bookTitle: 'private-book-marker' },
        { ...payload, currentUrl: 'private-url-marker' },
        { ...payload, cookie: 'secret-cookie-marker' },
        { ...payload, category: 'unknown' },
        { ...payload, description: 'x'.repeat(1001) },
        { ...payload, requestId: 'has spaces' },
      ])
        expect(
          (await post(app, session).send(bad).expect(400)).body.error.code,
        ).toBe('INVALID_FEEDBACK');
      await post(app, session, 'not-a-uuid').send(payload).expect(400);
      await post(app, session)
        .send({ ...payload, description: 'x'.repeat(9000) })
        .expect(413);
      expect(
        JSON.parse(await readFile(join(root, 'feedback/state.json'), 'utf8'))
          .records,
      ).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('advertises disabled feedback truthfully yet removes expired records even when processing/feedback are disabled', async () => {
    const root = await directory();
    const now = Date.now() - 25 * 60 * 60 * 1000;
    const store = new LocalFeedbackPersistence(root, () => now);
    await store.initialize();
    await store.submit('a'.repeat(64), randomUUID(), payload);
    const app = await application(root, false, false);
    try {
      expect(app.get(FeedbackService).available()).toBe(false);
      expect(
        JSON.parse(await readFile(join(root, 'feedback/state.json'), 'utf8'))
          .records,
      ).toEqual([]);
    } finally {
      await app.close();
    }
    const enabledProcessing = await application(root, false);
    try {
      expect(
        (await get(enabledProcessing).expect(200)).body.data,
      ).toMatchObject({
        feedbackAvailable: false,
        feedbackRetentionHours: null,
      });
      expect(
        (
          await post(enabledProcessing, await cookie(enabledProcessing))
            .send(payload)
            .expect(503)
        ).body.error.code,
      ).toBe('FEEDBACK_DISABLED');
    } finally {
      await enabledProcessing.close();
    }
  });
  it('keeps feedback inside the existing beta storage admission and exposes only safe storage errors', async () => {
    const root = await directory();
    const app = await application(root);
    try {
      const session = await cookie(app);
      const sparse = join(root, 'capacity-test.bin');
      await writeFile(sparse, '');
      await truncate(sparse, 1024 * 1024 * 1024);
      expect(
        (await post(app, session).send(payload).expect(507)).body.error.code,
      ).toBe('STORAGE_CAPACITY_EXCEEDED');
      await rm(sparse);
      await writeFile(
        join(root, 'feedback/state.json'),
        'private-corrupt-state-marker',
      );
      const response = await post(app, session).send(payload).expect(503);
      expect(response.body.error.code).toBe('FEEDBACK_UNAVAILABLE');
      expect(response.text).not.toContain('private-corrupt-state-marker');
    } finally {
      await app.close();
    }
  });
});

describe('bounded feedback persistence', () => {
  it.skipIf(process.platform === 'win32')(
    'rejects a symbolic feedback state without modifying its target',
    async () => {
      const root = await directory();
      const store = new LocalFeedbackPersistence(root);
      await store.initialize();
      const target = join(root, 'unrelated-private.txt');
      await writeFile(target, 'unrelated');
      await rm(join(root, 'feedback/state.json'));
      await symlink(target, join(root, 'feedback/state.json'));
      await expect(
        store.submit('a'.repeat(64), randomUUID(), payload),
      ).rejects.toMatchObject({ payload: { code: 'FEEDBACK_UNAVAILABLE' } });
      expect(await readFile(target, 'utf8')).toBe('unrelated');
    },
  );
  it('serializes competing writers, keeps exact global bounds and preserves duplicate receipts at capacity', async () => {
    const root = await directory();
    const one = new LocalFeedbackPersistence(root, Date.now, {
      owner: 2,
      global: 3,
    });
    const two = new LocalFeedbackPersistence(root, Date.now, {
      owner: 2,
      global: 3,
    });
    await one.initialize();
    const key = randomUUID();
    const first = await one.submit('a'.repeat(64), key, payload);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        (i % 2 ? one : two).submit(
          (i % 2 ? 'b' : 'c').repeat(64),
          randomUUID(),
          payload,
        ),
      ),
    );
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(2);
    expect(await one.readForOperator()).toHaveLength(3);
    expect(await one.submit('a'.repeat(64), key, payload)).toEqual(first);
    await expect(
      one.submit('d'.repeat(64), randomUUID(), payload),
    ).rejects.toMatchObject({
      payload: { code: 'FEEDBACK_CAPACITY_EXCEEDED' },
    });
  });
  it('physically prunes exact 24h expiry and stale crash temporaries without removing the OS lock', async () => {
    const root = await directory();
    let now = Date.UTC(2026, 9, 30);
    const store = new LocalFeedbackPersistence(root, () => now);
    await store.initialize();
    const key = randomUUID();
    const first = await store.submit('a'.repeat(64), key, payload);
    expect(Date.parse(first.expiresAt) - now).toBe(24 * 60 * 60 * 1000);
    now += 24 * 60 * 60 * 1000 - 1;
    expect(await store.readForOperator()).toHaveLength(1);
    await writeFile(
      join(root, 'feedback', `.state-${randomUUID()}.tmp`),
      'uncommitted-note',
    );
    now++;
    await store.prune();
    expect(
      JSON.parse(await readFile(join(root, 'feedback/state.json'), 'utf8'))
        .records,
    ).toEqual([]);
    expect(await readdir(join(root, 'feedback'))).toContain(
      'state.lock.sqlite',
    );
    expect(
      (await readdir(join(root, 'feedback'))).some((name) =>
        name.endsWith('.tmp'),
      ),
    ).toBe(false);
    expect(
      (await store.submit('a'.repeat(64), key, payload)).receiptId,
    ).not.toBe(first.receiptId);
  });
  it('does not charge capacity checks on duplicate requests and does not persist rejected new submissions', async () => {
    const root = await directory();
    const store = new LocalFeedbackPersistence(root);
    await store.initialize();
    const capacity = vi.fn().mockResolvedValue(undefined);
    const key = randomUUID();
    await store.submit('a'.repeat(64), key, payload, capacity);
    expect(capacity).toHaveBeenCalledTimes(1);
    await store.submit('a'.repeat(64), key, payload, capacity);
    expect(capacity).toHaveBeenCalledTimes(1);
    const failed = vi
      .fn()
      .mockRejectedValue(new Error('storage-private-marker'));
    await expect(
      store.submit('a'.repeat(64), randomUUID(), payload, failed),
    ).rejects.toThrow('storage-private-marker');
    expect(await store.readForOperator()).toHaveLength(1);
  });
});
