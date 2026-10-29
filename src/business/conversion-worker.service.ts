import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import { AppConfig } from '../config/app-config.module.js';
import { AiService } from '../ai/ai.service.js';
import {
  IllustrationVisualReviewer,
  illustrationVisualReviewSchema,
  publicVisualReviewSchema,
  type IllustrationVisualReview,
} from '../ai/illustration-visual-reviewer.js';
import {
  illustrationArtDirectionSchema,
  resolveArtDirection,
  assertArtDirectedPrompt,
  artDirectionHash,
} from '../ai/illustration-art-direction.js';
import {
  bookArtPlanSchema,
  bookArtPlanHash,
  type BookArtPlan,
} from '../ai/book-art-planner.js';
import {
  illustrationVisualPlanSchema,
  contentPeopleVisualPlanSchema,
  compileContentIllustrationPrompt,
} from '../ai/chapter-illustration-planner.js';
import type { Environment } from '../config/environment.js';
import {
  inspectIllustrationChapter,
  type IllustrationChapterIndex,
} from '../documents/chapter-illustration-index.js';
import { insertEpubIllustrations } from '../documents/illustrated-epub.js';
import { ProcessingRepository } from '../processing/processing.repository.js';
import type { StepHandler } from '../processing/processing-worker.service.js';
import {
  ProcessingError,
  type ClaimedStep,
  type ProcessingRun,
} from '../processing/processing.types.js';
import { LocalArtifactStorage } from './artifact-storage.js';
import { EpubCheckService } from './epubcheck.service.js';
import {
  ILLUSTRATION_CLI_RUNNER,
  illustrationCliRunner,
  type IllustrationCliRunner,
} from './illustration-worker.service.js';
import {
  conversionConfigurationSchema,
  conversionProgressSchema,
  conversionSelectionSchema,
  conversionPricing,
  CONVERSION_CONTENT_STYLE_VERSION,
  CONVERSION_PEOPLE_PLANNING_POLICY,
  CONVERSION_UNREVIEWED_PIPELINE_VERSION,
  conversionRequiresReview,
  type ConversionProgress,
  type ConversionUnit,
} from './conversion.types.js';

const hash = (value: Buffer | string) =>
  createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(JSON.stringify(value));
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const text = (maximum: number) =>
  z
    .string()
    .min(1)
    .refine(
      (value) =>
        !/[\uD800-\uDFFF]/u.test(value) && Array.from(value).length <= maximum,
    );
const referenceSchema = z
  .object({
    storageKey: z.string(),
    sha256: sha,
    byteSize: z
      .number()
      .int()
      .positive()
      .max(2 * 1024 * 1024),
  })
  .strict();
const planSchema = z
  .object({
    schemaVersion: z.literal(1),
    decision: z.literal('ILLUSTRATE'),
    coverage: z.literal('COMPLETE'),
    sourceSha256: sha,
    chapterId: sha,
    anchorId: sha,
    layout: z.enum(['compact', 'medium', 'wide']).optional(),
    settingEvidenceBlockIds: z.array(sha).min(1).max(6).optional(),
    sceneEvidenceBlockIds: z.array(sha).min(1).max(6).optional(),
    layoutSource: z.enum(['model', 'default']).optional(),
    summary: text(450),
    emotionalReading: text(180),
    facts: z
      .array(
        z
          .object({
            text: text(60),
            sourceBlockIds: z.array(sha).min(1).max(6),
          })
          .strict(),
      )
      .min(1)
      .max(6),
    concept: text(350),
    imagePrompt: text(800),
    artDirection: illustrationArtDirectionSchema.optional(),
    artDirectionHash: sha.optional(),
    visualPlan: z
      .union([illustrationVisualPlanSchema, contentPeopleVisualPlanSchema])
      .optional(),
    planningPolicy: z.literal(CONVERSION_PEOPLE_PLANNING_POLICY).optional(),
    sceneDescription: text(140).optional(),
    depicts: z.enum(['adults-only', 'no-people']).optional(),
    alt: text(500),
  })
  .passthrough();
const planReceiptSchema = z
  .object({
    stage: z.literal('plan'),
    sourceSha256: sha,
    chapterId: sha,
    chapterTitle: text(1000),
    sourcePlanHash: sha,
    planPath: z.string(),
  })
  .strict();
const imageReceiptSchema = z
  .object({
    callId: z.uuid(),
    asset: z
      .object({
        path: z.string(),
        sha256: sha,
        byteSize: z.number().int().positive(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        mediaType: z.literal('image/png'),
      })
      .strict(),
  })
  .passthrough();
const imageStageSchema = z
  .object({
    stage: z.literal('image'),
    callId: z.uuid(),
    sourceSha256: sha,
    chapterId: sha,
    sourcePlanHash: sha,
    anchorId: sha,
  })
  .strict();
const planFingerprint = (plan: z.infer<typeof planSchema>) =>
  digest({
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
    ...(plan.layout
      ? {
          layout: plan.layout,
          settingEvidenceBlockIds: plan.settingEvidenceBlockIds,
          ...(plan.sceneEvidenceBlockIds
            ? { sceneEvidenceBlockIds: plan.sceneEvidenceBlockIds }
            : {}),
          ...(plan.layoutSource ? { layoutSource: plan.layoutSource } : {}),
        }
      : {}),
    ...(plan.artDirection
      ? {
          artDirection: plan.artDirection,
          artDirectionHash: plan.artDirectionHash,
        }
      : {}),
    ...(plan.visualPlan ? { visualPlan: plan.visualPlan } : {}),
    ...(plan.sceneDescription
      ? { sceneDescription: plan.sceneDescription }
      : {}),
    ...(plan.planningPolicy ? { planningPolicy: plan.planningPolicy } : {}),
  });
const terminal = new Set([
  'SUCCEEDED',
  'FAILED',
  'SKIPPED',
  'UNKNOWN',
  'REJECTED',
]);
const sceneDirection =
  '统一全书的克制文学插画：有限色彩、留白、清晰构图，扁平独立画面，不画书本、样机、页面、相框、文字或水印。优先依据原文可证实的环境与物件表达章节情绪，不虚构时代、建筑、服装或人物身份。';

const inlineSceneDirection =
  '按当前小节的实际内容表达，不把技术或知识内容改编成文学情节。叙事小节采用克制、留白、有限色彩的独立书籍插画；知识小节只表现原文明确支持的物件或关系。场景优先取自当前小节具体段落，尺寸与构图相适应。禁止书本样机、页面、相框、文字、水印；不虚构时代、服装或人物身份。';

export const CONVERSION_DOCUMENTS = Symbol('CONVERSION_DOCUMENTS');
export const CONVERSION_VISUAL_REVIEWER = Symbol('CONVERSION_VISUAL_REVIEWER');
export type ConversionVisualReviewer = Pick<
  IllustrationVisualReviewer,
  'review'
>;
export interface ConversionDocuments {
  inspect: typeof inspectIllustrationChapter;
  insert: typeof insertEpubIllustrations;
}
const documents: ConversionDocuments = {
  inspect: inspectIllustrationChapter,
  insert: insertEpubIllustrations,
};

/** One immutable source, independently cached chapter calls, one final archive. */
@Injectable()
export class ConversionWorkerService {
  private readonly reviewer: ConversionVisualReviewer;
  constructor(
    @Inject(AppConfig) private readonly config: AppConfig,
    @Inject(LocalArtifactStorage)
    private readonly storage: LocalArtifactStorage,
    @Inject(ProcessingRepository)
    private readonly repository: ProcessingRepository,
    @Inject(EpubCheckService) private readonly checker: EpubCheckService,
    @Optional()
    @Inject(ILLUSTRATION_CLI_RUNNER)
    private readonly runner: IllustrationCliRunner = illustrationCliRunner,
    @Optional()
    @Inject(CONVERSION_DOCUMENTS)
    private readonly documentOperations: ConversionDocuments = documents,
    @Optional()
    @Inject(CONVERSION_VISUAL_REVIEWER)
    reviewer?: ConversionVisualReviewer,
  ) {
    let defaultReviewer: IllustrationVisualReviewer | undefined;
    this.reviewer = reviewer ?? {
      review: (input) => {
        defaultReviewer ??= new IllustrationVisualReviewer(
          config,
          repository,
          new AiService(config),
          storage.path('visual-reviews'),
        );
        return defaultReviewer.review(input);
      },
    };
  }

  readonly handle: StepHandler = async (context): ReturnType<StepHandler> => {
    this.assertEnabled();
    await this.assertCurrent(context);
    if (context.run.operation !== 'illustration-conversion')
      throw new ProcessingError('INVALID_PROCESSING_STAGE');
    const configuration = this.parse(
      conversionConfigurationSchema,
      context.run.configuration,
    );
    const reviewed = conversionRequiresReview(configuration.pipelineVersion);
    const explicitlyUnreviewed =
      configuration.pipelineVersion === CONVERSION_UNREVIEWED_PIPELINE_VERSION;
    if (reviewed && !this.config.get('VISUAL_REVIEW_ENABLED'))
      throw new ProcessingError('VISUAL_REVIEW_DISABLED', 503);
    this.assertPricing(configuration);
    if (
      configuration.budgetEnforced !== false &&
      this.config.get('BUDGET_LIMITS_ENABLED') !== false &&
      configuration.upperBoundMicros >
        this.config.get('ILLUSTRATION_BATCH_BUDGET_MICROS')
    )
      throw new ProcessingError('CONVERSION_BUDGET_EXCEEDED');
    const owned = await this.repository.getBook(
      context.run.ownerId,
      context.run.bookId,
    );
    const source = await this.storage.describe(owned.sourceKey);
    if (
      owned.sourceHash !== configuration.sourceHash ||
      source.sha256 !== owned.sourceHash ||
      context.book.id !== owned.id ||
      context.book.sourceHash !== owned.sourceHash
    )
      throw new ProcessingError('SOURCE_CHANGED');
    const selection = this.parse(
      conversionSelectionSchema,
      await this.readReference({
        storageKey: configuration.selectionKey,
        sha256: configuration.selectionHash,
        byteSize: configuration.selectionByteSize,
      }),
    );
    if (
      selection.chapters.some(
        (chapter) =>
          (chapter.scope === 'section') !== !!chapter.sectionId ||
          (chapter.scope === 'section' &&
            (chapter.sectionId !== chapter.id ||
              chapter.placementMode !== 'content-inline-v2')),
      ) ||
      selection.catalogId !== configuration.catalogId ||
      selection.sourceSha256 !== owned.sourceHash ||
      selection.chapters.length * configuration.perChapterUpperMicros +
        (configuration.bookArtUpperMicros ?? 0) !==
        configuration.upperBoundMicros ||
      (configuration.budgetEnforced !== false &&
        this.config.get('BUDGET_LIMITS_ENABLED') !== false &&
        configuration.upperBoundMicros > configuration.maxCostMicros)
    )
      throw new ProcessingError('CONVERSION_SELECTION_INVALID');

    const contentDirected =
      configuration.styleVersion === CONVERSION_CONTENT_STYLE_VERSION;
    if (context.step.stage === 'art-plan') {
      if (!contentDirected || !configuration.artSeed)
        throw new ProcessingError('INVALID_PROCESSING_STAGE');
      const seed = configuration.artSeed;
      const operationId = digest([
        context.run.ownerId,
        owned.id,
        owned.sourceHash,
        configuration.bookArtPolicyVersion,
        configuration.pricingHash,
        seed.id,
      ]);
      const outputDirectory = dirname(
        this.storage.path(`book-art/${operationId}/book-art-plan.json`),
      );
      const requestPath = await this.freezeRequest(outputDirectory, {
        sourcePath: this.storage.path(owned.sourceKey),
        outputDirectory,
        textStateDirectory: dirname(
          this.storage.path('illustration-text-state/metadata.json'),
        ),
        chapterIndex: seed.index,
        sectionId: seed.sectionId,
        placementMode: 'content-inline-v2',
        operationId,
      });
      await this.child(requestPath, 'book-art', context.signal);
      await this.assertCurrent(context);
      const plan = this.parse(
        bookArtPlanSchema,
        await this.readJsonFile(
          resolve(outputDirectory, 'book-art-plan.json'),
          outputDirectory,
        ),
      );
      const receipt = this.parse(
        z
          .object({
            stage: z.literal('book-art'),
            sourceSha256: sha,
            chapterId: sha,
            bookArtPlanHash: sha,
          })
          .strict(),
        await this.readJsonFile(
          resolve(outputDirectory, 'stage-receipt.json'),
          outputDirectory,
        ),
      );
      if (
        plan.sourceSha256 !== owned.sourceHash ||
        receipt.sourceSha256 !== owned.sourceHash ||
        receipt.chapterId !== seed.id ||
        receipt.bookArtPlanHash !== bookArtPlanHash(plan)
      )
        throw new ProcessingError('ART_DIRECTION_INVALID');
      resolveArtDirection(plan.artDirection, undefined, owned.sourceHash);
      const storageKey = `${this.publicationPrefix(context)}/book-art-plan.json`;
      const reference = await this.storage.storeJson(storageKey, plan);
      await this.assertCurrent(context);
      return {
        result: {
          bookArtPlan: { storageKey, ...reference },
          bookArtPlanHash: bookArtPlanHash(plan),
        },
      };
    }
    const bookArtPlan = contentDirected
      ? await this.readBookArtPlan(context.run)
      : null;
    if (contentDirected && !bookArtPlan)
      throw new ProcessingError('ART_DIRECTION_INVALID');
    const expectedArt = bookArtPlan
      ? {
          artDirection: bookArtPlan.artDirection,
          artDirectionHash: artDirectionHash(bookArtPlan.artDirection),
          ...(configuration.planningPolicy
            ? { planningPolicy: configuration.planningPolicy }
            : {}),
        }
      : configuration;
    const semanticBookPlanHash = bookArtPlan
      ? bookArtPlanHash(bookArtPlan)
      : undefined;

    if (context.step.stage === 'convert') {
      let progress = await this.readProgress(context.run);
      if (!progress)
        progress = conversionProgressSchema.parse({
          schemaVersion: 1,
          sourceSha256: owned.sourceHash,
          catalogId: selection.catalogId,
          chapters: selection.chapters.map((chapter) => ({
            ...chapter,
            status: 'WAITING',
            errorCode: null,
            image: null,
            anchor: null,
            alt: null,
          })),
        });
      this.assertSelection(progress, selection);
      await this.checkpoint(context, progress);
      for (const chapter of progress.chapters) {
        if (terminal.has(chapter.status)) continue;
        await this.assertCurrent(context);
        this.assertPricing(configuration);
        try {
          const index = await this.documentOperations.inspect({
            sourcePath: this.storage.path(owned.sourceKey),
            chapterIndex: chapter.index,
            ...(chapter.sectionId ? { sectionId: chapter.sectionId } : {}),
            signal: context.signal,
          });
          if (
            index.sourceSha256 !== owned.sourceHash ||
            index.chapterId !== chapter.id ||
            index.title !== chapter.title ||
            (chapter.scope === 'section' &&
              (index.scope !== 'section' ||
                index.sectionId !== chapter.sectionId))
          )
            throw new ProcessingError('CONVERSION_SELECTION_INVALID');
          const childId = digest([
            context.run.ownerId,
            owned.id,
            owned.sourceHash,
            chapter.id,
            configuration.styleVersion,
            configuration.pricingHash,
            ...(expectedArt.artDirectionHash
              ? [expectedArt.artDirectionHash]
              : []),
            ...(semanticBookPlanHash ? [semanticBookPlanHash] : []),
            ...(configuration.pipelineVersion
              ? [configuration.pipelineVersion]
              : []),
          ]);
          const outputDirectory = dirname(
            this.storage.path(`conversion-chapters/${childId}/plan.json`),
          );
          const request = {
            sourcePath: this.storage.path(owned.sourceKey),
            outputDirectory,
            textStateDirectory: dirname(
              this.storage.path('illustration-text-state/metadata.json'),
            ),
            chapterIndex: chapter.index,
            operationId: childId,
            ...(configuration.planningPolicy
              ? { planningPolicy: configuration.planningPolicy }
              : {}),
            ...(semanticBookPlanHash
              ? { bookArtPlanHash: semanticBookPlanHash }
              : {}),
            ...(expectedArt.artDirection
              ? {
                  artDirection: expectedArt.artDirection,
                  artDirectionHash: expectedArt.artDirectionHash,
                }
              : {}),
            ...(chapter.sectionId
              ? {
                  sectionId: chapter.sectionId,
                  placementMode: 'content-inline-v2',
                }
              : {}),
            sceneDirection:
              chapter.scope === 'section'
                ? inlineSceneDirection
                : sceneDirection,
          };
          const requestPath = await this.freezeRequest(
            outputDirectory,
            request,
          );
          chapter.status = 'PLANNING';
          await this.checkpoint(context, progress);
          await this.child(requestPath, 'plan', context.signal);
          await this.assertCurrent(context);
          const plan = await this.readPlan(
            outputDirectory,
            index,
            false,
            expectedArt,
          );
          chapter.anchor = this.anchor(index, plan.anchorId);
          chapter.alt = plan.alt;
          if (plan.visualPlan) chapter.visualPlan = plan.visualPlan;
          if (chapter.scope === 'section') {
            if (!plan.layout)
              throw new ProcessingError('ILLUSTRATION_PLAN_INVALID');
            chapter.layout = { size: plan.layout, alignment: 'center' };
          }
          chapter.status = 'GENERATING';
          await this.checkpoint(context, progress);
          this.assertPricing(configuration);
          await this.child(requestPath, 'image', context.signal);
          await this.assertCurrent(context);
          // Re-validate the generated plan and source-bound anchor after child output.
          const finalPlan = await this.readPlan(
            outputDirectory,
            index,
            true,
            expectedArt,
          );
          if (planFingerprint(finalPlan) !== planFingerprint(plan))
            throw new ProcessingError('ILLUSTRATION_PLAN_INVALID');
          chapter.image = await this.copyImage(
            outputDirectory,
            index,
            plan,
            childId,
          );
          if (explicitlyUnreviewed)
            chapter.sourcePlanHash = planFingerprint(finalPlan);
          if (reviewed) {
            chapter.sourcePlanHash = planFingerprint(finalPlan);
            chapter.status = 'REVIEWING';
            delete chapter.visualReview;
            delete chapter.visualReviewReference;
            await this.checkpoint(context, progress);
            this.assertPricing(configuration);
            await this.assertCurrent(context);
            const review = this.parse(
              illustrationVisualReviewSchema,
              await this.reviewer.review({
                chapter: index,
                plan: finalPlan,
                sourcePlanHash: chapter.sourcePlanHash,
                image: {
                  path: this.storage.path(chapter.image.storageKey),
                  sha256: chapter.image.sha256,
                  byteSize: chapter.image.byteSize,
                },
                context: {
                  ownerId: context.run.ownerId,
                  bookId: owned.id,
                  operationId: childId,
                  parentRunId: context.run.id,
                  ...(configuration.planningPolicy
                    ? { planningPolicy: configuration.planningPolicy }
                    : {}),
                  signal: context.signal,
                },
              }),
            );
            await this.assertCurrent(context);
            this.assertReviewBindings(
              review,
              chapter,
              owned.sourceHash,
              expectedArt.artDirectionHash,
              configuration.planningPolicy,
            );
            const reviewKey = `${this.publicationPrefix(context)}/visual-review-${chapter.id}.json`;
            chapter.visualReviewReference = {
              storageKey: reviewKey,
              ...(await this.storage.storeJson(reviewKey, review)),
            };
            chapter.visualReview = this.publicReview(review);
            chapter.status =
              review.status === 'PASSED' ? 'SUCCEEDED' : 'REJECTED';
            chapter.errorCode =
              review.status === 'PASSED'
                ? null
                : review.status === 'REJECTED'
                  ? 'VISUAL_REVIEW_REJECTED'
                  : 'VISUAL_REVIEW_UNCERTAIN';
          } else {
            chapter.status = 'SUCCEEDED';
            chapter.errorCode = null;
          }
        } catch (error) {
          if (context.signal.aborted)
            throw new ProcessingError('PROCESSING_CANCELLED');
          if (
            error instanceof ProcessingError &&
            error.code === 'STALE_PROCESSING_LEASE'
          )
            throw error;
          const code = this.safeCode(error);
          if (
            [
              'SOURCE_CHANGED',
              'CONVERSION_SELECTION_INVALID',
              'CONVERSION_PRICING_CHANGED',
            ].includes(code)
          )
            throw error;
          chapter.status =
            /(?:_BUDGET_|_INPUT_LIMIT$|_NOT_CONFIGURED$|_DISABLED$|_INVALID_INPUT$)/u.test(
              code,
            )
              ? 'FAILED'
              : /(?:DECLINED|UNSUPPORTED_|NO_SAFE_|AMBIGUOUS_|FIXED_LAYOUT|ENCRYPTED_EPUB|CHAPTER_TEXT_LIMIT)/u.test(
                    code,
                  )
                ? 'SKIPPED'
                : /(?:UNKNOWN|AI_|VISUAL_REVIEW_(?:TIMEOUT|UPSTREAM_ERROR)|ILLUSTRATION_(?:CHILD_FAILED|TIMEOUT|PLAN_INVALID|PLANNING_FAILED|CLI_FAILED)|IMAGE_)/u.test(
                      code,
                    )
                  ? 'UNKNOWN'
                  : 'FAILED';
          chapter.errorCode = code;
          chapter.image = null;
          chapter.anchor = null;
          chapter.alt = null;
          delete chapter.visualReview;
          delete chapter.visualReviewReference;
        }
        await this.checkpoint(context, progress);
      }
      await this.assertCurrent(context);
      return { result: await this.storeProgress(context, progress) };
    }

    if (context.step.stage !== 'assemble')
      throw new ProcessingError('INVALID_PROCESSING_STAGE');
    const progress = await this.readProgress(context.run);
    if (!progress) throw new ProcessingError('CONVERSION_PROGRESS_INVALID');
    this.assertSelection(progress, selection);
    if (progress.chapters.some((chapter) => !terminal.has(chapter.status)))
      throw new ProcessingError('CONVERSION_PROGRESS_INVALID');
    const successes = progress.chapters.filter(
      (chapter) => chapter.status === 'SUCCEEDED',
    );
    if (!successes.length) {
      if (!reviewed) throw new ProcessingError('CONVERSION_NO_IMAGES');
      const reportKey = `${this.publicationPrefix(context)}/conversion-report.json`;
      const reportDescription = await this.storage.storeJson(reportKey, {
        schemaVersion: 1,
        pipelineVersion: 'chapter-illustration-conversion-2',
        sourceSha256: owned.sourceHash,
        outputSha256: null,
        visualReviewPolicyVersion: configuration.visualReviewPolicyVersion,
        ...(configuration.planningPolicy
          ? { planningPolicy: configuration.planningPolicy }
          : {}),
        visualReview: 'no-approved-images',
        ...(expectedArt.artDirection
          ? {
              artDirection: expectedArt.artDirection,
              artDirectionHash: expectedArt.artDirectionHash,
            }
          : {}),
        selectedChapters: progress.chapters.length,
        insertedIllustrations: 0,
        chapters: progress.chapters.map(
          ({
            id,
            index,
            title,
            status,
            errorCode,
            visualReview,
            visualPlan,
          }) => ({
            id,
            index,
            title,
            status,
            errorCode,
            ...(visualReview ? { visualReview } : {}),
            ...(visualPlan ? { visualPlan } : {}),
            image: null,
          }),
        ),
        budget: {
          upperBoundMicros: configuration.upperBoundMicros,
          maxCostMicros: configuration.maxCostMicros,
          perChapterUpperMicros: configuration.perChapterUpperMicros,
          pricingHash: configuration.pricingHash,
          accounting: 'conservative-admission-upper-bound',
          reconciledProviderBill: false,
        },
        readerDeviceValidated: false,
      });
      await this.assertCurrent(context);
      return {
        result: {
          ...(await this.storeProgress(context, progress)),
          insertedIllustrations: 0,
        },
        artifacts: [
          {
            storageKey: reportKey,
            ...reportDescription,
            mediaType: 'application/json',
            kind: 'report',
          },
        ],
      };
    }
    const insertions = [];
    for (const chapter of successes) {
      if (!chapter.image || !chapter.anchor || !chapter.alt)
        throw new ProcessingError('CONVERSION_PROGRESS_INVALID');
      await this.verifyImage(chapter.image);
      if (reviewed || explicitlyUnreviewed) {
        const index = await this.documentOperations.inspect({
          sourcePath: this.storage.path(owned.sourceKey),
          chapterIndex: chapter.index,
          ...(chapter.sectionId ? { sectionId: chapter.sectionId } : {}),
          signal: context.signal,
        });
        const childId = digest([
          context.run.ownerId,
          owned.id,
          owned.sourceHash,
          chapter.id,
          configuration.styleVersion,
          configuration.pricingHash,
          ...(expectedArt.artDirectionHash
            ? [expectedArt.artDirectionHash]
            : []),
          ...(semanticBookPlanHash ? [semanticBookPlanHash] : []),
          ...(configuration.pipelineVersion
            ? [configuration.pipelineVersion]
            : []),
        ]);
        const output = dirname(
          this.storage.path(`conversion-chapters/${childId}/plan.json`),
        );
        const finalPlan = await this.readPlan(output, index, true, expectedArt);
        if (
          index.sourceSha256 !== owned.sourceHash ||
          index.chapterId !== chapter.id ||
          chapter.sourcePlanHash !== planFingerprint(finalPlan) ||
          digest(chapter.anchor) !==
            digest(this.anchor(index, finalPlan.anchorId)) ||
          chapter.alt !== finalPlan.alt ||
          chapter.layout?.size !== finalPlan.layout
        )
          throw new ProcessingError(
            reviewed ? 'VISUAL_REVIEW_INVALID' : 'ILLUSTRATION_PLAN_INVALID',
          );
        if (explicitlyUnreviewed) {
          const boundImage = await this.copyImage(
            output,
            index,
            finalPlan,
            childId,
          );
          if (digest(boundImage) !== digest(chapter.image))
            throw new ProcessingError('ILLUSTRATION_OUTPUT_INVALID');
        }
        if (reviewed) {
          const review = await this.readVisualReview(
            context.run,
            chapter,
            expectedArt.artDirectionHash,
          );
          if (review.status !== 'PASSED')
            throw new ProcessingError('VISUAL_REVIEW_INVALID');
        }
      }
      insertions.push({
        anchor: chapter.anchor,
        image: {
          path: this.storage.path(chapter.image.storageKey),
          sha256: chapter.image.sha256,
        },
        alt: chapter.alt,
        ...(chapter.layout ? { layout: chapter.layout } : {}),
      });
    }
    const prefix = this.publicationPrefix(context);
    const outputDirectory = dirname(
      this.storage.path(`${prefix}/assembled/result.json`),
    );
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    await this.assertCurrent(context);
    const inserted = await this.documentOperations.insert({
      sourcePath: this.storage.path(owned.sourceKey),
      sourceSha256: owned.sourceHash,
      insertions,
      outputDirectory,
      signal: context.signal,
    });
    await this.assertCurrent(context);
    await this.safeFile(
      inserted.outputPath,
      outputDirectory,
      this.config.get('PROCESSING_UPLOAD_MAX_MIB') * 1024 * 1024 +
        successes.length * this.config.get('IMAGE_MAX_BYTES') +
        32 * 1024 * 1024,
    );
    const checked = await this.checker.check(
      inserted.outputPath,
      resolve(outputDirectory, 'epubcheck.json'),
      context.signal,
    );
    if (
      checked.errors ||
      checked.fatal ||
      inserted.report.sourceSha256 !== owned.sourceHash ||
      inserted.report.illustrations.length !== successes.length ||
      Object.entries(inserted.report.integrity).some(([key, value]) =>
        key === 'bodyBytesPreserved' ? value !== false : value !== true,
      )
    )
      throw new ProcessingError('ILLUSTRATION_OUTPUT_INVALID');
    const outputKey = `${prefix}/illustrated.epub`;
    const outputDescription = await this.storage.storeCopy(
      outputKey,
      inserted.outputPath,
    );
    if (
      outputDescription.sha256 !== inserted.report.outputSha256 ||
      (await this.storage.describe(owned.sourceKey)).sha256 !== owned.sourceHash
    )
      throw new ProcessingError('SOURCE_CHANGED');
    const reportKey = `${prefix}/conversion-report.json`;
    const reportDescription = await this.storage.storeJson(reportKey, {
      schemaVersion: 1,
      pipelineVersion: explicitlyUnreviewed
        ? 'chapter-illustration-conversion-3'
        : reviewed
          ? 'chapter-illustration-conversion-2'
          : 'chapter-illustration-conversion-1',
      ...(explicitlyUnreviewed
        ? { imageReviewMode: 'disabled', visualReview: 'disabled-by-request' }
        : {}),
      sourceSha256: owned.sourceHash,
      outputSha256: outputDescription.sha256,
      ...(expectedArt.artDirection
        ? {
            artDirection: expectedArt.artDirection,
            artDirectionHash: expectedArt.artDirectionHash,
            visualReview: explicitlyUnreviewed
              ? 'disabled-by-request'
              : reviewed
                ? 'automated-gated'
                : 'unreviewed',
          }
        : {}),
      ...(reviewed
        ? { visualReviewPolicyVersion: configuration.visualReviewPolicyVersion }
        : {}),
      ...(configuration.planningPolicy
        ? { planningPolicy: configuration.planningPolicy }
        : {}),
      ...(bookArtPlan
        ? {
            bookArtPlan: {
              schemaVersion: bookArtPlan.schemaVersion,
              sourceSha256: bookArtPlan.sourceSha256,
              evidenceSha256: bookArtPlan.evidenceSha256,
              reading: bookArtPlan.reading,
              coverage: bookArtPlan.coverage,
              artDirection: bookArtPlan.artDirection,
              planHash: semanticBookPlanHash,
            },
          }
        : {}),
      selectedChapters: progress.chapters.length,
      insertedIllustrations: successes.length,
      chapters: progress.chapters.map(
        ({
          id,
          index,
          title,
          scope,
          sectionId,
          parentChapterTitle,
          status,
          errorCode,
          image,
          layout,
          visualPlan,
          visualReview,
        }) => ({
          id,
          index,
          title,
          status,
          errorCode,
          ...(scope ? { scope, sectionId, parentChapterTitle } : {}),
          ...(visualPlan ? { visualPlan } : {}),
          ...(visualReview ? { visualReview } : {}),
          ...(layout
            ? { placement: { kind: 'after-paragraph', ...layout } }
            : {}),
          image:
            image && status === 'SUCCEEDED'
              ? {
                  sha256: image.sha256,
                  width: image.width,
                  height: image.height,
                }
              : null,
        }),
      ),
      budget: {
        upperBoundMicros: configuration.upperBoundMicros,
        maxCostMicros: configuration.maxCostMicros,
        perChapterUpperMicros: configuration.perChapterUpperMicros,
        pricingHash: configuration.pricingHash,
        accounting: 'conservative-admission-upper-bound',
        enforced: configuration.budgetEnforced !== false,
        ...(configuration.bookArtUpperMicros !== undefined
          ? { bookArtUpperMicros: configuration.bookArtUpperMicros }
          : {}),
        reconciledProviderBill: false,
      },
      integrity: inserted.report.integrity,
      ...(inserted.report.phases.baseline.sourceRepairs
        ? {
            sourceRepairs: inserted.report.phases.baseline.sourceRepairs,
            baselineOriginalResourcesPreserved: false,
          }
        : {}),
      format: {
        errors: checked.errors,
        fatal: checked.fatal,
        warnings: checked.warnings,
      },
      readerDeviceValidated: false,
    });
    await this.assertCurrent(context);
    return {
      result: {
        ...(await this.storeProgress(context, progress)),
        insertedIllustrations: successes.length,
      },
      artifacts: [
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
      ],
    };
  };

  async readBookArtPlan(run: ProcessingRun): Promise<BookArtPlan | null> {
    const current = await this.repository.getRun(run.ownerId, run.id);
    const configuration = this.parse(
      conversionConfigurationSchema,
      current.configuration,
    );
    if (configuration.styleVersion !== CONVERSION_CONTENT_STYLE_VERSION)
      return null;
    const book = await this.repository.getBook(current.ownerId, current.bookId);
    const result = [...current.steps]
      .reverse()
      .find(
        (step) =>
          step.result &&
          typeof step.result === 'object' &&
          !Array.isArray(step.result) &&
          'bookArtPlan' in step.result,
      )?.result;
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      !('bookArtPlan' in result)
    )
      return null;
    const reference = this.parse(referenceSchema, result.bookArtPlan);
    if (!reference.storageKey.startsWith(`runs/${run.id}/`))
      throw new ProcessingError('ART_DIRECTION_INVALID');
    const plan = this.parse(
      bookArtPlanSchema,
      await this.readReference(reference),
    );
    if (
      plan.sourceSha256 !== book.sourceHash ||
      configuration.sourceHash !== book.sourceHash ||
      !('bookArtPlanHash' in result) ||
      result.bookArtPlanHash !== bookArtPlanHash(plan)
    )
      throw new ProcessingError('ART_DIRECTION_INVALID');
    resolveArtDirection(plan.artDirection, undefined, book.sourceHash);
    return plan;
  }

  async readProgress(run: ProcessingRun): Promise<ConversionProgress | null> {
    if (run.operation !== 'illustration-conversion')
      throw new ProcessingError('CONVERSION_PROGRESS_INVALID');
    const current = await this.repository.getRun(run.ownerId, run.id);
    await this.repository.getBook(current.ownerId, current.bookId);
    const result = [...current.steps]
      .reverse()
      .find(
        (step) =>
          step.result &&
          typeof step.result === 'object' &&
          !Array.isArray(step.result) &&
          'progress' in step.result,
      )?.result;
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      !('progress' in result)
    )
      return null;
    const reference = this.parse(referenceSchema, result.progress);
    if (!reference.storageKey.startsWith(`runs/${run.id}/`))
      throw new ProcessingError('CONVERSION_PROGRESS_INVALID');
    const progress = this.parse(
      conversionProgressSchema,
      await this.readReference(reference),
    );
    const configuration = this.parse(
      conversionConfigurationSchema,
      current.configuration,
    );
    if (
      progress.sourceSha256 !== configuration.sourceHash ||
      progress.catalogId !== configuration.catalogId
    )
      throw new ProcessingError('CONVERSION_PROGRESS_INVALID');
    const selection = this.parse(
      conversionSelectionSchema,
      await this.readReference({
        storageKey: configuration.selectionKey,
        sha256: configuration.selectionHash,
        byteSize: configuration.selectionByteSize,
      }),
    );
    this.assertSelection(progress, selection);
    if (
      progress.chapters.some(
        (chapter) =>
          chapter.status === 'SUCCEEDED' &&
          (!chapter.image || !chapter.anchor || !chapter.alt),
      )
    )
      throw new ProcessingError('CONVERSION_PROGRESS_INVALID');
    if (conversionRequiresReview(configuration.pipelineVersion)) {
      const bookArtPlan = await this.readBookArtPlan(current);
      if (
        progress.chapters.some(
          (chapter) =>
            chapter.status === 'SUCCEEDED' || chapter.status === 'REJECTED',
        ) &&
        !bookArtPlan
      )
        throw new ProcessingError('VISUAL_REVIEW_INVALID');
      for (const chapter of progress.chapters) {
        if (chapter.status === 'SUCCEEDED' || chapter.status === 'REJECTED') {
          const review = await this.readVisualReview(
            current,
            chapter,
            bookArtPlan
              ? artDirectionHash(bookArtPlan.artDirection)
              : undefined,
          );
          if ((chapter.status === 'SUCCEEDED') !== (review.status === 'PASSED'))
            throw new ProcessingError('VISUAL_REVIEW_INVALID');
        } else if (chapter.visualReview || chapter.visualReviewReference) {
          throw new ProcessingError('VISUAL_REVIEW_INVALID');
        }
      }
    } else if (
      configuration.pipelineVersion ===
        CONVERSION_UNREVIEWED_PIPELINE_VERSION &&
      progress.chapters.some(
        (chapter) =>
          chapter.status === 'REVIEWING' ||
          chapter.status === 'REJECTED' ||
          chapter.visualReview ||
          chapter.visualReviewReference ||
          (chapter.status === 'SUCCEEDED' && !chapter.sourcePlanHash),
      )
    ) {
      throw new ProcessingError('CONVERSION_PROGRESS_INVALID');
    }
    return progress;
  }

  private publicReview(review: IllustrationVisualReview) {
    return publicVisualReviewSchema.parse({
      status: review.status,
      summary: review.summary,
      checks: review.checks,
    });
  }

  private assertReviewBindings(
    review: IllustrationVisualReview,
    chapter: ConversionUnit,
    sourceSha256: string,
    expectedArtHash?: string,
    expectedPlanningPolicy?: typeof CONVERSION_PEOPLE_PLANNING_POLICY,
  ) {
    if (
      !chapter.image ||
      !chapter.sourcePlanHash ||
      !expectedArtHash ||
      review.sourceSha256 !== sourceSha256 ||
      review.chapterId !== chapter.id ||
      review.sourcePlanHash !== chapter.sourcePlanHash ||
      review.artDirectionHash !== expectedArtHash ||
      review.imageSha256 !== chapter.image.sha256 ||
      review.planningPolicy !== expectedPlanningPolicy
    )
      throw new ProcessingError('VISUAL_REVIEW_INVALID');
  }

  private async readVisualReview(
    run: ProcessingRun,
    chapter: ConversionUnit,
    expectedArtHash?: string,
  ) {
    const reference = chapter.visualReviewReference;
    if (
      !reference ||
      !reference.storageKey.startsWith(`runs/${run.id}/`) ||
      !chapter.visualReview
    )
      throw new ProcessingError('VISUAL_REVIEW_INVALID');
    const review = this.parse(
      illustrationVisualReviewSchema,
      await this.readReference(reference),
    );
    const configuration = this.parse(
      conversionConfigurationSchema,
      run.configuration,
    );
    this.assertReviewBindings(
      review,
      chapter,
      configuration.sourceHash,
      expectedArtHash,
      configuration.planningPolicy,
    );
    if (
      review.policyVersion !== configuration.visualReviewPolicyVersion ||
      digest(this.publicReview(review)) !== digest(chapter.visualReview)
    )
      throw new ProcessingError('VISUAL_REVIEW_INVALID');
    return review;
  }

  async verifyImage(
    image: NonNullable<ConversionProgress['chapters'][number]['image']>,
  ) {
    if (
      !/^conversion-assets\/[a-f0-9]{64}\/[a-f0-9]{64}\.png$/u.test(
        image.storageKey,
      ) ||
      !image.storageKey.endsWith(`/${image.sha256}.png`)
    )
      throw new ProcessingError('CONVERSION_PROGRESS_INVALID');
    await this.safeFile(
      this.storage.path(image.storageKey),
      this.config.get('PROCESSING_DATA_DIR'),
      this.config.get('IMAGE_MAX_BYTES'),
    );
    const description = await this.storage.describe(image.storageKey);
    if (
      description.sha256 !== image.sha256 ||
      description.byteSize !== image.byteSize
    )
      throw new ProcessingError('ILLUSTRATION_OUTPUT_INVALID');
  }

  private assertSelection(
    progress: ConversionProgress,
    selection: z.infer<typeof conversionSelectionSchema>,
  ) {
    if (
      progress.sourceSha256 !== selection.sourceSha256 ||
      progress.catalogId !== selection.catalogId ||
      digest(
        progress.chapters.map(
          ({
            id,
            index,
            title,
            scope,
            sectionId,
            parentChapterTitle,
            placementMode,
          }) => ({
            id,
            index,
            title,
            ...(scope
              ? { scope, sectionId, parentChapterTitle, placementMode }
              : {}),
          }),
        ),
      ) !== digest(selection.chapters)
    )
      throw new ProcessingError('CONVERSION_SELECTION_INVALID');
  }
  private anchor(index: IllustrationChapterIndex, id: string) {
    const anchor = index.anchors.find(
      (entry) =>
        entry.id === id &&
        entry.kind ===
          (index.scope === 'section' ? 'after-paragraph' : 'chapter-end'),
    );
    if (!anchor) throw new ProcessingError('ILLUSTRATION_PLAN_INVALID');
    return {
      documentPath: anchor.documentPath,
      sourceStart: anchor.sourceStart,
      sourceEnd: anchor.sourceEnd,
      contentSha256: anchor.contentSha256,
    };
  }
  private async readPlan(
    output: string,
    index: IllustrationChapterIndex,
    image = false,
    configuration?: {
      artDirection?: z.infer<typeof illustrationArtDirectionSchema>;
      artDirectionHash?: string;
      planningPolicy?: typeof CONVERSION_PEOPLE_PLANNING_POLICY;
    },
  ) {
    const plan = this.parse(
      planSchema,
      await this.readJsonFile(resolve(output, 'plan.json'), output),
    );
    const planHash = planFingerprint(plan);
    if (plan.planningPolicy !== configuration?.planningPolicy)
      throw new ProcessingError('ILLUSTRATION_PLAN_INVALID');
    if (configuration?.artDirection) {
      try {
        if (
          !plan.artDirection ||
          plan.artDirectionHash !== configuration.artDirectionHash
        )
          throw new Error();
        resolveArtDirection(
          plan.artDirection,
          configuration.artDirectionHash,
          index.sourceSha256,
        );
        assertArtDirectedPrompt(
          plan.imagePrompt,
          plan.artDirection,
          plan.planningPolicy && plan.depicts
            ? { planningPolicy: plan.planningPolicy, depicts: plan.depicts }
            : undefined,
        );
        if (plan.artDirection.id === 'book-art') {
          if (
            !plan.visualPlan ||
            !plan.sceneDescription ||
            !plan.depicts ||
            compileContentIllustrationPrompt(
              {
                sceneDescription: plan.sceneDescription,
                visualPlan: plan.visualPlan,
                depicts: plan.depicts,
                ...(plan.planningPolicy
                  ? { planningPolicy: plan.planningPolicy }
                  : {}),
              },
              plan.artDirection,
            ) !== plan.imagePrompt
          )
            throw new Error();
          if (
            !(
              plan.planningPolicy
                ? contentPeopleVisualPlanSchema
                : illustrationVisualPlanSchema
            ).safeParse(plan.visualPlan).success
          )
            throw new Error();
          const selected = plan.visualPlan.concepts.find(
            (item) => item.id === plan.visualPlan?.selectedConceptId,
          )!;
          const evidence = new Set([
            ...plan.facts.flatMap((item) => item.sourceBlockIds),
            ...(plan.sceneEvidenceBlockIds ?? []),
            ...(plan.settingEvidenceBlockIds ?? []),
          ]);
          if (
            selected.sourceBlockIds.some((id) => !evidence.has(id)) ||
            plan.visualPlan.concepts.some((item) =>
              item.sourceBlockIds.some(
                (id) => !index.blocks.some((block) => block.id === id),
              ),
            )
          )
            throw new Error();
        }
      } catch {
        throw new ProcessingError('ART_DIRECTION_INVALID');
      }
    } else if (plan.artDirection || plan.artDirectionHash) {
      throw new ProcessingError('ART_DIRECTION_INVALID');
    }
    const allowed = new Set(index.blocks.map((block) => block.id));
    if (
      plan.sourceSha256 !== index.sourceSha256 ||
      plan.chapterId !== index.chapterId ||
      plan.facts.some((fact) =>
        fact.sourceBlockIds.some((id) => !allowed.has(id)),
      )
    )
      throw new ProcessingError('ILLUSTRATION_PLAN_INVALID');
    const chosenAnchor = index.anchors.find(
      (anchor) => anchor.id === plan.anchorId,
    );
    this.anchor(index, plan.anchorId);
    if (index.scope === 'section') {
      if (
        !plan.layout ||
        !plan.settingEvidenceBlockIds ||
        !plan.sceneEvidenceBlockIds ||
        plan.sceneEvidenceBlockIds.some((id) => !allowed.has(id)) ||
        plan.settingEvidenceBlockIds.some((id) => !allowed.has(id))
      )
        throw new ProcessingError('ILLUSTRATION_PLAN_INVALID');
      const evidence = [
        ...plan.facts.flatMap((fact) => fact.sourceBlockIds),
        ...plan.settingEvidenceBlockIds,
        ...plan.sceneEvidenceBlockIds,
      ];
      const latest = Math.max(
        ...evidence.map(
          (id) => index.blocks.find((block) => block.id === id)!.order,
        ),
      );
      if (
        !chosenAnchor ||
        chosenAnchor.readingOrder < latest ||
        chosenAnchor.readingOrder - latest > 3
      )
        throw new ProcessingError('ILLUSTRATION_PLACEMENT_MISMATCH');
    }
    const receipt = image
      ? this.parse(
          imageStageSchema,
          await this.readJsonFile(
            resolve(output, 'stage-receipt.json'),
            output,
          ),
        )
      : this.parse(
          planReceiptSchema,
          await this.readJsonFile(
            resolve(output, 'stage-receipt.json'),
            output,
          ),
        );
    if (
      receipt.sourceSha256 !== index.sourceSha256 ||
      receipt.chapterId !== index.chapterId ||
      receipt.sourcePlanHash !== planHash ||
      ('planPath' in receipt &&
        resolve(receipt.planPath) !== resolve(output, 'plan.json')) ||
      ('chapterTitle' in receipt && receipt.chapterTitle !== index.title) ||
      ('anchorId' in receipt && receipt.anchorId !== plan.anchorId)
    )
      throw new ProcessingError('ILLUSTRATION_PLAN_INVALID');
    return plan;
  }
  private async copyImage(
    output: string,
    index: IllustrationChapterIndex,
    plan: z.infer<typeof planSchema>,
    childId: string,
  ) {
    const image = this.parse(
      imageReceiptSchema,
      await this.readJsonFile(resolve(output, 'image-receipt.json'), output),
    );
    const receipt = this.parse(
      imageStageSchema,
      await this.readJsonFile(resolve(output, 'stage-receipt.json'), output),
    );
    if (
      receipt.callId !== image.callId ||
      receipt.sourceSha256 !== index.sourceSha256 ||
      receipt.chapterId !== index.chapterId ||
      receipt.anchorId !== plan.anchorId ||
      resolve(image.asset.path) !==
        resolve(
          this.config.get('IMAGE_DATA_DIR'),
          'assets',
          `${image.callId}.png`,
        ) ||
      image.asset.byteSize > this.config.get('IMAGE_MAX_BYTES') ||
      image.asset.width * image.asset.height >
        this.config.get('IMAGE_MAX_PIXELS')
    )
      throw new ProcessingError('ILLUSTRATION_OUTPUT_INVALID');
    await this.safeFile(
      image.asset.path,
      this.config.get('IMAGE_DATA_DIR'),
      this.config.get('IMAGE_MAX_BYTES'),
    );
    const bytes = await readFile(image.asset.path);
    if (
      bytes.length !== image.asset.byteSize ||
      hash(bytes) !== image.asset.sha256 ||
      bytes.length < 24 ||
      bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      bytes.readUInt32BE(16) !== image.asset.width ||
      bytes.readUInt32BE(20) !== image.asset.height
    )
      throw new ProcessingError('ILLUSTRATION_OUTPUT_INVALID');
    const storageKey = `conversion-assets/${childId}/${image.asset.sha256}.png`;
    try {
      await this.storage.storeCopy(storageKey, image.asset.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const result = {
      storageKey,
      sha256: image.asset.sha256,
      byteSize: image.asset.byteSize,
      width: image.asset.width,
      height: image.asset.height,
      callId: image.callId,
    };
    await this.verifyImage(result);
    return result;
  }
  private async checkpoint(
    context: ClaimedStep & { signal: AbortSignal },
    progress: ConversionProgress,
  ) {
    await this.assertCurrent(context);
    const result = await this.storeProgress(context, progress);
    const done = progress.chapters.filter((chapter) =>
      terminal.has(chapter.status),
    ).length;
    if (
      !(await this.repository.checkpointStep(
        context.lease,
        result,
        done,
        progress.chapters.length,
      ))
    )
      throw new ProcessingError('STALE_PROCESSING_LEASE');
  }
  private async storeProgress(
    context: ClaimedStep,
    progress: ConversionProgress,
  ): Promise<{
    progress: { storageKey: string; sha256: string; byteSize: number };
  }> {
    const storageKey = `${this.publicationPrefix(context)}/progress.json`;
    return {
      progress: {
        storageKey,
        ...(await this.storage.storeJson(storageKey, progress)),
      },
    };
  }
  private publicationPrefix(context: ClaimedStep) {
    return `runs/${context.run.id}/${context.step.id}-${context.lease.leaseVersion}/${randomUUID()}`;
  }
  private async freezeRequest(output: string, value: unknown) {
    const path = resolve(output, 'request.json');
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
    until: 'plan' | 'image' | 'book-art',
    signal: AbortSignal,
  ) {
    const timeout = AbortSignal.timeout(15 * 60 * 1000);
    try {
      await this.runner.run({
        requestPath,
        until,
        environment: this.environment(),
        signal: AbortSignal.any([signal, timeout]),
      });
    } catch (error) {
      if (signal.aborted) throw new ProcessingError('PROCESSING_CANCELLED');
      if (timeout.aborted) throw new ProcessingError('ILLUSTRATION_TIMEOUT');
      if (error instanceof ProcessingError) throw error;
      throw new ProcessingError('ILLUSTRATION_CHILD_FAILED');
    }
  }
  private environment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { ...process.env };
    const keys: (keyof Environment)[] = [
      'NODE_ENV',
      'BUDGET_LIMITS_ENABLED',
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
    // A chapter may call the planner more than once, but its existing hard cap is 400000.
    environment.IMAGE_OPERATION_BUDGET_MICROS = String(
      this.config.get('IMAGE_PRICE_MICROS'),
    );
    return environment;
  }
  private assertPricing(
    configuration: z.infer<typeof conversionConfigurationSchema>,
  ) {
    const pricing = conversionPricing(
      this.config,
      configuration.pipelineVersion,
      configuration.styleVersion,
    );
    if (
      pricing.pricingHash !== configuration.pricingHash ||
      pricing.perChapterUpperMicros !== configuration.perChapterUpperMicros ||
      (pricing.bookArtUpperMicros ?? 0) !==
        (configuration.bookArtUpperMicros ?? 0)
    )
      throw new ProcessingError('CONVERSION_PRICING_CHANGED');
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
  private safeCode(error: unknown) {
    const code =
      error && typeof error === 'object' && 'code' in error ? error.code : null;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/u.test(code)
      ? code
      : 'ILLUSTRATION_CHILD_FAILED';
  }
  private parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new ProcessingError('CONVERSION_PROGRESS_INVALID');
    return parsed.data;
  }
  private async safeFile(path: string, root: string, maxBytes: number) {
    const base = resolve(root),
      target = resolve(path),
      within = relative(base, target);
    if (
      !isAbsolute(path) ||
      !within ||
      within.startsWith(`..${sep}`) ||
      isAbsolute(within)
    )
      throw new ProcessingError('ILLUSTRATION_PRIVATE_FILE_INVALID');
    let current = base;
    const segments = within.split(sep);
    for (const [index, segment] of ['', ...segments].entries()) {
      if (segment) current = resolve(current, segment);
      const info = await lstat(current);
      if (
        info.isSymbolicLink() ||
        (index < segments.length && !info.isDirectory()) ||
        (index === segments.length &&
          (!info.isFile() || info.size < 1 || info.size > maxBytes))
      )
        throw new ProcessingError('ILLUSTRATION_PRIVATE_FILE_INVALID');
    }
  }
  private async readJsonFile(
    path: string,
    root: string,
    maxBytes = 2 * 1024 * 1024,
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
    const checked = this.parse(referenceSchema, reference);
    const path = this.storage.path(checked.storageKey);
    await this.safeFile(
      path,
      this.config.get('PROCESSING_DATA_DIR'),
      checked.byteSize,
    );
    const bytes = await readFile(path);
    if (bytes.length !== checked.byteSize || hash(bytes) !== checked.sha256)
      throw new ProcessingError('CONVERSION_PROGRESS_INVALID');
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      ) as unknown;
    } catch {
      throw new ProcessingError('CONVERSION_PROGRESS_INVALID');
    }
  }
}
