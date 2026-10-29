import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AppConfig } from '../config/app-config.module.js';
import { estimatedMicros } from '../ai/ai-structure.service.js';
import {
  publicVisualReviewSchema,
  reviewPriceSnapshot,
  reviewUpperMicros,
  visualReviewPolicyVersion,
} from '../ai/illustration-visual-reviewer.js';
import {
  illustrationArtDirectionSchema,
  artDirectionHash,
  getIllustrationArtDirection,
  resolveArtDirection,
} from '../ai/illustration-art-direction.js';

export const conversionHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const CONVERSION_STYLE_VERSION = 'literary-v1' as const;
export const CONVERSION_ART_STYLE_VERSION = 'literary-editorial-v2' as const;
export const CONVERSION_INLINE_PIPELINE_VERSION =
  'subsection-inline-4' as const;
export const CONVERSION_ART_PIPELINE_VERSION = 'subsection-inline-5' as const;
export const CONVERSION_CONTENT_STYLE_VERSION = 'book-art-v1' as const;
export const CONVERSION_CONTENT_PIPELINE_VERSION =
  'subsection-inline-6' as const;
export const CONVERSION_REVIEW_PIPELINE_VERSION =
  'subsection-inline-7' as const;
export const CONVERSION_PEOPLE_PIPELINE_VERSION =
  'subsection-inline-8' as const;
export const CONVERSION_UNREVIEWED_PIPELINE_VERSION =
  'subsection-inline-9' as const;
export const CONVERSION_PEOPLE_PLANNING_POLICY = 'content-people-1' as const;
export const CONVERSION_UNREVIEWED_DESCRIPTION =
  '本次转换不做生成后的 AI 视觉复核；保留文件完整性、插入位置及 EPUB 格式检查。';
export function conversionUsesPeoplePlanning(pipelineVersion?: string) {
  return (
    pipelineVersion === CONVERSION_PEOPLE_PIPELINE_VERSION ||
    pipelineVersion === CONVERSION_UNREVIEWED_PIPELINE_VERSION
  );
}
export function conversionRequiresReview(pipelineVersion?: string) {
  return (
    pipelineVersion === CONVERSION_REVIEW_PIPELINE_VERSION ||
    pipelineVersion === CONVERSION_PEOPLE_PIPELINE_VERSION
  );
}
export const CONVERSION_BOOK_ART_POLICY_VERSION =
  'book-art-direction-1' as const;
export const CONVERSION_TEXT_UPPER_MICROS = 400_000;
export const conversionSha = z.string().regex(/^[a-f0-9]{64}$/);
export const conversionReferenceSchema = z
  .object({
    storageKey: z.string().min(1).max(255),
    sha256: conversionSha,
    byteSize: z
      .number()
      .int()
      .positive()
      .max(2 * 1024 * 1024),
  })
  .strict();
export const conversionChapterSchema = z
  .object({
    id: conversionSha,
    index: z.number().int().min(0).max(500),
    title: z.string().min(1).max(1000),
    scope: z.literal('section').optional(),
    sectionId: conversionSha.optional(),
    parentChapterTitle: z.string().min(1).max(1000).optional(),
    placementMode: z.literal('content-inline-v2').optional(),
  })
  .strict();
export const conversionSelectionSchema = z
  .object({
    catalogId: conversionSha,
    sourceSha256: conversionSha,
    title: z.string().nullable(),
    chapters: z.array(conversionChapterSchema).min(1).max(501),
  })
  .strict();
export const conversionConfigurationSchema = z
  .object({
    catalogId: conversionSha,
    sourceHash: conversionSha,
    selectionKey: z.string().max(255),
    selectionHash: conversionSha,
    selectionByteSize: z
      .number()
      .int()
      .positive()
      .max(2 * 1024 * 1024),
    maxCostMicros: z.number().int().positive(),
    budgetEnforced: z.boolean().optional(),
    perChapterUpperMicros: z.number().int().positive(),
    upperBoundMicros: z.number().int().positive(),
    pricingHash: conversionSha,
    styleVersion: z.enum([
      CONVERSION_STYLE_VERSION,
      CONVERSION_ART_STYLE_VERSION,
      CONVERSION_CONTENT_STYLE_VERSION,
    ]),
    pipelineVersion: z
      .enum([
        CONVERSION_INLINE_PIPELINE_VERSION,
        CONVERSION_ART_PIPELINE_VERSION,
        CONVERSION_CONTENT_PIPELINE_VERSION,
        CONVERSION_REVIEW_PIPELINE_VERSION,
        CONVERSION_PEOPLE_PIPELINE_VERSION,
        CONVERSION_UNREVIEWED_PIPELINE_VERSION,
      ])
      .optional(),
    artDirection: illustrationArtDirectionSchema.optional(),
    artDirectionHash: conversionSha.optional(),
    bookArtPolicyVersion: z
      .literal(CONVERSION_BOOK_ART_POLICY_VERSION)
      .optional(),
    bookArtUpperMicros: z.number().int().nonnegative().optional(),
    artSeed: conversionChapterSchema.optional(),
    visualReviewPolicyVersion: z.literal(visualReviewPolicyVersion).optional(),
    planningPolicy: z.literal(CONVERSION_PEOPLE_PLANNING_POLICY).optional(),
    imageReviewMode: z.literal('disabled').optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.styleVersion === CONVERSION_CONTENT_STYLE_VERSION) {
      if (
        value.artDirection ||
        value.artDirectionHash ||
        ![
          CONVERSION_CONTENT_PIPELINE_VERSION,
          CONVERSION_REVIEW_PIPELINE_VERSION,
          CONVERSION_PEOPLE_PIPELINE_VERSION,
          CONVERSION_UNREVIEWED_PIPELINE_VERSION,
        ].includes(
          value.pipelineVersion as
            | typeof CONVERSION_CONTENT_PIPELINE_VERSION
            | typeof CONVERSION_REVIEW_PIPELINE_VERSION
            | typeof CONVERSION_PEOPLE_PIPELINE_VERSION
            | typeof CONVERSION_UNREVIEWED_PIPELINE_VERSION,
        ) ||
        (conversionRequiresReview(value.pipelineVersion)
          ? value.visualReviewPolicyVersion !== visualReviewPolicyVersion
          : value.visualReviewPolicyVersion !== undefined) ||
        (conversionUsesPeoplePlanning(value.pipelineVersion)
          ? value.planningPolicy !== CONVERSION_PEOPLE_PLANNING_POLICY
          : value.planningPolicy !== undefined) ||
        (value.pipelineVersion === CONVERSION_UNREVIEWED_PIPELINE_VERSION
          ? value.imageReviewMode !== 'disabled'
          : value.imageReviewMode !== undefined) ||
        value.bookArtPolicyVersion !== CONVERSION_BOOK_ART_POLICY_VERSION ||
        value.bookArtUpperMicros === undefined ||
        !value.artSeed ||
        value.artSeed.scope !== 'section' ||
        value.artSeed.id !== value.artSeed.sectionId ||
        value.artSeed.placementMode !== 'content-inline-v2'
      )
        context.addIssue({
          code: 'custom',
          message:
            'A frozen book-art planning policy and source seed are required',
        });
      return;
    }
    if (
      value.bookArtPolicyVersion ||
      value.bookArtUpperMicros !== undefined ||
      value.artSeed ||
      value.visualReviewPolicyVersion ||
      value.planningPolicy ||
      value.imageReviewMode ||
      value.pipelineVersion === CONVERSION_CONTENT_PIPELINE_VERSION ||
      value.pipelineVersion === CONVERSION_REVIEW_PIPELINE_VERSION ||
      value.pipelineVersion === CONVERSION_PEOPLE_PIPELINE_VERSION ||
      value.pipelineVersion === CONVERSION_UNREVIEWED_PIPELINE_VERSION
    )
      context.addIssue({
        code: 'custom',
        message: 'Unexpected content-directed configuration on a legacy run',
      });
    const styled = value.styleVersion === CONVERSION_ART_STYLE_VERSION;
    if (!styled) {
      if (
        value.artDirection ||
        value.artDirectionHash ||
        value.pipelineVersion === CONVERSION_ART_PIPELINE_VERSION
      )
        context.addIssue({
          code: 'custom',
          message: 'Unexpected art direction for legacy conversion',
        });
      return;
    }
    try {
      if (
        !value.artDirection ||
        value.artDirection.id !== 'literary-editorial' ||
        !value.artDirectionHash ||
        value.pipelineVersion === CONVERSION_INLINE_PIPELINE_VERSION
      )
        throw new Error();
      resolveArtDirection(value.artDirection, value.artDirectionHash);
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Missing or invalid registered art direction',
      });
    }
  });
export const conversionInputSchema = z
  .object({
    catalogId: conversionSha,
    chapterIds: z.array(conversionSha).min(1).max(501),
    maxCostMicros: z.number().int().positive().max(1_000_000_000),
  })
  .strict()
  .refine((v) => new Set(v.chapterIds).size === v.chapterIds.length);
export const conversionAnchorSchema = z
  .object({
    documentPath: z.string().min(1).max(500),
    sourceStart: z.number().int().nonnegative(),
    sourceEnd: z.number().int().nonnegative(),
    contentSha256: conversionSha,
  })
  .strict();
export const conversionImageSchema = z
  .object({
    storageKey: z.string().max(255),
    sha256: conversionSha,
    byteSize: z.number().int().positive().max(20971520),
    width: z.number().int().positive().max(4096),
    height: z.number().int().positive().max(4096),
    callId: z.uuid(),
  })
  .strict();
export const conversionUnitSchema = conversionChapterSchema
  .extend({
    status: z.enum([
      'WAITING',
      'PLANNING',
      'GENERATING',
      'REVIEWING',
      'SUCCEEDED',
      'SKIPPED',
      'FAILED',
      'UNKNOWN',
      'REJECTED',
    ]),
    errorCode: z
      .string()
      .regex(/^[A-Z0-9_]{1,64}$/)
      .nullable(),
    image: conversionImageSchema.nullable(),
    anchor: conversionAnchorSchema.nullable(),
    alt: z.string().max(2000).nullable(),
    sourcePlanHash: conversionSha.optional(),
    visualReview: publicVisualReviewSchema.optional(),
    visualReviewReference: conversionReferenceSchema.optional(),
    visualPlan: z
      .object({
        concepts: z
          .array(
            z
              .object({
                id: z.string().regex(/^c[1-3]$/),
                idea: z.string().min(1).max(320),
                composition: z.string().min(1).max(400),
                emotionalIntent: z.string().min(1).max(240),
                sourceBlockIds: z.array(conversionSha).min(1).max(6),
              })
              .strict(),
          )
          .min(2)
          .max(3),
        selectedConceptId: z.string().regex(/^c[1-3]$/),
        selectionReason: z.string().min(1).max(480),
      })
      .strict()
      .optional(),
    layout: z
      .object({
        size: z.enum(['compact', 'medium', 'wide']),
        alignment: z.literal('center'),
      })
      .strict()
      .optional(),
  })
  .strict();
export const conversionProgressSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceSha256: conversionSha,
    catalogId: conversionSha,
    chapters: z.array(conversionUnitSchema).min(1).max(501),
  })
  .strict();
export type ConversionConfiguration = z.infer<
  typeof conversionConfigurationSchema
>;
export type ConversionSelection = z.infer<typeof conversionSelectionSchema>;
export type ConversionProgress = z.infer<typeof conversionProgressSchema>;
export type ConversionUnit = z.infer<typeof conversionUnitSchema>;

/** A conservative whole-batch admission ceiling; configured estimates, not a provider invoice. */
export function conversionPricing(
  config: AppConfig,
  pipelineVersion?:
    | typeof CONVERSION_INLINE_PIPELINE_VERSION
    | typeof CONVERSION_ART_PIPELINE_VERSION
    | typeof CONVERSION_CONTENT_PIPELINE_VERSION
    | typeof CONVERSION_REVIEW_PIPELINE_VERSION
    | typeof CONVERSION_PEOPLE_PIPELINE_VERSION
    | typeof CONVERSION_UNREVIEWED_PIPELINE_VERSION,
  styleVersion:
    | typeof CONVERSION_STYLE_VERSION
    | typeof CONVERSION_ART_STYLE_VERSION
    | typeof CONVERSION_CONTENT_STYLE_VERSION = CONVERSION_STYLE_VERSION,
) {
  const keys = [
    'QWEN_BASE_URL',
    'QWEN_MODEL',
    'QWEN_MAX_OUTPUT_TOKENS',
    'AI_INPUT_TOKEN_BUDGET',
    'AI_MAX_MESSAGE_BYTES',
    'AI_RUN_BUDGET_MICROS',
    'AI_INPUT_PRICE_MICROS_PER_MILLION',
    'AI_OUTPUT_PRICE_MICROS_PER_MILLION',
    'AI_PRICE_VERSION',
    'IMAGE_API_BASE_URL',
    'IMAGE_MODEL',
    'IMAGE_SIZE',
    'IMAGE_PRICE_MICROS',
    'IMAGE_OPERATION_BUDGET_MICROS',
    'IMAGE_PRICE_VERSION',
  ] as const;
  return {
    pricingHash: conversionHash({
      version: styleVersion,
      ...(styleVersion === CONVERSION_ART_STYLE_VERSION
        ? { artDirectionHash: artDirectionHash(getIllustrationArtDirection()) }
        : {}),
      ...(styleVersion === CONVERSION_CONTENT_STYLE_VERSION
        ? { bookArtPolicyVersion: CONVERSION_BOOK_ART_POLICY_VERSION }
        : {}),
      ...(pipelineVersion ? { pipelineVersion } : {}),
      ...(conversionRequiresReview(pipelineVersion)
        ? {
            visualReviewPolicyVersion,
            visualReview: reviewPriceSnapshot(config),
          }
        : {}),
      ...(conversionUsesPeoplePlanning(pipelineVersion)
        ? { planningPolicy: CONVERSION_PEOPLE_PLANNING_POLICY }
        : {}),
      ...(pipelineVersion === CONVERSION_UNREVIEWED_PIPELINE_VERSION
        ? { imageReviewMode: 'disabled' }
        : {}),
      configuration: keys.map((key) => [key, config.get(key)]),
      ...(config.get('BUDGET_LIMITS_ENABLED') === false
        ? { budgetEnforced: false }
        : {}),
    }),
    perChapterUpperMicros:
      CONVERSION_TEXT_UPPER_MICROS +
      config.get('IMAGE_PRICE_MICROS') +
      (conversionRequiresReview(pipelineVersion)
        ? reviewUpperMicros(config)
        : 0),
    ...(conversionRequiresReview(pipelineVersion)
      ? { perChapterReviewUpperMicros: reviewUpperMicros(config) }
      : {}),
    ...(styleVersion === CONVERSION_CONTENT_STYLE_VERSION
      ? {
          bookArtUpperMicros: estimatedMicros(
            config.get('AI_INPUT_TOKEN_BUDGET'),
            config.get('QWEN_MAX_OUTPUT_TOKENS'),
            config.get('AI_INPUT_PRICE_MICROS_PER_MILLION'),
            config.get('AI_OUTPUT_PRICE_MICROS_PER_MILLION'),
          ),
        }
      : {}),
  };
}

export function conversionArtDirectionView(
  configuration: Pick<
    ConversionConfiguration,
    'artDirection' | 'artDirectionHash'
  >,
) {
  if (!configuration.artDirection) return undefined;
  const direction = resolveArtDirection(
    configuration.artDirection,
    configuration.artDirectionHash,
  );
  if (direction.id === 'book-art')
    return {
      id: direction.id,
      version: direction.version,
      hash: artDirectionHash(direction),
      label: '本书专属艺术方案',
      description: `${direction.medium}；${direction.palette.map((color) => color.colorName).join('、')}；${direction.lineLanguage}；${direction.shapeLanguage}`,
      status: 'provisional' as const,
      visualReview: 'unreviewed' as const,
    };
  return {
    id: direction.id,
    version: direction.version,
    hash: artDirectionHash(direction),
    label: '文学编辑插画',
    description:
      '近白留白底、炭灰手绘线条、石板灰与赭色、克制的扁平色块；全书保持统一。',
    status: 'provisional' as const,
    visualReview: 'unreviewed' as const,
  };
}

export function conversionEnabled(config: AppConfig) {
  return (
    config.get('PROCESSING_AI_ENABLED') &&
    config.get('QWEN_ENABLED') &&
    config.get('IMAGE_GENERATION_ENABLED') &&
    config.get('NODE_ENV') !== 'production' &&
    config.get('PROCESSING_REPOSITORY') === 'local'
  );
}

export function conversionCounts(
  progress: ConversionProgress,
  reviewed = false,
) {
  const count = (status: ConversionUnit['status']) =>
    progress.chapters.filter((ch) => ch.status === status).length;
  const succeeded = count('SUCCEEDED'),
    failed = count('FAILED'),
    skipped = count('SKIPPED'),
    unknown = count('UNKNOWN'),
    rejected = count('REJECTED');
  return {
    total: progress.chapters.length,
    completed: succeeded + failed + skipped + unknown + rejected,
    succeeded,
    failed,
    skipped,
    unknown,
    ...(reviewed || rejected > 0 ? { rejected } : {}),
  };
}
