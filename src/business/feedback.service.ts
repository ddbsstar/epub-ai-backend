import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { isAbsolute } from 'node:path';
import { ApiException } from '../common/http/api-exception.js';
import { AppConfig } from '../config/app-config.module.js';
import { ProcessingRepository } from '../processing/processing.repository.js';
import { LocalProcessingPersistence } from '../processing/local-processing.persistence.js';
import { BetaMaintenanceService } from './beta-maintenance.service.js';
import {
  LocalFeedbackPersistence,
  FEEDBACK_RETENTION_HOURS,
} from './feedback-persistence.js';
import { businessError } from './business-errors.js';

@Injectable()
export class FeedbackService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FeedbackService.name);
  private persistence?: LocalFeedbackPersistence;
  private timer?: NodeJS.Timeout;
  private sweeping?: Promise<void>;
  constructor(
    @Inject(AppConfig) private readonly config: AppConfig,
    @Inject(ProcessingRepository)
    private readonly repository: ProcessingRepository,
    @Inject(BetaMaintenanceService)
    private readonly beta: BetaMaintenanceService,
  ) {}
  available() {
    return (
      this.config.get('PROCESSING_FEEDBACK_ENABLED') &&
      this.config.get('PROCESSING_ENABLED') &&
      this.repository.persistence instanceof LocalProcessingPersistence
    );
  }
  retentionHours() {
    return this.available() ? FEEDBACK_RETENTION_HOURS : null;
  }
  async onModuleInit() {
    const directory = this.config.get('PROCESSING_DATA_DIR');
    if (!directory || !isAbsolute(directory)) return;
    try {
      this.persistence = new LocalFeedbackPersistence(directory);
      if (this.available()) {
        const processing = this.repository.persistence;
        if (!(processing instanceof LocalProcessingPersistence))
          throw businessError('FEEDBACK_DISABLED', 503);
        await processing.initialize();
        await this.persistence.initialize();
      }
      await this.sweep();
    } catch {
      if (this.available()) throw businessError('FEEDBACK_UNAVAILABLE', 503);
      this.logger.warn('feedback_cleanup_unavailable');
    }
    if (this.persistence) {
      this.timer = setInterval(() => {
        void this.sweep().catch(() =>
          this.logger.warn('feedback_cleanup_unavailable'),
        );
      }, 30000);
      this.timer.unref();
    }
  }
  async onModuleDestroy() {
    clearInterval(this.timer);
    await this.sweeping?.catch(() => undefined);
  }
  sweep() {
    if (this.sweeping) return this.sweeping;
    this.sweeping = (this.persistence?.prune() ?? Promise.resolve()).finally(
      () => {
        this.sweeping = undefined;
      },
    );
    return this.sweeping;
  }
  async submit(ownerId: string, key: unknown, payload: unknown) {
    if (!this.available() || !this.persistence)
      throw businessError('FEEDBACK_DISABLED', 503);
    if (typeof key !== 'string') throw businessError('INVALID_IDEMPOTENCY_KEY');
    try {
      return await this.persistence.submit(ownerId, key, payload, () =>
        this.beta.ensureCapacity(),
      );
    } catch (error) {
      if (error instanceof ApiException) throw error;
      throw businessError('FEEDBACK_UNAVAILABLE', 503);
    }
  }
}
