import { Module } from '@nestjs/common';
import { ProcessingModule } from '../processing/processing.module.js';
import { AiModule } from '../ai/ai.module.js';
import { LocalArtifactStorage } from './artifact-storage.js';
import { BusinessAccessGuard } from './business-access.js';
import { BusinessController } from './business.controller.js';
import { BusinessService } from './business.service.js';
import { BusinessProcessingHandler } from './processing-handler.js';
import { EpubCheckService } from './epubcheck.service.js';
import { IllustrationWorkerService } from './illustration-worker.service.js';
import { IllustrationService } from './illustration.service.js';
import { IllustrationController } from './illustration.controller.js';
import { ConversionService } from './conversion.service.js';
import { ConversionWorkerService } from './conversion-worker.service.js';
import { ConversionController } from './conversion.controller.js';
import { BetaMaintenanceService } from './beta-maintenance.service.js';
import { FeedbackService } from './feedback.service.js';
import { FeedbackController } from './feedback.controller.js';

@Module({
  imports: [ProcessingModule, AiModule],
  providers: [
    LocalArtifactStorage,
    BetaMaintenanceService,
    FeedbackService,
    BusinessAccessGuard,
    BusinessService,
    BusinessProcessingHandler,
    EpubCheckService,
    IllustrationWorkerService,
    IllustrationService,
    ConversionService,
    ConversionWorkerService,
  ],
  exports: [
    ProcessingModule,
    LocalArtifactStorage,
    BusinessService,
    FeedbackService,
    BusinessAccessGuard,
    BusinessProcessingHandler,
    IllustrationService,
    ConversionService,
  ],
})
export class BusinessCoreModule {}

@Module({
  imports: [BusinessCoreModule],
  controllers: [
    BusinessController,
    FeedbackController,
    IllustrationController,
    ConversionController,
  ],
})
export class BusinessModule {}
