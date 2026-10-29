import { mkdir, readFile, stat, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { processEpub, inspectEpubStructure } from '../documents/epub-engine.js';
import { EpubProcessingError } from '../documents/epub.types.js';
import { AiStructureService } from '../ai/ai-structure.service.js';
import { AppConfig } from '../config/app-config.module.js';
import { IllustrationWorkerService } from './illustration-worker.service.js';
import { ConversionWorkerService } from './conversion-worker.service.js';
import {
  ProcessingError,
  type JsonValue,
  type NewArtifact,
} from '../processing/processing.types.js';
import type { StepHandler } from '../processing/processing-worker.service.js';
import { LocalArtifactStorage } from './artifact-storage.js';
import {
  businessAiSchema,
  disabledAi,
  aiFallbackMessage,
} from './business-ai-view.js';
import {
  EpubCheckService,
  assertNoNewFormatErrors,
} from './epubcheck.service.js';
import { typographySummarySchema } from './business-typography.js';
import { BetaMaintenanceService } from './beta-maintenance.service.js';

const processCheckpoint = z.object({
  outputKey: z.string(),
  reportKey: z.string(),
  coverKey: z.string().nullable(),
  coverMediaType: z.enum(['image/jpeg', 'image/png']).nullable(),
  ai: businessAiSchema.optional(),
});
const planReference = z.object({
  storageKey: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z.number().int().positive().max(32768),
});
const analysisCheckpoint = z.object({
  ai: businessAiSchema,
  plan: planReference.nullable(),
});
const storedPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    snapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    roles: z
      .array(
        z
          .object({
            id: z.string().max(100),
            role: z.enum(['body', 'quote', 'poem', 'caption', 'section-title']),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
const validationCheckpoint = z.object({
  title: z.string().nullable(),
  summary: z.object({
    chapters: z.number(),
    styledChapters: z.number(),
    preservedChapters: z.number(),
    bodyBytesPreserved: z.boolean(),
    formatErrors: z.number(),
    formatWarnings: z.number(),
    typography: typographySummarySchema.optional(),
  }),
  warnings: z.array(z.string()),
  reportKey: z.string(),
});

@Injectable()
export class BusinessProcessingHandler {
  constructor(
    @Inject(AppConfig) private readonly config: AppConfig,
    @Inject(LocalArtifactStorage)
    private readonly storage: LocalArtifactStorage,
    @Inject(EpubCheckService) private readonly checker: EpubCheckService,
    @Inject(AiStructureService) private readonly ai: AiStructureService,
    @Inject(IllustrationWorkerService)
    private readonly illustrations: IllustrationWorkerService,
    @Inject(ConversionWorkerService)
    private readonly conversions: ConversionWorkerService,
    @Inject(BetaMaintenanceService)
    private readonly beta: BetaMaintenanceService,
  ) {}

  readonly handle: StepHandler = async (
    context,
  ): Promise<{ result: JsonValue; artifacts?: NewArtifact[] }> => {
    const { run, book, step, signal } = context;
    signal.throwIfAborted();
    if (
      this.config.get('PROCESSING_PUBLIC_BETA_ENABLED') &&
      (run.operation !== 'beautify' ||
        !run.configuration ||
        typeof run.configuration !== 'object' ||
        Array.isArray(run.configuration) ||
        run.configuration.theme !== 'reader-editorial')
    )
      throw new ProcessingError('INVALID_PROCESSING_CONFIGURATION');
    if (run.operation === 'illustration-conversion')
      return this.conversions.handle(context);
    if (
      run.operation === 'illustration-plan' ||
      run.operation === 'illustration-export'
    )
      return this.illustrations.handle(context);
    const configuration =
      run.configuration &&
      typeof run.configuration === 'object' &&
      !Array.isArray(run.configuration)
        ? run.configuration
        : {};
    const editorial = configuration.theme === 'reader-editorial';
    if (
      editorial &&
      (configuration.typographyProfile !== 'editorial-1' ||
        configuration.pipelineVersion !== 'reader-editorial-v1' ||
        configuration.ai !== false ||
        run.steps.some((entry) => entry.stage === 'analyze'))
    )
      throw new ProcessingError('INVALID_PROCESSING_CONFIGURATION');
    if (
      (await this.storage.describe(book.sourceKey)).sha256 !== book.sourceHash
    )
      throw new ProcessingError('SOURCE_CHANGED');
    if (step.stage === 'analyze') {
      const prefix = `runs/${run.id}/${step.id}-${step.leaseVersion}`;
      try {
        const snapshot = await inspectEpubStructure({
          sourcePath: this.storage.path(book.sourceKey),
          limits: {
            maxSourceBytes:
              this.config.get('PROCESSING_UPLOAD_MAX_MIB') * 1024 * 1024,
            ...(this.config.get('PROCESSING_PUBLIC_BETA_ENABLED')
              ? {
                  maxExpandedBytes: 64 * 1024 * 1024,
                  maxEntryBytes: 16 * 1024 * 1024,
                  maxXmlBytes: 2 * 1024 * 1024,
                  maxEntries: 2000,
                }
              : {}),
          },
          signal,
        });
        if (snapshot.sourceSha256 !== book.sourceHash)
          throw new ProcessingError('SOURCE_CHANGED');
        if (snapshot.blocks.length > 0) {
          // Complete the deterministic input/resource gate before any paid request.
          // This dedicated path has already passed LocalArtifactStorage's root containment check.
          const preflightDirectory = dirname(
            this.storage.path(`${prefix}/preflight/output.epub`),
          );
          try {
            await processEpub({
              sourcePath: this.storage.path(book.sourceKey),
              outputDirectory: preflightDirectory,
              limits: {
                maxSourceBytes:
                  this.config.get('PROCESSING_UPLOAD_MAX_MIB') * 1024 * 1024,
              },
              signal,
            });
          } finally {
            await rm(preflightDirectory, { recursive: true, force: true });
          }
        }
        const outcome = await this.ai.analyze(snapshot, {
          lease: context.lease,
          signal,
          planStore: {
            write: async (plan) => {
              const key = `${prefix}/model-plan-${randomUUID()}.json`;
              const description = await this.storage.storeJson(key, plan);
              return { storageKey: key, ...description };
            },
            read: (reference) => this.readPlan(reference),
          },
        });
        signal.throwIfAborted();
        const ai = businessAiSchema.parse({
          status: outcome.status,
          model: outcome.model ?? null,
          reasonCode: outcome.reasonCode,
          sampledBlocks: snapshot.blocks.length,
          appliedBlocks: 0,
          usage: outcome.usage ?? null,
          estimatedCostMicros: outcome.estimatedCostMicros ?? null,
          currency: 'CNY',
        });
        let plan: z.infer<typeof planReference> | null = null;
        if (outcome.status === 'APPLIED') {
          const validated = storedPlanSchema.parse(outcome.plan);
          const key = `${prefix}/validated-plan.json`;
          plan = {
            storageKey: key,
            ...(await this.storage.storeJson(key, validated)),
          };
        }
        return { result: { ai, plan } as JsonValue };
      } catch (error) {
        if (error instanceof EpubProcessingError)
          throw new ProcessingError(error.code);
        throw error;
      }
    }
    if (step.stage === 'process') {
      if (this.config.get('PROCESSING_PUBLIC_BETA_ENABLED')) {
        try {
          await this.beta.ensureCapacity();
        } catch {
          throw new ProcessingError('STORAGE_CAPACITY_EXCEEDED', 507);
        }
      }
      const prefix = `runs/${run.id}/${step.id}-${step.leaseVersion}`;
      const directory = this.storage.path(`${prefix}/output.epub`);
      await mkdir(dirname(directory), { recursive: true });
      try {
        const analyzed = run.steps.find((value) => value.stage === 'analyze');
        const analysis = analyzed
          ? analysisCheckpoint.parse(analyzed.result)
          : null;
        const structurePlan = analysis?.plan
          ? storedPlanSchema.parse(await this.readPlan(analysis.plan))
          : undefined;
        const result = await processEpub({
          sourcePath: this.storage.path(book.sourceKey),
          outputDirectory: dirname(directory),
          limits: {
            maxSourceBytes:
              this.config.get('PROCESSING_UPLOAD_MAX_MIB') * 1024 * 1024,
            ...(this.config.get('PROCESSING_PUBLIC_BETA_ENABLED')
              ? {
                  maxExpandedBytes: 64 * 1024 * 1024,
                  maxEntryBytes: 16 * 1024 * 1024,
                  maxXmlBytes: 2 * 1024 * 1024,
                  maxEntries: 2000,
                }
              : {}),
          },
          signal,
          structurePlan,
          ...(editorial ? { typographyProfile: 'editorial-1' as const } : {}),
        });
        if (
          result.report.sourceSha256 !== book.sourceHash ||
          !result.report.summary.bodyBytesPreserved
        )
          throw new ProcessingError('VALIDATION_FAILED');
        const coverKey = result.cover
          ? `${prefix}/${result.cover.mediaType === 'image/png' ? 'cover.png' : 'cover.jpg'}`
          : null;
        return {
          result: {
            outputKey: `${prefix}/output.epub`,
            reportKey: `${prefix}/report.json`,
            coverKey,
            coverMediaType: result.cover?.mediaType ?? null,
            ai: analysis
              ? {
                  ...analysis.ai,
                  appliedBlocks: result.report.structure.appliedBlocks,
                }
              : disabledAi(),
          },
        };
      } catch (error) {
        if (error instanceof EpubProcessingError)
          throw new ProcessingError(error.code);
        throw error;
      }
    }
    const processed = processCheckpoint.parse(
      run.steps.find((value) => value.stage === 'process')?.result,
    );
    if (step.stage === 'validate') {
      const prefix = `runs/${run.id}/${step.id}-${step.leaseVersion}`;
      await mkdir(dirname(this.storage.path(`${prefix}/input-check.json`)), {
        recursive: true,
      });
      const before = await this.checker.check(
        this.storage.path(book.sourceKey),
        this.storage.path(`${prefix}/input-check.json`),
        signal,
      );
      const after = await this.checker.check(
        this.storage.path(processed.outputKey),
        this.storage.path(`${prefix}/output-check.json`),
        signal,
      );
      assertNoNewFormatErrors(before, after);
      const engine = z
        .object({
          sourceSha256: z.string(),
          outputSha256: z.string(),
          summary: z.object({
            title: z.string().nullable(),
            chapters: z.number(),
            styledChapters: z.number(),
            preservedChapters: z.number(),
            bodyBytesPreserved: z.literal(true),
          }),
          warnings: z.array(z.object({ message: z.string() })),
          integrity: z.object({
            bodyBytesPreserved: z.literal(true),
            sourceUnchanged: z.literal(true),
          }),
          typography: typographySummarySchema.optional(),
        })
        .parse(await this.storage.readJson(processed.reportKey));
      const output = await this.storage.describe(processed.outputKey);
      if (
        output.sha256 !== engine.outputSha256 ||
        engine.sourceSha256 !== book.sourceHash
      )
        throw new ProcessingError('VALIDATION_FAILED');
      const summary = {
        chapters: engine.summary.chapters,
        styledChapters: engine.summary.styledChapters,
        preservedChapters: engine.summary.preservedChapters,
        bodyBytesPreserved: true,
        formatErrors: after.errors,
        formatWarnings: after.warnings,
        ...(engine.typography ? { typography: engine.typography } : {}),
      };
      const warnings = [
        ...new Set(engine.warnings.map((value) => value.message)),
      ].slice(0, 30);
      const ai = processed.ai ?? disabledAi();
      if (ai.status === 'FALLBACK')
        warnings.push(aiFallbackMessage(ai.reasonCode));
      if (ai.status === 'SKIPPED')
        warnings.push('未发现适合本轮 AI 判断的安全结构片段，已使用规则排版。');
      if (after.errors)
        warnings.push(
          `原书已有 ${after.errors} 项格式错误仍保留，本轮未增加新的格式错误。`,
        );
      if (after.warnings)
        warnings.push(
          `格式检查报告 ${after.warnings} 项警告，详情见处理报告。`,
        );
      if (summary.styledChapters === 0)
        warnings.push('本书结构较复杂，本轮保留原样；未强制应用统一样式。');
      const reportKey = `${prefix}/validation-report.json`;
      await this.storage.storeJson(reportKey, {
        schemaVersion: 1,
        pipelineVersion: editorial ? 'reader-editorial-v1' : 'reader-first-v2',
        aiUsed: ai.status === 'APPLIED',
        ai,
        modelCall: run.modelCall ?? null,
        sourceSha256: book.sourceHash,
        outputSha256: output.sha256,
        summary,
        warnings,
        engine: await this.storage.readJson(processed.reportKey),
        format: { before, after, newErrors: false },
        device: 'not-tested',
      });
      return {
        result: {
          title: engine.summary.title,
          summary,
          warnings,
          reportKey,
          ai,
        } as JsonValue,
      };
    }
    if (step.stage === 'publish') {
      const checked = validationCheckpoint.parse(
        run.steps.find((value) => value.stage === 'validate')?.result,
      );
      const artifacts: NewArtifact[] = [];
      for (const entry of [
        {
          kind: 'export',
          key: processed.outputKey,
          mediaType: 'application/epub+zip',
        },
        {
          kind: 'report',
          key: checked.reportKey,
          mediaType: 'application/json',
        },
        ...(processed.coverKey && processed.coverMediaType
          ? [
              {
                kind: 'cover',
                key: processed.coverKey,
                mediaType: processed.coverMediaType,
              },
            ]
          : []),
      ]) {
        const description = await this.storage.describe(entry.key);
        artifacts.push({
          kind: entry.kind,
          storageKey: entry.key,
          mediaType: entry.mediaType,
          ...description,
        });
      }
      // Publication checks the same source and output hashes as validation.
      const report = z
        .object({ outputSha256: z.string() })
        .parse(
          JSON.parse(
            await readFile(this.storage.path(checked.reportKey), 'utf8'),
          ),
        );
      if (artifacts[0]?.sha256 !== report.outputSha256)
        throw new ProcessingError('VALIDATION_FAILED');
      return { result: { published: true }, artifacts };
    }
    throw new ProcessingError('INVALID_PROCESSING_STAGE');
  };

  private async readPlan(
    reference: z.infer<typeof planReference>,
  ): Promise<unknown> {
    const checked = planReference.parse(reference);
    const path = this.storage.path(checked.storageKey);
    const file = await stat(path);
    if (!file.isFile() || file.size !== checked.byteSize)
      throw new ProcessingError('VALIDATION_FAILED');
    const bytes = await readFile(path);
    if (
      bytes.length !== checked.byteSize ||
      createHash('sha256').update(bytes).digest('hex') !== checked.sha256
    )
      throw new ProcessingError('VALIDATION_FAILED');
    return JSON.parse(bytes.toString('utf8'));
  }
}
