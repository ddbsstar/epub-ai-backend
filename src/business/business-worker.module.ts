import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AppConfigModule, AppConfig } from '../config/app-config.module.js';
import { createLoggerOptions } from '../common/logging/logger-options.js';
import { BusinessCoreModule } from './business.module.js';
import { BusinessProcessingHandler } from './processing-handler.js';

export const PROCESSING_STEP_HANDLER = Symbol.for(
  'epub.processing.stepHandler',
);

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        pinoHttp: createLoggerOptions(config),
      }),
    }),
    BusinessCoreModule,
  ],
  providers: [
    {
      provide: PROCESSING_STEP_HANDLER,
      inject: [BusinessProcessingHandler],
      useFactory: (handler: BusinessProcessingHandler) => handler.handle,
    },
  ],
})
export class BusinessWorkerModule {}
