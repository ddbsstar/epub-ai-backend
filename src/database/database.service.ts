import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.module.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { ApiException } from '../common/http/api-exception.js';

export type DependencyStatus =
  | 'disabled'
  | 'not_configured'
  | 'configured_not_checked'
  | 'connected'
  | 'unavailable';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private client?: PrismaClient;
  private status: DependencyStatus = 'disabled';
  private checkedAt = 0;
  private checking?: Promise<DependencyStatus>;

  constructor(
    @Inject(AppConfig) private readonly config: AppConfig,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.get('DATABASE_ENABLED')) return;
    const url = new URL(this.config.get('DATABASE_URL'));
    url.searchParams.set(
      'connectionLimit',
      String(this.config.get('DB_CONNECTION_LIMIT')),
    );
    url.searchParams.set('connectTimeout', '1500');
    url.searchParams.set('acquireTimeout', '1500');
    this.client = new PrismaClient({
      adapter: new PrismaMariaDb(url.toString()),
    });
    await this.checkConnection();
  }

  getClient(): PrismaClient {
    if (!this.client) {
      throw new ApiException(
        { code: 'DATABASE_DISABLED', message: '数据库未启用' },
        503,
      );
    }
    return this.client;
  }

  checkConnection(): Promise<DependencyStatus> {
    if (!this.client) return Promise.resolve('disabled');
    if (this.checking) return this.checking;
    if (Date.now() - this.checkedAt < 5000) return Promise.resolve(this.status);
    this.checking = this.probe().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private async probe(): Promise<DependencyStatus> {
    try {
      await this.client!.$queryRaw`SELECT 1`;
      this.status = 'connected';
    } catch {
      this.status = 'unavailable';
      this.logger.warn({ event: 'database_unavailable' });
    }
    this.checkedAt = Date.now();
    return this.status;
  }

  async onModuleDestroy(): Promise<void> {
    await this.checking;
    await this.client?.$disconnect();
  }
}
