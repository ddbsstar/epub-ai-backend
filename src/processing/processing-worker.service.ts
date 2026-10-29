import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.module.js';
import { EPUB_QUEUE_NAME } from '../queue/queue.service.js';
import { LocalProcessingPersistence } from './local-processing.persistence.js';
import { ProcessingRepository } from './processing.repository.js';
import {
  ProcessingError,
  type ClaimedStep,
  type JsonValue,
  type NewArtifact,
  type StepPayload,
} from './processing.types.js';

interface DispatchQueue {
  getJob(
    id: string,
  ): Promise<{ getState(): Promise<string> } | undefined | null>;
  add(
    name: string,
    payload: StepPayload,
    options: {
      jobId: string;
      attempts: number;
      removeOnComplete: { age: number; count: number };
      removeOnFail: { age: number; count: number };
    },
  ): Promise<unknown>;
}

export async function dispatchProcessingStep(
  repository: ProcessingRepository,
  queue: DispatchQueue,
  initial: StepPayload,
): Promise<void> {
  let payload = initial;
  const existing = await queue.getJob(
    `s-${payload.stepId}-d${payload.dispatchGeneration}`,
  );
  if (existing) {
    const state = await existing.getState();
    if (state !== 'failed' && state !== 'completed') return;
    const advanced = await repository.advanceDispatchGeneration(payload);
    if (!advanced) return;
    payload = advanced;
  }
  await queue.add('processing-step-v1', payload, {
    jobId: `s-${payload.stepId}-d${payload.dispatchGeneration}`,
    attempts: 1,
    removeOnComplete: { age: 86400, count: 1000 },
    removeOnFail: { age: 604800, count: 1000 },
  });
}

export type StepHandler = (
  context: ClaimedStep & { signal: AbortSignal },
) => Promise<{ result: JsonValue; artifacts?: NewArtifact[] }>;

@Injectable()
export class ProcessingWorkerService implements OnModuleDestroy {
  private stopping = false;
  private active?: AbortController;
  private loop?: Promise<void>;
  private worker?: Worker;
  private queue?: Queue;
  private workerConnection?: Redis;
  private producerConnection?: Redis;
  private releaseWorker?: () => Promise<void>;
  private readonly workerId = randomUUID();

  constructor(
    @Inject(AppConfig) private readonly config: AppConfig,
    @Inject(ProcessingRepository)
    private readonly repository: ProcessingRepository,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  run(handler: StepHandler): Promise<void> {
    if (this.loop) throw new ProcessingError('WORKER_ALREADY_STARTED', 500);
    if (!this.config.get('PROCESSING_ENABLED'))
      throw new ProcessingError('PROCESSING_DISABLED', 503);
    this.loop = this.start(handler).finally(async () => {
      await this.worker?.close().catch(() => undefined);
      await this.queue?.close().catch(() => undefined);
      this.workerConnection?.disconnect();
      this.producerConnection?.disconnect();
      await this.releaseWorker?.();
    });
    return this.loop;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.active?.abort();
    await this.loop;
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  private async start(handler: StepHandler): Promise<void> {
    if (this.repository.persistence instanceof LocalProcessingPersistence)
      this.releaseWorker =
        await this.repository.persistence.acquireWorkerLock();
    else {
      this.workerConnection = new Redis(this.config.get('REDIS_URL'), {
        maxRetriesPerRequest: null,
        connectTimeout: 1500,
      });
      this.producerConnection = new Redis(this.config.get('REDIS_URL'), {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        connectTimeout: 1500,
        commandTimeout: 1500,
      });
      this.workerConnection.on('error', () =>
        this.logger.warn({ event: 'processing_worker_redis_unavailable' }),
      );
      this.producerConnection.on('error', () =>
        this.logger.warn({ event: 'processing_dispatch_redis_unavailable' }),
      );
      this.queue = new Queue(EPUB_QUEUE_NAME, {
        connection: this.producerConnection,
        prefix: this.config.get('QUEUE_PREFIX'),
      });
      this.queue.on('error', () =>
        this.logger.warn({ event: 'processing_dispatch_unavailable' }),
      );
      this.worker = new Worker(
        EPUB_QUEUE_NAME,
        async (job) => {
          await this.execute(job.data as unknown, handler);
        },
        {
          connection: this.workerConnection,
          prefix: this.config.get('QUEUE_PREFIX'),
          concurrency: 1,
        },
      );
      this.worker.on('error', () =>
        this.logger.warn({ event: 'processing_worker_unavailable' }),
      );
      this.worker.on('failed', () =>
        this.logger.warn({ event: 'processing_step_delivery_failed' }),
      );
    }
    this.logger.info({
      event: 'processing_worker_started',
      driver: this.config.get('PROCESSING_REPOSITORY'),
      concurrency: 1,
    });
    while (!this.stopping) {
      try {
        await this.repository.recoverExpired();
        const payloads = await this.repository.listDispatchable();
        for (const payload of payloads) {
          if (this.stopping) break;
          if (this.queue)
            await dispatchProcessingStep(this.repository, this.queue, payload);
          else await this.execute(payload, handler);
        }
      } catch {
        this.logger.warn({ event: 'processing_dispatch_unavailable' });
      }
      if (!this.stopping) await delay(this.config.get('PROCESSING_POLL_MS'));
    }
  }

  private async execute(payload: unknown, handler: StepHandler): Promise<void> {
    if (this.stopping) return;
    const claimed = await this.repository.claim(
      payload,
      this.workerId,
      this.config.get('PROCESSING_LEASE_MS'),
    );
    if (!claimed) return;
    const controller = new AbortController();
    this.active = controller;
    let renewing = false;
    const heartbeat = setInterval(
      () => {
        if (renewing) return;
        renewing = true;
        void this.repository
          .heartbeat(claimed.lease, this.config.get('PROCESSING_LEASE_MS'))
          .then((valid) => {
            if (!valid) controller.abort();
          })
          .catch(() => controller.abort())
          .finally(() => {
            renewing = false;
          });
      },
      Math.max(100, Math.floor(this.config.get('PROCESSING_LEASE_MS') / 3)),
    );
    heartbeat.unref();
    try {
      const output = await handler({ ...claimed, signal: controller.signal });
      const committed = await this.repository.completeStep(
        claimed.lease,
        output.result,
        { artifacts: output.artifacts },
      );
      this.logger.info({
        event: committed
          ? 'processing_step_committed'
          : 'processing_step_fenced',
        runId: claimed.run.id,
        stepId: claimed.step.id,
      });
    } catch (error) {
      if (!this.stopping)
        await this.repository.failStep(
          claimed.lease,
          error instanceof ProcessingError ? error.code : 'PROCESSING_FAILED',
        );
      this.logger.warn({
        event: this.stopping
          ? 'processing_step_interrupted'
          : 'processing_step_failed',
        runId: claimed.run.id,
        stepId: claimed.step.id,
      });
    } finally {
      clearInterval(heartbeat);
      this.active = undefined;
    }
  }
}
