import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json, type Express } from 'express';
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
  app.use('/api/v1/feedback', json({ limit: 8192, strict: true }));
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
          '基础设施与本机 EPUB 业务接口。书籍处理默认关闭，正式账号尚未接入。JSON 响应包含 meta.requestId，二进制下载使用文件流；响应头包含 x-request-id。',
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
