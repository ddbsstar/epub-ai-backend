import 'reflect-metadata';
import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { IsString, MinLength } from 'class-validator';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/app-config.module.js';
import {
  validateEnvironment,
  type Environment,
} from '../src/config/environment.js';
import { configureApp } from '../src/setup-app.js';
import { DatabaseService } from '../src/database/database.service.js';

class TestInput {
  @IsString()
  @MinLength(2)
  title!: string;
}

// Only the test module registers these routes; production exposes no demo APIs.
@Controller('test')
class TestController {
  @Post()
  create(@Body() input: TestInput) {
    return { title: input.title };
  }

  @Get('failure')
  fail(): never {
    throw new Error('private-exception-marker');
  }
}
// Vitest's TypeScript transform does not emit decorator type metadata.
Reflect.defineMetadata(
  'design:paramtypes',
  [TestInput],
  TestController.prototype,
  'create',
);

@Module({ imports: [AppModule], controllers: [TestController] })
class TestModule {}

async function createApp(overrides: Partial<Environment> = {}) {
  const environment = validateEnvironment({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
  const fixture = await Test.createTestingModule({ imports: [TestModule] })
    .overrideProvider(AppConfig)
    .useValue({
      get: <K extends keyof Environment>(key: K) => environment[key],
    })
    .compile();
  const app = fixture.createNestApplication<NestExpressApplication>({
    bodyParser: false,
  });
  configureApp(app);
  await app.init();
  return app;
}

describe('HTTP foundation', () => {
  let app: NestExpressApplication;
  beforeAll(async () => {
    app = await createApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('starts with external services disabled and wraps a safe health payload', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/health')
      .expect(200);
    expect(response.body.data).toEqual({
      status: 'ok',
      service: 'epub-ai-backend',
      dependencies: {
        database: 'disabled',
        redis: 'disabled',
        queue: 'disabled',
        qwen: 'disabled',
      },
    });
    expect(response.body.meta.requestId).toBe(response.headers['x-request-id']);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('keeps a safe caller request ID and replaces an unsafe one', async () => {
    const safe = await request(app.getHttpServer())
      .get('/api/health')
      .set('X-Request-Id', 'test-id_123')
      .expect(200);
    expect(safe.body.meta.requestId).toBe('test-id_123');
    const unsafe = await request(app.getHttpServer())
      .get('/api/health')
      .set('X-Request-Id', 'invalid/id')
      .expect(200);
    expect(unsafe.body.meta.requestId).not.toBe('invalid/id');
    expect(unsafe.body.meta.requestId).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('normalizes missing endpoints', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/not-found')
      .expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.meta.requestId).toBe(response.headers['x-request-id']);
  });

  it('does not expose an unprefixed health endpoint', async () => {
    await request(app.getHttpServer()).get('/health').expect(404);
  });

  it('reports disabled dependencies as optional but rejects unavailable enabled infrastructure', async () => {
    const ready = await request(app.getHttpServer())
      .get('/api/health/ready')
      .expect(200);
    expect(ready.body.data.status).toBe('ready');
    const database = app.get(DatabaseService);
    const probe = vi
      .spyOn(database, 'checkConnection')
      .mockResolvedValue('unavailable');
    try {
      const unavailable = await request(app.getHttpServer())
        .get('/api/health/ready')
        .expect(503);
      expect(unavailable.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(unavailable.body.error.details.database).toBe('unavailable');
    } finally {
      probe.mockRestore();
    }
  });

  it('validates DTOs and rejects unknown fields without echoing values', async () => {
    const valid = await request(app.getHttpServer())
      .post('/api/test')
      .send({ title: 'A book' })
      .expect(201);
    expect(valid.body.data).toEqual({ title: 'A book' });
    const invalid = await request(app.getHttpServer())
      .post('/api/test')
      .send({ title: 1, secret: 'private-input-marker' })
      .expect(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(invalid.body)).not.toContain('private-input-marker');
  });

  it('does not leak unhandled exception text', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/test/failure')
      .expect(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(response.body)).not.toContain(
      'private-exception-marker',
    );
    expect(response.body).not.toHaveProperty('stack');
  });

  it('normalizes body parser errors and enforces the JSON limit', async () => {
    const malformed = await request(app.getHttpServer())
      .post('/api/test')
      .set('Content-Type', 'application/json')
      .send('{"password":"private-input-marker"')
      .expect(400);
    expect(malformed.body.error.code).toBe('BAD_REQUEST');
    expect(JSON.stringify(malformed.body)).not.toContain(
      'private-input-marker',
    );
    const large = await request(app.getHttpServer())
      .post('/api/test')
      .send({ title: 'x'.repeat(300 * 1024) })
      .expect(413);
    expect(large.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('generates development documentation with the real envelope schema', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/docs-json')
      .expect(200);
    expect(
      response.body.paths['/api/health'].get.responses['200'].content[
        'application/json'
      ].schema.required,
    ).toEqual(['data', 'meta']);
  });

  it('disables API documentation by default in production', async () => {
    const production = await createApp({ NODE_ENV: 'production' });
    try {
      await request(production.getHttpServer())
        .get('/api/docs-json')
        .expect(404);
    } finally {
      await production.close();
    }
  });

  it('enforces request rate limits', async () => {
    const limited = await createApp({ THROTTLE_LIMIT: 1 });
    try {
      await request(limited.getHttpServer()).get('/api/health').expect(200);
      const response = await request(limited.getHttpServer())
        .get('/api/health')
        .expect(429);
      expect(response.body.error.code).toBe('RATE_LIMITED');
    } finally {
      await limited.close();
    }
  });
});
