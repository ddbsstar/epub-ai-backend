import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import {
  BusinessWorkerModule,
  PROCESSING_STEP_HANDLER,
} from './business/business-worker.module.js';
import {
  ProcessingWorkerService,
  type StepHandler,
} from './processing/processing-worker.service.js';

try {
  const application = await NestFactory.createApplicationContext(
    BusinessWorkerModule,
    { bufferLogs: true, abortOnError: false },
  );
  application.useLogger(application.get(Logger));
  application.enableShutdownHooks();
  try {
    await application
      .get(ProcessingWorkerService)
      .run(application.get<StepHandler>(PROCESSING_STEP_HANDLER));
  } finally {
    await application.close();
  }
} catch {
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', event: 'worker_startup_failed' })}\n`,
  );
  process.exitCode = 1;
}
