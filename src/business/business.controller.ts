import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiResponse,
  ApiTags,
  ApiHeader,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { pipeline } from 'node:stream/promises';
import {
  BusinessAccessGuard,
  type BusinessRequest,
} from './business-access.js';
import { BusinessService } from './business.service.js';

const envelope = (data: Record<string, unknown>) => ({
  type: 'object',
  required: ['data', 'meta'],
  properties: {
    data,
    meta: {
      type: 'object',
      required: ['requestId'],
      properties: { requestId: { type: 'string' } },
    },
  },
});
const nullableString = { type: 'string', nullable: true };
const runSchema = envelope({
  type: 'object',
  required: [
    'id',
    'bookId',
    'status',
    'stage',
    'completedUnits',
    'totalUnits',
    'artifacts',
    'warnings',
    'error',
    'ai',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    bookId: { type: 'string', format: 'uuid' },
    status: {
      type: 'string',
      enum: ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'],
    },
    stage: { type: 'string' },
    completedUnits: { type: 'integer' },
    totalUnits: { type: 'integer' },
    originalName: { type: 'string' },
    title: nullableString,
    artifacts: {
      type: 'object',
      properties: {
        epub: nullableString,
        report: nullableString,
        cover: nullableString,
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
    ai: {
      type: 'object',
      required: [
        'status',
        'model',
        'reasonCode',
        'sampledBlocks',
        'appliedBlocks',
        'usage',
        'estimatedCostMicros',
        'currency',
      ],
      properties: {
        status: {
          type: 'string',
          enum: [
            'DISABLED',
            'PENDING',
            'RUNNING',
            'APPLIED',
            'FALLBACK',
            'SKIPPED',
          ],
        },
        model: nullableString,
        reasonCode: nullableString,
        sampledBlocks: { type: 'integer', minimum: 0 },
        appliedBlocks: { type: 'integer', minimum: 0 },
        usage: {
          type: 'object',
          nullable: true,
          properties: {
            inputTokens: { type: 'integer' },
            outputTokens: { type: 'integer' },
            totalTokens: { type: 'integer' },
          },
        },
        estimatedCostMicros: {
          type: 'integer',
          nullable: true,
          description:
            'CNY millionths, configured price estimate; null if not confirmed',
        },
        currency: { type: 'string', enum: ['CNY'] },
      },
    },
    summary: {
      type: 'object',
      nullable: true,
      properties: {
        chapters: { type: 'integer' },
        styledChapters: { type: 'integer' },
        preservedChapters: { type: 'integer' },
        bodyBytesPreserved: { type: 'boolean' },
        formatErrors: { type: 'integer' },
        formatWarnings: { type: 'integer' },
        typography: {
          type: 'object',
          required: [
            'profile',
            'totalParagraphs',
            'styledParagraphs',
            'preservedParagraphs',
            'styledHeadings',
            'roleCounts',
          ],
          properties: {
            profile: { type: 'string', enum: ['editorial-1'] },
            totalParagraphs: { type: 'integer', minimum: 0 },
            styledParagraphs: { type: 'integer', minimum: 0 },
            styledSeparatorParagraphs: {
              type: 'integer',
              minimum: 0,
              description:
                'Styled p elements with the separator role; excluded hr elements are counted only in roleCounts.separator. Missing in historical summaries means zero.',
            },
            preservedParagraphs: { type: 'integer', minimum: 0 },
            styledHeadings: { type: 'integer', minimum: 0 },
            roleCounts: {
              type: 'object',
              properties: Object.fromEntries(
                [
                  'body',
                  'opening',
                  'quote',
                  'poem',
                  'caption',
                  'note',
                  'separator',
                ].map((role) => [role, { type: 'integer', minimum: 0 }]),
              ),
            },
          },
        },
      },
    },
    error: {
      type: 'object',
      nullable: true,
      properties: { code: { type: 'string' }, message: { type: 'string' } },
    },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
});

@ApiTags('books')
@UseGuards(BusinessAccessGuard)
@ApiResponse({
  status: 503,
  description: '处理未启用；错误使用统一 error/meta 封装',
})
@ApiResponse({
  status: 403,
  description: '仅限本机及允许的来源；错误使用统一 error/meta 封装',
})
@Controller('v1')
export class BusinessController {
  constructor(
    @Inject(BusinessService) private readonly service: BusinessService,
  ) {}

  @Get('capabilities')
  @ApiOkResponse({
    description: 'Enabled upload/retention limits; no private configuration.',
  })
  capabilities() {
    return this.service.capabilities();
  }

  @Post('uploads')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiCreatedResponse({
    schema: envelope({
      type: 'object',
      required: ['id', 'bookId', 'originalName', 'byteSize', 'sha256'],
      properties: {
        id: { type: 'string' },
        bookId: { type: 'string' },
        originalName: { type: 'string' },
        byteSize: { type: 'integer' },
        sha256: { type: 'string' },
      },
    }),
  })
  @ApiResponse({ status: 413, description: '文件超过上传限制' })
  upload(@Req() request: BusinessRequest) {
    return this.service.upload(request);
  }

  @Post('books/:bookId/exports')
  @HttpCode(202)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '客户端重试同一请求时保持不变',
  })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['theme'],
      properties: {
        theme: { type: 'string', enum: ['reader-first', 'reader-editorial'] },
        ai: {
          type: 'boolean',
          description:
            'Legacy reader-first opt-out. reader-editorial always uses deterministic typography and rejects ai:true.',
        },
      },
    },
  })
  @ApiResponse({ status: 202, schema: runSchema })
  create(
    @Req() request: BusinessRequest,
    @Param('bookId') bookId: string,
    @Body() input: unknown,
  ) {
    return this.service.createExport(
      request.processingOwnerId,
      bookId,
      input,
      request.headers['idempotency-key'],
    );
  }

  @Get('runs/:id')
  @ApiOkResponse({ schema: runSchema })
  get(@Req() request: BusinessRequest, @Param('id') id: string) {
    return this.service.getRun(request.processingOwnerId, id);
  }

  @Post('runs/:id/cancel')
  @HttpCode(200)
  @ApiOkResponse({ schema: runSchema })
  cancel(@Req() request: BusinessRequest, @Param('id') id: string) {
    return this.service.cancel(request.processingOwnerId, id);
  }

  @Get('artifacts/:id/download')
  @ApiOkResponse({
    description: '私有产物二进制流，无 JSON envelope',
    schema: { type: 'string', format: 'binary' },
  })
  async download(
    @Req() request: BusinessRequest,
    @Param('id') id: string,
    @Res() response: Response,
  ): Promise<void> {
    const { artifact, stream } = await this.service.getDownload(
      request.processingOwnerId,
      id,
    );
    const image =
      ['cover', 'illustration'].includes(artifact.kind) &&
      ['image/jpeg', 'image/png'].includes(artifact.mediaType);
    response.setHeader('Content-Type', artifact.mediaType);
    response.setHeader('Content-Length', artifact.byteSize);
    response.setHeader(
      'Content-Disposition',
      image
        ? 'inline'
        : `attachment; filename="${artifact.kind === 'export' ? 'epub-reader-first.epub' : 'epub-processing-report.json'}"`,
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; sandbox",
    );
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    await pipeline(stream, response);
  }
}
