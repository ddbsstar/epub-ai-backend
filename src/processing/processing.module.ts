import { Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { AppConfig } from '../config/app-config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { DatabaseService } from '../database/database.service.js';
import { LocalProcessingPersistence } from './local-processing.persistence.js';
import { PrismaProcessingPersistence } from './prisma-processing.persistence.js';
import { ProcessingRepository } from './processing.repository.js';
import { ProcessingWorkerService } from './processing-worker.service.js';
import type { ModelDailyBudget } from './model-call.types.js';
import {
  ProcessingError,
  type ProcessingArtifact,
  type ProcessingBook,
  type ProcessingPersistence,
  type ProcessingRun,
  type RunMutation,
} from './processing.types.js';

class DisabledPersistence implements ProcessingPersistence {
  private disabled(): never {
    throw new ProcessingError('PROCESSING_DISABLED', 503);
  }
  createBook(_book: ProcessingBook): Promise<void> {
    return this.disabled();
  }
  getBook(_id: string): Promise<ProcessingBook | null> {
    return this.disabled();
  }
  createRun(
    _run: ProcessingRun,
  ): Promise<{ run: ProcessingRun; reused: boolean }> {
    return this.disabled();
  }
  getRun(_id: string): Promise<ProcessingRun | null> {
    return this.disabled();
  }
  findRunByKey(
    _ownerId: string,
    _operation: string,
    _idempotencyKey: string,
  ): Promise<ProcessingRun | null> {
    return this.disabled();
  }
  mutateRun<T>(
    _id: string,
    _change: (
      run: ProcessingRun,
      book: ProcessingBook,
      dailyBudgets: Record<string, ModelDailyBudget>,
    ) => { result: T; mutation?: RunMutation },
  ): Promise<T | null> {
    return this.disabled();
  }
  listActive(_limit: number): Promise<ProcessingRun[]> {
    return this.disabled();
  }
  getArtifact(_id: string): Promise<ProcessingArtifact | null> {
    return this.disabled();
  }
  async close(): Promise<void> {}
}

class ProcessingLifecycle implements OnModuleDestroy {
  constructor(
    @Inject(ProcessingRepository)
    private readonly repository: ProcessingRepository,
  ) {}
  async onModuleDestroy(): Promise<void> {
    await this.repository.close();
  }
}

@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: ProcessingRepository,
      inject: [AppConfig, DatabaseService],
      useFactory: (config: AppConfig, database: DatabaseService) => {
        if (!config.get('PROCESSING_ENABLED'))
          return new ProcessingRepository(new DisabledPersistence());
        const limits = {
          maxRuns: config.get('PROCESSING_MAX_RUNS'),
          ownerActiveLimit: config.get('PROCESSING_OWNER_ACTIVE_LIMIT'),
          ...(config.get('PROCESSING_PUBLIC_BETA_ENABLED')
            ? {
                ownerBookLimit: config.get('PROCESSING_BETA_OWNER_BOOK_LIMIT'),
                maxActiveRuns: config.get('PROCESSING_BETA_MAX_ACTIVE_RUNS'),
                maxSourceBytes:
                  (config.get('PROCESSING_BETA_STORAGE_MAX_MIB') *
                    1024 *
                    1024) /
                  4,
                retentionMs:
                  config.get('PROCESSING_BETA_RETENTION_HOURS') * 3600000,
              }
            : {}),
        };
        const persistence =
          config.get('PROCESSING_REPOSITORY') === 'mysql'
            ? new PrismaProcessingPersistence(database.getClient(), limits)
            : new LocalProcessingPersistence(
                config.get('PROCESSING_DATA_DIR'),
                limits,
              );
        return new ProcessingRepository(persistence);
      },
    },
    ProcessingLifecycle,
    ProcessingWorkerService,
  ],
  exports: [ProcessingRepository, ProcessingWorkerService],
})
export class ProcessingModule {}
