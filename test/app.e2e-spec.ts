import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/setup-app.js';

describe('Health endpoint (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ConfigService)
      .useValue({ get: () => undefined })
      .compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  it('starts without MySQL or Qwen credentials and serves the prefixed health endpoint', () => {
    return request(app.getHttpServer())
      .get('/api/health')
      .expect(200)
      .expect({
        status: 'ok',
        service: 'epub-ai-backend',
        dependencies: {
          database: 'not_configured',
          qwen: 'not_configured',
        },
      });
  });

  it('does not expose an unprefixed health endpoint', () => {
    return request(app.getHttpServer()).get('/health').expect(404);
  });

  afterAll(async () => {
    await app.close();
  });
});
