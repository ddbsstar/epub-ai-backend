import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiHeader, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import {
  BusinessAccessGuard,
  type BusinessRequest,
} from './business-access.js';
import { businessError } from './business-errors.js';
import { ConversionService } from './conversion.service.js';

const string = { type: 'string' },
  nullable = { type: 'string', nullable: true },
  integer = { type: 'integer', minimum: 0 };
const error = {
  type: 'object',
  nullable: true,
  required: ['code', 'message'],
  properties: { code: string, message: string },
};
const artDirectionFields = {
  hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  label: { type: 'string', minLength: 1, maxLength: 100 },
  description: { type: 'string', minLength: 1, maxLength: 500 },
  status: { type: 'string', enum: ['provisional'] },
  visualReview: { type: 'string', enum: ['unreviewed'] },
};
const directionRequired = [
  'id',
  'version',
  'hash',
  'label',
  'description',
  'status',
  'visualReview',
];
const artDirection = {
  description:
    'Optional frozen task direction. Legacy literary-editorial@2 is a fixed preset; book-art@1 is created from representative book samples. Neither variant claims visual approval.',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: directionRequired,
      properties: {
        id: { type: 'string', enum: ['literary-editorial'] },
        version: { type: 'integer', enum: [2] },
        ...artDirectionFields,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: directionRequired,
      properties: {
        id: { type: 'string', enum: ['book-art'] },
        version: { type: 'integer', enum: [1] },
        ...artDirectionFields,
      },
    },
  ],
};
const bookArtPlan = {
  type: 'object',
  additionalProperties: false,
  description:
    'Optional content-directed art overview bound to book-art@1. Text fields are model summaries, not long original passages. Coverage is computed by the server and does not imply full-book close reading.',
  required: [
    'reading',
    'rationale',
    'coverage',
    'medium',
    'palette',
    'lineLanguage',
    'shapeLanguage',
    'negativeSpace',
    'characterTreatment',
  ],
  properties: {
    reading: { type: 'string', minLength: 1, maxLength: 4000 },
    rationale: {
      type: 'string',
      minLength: 1,
      maxLength: 4000,
      description:
        'Why the chosen visual language fits the sampled book content.',
    },
    coverage: {
      type: 'object',
      required: [
        'mode',
        'totalSupportedSections',
        'sampledSections',
        'sampledParagraphs',
      ],
      properties: {
        mode: { type: 'string', enum: ['representative-samples'] },
        totalSupportedSections: integer,
        sampledSections: {
          ...integer,
          description: 'Does not exceed totalSupportedSections.',
        },
        sampledParagraphs: integer,
      },
    },
    medium: {
      type: 'string',
      enum: [
        'graphite-contour',
        'monochrome-ink',
        'restrained-woodcut',
        'flat-gouache',
        'paper-cut',
        'watercolor-line',
      ],
    },
    palette: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['colorName', 'hex'],
        properties: {
          colorName: { type: 'string', minLength: 1, maxLength: 100 },
          hex: { type: 'string', pattern: '^#[a-fA-F0-9]{6}$' },
        },
      },
    },
    lineLanguage: { type: 'string', minLength: 1, maxLength: 1000 },
    shapeLanguage: { type: 'string', minLength: 1, maxLength: 1000 },
    negativeSpace: {
      type: 'string',
      enum: ['generous', 'balanced', 'compact'],
    },
    characterTreatment: { type: 'string', minLength: 1, maxLength: 1000 },
  },
};
const visualPlan = {
  type: 'object',
  additionalProperties: false,
  description:
    'Optional chapter/section visual alternatives. Concept IDs are unique; selectedConceptId must identify one of the 2–3 concepts. No original long passages are exposed.',
  required: ['concepts', 'selectedConceptId', 'selectionReason'],
  properties: {
    concepts: {
      type: 'array',
      minItems: 2,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'idea', 'composition', 'emotionalIntent'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 100 },
          idea: { type: 'string', minLength: 1, maxLength: 4000 },
          composition: { type: 'string', minLength: 1, maxLength: 4000 },
          emotionalIntent: { type: 'string', minLength: 1, maxLength: 2000 },
        },
      },
    },
    selectedConceptId: { type: 'string', minLength: 1, maxLength: 100 },
    selectionReason: { type: 'string', minLength: 1, maxLength: 4000 },
  },
};
const chapter = {
  type: 'object',
  required: ['id', 'index', 'title', 'status', 'error', 'imageUrl'],
  properties: {
    id: string,
    index: integer,
    title: string,
    status: {
      type: 'string',
      enum: [
        'WAITING',
        'PLANNING',
        'GENERATING',
        'REVIEWING',
        'SUCCEEDED',
        'SKIPPED',
        'FAILED',
        'UNKNOWN',
        'REJECTED',
      ],
    },
    error,
    imageUrl: nullable,
    scope: { type: 'string', enum: ['section'] },
    sectionId: string,
    parentChapterTitle: string,
    visualPlan,
    visualReview: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'summary', 'checks'],
      description:
        'Optional automated image assessment. Only PASSED images can be inserted by V7/V8 tasks; V8 uses content-people-1 planning. This is not human aesthetic approval.',
      properties: {
        status: { type: 'string', enum: ['PASSED', 'REJECTED', 'UNCERTAIN'] },
        summary: { type: 'string', minLength: 1, maxLength: 640 },
        checks: {
          type: 'array',
          minItems: 5,
          maxItems: 5,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['aspect', 'result', 'reason'],
            properties: {
              aspect: {
                type: 'string',
                enum: ['source', 'people', 'style', 'composition', 'artifacts'],
              },
              result: { type: 'string', enum: ['PASS', 'FAIL', 'UNCERTAIN'] },
              reason: { type: 'string', minLength: 1, maxLength: 400 },
            },
          },
        },
      },
    },
    placement: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['after-paragraph'] },
        size: { type: 'string', enum: ['compact', 'medium', 'wide'] },
        alignment: { type: 'string', enum: ['center'] },
      },
    },
  },
};
const view = {
  type: 'object',
  required: [
    'id',
    'bookId',
    'catalogId',
    'status',
    'stage',
    'originalName',
    'title',
    'chapters',
    'counts',
    'budget',
    'artifacts',
    'partial',
    'error',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: string,
    bookId: string,
    catalogId: string,
    status: {
      type: 'string',
      enum: ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'],
    },
    stage: {
      type: 'string',
      description:
        'Current processing step. art-plan creates the book-specific art direction before chapter planning and image generation; legacy task stages remain readable.',
    },
    originalName: string,
    title: nullable,
    artDirection,
    bookArtPlan,
    imageReview: {
      type: 'object',
      additionalProperties: false,
      required: ['enabled', 'description'],
      description:
        'Image review policy frozen for this task. New V9 tasks disable the secondary AI visual assessment while retaining deterministic file, source, anchor and EPUB validation. Historical V7/V8 assessments remain unchanged.',
      properties: { enabled: { type: 'boolean' }, description: string },
    },
    chapters: { type: 'array', items: chapter },
    counts: {
      type: 'object',
      required: [
        'total',
        'completed',
        'succeeded',
        'failed',
        'skipped',
        'unknown',
      ],
      properties: {
        total: integer,
        completed: integer,
        succeeded: integer,
        failed: integer,
        skipped: integer,
        unknown: integer,
        rejected: {
          ...integer,
          description:
            'Optional V7/V8 count of rejected or uncertain-quality images, separate from failed and included in completed.',
        },
      },
    },
    budget: {
      type: 'object',
      required: ['currency', 'maxCostMicros', 'upperBoundMicros'],
      properties: {
        currency: { type: 'string', enum: ['CNY'] },
        maxCostMicros: integer,
        upperBoundMicros: {
          ...integer,
          description:
            'Selection estimate: selected item count × perChapterUpperMicros + one fixed bookArtUpperMicros when present. This is an upper-bound estimate, not a final bill.',
        },
        enforced: { type: 'boolean' },
      },
    },
    artifacts: {
      type: 'object',
      required: ['epub', 'report', 'cover'],
      properties: { epub: nullable, report: nullable, cover: nullable },
    },
    partial: { type: 'boolean' },
    error,
    createdAt: string,
    updatedAt: string,
  },
};
const catalog = {
  type: 'object',
  required: [
    'catalogId',
    'sourceSha256',
    'parserVersion',
    'title',
    'chapters',
    'pricing',
  ],
  properties: {
    catalogId: string,
    sourceSha256: string,
    parserVersion: string,
    title: nullable,
    artDirection,
    visualReview: {
      type: 'object',
      additionalProperties: false,
      required: ['enabled', 'description'],
      properties: { enabled: { type: 'boolean' }, description: string },
    },
    artPlanning: {
      type: 'object',
      additionalProperties: false,
      required: ['mode', 'description'],
      description:
        'Optional declaration for new content-directed conversions. The free catalog does not invoke models or return a guessed book-specific palette.',
      properties: {
        mode: { type: 'string', enum: ['content-directed'] },
        description: { type: 'string', minLength: 1, maxLength: 2000 },
      },
    },
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'index', 'title', 'level', 'selectable', 'reasonCode'],
        properties: {
          id: string,
          index: { type: 'integer', minimum: -1 },
          title: string,
          level: integer,
          selectable: { type: 'boolean' },
          reasonCode: nullable,
          scope: { type: 'string', enum: ['chapter', 'section'] },
          sectionId: string,
          parentChapterTitle: string,
          boundaryKind: { type: 'string', enum: ['heading', 'document'] },
        },
      },
    },
    pricing: {
      type: 'object',
      required: [
        'currency',
        'perChapterUpperMicros',
        'maxBudgetMicros',
        'enabled',
      ],
      properties: {
        currency: { type: 'string', enum: ['CNY'] },
        perChapterUpperMicros: integer,
        bookArtUpperMicros: {
          ...integer,
          description:
            'Optional one-time estimate for planning this book art direction. Add once to the selected item count × perChapterUpperMicros; omitted by legacy catalogs.',
        },
        perChapterReviewUpperMicros: {
          ...integer,
          description:
            'Optional visual-review estimate already included in perChapterUpperMicros. Do not add it a second time.',
        },
        maxBudgetMicros: integer,
        enabled: { type: 'boolean' },
        budgetEnforced: { type: 'boolean' },
      },
    },
  },
};
const envelope = (data: Record<string, unknown>) => ({
  type: 'object',
  required: ['data', 'meta'],
  properties: {
    data,
    meta: {
      type: 'object',
      required: ['requestId'],
      properties: { requestId: string },
    },
  },
});
const querySchema = z
  .object({ requestKey: z.string().min(8).max(100) })
  .strict();

@ApiTags('illustration-conversions')
@UseGuards(BusinessAccessGuard)
@Controller('v1')
export class ConversionController {
  constructor(
    @Inject(ConversionService) private readonly service: ConversionService,
  ) {}
  @Get('books/:bookId/chapters')
  @ApiResponse({ status: 200, schema: envelope(catalog) })
  chapters(@Req() r: BusinessRequest, @Param('bookId') id: string) {
    return this.service.chapters(r.processingOwnerId, id);
  }

  @Get('books/:bookId/illustration-conversions/lookup')
  @ApiResponse({ status: 200, schema: envelope({ ...view, nullable: true }) })
  lookup(
    @Req() r: BusinessRequest,
    @Param('bookId') id: string,
    @Query() input: unknown,
  ) {
    const parsed = querySchema.safeParse(input);
    if (!parsed.success) throw businessError('INVALID_ILLUSTRATION_INPUT');
    return this.service.lookup(r.processingOwnerId, id, parsed.data.requestKey);
  }

  @Post('books/:bookId/illustration-conversions')
  @HttpCode(202)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['catalogId', 'chapterIds', 'maxCostMicros'],
      properties: {
        catalogId: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        chapterIds: {
          description:
            'Selectable subsection IDs from the current catalog; field name retained for wire compatibility.',
          type: 'array',
          minItems: 1,
          maxItems: 501,
          uniqueItems: true,
          items: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        },
        maxCostMicros: { type: 'integer', minimum: 1, maximum: 1000000000 },
      },
    },
  })
  @ApiResponse({ status: 202, schema: envelope(view) })
  create(
    @Req() r: BusinessRequest,
    @Param('bookId') id: string,
    @Body() input: unknown,
  ) {
    return this.service.create(
      r.processingOwnerId,
      id,
      input,
      r.headers['idempotency-key'],
    );
  }

  @Get('illustration-conversions/:id')
  @ApiResponse({ status: 200, schema: envelope(view) })
  get(@Req() r: BusinessRequest, @Param('id') id: string) {
    return this.service.get(r.processingOwnerId, id);
  }

  @Post('illustration-conversions/:id/cancel')
  @HttpCode(200)
  @ApiResponse({ status: 200, schema: envelope(view) })
  cancel(@Req() r: BusinessRequest, @Param('id') id: string) {
    return this.service.cancel(r.processingOwnerId, id);
  }

  @Get('illustration-conversions/:id/chapters/:chapterId/image')
  @ApiResponse({
    status: 200,
    description: 'Private hash-verified PNG',
    content: { 'image/png': { schema: { type: 'string', format: 'binary' } } },
  })
  async image(
    @Req() r: BusinessRequest,
    @Param('id') id: string,
    @Param('chapterId') chapterId: string,
    @Res() response: Response,
  ) {
    const result = await this.service.image(r.processingOwnerId, id, chapterId);
    response.set({
      'Content-Type': 'image/png',
      'Content-Length': String(result.byteSize),
      'Content-Disposition': 'inline; filename="chapter-illustration.png"',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    });
    await pipeline(createReadStream(result.file), response);
  }
}
