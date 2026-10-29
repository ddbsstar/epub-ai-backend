import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import { AppConfig } from '../config/app-config.module.js';
import type { Environment } from '../config/environment.js';
import { ProcessingRepository } from '../processing/processing.repository.js';
import type { StepHandler } from '../processing/processing-worker.service.js';
import {
  ProcessingError,
  type ClaimedStep,
  type JsonValue,
  type NewArtifact,
  type ProcessingRun,
} from '../processing/processing.types.js';
import { LocalArtifactStorage } from './artifact-storage.js';

const hash = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');
const digest = (value: unknown) => hash(JSON.stringify(value));
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const boundedText = (max: number) =>
  z
    .string()
    .min(1)
    .refine(
      (value) =>
        value.trim().length > 0 &&
        !/[\uD800-\uDFFF]/u.test(value) &&
        Array.from(value).length <= max,
    );
const referenceSchema = z
  .object({
    storageKey: z.string(),
    sha256: sha,
    byteSize: z.number().int().min(1).max(262144),
  })
  .strict();
const planConfiguration = z
  .object({
    chapterIndex: z.number().int().min(0).max(500),
    sceneDirection: boundedText(200).optional(),
  })
  .strict();
const exportConfiguration = z
  .object({
    planRunId: z.uuid(),
    sourcePlanHash: sha,
    reviewKey: z.string(),
    reviewHash: sha,
    reviewByteSize: z.number().int().min(1).max(16384),
  })
  .strict();
const reviewSchema = z
  .object({
    sourcePlanHash: sha,
    prompt: boundedText(800),
    alt: boundedText(500),
  })
  .strict();
const planPayload = z
  .object({
    schemaVersion: z.literal(1),
    decision: z.literal('ILLUSTRATE'),
    coverage: z.literal('COMPLETE'),
    sourceSha256: sha,
    chapterId: z.string().min(1).max(100),
    anchorId: sha,
    summary: boundedText(450),
    emotionalReading: boundedText(180),
    concept: boundedText(350),
    imagePrompt: boundedText(800),
    alt: boundedText(500),
    facts: z
      .array(
        z
          .object({
            text: boundedText(60),
            sourceBlockIds: z.array(sha).min(1).max(6),
          })
          .strict(),
      )
      .min(1)
      .max(6),
  })
  .passthrough();
const planViewSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceSha256: sha,
    sourcePlanHash: sha,
    chapterId: z.string().min(1).max(100),
    chapterTitle: boundedText(300),
    chapterIndex: z.number().int().min(0).max(500),
    sceneDirection: boundedText(200).optional(),
    summary: boundedText(450),
    concept: boundedText(350),
    prompt: boundedText(800),
    alt: boundedText(500),
  })
  .strict();
export type IllustrationPlanView = z.infer<typeof planViewSchema>;
export const ILLUSTRATION_CLI_RUNNER = Symbol('ILLUSTRATION_CLI_RUNNER');
export interface IllustrationCliRunner {
  run(
    this: void,
    input: {
      requestPath: string;
      until: 'plan' | 'image' | 'export' | 'book-art';
      environment: NodeJS.ProcessEnv;
      signal: AbortSignal;
    },
  ): Promise<void>;
}
const cliPath = fileURLToPath(
  new URL('../../scripts/illustrate-chapter.mjs', import.meta.url),
);

/** No shell, no prompt/credential arguments, no child output forwarding. */
export const illustrationCliRunner: IllustrationCliRunner = {
  run: ({ requestPath, until, environment, signal }) =>
    new Promise<void>((resolveRun, reject) => {
      if (signal.aborted) {
        reject(new ProcessingError('PROCESSING_CANCELLED'));
        return;
      }
      const child = spawn(
        process.execPath,
        [cliPath, '--request', requestPath, '--until', until],
        {
          cwd: dirname(dirname(cliPath)),
          env: environment,
          windowsHide: true,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stderr = '';
      let failure: string | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (error?: ProcessingError) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', cancel);
        if (killTimer) clearTimeout(killTimer);
        if (error) reject(error);
        else resolveRun();
      };
      const cancel = () => {
        failure ??= 'PROCESSING_CANCELLED';
        if (child.connected) child.send({ type: 'cancel' }, () => undefined);
        killTimer ??= setTimeout(() => {
          child.kill('SIGTERM');
        }, 3000);
        killTimer.unref();
      };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      child.stdout!.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > 65536) {
          failure = 'ILLUSTRATION_CHILD_OUTPUT_LIMIT';
          cancel();
        }
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > 16384) {
          failure = 'ILLUSTRATION_CHILD_OUTPUT_LIMIT';
          cancel();
        } else stderr += chunk.toString('utf8');
      });
      child.once('error', () =>
        finish(new ProcessingError('ILLUSTRATION_CHILD_FAILED')),
      );
      child.once('close', (code) => {
        if (failure) {
          finish(new ProcessingError(failure));
          return;
        }
        if (code === 0) {
          finish();
          return;
        }
        let safeCode = 'ILLUSTRATION_CHILD_FAILED';
        for (const line of stderr.split('\n')) {
          try {
            const parsed = z
              .object({
                error: z
                  .object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/) })
                  .strict(),
              })
              .strict()
              .safeParse(JSON.parse(line));
            if (parsed.success) safeCode = parsed.data.error.code;
          } catch {
            /* Raw child output is deliberately discarded. */
          }
        }
        finish(new ProcessingError(safeCode));
      });
    }),
};

@Injectable()
export class IllustrationWorkerService {
  constructor(
    @Inject(AppConfig) private readonly config: AppConfig,
    @Inject(LocalArtifactStorage)
    private readonly storage: LocalArtifactStorage,
    @Inject(ProcessingRepository)
    private readonly repository: ProcessingRepository,
    @Optional()
    @Inject(ILLUSTRATION_CLI_RUNNER)
    private readonly runner: IllustrationCliRunner = illustrationCliRunner,
  ) {}

  readonly handle: StepHandler = async (
    context,
  ): Promise<{ result: JsonValue; artifacts?: NewArtifact[] }> => {
    this.assertEnabled();
    await this.assertCurrent(context);
    const { run, book, signal } = context;
    const ownedBook = await this.repository.getBook(run.ownerId, run.bookId);
    if (
      book.id !== ownedBook.id ||
      book.sourceHash !== ownedBook.sourceHash ||
      (await this.storage.describe(ownedBook.sourceKey)).sha256 !==
        ownedBook.sourceHash
    )
      throw new ProcessingError('SOURCE_CHANGED');
    if (
      run.operation === 'illustration-plan' &&
      context.step.stage === 'illustration-plan'
    ) {
      const configuration = this.parse(planConfiguration, run.configuration);
      const output = this.outputDirectory(run.id);
      const request = {
        sourcePath: this.storage.path(ownedBook.sourceKey),
        outputDirectory: output,
        textStateDirectory: this.textStateDirectory(),
        chapterIndex: configuration.chapterIndex,
        operationId: run.id,
        ...(configuration.sceneDirection
          ? { sceneDirection: configuration.sceneDirection }
          : {}),
      };
      const requestPath = await this.freezeRequest(
        output,
        'request-plan.json',
        request,
      );
      await this.child(requestPath, 'plan', signal);
      await this.assertCurrent(context);
      const view = await this.readCompletedPlan(
        output,
        ownedBook.sourceHash,
        configuration,
      );
      const prefix = this.publicationPrefix(context);
      const storageKey = `${prefix}/illustration-plan.json`;
      const description = await this.storage.storeJson(storageKey, view);
      await this.assertCurrent(context);
      return {
        result: {
          illustration: {
            phase: 'plan',
            chapterTitle: view.chapterTitle,
            chapterIndex: view.chapterIndex,
          },
        },
        artifacts: [
          {
            storageKey,
            ...description,
            kind: 'illustration-plan',
            mediaType: 'application/json',
          },
        ],
      };
    }
    if (
      run.operation === 'illustration-export' &&
      context.step.stage === 'illustration-export'
    ) {
      const configuration = this.parse(exportConfiguration, run.configuration);
      const planRun = await this.repository.getRun(
        run.ownerId,
        configuration.planRunId,
      );
      if (planRun.bookId !== ownedBook.id)
        throw new ProcessingError('ILLUSTRATION_REVIEW_CONFLICT');
      const plan = await this.getPlanData(planRun);
      if (plan.sourcePlanHash !== configuration.sourcePlanHash)
        throw new ProcessingError('ILLUSTRATION_REVIEW_CONFLICT');
      if (
        !new RegExp(
          `^illustration-reviews/${planRun.id}/[a-f0-9]{64}\\.json$`,
        ).test(configuration.reviewKey)
      )
        throw new ProcessingError('ILLUSTRATION_REVIEW_CONFLICT');
      const review = this.parse(
        reviewSchema,
        await this.readReference({
          storageKey: configuration.reviewKey,
          sha256: configuration.reviewHash,
          byteSize: configuration.reviewByteSize,
        }),
      );
      if (review.sourcePlanHash !== plan.sourcePlanHash)
        throw new ProcessingError('ILLUSTRATION_REVIEW_CONFLICT');
      const output = this.outputDirectory(planRun.id);
      const planRequest = await this.readJsonFile(
        resolve(output, 'request-plan.json'),
        this.config.get('PROCESSING_DATA_DIR'),
        16384,
      );
      const expected = {
        sourcePath: this.storage.path(ownedBook.sourceKey),
        outputDirectory: output,
        textStateDirectory: this.textStateDirectory(),
        chapterIndex: plan.chapterIndex,
        operationId: planRun.id,
        ...(plan.sceneDirection ? { sceneDirection: plan.sceneDirection } : {}),
      };
      if (digest(planRequest) !== digest(expected))
        throw new ProcessingError('ILLUSTRATION_REVIEW_CONFLICT');
      const imagePromptReview = {
        ...review,
        reason: '用户在页面确认或调整画面描述',
      };
      const requestPath = await this.freezeRequest(
        output,
        `request-export-${run.id}.json`,
        { ...expected, imagePromptReview },
      );
      await this.child(requestPath, 'export', signal);
      await this.assertCurrent(context);
      const artifacts = await this.exportArtifacts(
        context,
        output,
        plan,
        imagePromptReview,
      );
      await this.assertCurrent(context);
      return {
        result: {
          illustration: {
            phase: 'export',
            planRunId: planRun.id,
            sourcePlanHash: plan.sourcePlanHash,
          },
          title: plan.chapterTitle,
        },
        artifacts,
      };
    }
    throw new ProcessingError('INVALID_PROCESSING_STAGE');
  };

  async getPlanData(planRun: ProcessingRun): Promise<IllustrationPlanView> {
    const current = await this.repository.getRun(planRun.ownerId, planRun.id);
    if (
      current.operation !== 'illustration-plan' ||
      current.status !== 'SUCCEEDED'
    )
      throw new ProcessingError('ILLUSTRATION_PLAN_NOT_READY', 409);
    const book = await this.repository.getBook(current.ownerId, current.bookId);
    const configuration = this.parse(planConfiguration, current.configuration);
    const matches = [];
    for (const id of current.artifactIds) {
      const artifact = await this.repository.getArtifact(current.ownerId, id);
      if (artifact.kind === 'illustration-plan') matches.push(artifact);
    }
    if (matches.length !== 1)
      throw new ProcessingError('ILLUSTRATION_PLAN_INVALID');
    const artifact = matches[0]!;
    if (!artifact.storageKey.startsWith(`runs/${current.id}/`))
      throw new ProcessingError('ILLUSTRATION_PLAN_INVALID');
    const plan = this.parse(planViewSchema, await this.readReference(artifact));
    if (
      plan.sourceSha256 !== book.sourceHash ||
      plan.chapterIndex !== configuration.chapterIndex ||
      plan.sceneDirection !== configuration.sceneDirection
    )
      throw new ProcessingError('ILLUSTRATION_PLAN_INVALID');
    return plan;
  }

  private async readCompletedPlan(
    output: string,
    sourceSha256: string,
    configuration: z.infer<typeof planConfiguration>,
  ) {
    const receipt = this.parse(
      z
        .object({
          stage: z.literal('plan'),
          sourceSha256: sha,
          chapterId: z.string().min(1).max(100),
          chapterTitle: boundedText(300),
          sourcePlanHash: sha,
          planPath: z.string(),
        })
        .strict(),
      await this.readJsonFile(resolve(output, 'stage-receipt.json'), output),
    );
    if (
      receipt.sourceSha256 !== sourceSha256 ||
      resolve(receipt.planPath) !== resolve(output, 'plan.json')
    )
      throw new ProcessingError('ILLUSTRATION_PLAN_INVALID');
    const plan = this.parse(
      planPayload,
      await this.readJsonFile(resolve(output, 'plan.json'), output),
    );
    const sourcePlanHash = digest({
      sourceSha256: plan.sourceSha256,
      chapterId: plan.chapterId,
      coverage: plan.coverage,
      summary: plan.summary,
      emotionalReading: plan.emotionalReading,
      facts: plan.facts,
      anchorId: plan.anchorId,
      concept: plan.concept,
      imagePrompt: plan.imagePrompt,
      alt: plan.alt,
    });
    if (
      sourcePlanHash !== receipt.sourcePlanHash ||
      plan.sourceSha256 !== sourceSha256 ||
      plan.chapterId !== receipt.chapterId
    )
      throw new ProcessingError('ILLUSTRATION_PLAN_INVALID');
    return planViewSchema.parse({
      schemaVersion: 1,
      sourceSha256,
      sourcePlanHash,
      chapterId: plan.chapterId,
      chapterTitle: receipt.chapterTitle,
      ...configuration,
      summary: plan.summary,
      concept: plan.concept,
      prompt: plan.imagePrompt,
      alt: plan.alt,
    });
  }

  private async exportArtifacts(
    context: ClaimedStep & { signal: AbortSignal },
    output: string,
    plan: IllustrationPlanView,
    review: z.infer<typeof reviewSchema> & { reason: string },
  ): Promise<NewArtifact[]> {
    const final = this.parse(
      z
        .object({
          schemaVersion: z.literal(1),
          sourceSha256: sha,
          sourcePlanHash: sha,
          coverage: z.literal('COMPLETE'),
          planHash: sha,
          imageSha256: sha,
          imageCallId: z.uuid(),
          outputPath: z.string(),
          outputSha256: sha,
          byteSize: z.number().int().min(1),
          check: z
            .object({
              errors: z.literal(0),
              fatal: z.literal(0),
              warnings: z.number().int().nonnegative(),
            })
            .passthrough(),
        })
        .passthrough(),
      await this.readJsonFile(resolve(output, 'pipeline-result.json'), output),
    );
    if (
      final.sourceSha256 !== context.book.sourceHash ||
      final.sourcePlanHash !== plan.sourcePlanHash ||
      final.planHash !==
        digest({ sourcePlanHash: plan.sourcePlanHash, review }) ||
      resolve(final.outputPath) !== resolve(output, 'illustrated.epub')
    )
      throw new ProcessingError('ILLUSTRATION_OUTPUT_INVALID');
    const image = this.parse(
      z
        .object({
          callId: z.uuid(),
          asset: z
            .object({
              path: z.string(),
              sha256: sha,
              byteSize: z
                .number()
                .int()
                .min(1)
                .max(this.config.get('IMAGE_MAX_BYTES')),
              width: z.number().int().positive(),
              height: z.number().int().positive(),
              mediaType: z.literal('image/png'),
            })
            .strict(),
        })
        .passthrough(),
      await this.readJsonFile(resolve(output, 'image-receipt.json'), output),
    );
    if (
      image.callId !== final.imageCallId ||
      image.asset.sha256 !== final.imageSha256 ||
      resolve(image.asset.path) !==
        resolve(
          this.config.get('IMAGE_DATA_DIR'),
          'assets',
          `${image.callId}.png`,
        )
    )
      throw new ProcessingError('ILLUSTRATION_OUTPUT_INVALID');
    const integrity = this.parse(
      z
        .object({
          sourceSha256: sha,
          outputSha256: sha,
          integrity: z
            .object({
              sourceUnchanged: z.literal(true),
              originalBodySourceFragmentsPreserved: z.literal(true),
              exactAllowlistedInsertion: z.literal(true),
              originalImagesPreserved: z.literal(true),
              originalIdsPreserved: z.literal(true),
              spineOrderPreserved: z.literal(true),
              navigationTargetsPreserved: z.literal(true),
              internalReferencesChecked: z.literal(true),
              writtenArchiveHashesVerified: z.literal(true),
              bodyBytesPreserved: z.literal(false),
            })
            .strict(),
        })
        .passthrough(),
      await this.readJsonFile(
        resolve(output, 'illustration-report.json'),
        output,
      ),
    );
    if (
      integrity.sourceSha256 !== final.sourceSha256 ||
      integrity.outputSha256 !== final.outputSha256
    )
      throw new ProcessingError('ILLUSTRATION_OUTPUT_INVALID');
    await this.safeFile(
      final.outputPath,
      output,
      this.config.get('PROCESSING_UPLOAD_MAX_MIB') * 1024 * 1024 +
        32 * 1024 * 1024,
    );
    await this.safeFile(
      image.asset.path,
      this.config.get('IMAGE_DATA_DIR'),
      this.config.get('IMAGE_MAX_BYTES'),
    );
    const prefix = this.publicationPrefix(context);
    const outputKey = `${prefix}/illustrated.epub`;
    const imageKey = `${prefix}/illustration.png`;
    const outputDescription = await this.storage.storeCopy(
      outputKey,
      final.outputPath,
    );
    const imageDescription = await this.storage.storeCopy(
      imageKey,
      image.asset.path,
    );
    if (
      outputDescription.sha256 !== final.outputSha256 ||
      outputDescription.byteSize !== final.byteSize ||
      imageDescription.sha256 !== image.asset.sha256 ||
      imageDescription.byteSize !== image.asset.byteSize
    )
      throw new ProcessingError('ILLUSTRATION_OUTPUT_INVALID');
    const reportKey = `${prefix}/illustration-report.json`;
    const reportDescription = await this.storage.storeJson(reportKey, {
      schemaVersion: 1,
      pipelineVersion: 'chapter-illustration-ui-1',
      sourceSha256: final.sourceSha256,
      outputSha256: final.outputSha256,
      sourcePlanHash: plan.sourcePlanHash,
      chapterTitle: plan.chapterTitle,
      chapterIndex: plan.chapterIndex,
      imagePromptReviewed: true,
      coverage: 'COMPLETE',
      integrity: integrity.integrity,
      image: {
        sha256: image.asset.sha256,
        width: image.asset.width,
        height: image.asset.height,
      },
      format: { errors: 0, fatal: 0, warnings: final.check.warnings },
      readerDeviceValidated: false,
    });
    return [
      {
        storageKey: outputKey,
        ...outputDescription,
        mediaType: 'application/epub+zip',
        kind: 'export',
      },
      {
        storageKey: reportKey,
        ...reportDescription,
        mediaType: 'application/json',
        kind: 'report',
      },
      {
        storageKey: imageKey,
        ...imageDescription,
        mediaType: 'image/png',
        kind: 'illustration',
      },
    ];
  }

  private outputDirectory(runId: string) {
    if (!z.uuid().safeParse(runId).success)
      throw new ProcessingError('ILLUSTRATION_PLAN_INVALID');
    return dirname(this.storage.path(`illustration-jobs/${runId}/plan.json`));
  }
  private textStateDirectory() {
    return dirname(this.storage.path('illustration-text-state/metadata.json'));
  }
  private publicationPrefix(context: ClaimedStep) {
    return `runs/${context.run.id}/${context.step.id}-${context.lease.leaseVersion}-${randomUUID()}`;
  }
  private async freezeRequest(output: string, name: string, value: unknown) {
    const path = resolve(output, name);
    await mkdir(output, { recursive: true, mode: 0o700 });
    try {
      await writeFile(path, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        digest(await this.readJsonFile(path, output, 16384)) !== digest(value)
      )
        throw new ProcessingError('ILLUSTRATION_REVIEW_CONFLICT');
    }
    return path;
  }
  private async child(
    requestPath: string,
    until: 'plan' | 'export',
    caller: AbortSignal,
  ) {
    const timeout = AbortSignal.timeout(15 * 60 * 1000);
    try {
      await this.runner.run({
        requestPath,
        until,
        environment: this.environment(),
        signal: AbortSignal.any([caller, timeout]),
      });
    } catch (error) {
      if (caller.aborted) throw new ProcessingError('PROCESSING_CANCELLED');
      if (timeout.aborted) throw new ProcessingError('ILLUSTRATION_TIMEOUT');
      if (error instanceof ProcessingError) throw error;
      throw new ProcessingError('ILLUSTRATION_CHILD_FAILED');
    }
  }
  private environment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { ...process.env };
    const keys: (keyof Environment)[] = [
      'NODE_ENV',
      'HOST',
      'QWEN_ENABLED',
      'QWEN_API_KEY',
      'QWEN_BASE_URL',
      'QWEN_MODEL',
      'QWEN_TIMEOUT_MS',
      'QWEN_MAX_OUTPUT_TOKENS',
      'IMAGE_GENERATION_ENABLED',
      'IMAGE_API_KEY',
      'IMAGE_API_BASE_URL',
      'IMAGE_MODEL',
      'IMAGE_SIZE',
      'IMAGE_TIMEOUT_MS',
      'IMAGE_DATA_DIR',
      'IMAGE_DOWNLOAD_HOSTS',
      'IMAGE_MAX_BYTES',
      'IMAGE_MAX_PIXELS',
      'IMAGE_PRICE_MICROS',
      'IMAGE_OPERATION_BUDGET_MICROS',
      'IMAGE_DAILY_BUDGET_MICROS',
      'IMAGE_PRICE_VERSION',
      'PROCESSING_ENABLED',
      'PROCESSING_AI_ENABLED',
      'PROCESSING_REPOSITORY',
      'PROCESSING_DATA_DIR',
      'EPUBCHECK_JAR_PATH',
      'EPUBCHECK_JAVA_PATH',
      'EPUBCHECK_TIMEOUT_MS',
      'AI_INPUT_TOKEN_BUDGET',
      'AI_MAX_MESSAGE_BYTES',
      'AI_MAX_RESPONSE_BYTES',
      'AI_RUN_BUDGET_MICROS',
      'AI_DAILY_BUDGET_MICROS',
      'AI_INPUT_PRICE_MICROS_PER_MILLION',
      'AI_OUTPUT_PRICE_MICROS_PER_MILLION',
      'AI_PRICE_VERSION',
    ];
    for (const key of keys) environment[key] = String(this.config.get(key));
    return environment;
  }
  private assertEnabled() {
    if (
      this.config.get('NODE_ENV') === 'production' ||
      this.config.get('PROCESSING_REPOSITORY') !== 'local' ||
      !this.config.get('PROCESSING_ENABLED') ||
      !this.config.get('PROCESSING_AI_ENABLED') ||
      !this.config.get('QWEN_ENABLED') ||
      !this.config.get('IMAGE_GENERATION_ENABLED')
    )
      throw new ProcessingError('ILLUSTRATION_DISABLED', 503);
  }
  private async assertCurrent(context: ClaimedStep & { signal: AbortSignal }) {
    if (context.signal.aborted)
      throw new ProcessingError('PROCESSING_CANCELLED');
    if (
      !(await this.repository.heartbeat(
        context.lease,
        this.config.get('PROCESSING_LEASE_MS'),
      ))
    )
      throw new ProcessingError('STALE_PROCESSING_LEASE');
  }
  private parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new ProcessingError('ILLUSTRATION_PLAN_INVALID');
    return result.data;
  }
  private async safeFile(path: string, root: string, maxBytes: number) {
    const target = resolve(path);
    const base = resolve(root);
    const within = relative(base, target);
    if (
      !isAbsolute(path) ||
      !within ||
      within.startsWith(`..${sep}`) ||
      isAbsolute(within)
    )
      throw new ProcessingError('ILLUSTRATION_PRIVATE_FILE_INVALID');
    const segments = within.split(sep);
    let current = base;
    for (const [index, segment] of ['', ...segments].entries()) {
      if (segment) current = resolve(current, segment);
      const info = await lstat(current);
      if (
        info.isSymbolicLink() ||
        (index < segments.length && !info.isDirectory())
      )
        throw new ProcessingError('ILLUSTRATION_PRIVATE_FILE_INVALID');
      if (
        index === segments.length &&
        (!info.isFile() || info.size < 1 || info.size > maxBytes)
      )
        throw new ProcessingError('ILLUSTRATION_PRIVATE_FILE_INVALID');
    }
  }
  private async readJsonFile(
    path: string,
    root: string,
    maxBytes = 262144,
  ): Promise<unknown> {
    try {
      await this.safeFile(path, root, maxBytes);
      const bytes = await readFile(path);
      if (bytes.length > maxBytes) throw new Error();
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      ) as unknown;
    } catch {
      throw new ProcessingError('ILLUSTRATION_PRIVATE_FILE_INVALID');
    }
  }
  private async readReference(
    reference: z.infer<typeof referenceSchema>,
  ): Promise<unknown> {
    const checked = this.parse(referenceSchema, {
      storageKey: reference.storageKey,
      sha256: reference.sha256,
      byteSize: reference.byteSize,
    });
    const path = this.storage.path(checked.storageKey);
    await this.safeFile(
      path,
      this.config.get('PROCESSING_DATA_DIR'),
      checked.byteSize,
    );
    const bytes = await readFile(path);
    if (bytes.length !== checked.byteSize || hash(bytes) !== checked.sha256)
      throw new ProcessingError('ILLUSTRATION_PRIVATE_FILE_INVALID');
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      ) as unknown;
    } catch {
      throw new ProcessingError('ILLUSTRATION_PRIVATE_FILE_INVALID');
    }
  }
}
