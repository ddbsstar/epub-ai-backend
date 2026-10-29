import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppConfig } from '../config/app-config.module.js';
import { ProcessingRepository } from '../processing/processing.repository.js';
import type { ProcessingRun } from '../processing/processing.types.js';
import { LocalArtifactStorage } from './artifact-storage.js';
import {
  businessError,
  exposeProcessingErrors,
  safeProcessingMessage,
} from './business-errors.js';
import { IllustrationWorkerService } from './illustration-worker.service.js';

const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const boundedText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .refine(
      (value) =>
        Array.from(value).length <= max &&
        Array.from(value).every((char) => {
          const code = char.codePointAt(0)!;
          return code < 0xd800 || code > 0xdfff;
        }),
    );
const planInput = z
  .object({ chapterIndex: z.number().int().min(0).max(500) })
  .strict();
const generateInput = z
  .object({ prompt: boundedText(800), alt: boundedText(500) })
  .strict();
const planConfiguration = z.object({
  chapterIndex: z.number().int().min(0).max(500),
  sceneDirection: z.string(),
});
const exportConfiguration = z.object({
  planRunId: z.uuid(),
  sourcePlanHash: z.string().regex(/^[a-f0-9]{64}$/),
  reviewKey: z.string().max(300),
  reviewHash: z.string().regex(/^[a-f0-9]{64}$/),
  reviewByteSize: z.number().int().positive().max(16384),
});
const sceneDirection =
  '从概要的事实依据中选择最有辨识度的自然环境或静物，画面完全无人。候选场景不安全时，可选择事实中的安全环境；不要画战争、暴力或亲密行为。建筑材质、服装、具体器物没有依据就省略，不把推测当事实。章末插画可回望本章开头。缺少安全依据仍可拒绝。';

@Injectable()
export class IllustrationService {
  constructor(
    @Inject(AppConfig) private readonly config: AppConfig,
    @Inject(ProcessingRepository)
    private readonly repository: ProcessingRepository,
    @Inject(LocalArtifactStorage)
    private readonly storage: LocalArtifactStorage,
    @Inject(IllustrationWorkerService)
    private readonly worker: IllustrationWorkerService,
  ) {}

  async createPlan(
    ownerId: string,
    bookId: string,
    input: unknown,
    key: unknown,
  ) {
    this.assertEnabled();
    this.assertId(bookId);
    this.assertKey(key);
    const parsed = planInput.safeParse(input);
    if (!parsed.success) throw businessError('INVALID_ILLUSTRATION_INPUT');
    const book = await exposeProcessingErrors(() =>
      this.repository.getBook(ownerId, bookId),
    );
    const configuration = {
      chapterIndex: parsed.data.chapterIndex,
      sceneDirection,
    };
    const created = await exposeProcessingErrors(() =>
      this.repository.createRun({
        ownerId,
        bookId,
        operation: 'illustration-plan',
        idempotencyKey: `illustration-plan:${bookId}:${parsed.data.chapterIndex}`,
        requestHash: digest({
          bookId,
          sourceHash: book.sourceHash,
          configuration,
          version: 'illustration-web-1',
        }),
        configuration,
        stages: ['illustration-plan'],
      }),
    );
    return this.view(ownerId, created.run);
  }

  async generate(
    ownerId: string,
    planId: string,
    input: unknown,
    key: unknown,
  ) {
    this.assertEnabled();
    this.assertId(planId);
    this.assertKey(key);
    const parsed = generateInput.safeParse(input);
    if (!parsed.success) throw businessError('INVALID_ILLUSTRATION_INPUT');
    if (
      Array.from(parsed.data.alt).some((char) => {
        const code = char.codePointAt(0)!;
        return (
          code === 127 ||
          !(
            [9, 10, 13].includes(code) ||
            (code >= 32 && code <= 0xd7ff) ||
            (code >= 0xe000 && code <= 0xfffd) ||
            (code >= 0x10000 && code <= 0x10ffff)
          )
        );
      })
    )
      throw businessError('INVALID_ILLUSTRATION_INPUT');
    const planRun = await this.ownedRun(ownerId, planId);
    if (
      planRun.operation !== 'illustration-plan' ||
      planRun.status !== 'SUCCEEDED'
    )
      throw businessError('ILLUSTRATION_PLAN_NOT_READY', 409);
    const plan = await exposeProcessingErrors(() =>
      this.worker.getPlanData(planRun),
    );
    const review = {
      sourcePlanHash: plan.sourcePlanHash,
      prompt: parsed.data.prompt,
      alt: parsed.data.alt,
    };
    const fingerprint = digest(review);
    const reviewKey = `illustration-reviews/${planId}/${fingerprint}.json`;
    let described: { sha256: string; byteSize: number };
    try {
      described = await this.storage.storeJson(reviewKey, review);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'EEXIST'
      )
        throw error;
      described = await this.storage.describe(reviewKey);
      if (digest(await this.storage.readJson(reviewKey)) !== fingerprint)
        throw businessError('ILLUSTRATION_REVIEW_CONFLICT', 409);
    }
    const configuration = {
      planRunId: planId,
      sourcePlanHash: plan.sourcePlanHash,
      reviewKey,
      reviewHash: described.sha256,
      reviewByteSize: described.byteSize,
    };
    const created = await exposeProcessingErrors(() =>
      this.repository.createRun({
        ownerId,
        bookId: planRun.bookId,
        operation: 'illustration-export',
        idempotencyKey: `illustration-export:${planId}`,
        requestHash: digest({
          planId,
          fingerprint,
          version: 'illustration-web-1',
        }),
        configuration,
        stages: ['illustration-export'],
      }),
    );
    return this.view(ownerId, created.run);
  }

  async get(ownerId: string, id: string) {
    this.assertId(id);
    return this.view(ownerId, await this.ownedRun(ownerId, id));
  }

  private async ownedRun(ownerId: string, id: string) {
    const run = await exposeProcessingErrors(() =>
      this.repository.getRun(ownerId, id),
    );
    if (!['illustration-plan', 'illustration-export'].includes(run.operation))
      throw businessError('RUN_NOT_FOUND', 404);
    await exposeProcessingErrors(() =>
      this.repository.getBook(ownerId, run.bookId),
    );
    return run;
  }

  private async view(ownerId: string, run: ProcessingRun) {
    const parent =
      run.operation === 'illustration-plan'
        ? run
        : await this.ownedRun(
            ownerId,
            exportConfiguration.parse(run.configuration).planRunId,
          );
    if (
      parent.operation !== 'illustration-plan' ||
      parent.bookId !== run.bookId
    )
      throw businessError('RUN_NOT_FOUND', 404);
    const settings = planConfiguration.parse(parent.configuration);
    const plan =
      parent.status === 'SUCCEEDED'
        ? await exposeProcessingErrors(() => this.worker.getPlanData(parent))
        : null;
    let prompt = plan?.prompt ?? null;
    let alt = plan?.alt ?? null;
    if (run.operation === 'illustration-export') {
      const configuration = exportConfiguration.parse(run.configuration);
      const description = await this.storage.describe(configuration.reviewKey);
      if (
        description.sha256 !== configuration.reviewHash ||
        description.byteSize !== configuration.reviewByteSize
      )
        throw businessError('ILLUSTRATION_REVIEW_CONFLICT', 409);
      const review = generateInput
        .extend({ sourcePlanHash: z.string() })
        .strict()
        .parse(await this.storage.readJson(configuration.reviewKey));
      if (
        review.sourcePlanHash !== plan?.sourcePlanHash ||
        review.sourcePlanHash !== configuration.sourcePlanHash
      )
        throw businessError('ILLUSTRATION_REVIEW_CONFLICT', 409);
      prompt = review.prompt;
      alt = review.alt;
    }
    const child =
      run.operation === 'illustration-plan'
        ? await exposeProcessingErrors(() =>
            this.repository.findRunByKey(
              ownerId,
              'illustration-export',
              `illustration-export:${parent.id}`,
            ),
          )
        : run;
    const artifacts: {
      image: string | null;
      epub: string | null;
      report: string | null;
    } = { image: null, epub: null, report: null };
    if (run.status === 'SUCCEEDED' && run.operation === 'illustration-export') {
      for (const id of run.artifactIds) {
        const artifact = await exposeProcessingErrors(() =>
          this.repository.getArtifact(ownerId, id),
        );
        const name =
          artifact.kind === 'illustration'
            ? 'image'
            : artifact.kind === 'export'
              ? 'epub'
              : artifact.kind;
        if (name === 'image' || name === 'epub' || name === 'report')
          artifacts[name] = `/api/v1/artifacts/${id}/download`;
      }
    }
    return {
      id: run.id,
      bookId: run.bookId,
      kind: run.operation === 'illustration-plan' ? 'plan' : 'export',
      planId: run.operation === 'illustration-plan' ? null : parent.id,
      exportId: child?.id ?? null,
      status: run.status,
      stage: run.stage,
      chapterIndex: settings.chapterIndex,
      chapterTitle: plan?.chapterTitle ?? null,
      concept: plan?.concept ?? null,
      prompt,
      alt,
      artifacts,
      error: run.errorCode
        ? { code: run.errorCode, message: safeProcessingMessage(run.errorCode) }
        : null,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  }

  private assertId(id: string) {
    if (!z.uuid().safeParse(id).success)
      throw businessError('RUN_NOT_FOUND', 404);
  }
  private assertKey(key: unknown) {
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(key))
      throw businessError('INVALID_IDEMPOTENCY_KEY');
  }
  private assertEnabled() {
    if (
      !this.config.get('PROCESSING_AI_ENABLED') ||
      !this.config.get('QWEN_ENABLED') ||
      !this.config.get('IMAGE_GENERATION_ENABLED') ||
      this.config.get('NODE_ENV') === 'production' ||
      this.config.get('PROCESSING_REPOSITORY') !== 'local'
    )
      throw businessError('ILLUSTRATION_DISABLED', 503);
  }
}
