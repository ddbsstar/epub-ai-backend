import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { QueueService } from '../src/queue/queue.service.js';
import { RedisService } from '../src/queue/redis.service.js';

describe.runIf(process.env.RUN_INFRA_INTEGRATION === 'true')(
  'Isolated infrastructure',
  () => {
    it('applies migrations, uses MySQL and persists a queue item, then closes resources', async () => {
      if (
        !process.env.DATABASE_URL?.includes('127.0.0.1:3307/') ||
        !process.env.REDIS_URL?.includes('127.0.0.1:6380')
      ) {
        throw new Error(
          'Integration tests require the isolated localhost 3307/6380 services.',
        );
      }
      const app = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      await app.init();
      const database = app.get(DatabaseService);
      const queue = app.get(QueueService).getQueue();
      const id = randomUUID();
      let queueId: string | undefined;
      try {
        expect(await database.checkConnection()).toBe('connected');
        expect(app.get(RedisService).getStatus()).toBe('connected');
        await database
          .getClient()
          .backgroundJob.create({ data: { id, type: 'infrastructure-check' } });
        expect(
          (
            await database
              .getClient()
              .backgroundJob.findUnique({ where: { id } })
          )?.status,
        ).toBe('queued');
        const job = await queue.add(
          'infrastructure-check',
          { recordId: id },
          { jobId: id },
        );
        queueId = job.id;
        expect(await queue.getJob(id)).toBeDefined();
      } finally {
        if (queueId) await (await queue.getJob(queueId))?.remove();
        await database.getClient().backgroundJob.deleteMany({ where: { id } });
        await app.close();
      }
    }, 20000);
  },
);
