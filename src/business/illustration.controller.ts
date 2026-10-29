import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiHeader, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  BusinessAccessGuard,
  type BusinessRequest,
} from './business-access.js';
import { IllustrationService } from './illustration.service.js';

const nullable = { type: 'string', nullable: true };
const view = {
  type: 'object',
  required: ['data', 'meta'],
  properties: {
    meta: {
      type: 'object',
      required: ['requestId'],
      properties: { requestId: { type: 'string' } },
    },
    data: {
      type: 'object',
      required: [
        'id',
        'bookId',
        'kind',
        'planId',
        'exportId',
        'status',
        'stage',
        'chapterIndex',
        'chapterTitle',
        'concept',
        'prompt',
        'alt',
        'artifacts',
        'error',
        'createdAt',
        'updatedAt',
      ],
      properties: {
        id: { type: 'string', format: 'uuid' },
        bookId: { type: 'string', format: 'uuid' },
        kind: { type: 'string', enum: ['plan', 'export'] },
        planId: nullable,
        exportId: nullable,
        status: {
          type: 'string',
          enum: ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'],
        },
        stage: { type: 'string' },
        chapterIndex: { type: 'integer', minimum: 0, maximum: 500 },
        chapterTitle: nullable,
        concept: nullable,
        prompt: nullable,
        alt: nullable,
        artifacts: {
          type: 'object',
          required: ['image', 'epub', 'report'],
          properties: { image: nullable, epub: nullable, report: nullable },
        },
        error: {
          type: 'object',
          nullable: true,
          properties: { code: { type: 'string' }, message: { type: 'string' } },
        },
        createdAt: { type: 'string' },
        updatedAt: { type: 'string' },
      },
    },
  },
};

@ApiTags('illustrations')
@UseGuards(BusinessAccessGuard)
@Controller('v1')
export class IllustrationController {
  constructor(
    @Inject(IllustrationService) private readonly service: IllustrationService,
  ) {}

  @Post('books/:bookId/illustrations/plan')
  @HttpCode(202)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['chapterIndex'],
      properties: {
        chapterIndex: { type: 'integer', minimum: 0, maximum: 500 },
      },
    },
  })
  @ApiResponse({ status: 202, schema: view })
  plan(
    @Req() request: BusinessRequest,
    @Param('bookId') bookId: string,
    @Body() input: unknown,
  ) {
    return this.service.createPlan(
      request.processingOwnerId,
      bookId,
      input,
      request.headers['idempotency-key'],
    );
  }

  @Get('illustrations/:id')
  @ApiResponse({ status: 200, schema: view })
  get(@Req() request: BusinessRequest, @Param('id') id: string) {
    return this.service.get(request.processingOwnerId, id);
  }

  @Post('illustrations/:planId/generate')
  @HttpCode(202)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt', 'alt'],
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 800 },
        alt: { type: 'string', minLength: 1, maxLength: 500 },
      },
    },
  })
  @ApiResponse({ status: 202, schema: view })
  generate(
    @Req() request: BusinessRequest,
    @Param('planId') id: string,
    @Body() input: unknown,
  ) {
    return this.service.generate(
      request.processingOwnerId,
      id,
      input,
      request.headers['idempotency-key'],
    );
  }
}
