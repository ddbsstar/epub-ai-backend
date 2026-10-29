import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AppConfig, AppConfigModule } from './config/app-config.module.js';
import { HealthController } from './health/health.controller.js';
import { createLoggerOptions } from './common/logging/logger-options.js';
import { ApiExceptionFilter } from './common/http/api-exception.filter.js';
import { ResponseInterceptor } from './common/http/response.interceptor.js';
import { DatabaseModule } from './database/database.module.js';
import { QueueModule } from './queue/queue.module.js';
import { AiModule } from './ai/ai.module.js';
import { BusinessModule } from './business/business.module.js';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        pinoHttp: createLoggerOptions(config),
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => [
        {
          ttl: config.get('THROTTLE_TTL_MS'),
          limit: config.get('THROTTLE_LIMIT'),
        },
      ],
    }),
    DatabaseModule,
    QueueModule,
    AiModule,
    BusinessModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
