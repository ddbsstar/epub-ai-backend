import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.module.js';
import { ApiException } from '../common/http/api-exception.js';
import type { DependencyStatus } from '../database/database.service.js';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client?: Redis;

  constructor(
    @Inject(AppConfig) private readonly config: AppConfig,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.get('REDIS_ENABLED')) return;
    this.client = new Redis(this.config.get('REDIS_URL'), {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 1500,
      commandTimeout: 1500,
      retryStrategy: (attempt) =>
        attempt <= 3 ? Math.min(attempt * 250, 1000) : null,
    });
    this.client.on('error', () => {
      this.logger.warn({ event: 'redis_unavailable' });
    });
    try {
      await this.client.connect();
    } catch {
      /* Health exposes unavailable. */
    }
  }

  getStatus(): DependencyStatus {
    return !this.client
      ? 'disabled'
      : this.client.status === 'ready'
        ? 'connected'
        : 'unavailable';
  }

  getClient(): Redis {
    if (!this.client) {
      throw new ApiException(
        { code: 'REDIS_DISABLED', message: 'Redis 未启用' },
        503,
      );
    }
    return this.client;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client?.status === 'ready') {
      await this.client.quit().catch(() => this.client?.disconnect());
    } else {
      this.client?.disconnect();
    }
  }
}
