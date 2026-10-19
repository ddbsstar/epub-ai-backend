import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DatabaseService } from '../database/database.service.js';
import { QueueService } from '../queue/queue.service.js';
import { RedisService } from '../queue/redis.service.js';
import { AiService } from '../ai/ai.service.js';
import { ApiException } from '../common/http/api-exception.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(AiService) private readonly ai: AiService,
  ) {}

  @Get()
  @ApiOkResponse({
    description: '进程存活。依赖状态单独报告；不付费探测模型，不执行迁移。',
    schema: {
      type: 'object',
      required: ['data', 'meta'],
      properties: {
        data: {
          type: 'object',
          required: ['status', 'service', 'dependencies'],
          properties: {
            status: { type: 'string', enum: ['ok'] },
            service: { type: 'string', enum: ['epub-ai-backend'] },
            dependencies: {
              type: 'object',
              required: ['database', 'qwen', 'redis', 'queue'],
              additionalProperties: {
                type: 'string',
                enum: [
                  'disabled',
                  'not_configured',
                  'configured_not_checked',
                  'connected',
                  'unavailable',
                ],
              },
            },
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
    description: '请求超过速率限制',
    schema: {
      type: 'object',
      required: ['error', 'meta'],
      properties: {
        error: {
          type: 'object',
          required: ['code', 'message'],
          properties: {
            code: { type: 'string', example: 'RATE_LIMITED' },
            message: { type: 'string' },
            details: {},
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
  async getHealth() {
    return {
      status: 'ok',
      service: 'epub-ai-backend',
      dependencies: {
        database: await this.database.checkConnection(),
        qwen: this.ai.getStatus(),
        redis: this.redis.getStatus(),
        queue: this.queue.getStatus(),
      },
    };
  }

  @Get('ready')
  @ApiOkResponse({
    description:
      '已启用的数据库、Redis 和队列已就绪；不调用付费模型。响应使用统一 data/meta 封装。',
  })
  @ApiResponse({
    status: 503,
    description: '已启用的基础设施不可用，响应使用统一 error/meta 封装。',
  })
  async getReadiness() {
    const health = await this.getHealth();
    if (Object.values(health.dependencies).includes('unavailable')) {
      throw new ApiException(
        {
          code: 'SERVICE_UNAVAILABLE',
          message: '已启用的基础设施尚未就绪',
          details: health.dependencies,
        },
        503,
      );
    }
    return { ...health, status: 'ready' };
  }
}
