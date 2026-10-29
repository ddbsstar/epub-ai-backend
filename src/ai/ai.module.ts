import { Module } from '@nestjs/common';
import { AiService } from './ai.service.js';
import { AiStructureService } from './ai-structure.service.js';
import { ProcessingModule } from '../processing/processing.module.js';
import { ImageGenerationModule } from './image-generation.module.js';

@Module({
  imports: [ProcessingModule, ImageGenerationModule],
  providers: [AiService, AiStructureService],
  exports: [AiService, AiStructureService, ImageGenerationModule],
})
export class AiModule {}
