import { Module } from '@nestjs/common';
import { QueueService } from './queue.service.js';
import { RedisService } from './redis.service.js';

@Module({
  providers: [RedisService, QueueService],
  exports: [RedisService, QueueService],
})
export class QueueModule {}
