import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { configureApp } from './setup-app.js';
import { AppConfig } from './config/app-config.module.js';
import { ConfigurationError } from './config/environment.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    abortOnError: false,
    bodyParser: false,
  });
  try {
    app.useLogger(app.get(Logger));
    configureApp(app);
    const config = app.get(AppConfig);
    await app.listen(config.get('PORT'), config.get('HOST'));
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}
try {
  await bootstrap();
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      level: 'fatal',
      event: 'startup_failed',
      message:
        error instanceof ConfigurationError
          ? error.message
          : 'Application failed to start',
    })}\n`,
  );
  process.exitCode = 1;
}
