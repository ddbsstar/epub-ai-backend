import { Body, Controller, Inject, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiHeader,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  BusinessAccessGuard,
  type BusinessRequest,
} from './business-access.js';
import { FeedbackService } from './feedback.service.js';

@ApiTags('feedback')
@UseGuards(BusinessAccessGuard)
@Controller('v1/feedback')
export class FeedbackController {
  constructor(
    @Inject(FeedbackService) private readonly service: FeedbackService,
  ) {}
  @Post()
  @ApiConsumes('application/json')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Owner-scoped UUID; retry the same chosen payload with the same key.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['category', 'reader', 'deliveryRoute'],
      properties: {
        category: {
          type: 'string',
          enum: ['typography', 'processing', 'download', 'other'],
        },
        reader: {
          type: 'string',
          enum: [
            'kindle',
            'apple-books',
            'kobo',
            'calibre',
            'other',
            'not-tested',
          ],
        },
        deliveryRoute: {
          type: 'string',
          enum: [
            'send-to-kindle',
            'usb',
            'reader-import',
            'not-tested',
            'other',
          ],
        },
        rating: { type: 'string', enum: ['better', 'same', 'worse'] },
        requestId: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,128}$' },
        description: { type: 'string', maxLength: 1000 },
      },
    },
  })
  @ApiCreatedResponse({
    description:
      'Private feedback saved for 24 hours; no email response is promised.',
    schema: {
      type: 'object',
      required: ['data', 'meta'],
      properties: {
        data: {
          type: 'object',
          required: ['receiptId', 'expiresAt'],
          properties: {
            receiptId: { type: 'string', format: 'uuid' },
            expiresAt: { type: 'string', format: 'date-time' },
          },
        },
        meta: {
          type: 'object',
          required: ['requestId'],
          properties: { requestId: { type: 'string' } },
        },
      },
    },
  })
  @ApiResponse({
    status: 429,
    description: 'Owner or global feedback limit reached.',
  })
  @ApiResponse({
    status: 503,
    description: 'Feedback disabled or private storage unavailable.',
  })
  submit(@Req() request: BusinessRequest, @Body() body: unknown) {
    return this.service.submit(
      request.processingOwnerId,
      request.headers['idempotency-key'],
      body,
    );
  }
}
