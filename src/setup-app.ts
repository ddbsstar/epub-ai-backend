import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Express } from 'express';
import helmet from 'helmet';
import { AppConfig } from './config/app-config.module.js';
import { createValidationPipe } from './common/http/validation.js';
import { requestIdMiddleware } from './common/http/request-id.js';

export function configureApp(app: NestExpressApplication): void {
  const config = app.get(AppConfig);
  const express = app.getHttpAdapter().getInstance() as Express;
  express.disable('x-powered-by');
  // Change only after documenting a known proxy topology; forwarded IP is untrusted.
  express.set('trust proxy', false);
  app.use(requestIdMiddleware);
  app.use(helmet({ strictTransportSecurity: false }));
  app.useBodyParser('json', { limit: config.get('JSON_BODY_LIMIT_KB') * 1024 });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(createValidationPipe());
  app.enableShutdownHooks();

  if (config.get('SWAGGER_ENABLED')) {
    // Swagger UI uses inline bootstrapping. Relax CSP only on this opt-in UI.
    app.use(
      '/api/docs',
      helmet({
        strictTransportSecurity: false,
        contentSecurityPolicy: {
          directives: {
            'script-src': ["'self'", "'unsafe-inline'"],
            'style-src': ["'self'", "'unsafe-inline'"],
            'upgrade-insecure-requests': null,
          },
        },
      }),
    );
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('EPUB AI API')
        .setDescription(
          '基础设施接口。业务、鉴权与 EPUB 处理尚未实现。API 成功和失败响应均包含 meta.requestId，响应头同步返回 x-request-id。',
        )
        .setVersion('0.1.0')
        .build(),
    );
    SwaggerModule.setup('api/docs', app, document, {
      jsonDocumentUrl: '/api/docs-json',
      swaggerOptions: { persistAuthorization: false },
    });
  }
}
