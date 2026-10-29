import { Module } from '@nestjs/common';
import { AppConfig, AppConfigModule } from '../config/app-config.module.js';
import { ImageProviderService } from './image-provider.service.js';
import { ImageAssetService } from './image-asset.service.js';
import { ImageCallLedger } from './image-call-ledger.js';
import { ImageGenerationService } from './image-generation.service.js';

@Module({
  imports: [AppConfigModule],
  providers: [
    ImageProviderService,
    ImageAssetService,
    ImageGenerationService,
    {
      provide: ImageCallLedger,
      inject: [AppConfig],
      useFactory: (config: AppConfig) =>
        new ImageCallLedger({
          enabled: config.get('IMAGE_GENERATION_ENABLED'),
          budgetEnforced: config.get('BUDGET_LIMITS_ENABLED'),
          dataDir: config.get('IMAGE_DATA_DIR'),
          sentTtlMs: config.get('IMAGE_TIMEOUT_MS') * 2 + 60000,
        }),
    },
  ],
  exports: [ImageGenerationService],
})
export class ImageGenerationModule {}
