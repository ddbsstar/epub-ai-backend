import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.module.js';
import { RedisService } from './redis.service.js';
import { ApiException } from '../common/http/api-exception.js';
import type { DependencyStatus } from '../database/database.service.js';

export const EPUB_QUEUE_NAME = 'epub-processing';
const QUEUE_READY_TIMEOUT_MS = 3000;
const QUEUE_CLOSE_TIMEOUT_MS = 2000;

function withDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Queue operation deadline exceeded')),
      timeoutMs,
    );
    operation.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private queue?: Queue;
  private status: DependencyStatus = 'disabled';
  private closing = false;

  constructor(
    @Inject(AppConfig) private readonly config: AppConfig,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.get('QUEUE_ENABLED')) return;
    this.status = 'unavailable';
    try {
      this.queue = new Queue(EPUB_QUEUE_NAME, {
        connection: this.redis.getClient(),
        prefix: this.config.get('QUEUE_PREFIX'),
        defaultJobOptions: {
          // Paid AI jobs must explicitly choose their own retry/idempotency policy.
          attempts: 1,
          removeOnComplete: { age: 86400, count: 100 },
          removeOnFail: { age: 604800, count: 500 },
        },
      });
      this.queue.on('error', () => {
        this.status = 'unavailable';
        if (!this.closing) this.logger.warn({ event: 'queue_unavailable' });
      });
      this.queue.on('ioredis:close', () => {
        this.status = 'unavailable';
      });
      await withDeadline(this.queue.waitUntilReady(), QUEUE_READY_TIMEOUT_MS);
      if (!this.closing && this.redis.getStatus() === 'connected') {
        this.status = 'connected';
      }
    } catch {
      // Redis transport readiness alone does not prove BullMQ initialization.
      this.status = 'unavailable';
      if (!this.closing) this.logger.warn({ event: 'queue_unavailable' });
    }
  }

  getStatus(): DependencyStatus {
    if (this.status === 'disabled') return 'disabled';
    return !this.closing &&
      this.status === 'connected' &&
      this.redis.getStatus() === 'connected'
      ? 'connected'
      : 'unavailable';
  }

  getQueue(): Queue {
    if (this.status === 'disabled') {
      throw new ApiException(
        { code: 'QUEUE_DISABLED', message: '后台队列未启用' },
        503,
      );
    }
    if (!this.queue || this.getStatus() !== 'connected') {
      throw new ApiException(
        { code: 'QUEUE_UNAVAILABLE', message: '后台队列暂时不可用' },
        503,
      );
    }
    return this.queue;
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    if (!this.queue) return;
    this.status = 'unavailable';
    try {
      await withDeadline(this.queue.close(), QUEUE_CLOSE_TIMEOUT_MS);
    } catch {
      this.logger.warn({ event: 'queue_shutdown_forced' });
      // The shared Redis client is being disposed with the application. Its
      // synchronous disconnect also stops retries if BullMQ's close is wedged.
      this.redis.getClient().disconnect();
    }
  }
}
