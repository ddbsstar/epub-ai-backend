import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppConfig } from '../config/app-config.module.js';
import { artDirectionHash } from '../ai/illustration-art-direction.js';
import {
  inspectIllustrationCatalog,
  ILLUSTRATION_SECTION_PARSER_VERSION,
} from '../documents/chapter-illustration-index.js';
import { ProcessingRepository } from '../processing/processing.repository.js';
import {
  ProcessingError,
  type ProcessingBook,
  type ProcessingRun,
} from '../processing/processing.types.js';
import { LocalArtifactStorage } from './artifact-storage.js';
import {
  businessError,
  exposeProcessingErrors,
  safeProcessingMessage,
} from './business-errors.js';
import { ConversionWorkerService } from './conversion-worker.service.js';
import {
  conversionConfigurationSchema,
  conversionCounts,
  conversionEnabled,
  conversionHash,
  conversionInputSchema,
  conversionPricing,
  conversionSelectionSchema,
  conversionSha,
  CONVERSION_CONTENT_STYLE_VERSION,
  CONVERSION_UNREVIEWED_PIPELINE_VERSION,
  CONVERSION_UNREVIEWED_DESCRIPTION,
  CONVERSION_PEOPLE_PLANNING_POLICY,
  conversionRequiresReview,
  CONVERSION_BOOK_ART_POLICY_VERSION,
  conversionArtDirectionView,
  type ConversionProgress,
  type ConversionSelection,
} from './conversion.types.js';

const chapterSchema = z
  .object({
    id: conversionSha,
    index: z.number().int().min(-1).max(10000),
    title: z.string().max(1000),
    level: z.number().int().min(0).max(100),
    selectable: z.boolean(),
    reasonCode: z.string().nullable(),
    scope: z.enum(['chapter', 'section']).optional(),
    sectionId: conversionSha.optional(),
    parentChapterTitle: z.string().max(1000).optional(),
    boundaryKind: z.enum(['heading', 'document']).optional(),
  })
  .strict();
const catalogSchema = z
  .object({
    catalogId: conversionSha,
    sourceSha256: conversionSha,
    parserVersion: z.string().max(100),
    title: z.string().nullable(),
    chapters: z.array(chapterSchema).max(10000),
  })
  .strict();
type Catalog = z.infer<typeof catalogSchema>;

@Injectable()
export class ConversionService {
  private readonly catalogs = new Map<string, Promise<Catalog>>();
  constructor(
    @Inject(AppConfig) private readonly config: AppConfig,
    @Inject(ProcessingRepository)
    private readonly repository: ProcessingRepository,
    @Inject(LocalArtifactStorage)
    private readonly storage: LocalArtifactStorage,
    @Inject(ConversionWorkerService)
    private readonly worker: ConversionWorkerService,
  ) {}

  async chapters(ownerId: string, bookId: string) {
    const book = await this.ownedBook(ownerId, bookId);
    const catalog = await this.catalog(book);
    return {
      ...catalog,
      artPlanning: {
        mode: 'content-directed' as const,
        description:
          '转换时将依据书内代表性片段制定本书艺术方案，再为小节设计画面。',
      },
      visualReview: {
        enabled: false,
        description: CONVERSION_UNREVIEWED_DESCRIPTION,
      },
      pricing: {
        currency: 'CNY' as const,
        perChapterUpperMicros: conversionPricing(
          this.config,
          CONVERSION_UNREVIEWED_PIPELINE_VERSION,
          CONVERSION_CONTENT_STYLE_VERSION,
        ).perChapterUpperMicros,
        maxBudgetMicros: this.config.get('ILLUSTRATION_BATCH_BUDGET_MICROS'),
        enabled: conversionEnabled(this.config),
        budgetEnforced: this.config.get('BUDGET_LIMITS_ENABLED') !== false,
        bookArtUpperMicros: conversionPricing(
          this.config,
          CONVERSION_UNREVIEWED_PIPELINE_VERSION,
          CONVERSION_CONTENT_STYLE_VERSION,
        ).bookArtUpperMicros,
      },
    };
  }

  async create(ownerId: string, bookId: string, input: unknown, key: unknown) {
    if (!conversionEnabled(this.config))
      throw businessError('ILLUSTRATION_DISABLED', 503);
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(key))
      throw businessError('INVALID_IDEMPOTENCY_KEY');
    const prepared = await this.prepare(ownerId, bookId, input);
    const { book, catalog, selection, requestHash, parsed } = prepared;
    await this.freeze(
      `conversion-submissions/${conversionHash(ownerId)}/${key}.json`,
      { requestHash },
    );
    const existing = await this.repository.findRunByKey(
      ownerId,
      'illustration-conversion',
      `conversion:${requestHash}`,
    );
    if (existing) return this.view(ownerId, existing);
    const pipelineVersion = CONVERSION_UNREVIEWED_PIPELINE_VERSION;
    const pricing = conversionPricing(
      this.config,
      pipelineVersion,
      CONVERSION_CONTENT_STYLE_VERSION,
    );
    const upperBoundMicros =
      selection.chapters.length * pricing.perChapterUpperMicros +
      (pricing.bookArtUpperMicros ?? 0);
    if (
      this.config.get('BUDGET_LIMITS_ENABLED') !== false &&
      (parsed.maxCostMicros >
        this.config.get('ILLUSTRATION_BATCH_BUDGET_MICROS') ||
        upperBoundMicros > parsed.maxCostMicros)
    )
      throw businessError('ILLUSTRATION_BATCH_BUDGET_EXCEEDED', 409);
    const selectionKey = `conversion-selections/${bookId}/${conversionHash(selection)}.json`;
    const reference = await this.freeze(selectionKey, selection);
    const seed = catalog.chapters.find(
      (ch) => ch.selectable && ch.scope === 'section',
    );
    if (!seed || !seed.sectionId)
      throw businessError('UNSUPPORTED_CHAPTER_STRUCTURE', 409);
    const configuration = conversionConfigurationSchema.parse({
      catalogId: catalog.catalogId,
      sourceHash: book.sourceHash,
      selectionKey,
      selectionHash: reference.sha256,
      selectionByteSize: reference.byteSize,
      maxCostMicros: parsed.maxCostMicros,
      ...(this.config.get('BUDGET_LIMITS_ENABLED') === false
        ? { budgetEnforced: false }
        : {}),
      perChapterUpperMicros: pricing.perChapterUpperMicros,
      upperBoundMicros,
      pricingHash: pricing.pricingHash,
      styleVersion: CONVERSION_CONTENT_STYLE_VERSION,
      bookArtPolicyVersion: CONVERSION_BOOK_ART_POLICY_VERSION,
      imageReviewMode: 'disabled',
      planningPolicy: CONVERSION_PEOPLE_PLANNING_POLICY,
      bookArtUpperMicros: pricing.bookArtUpperMicros,
      artSeed: {
        id: seed.id,
        index: seed.index,
        title: seed.title,
        scope: 'section',
        sectionId: seed.sectionId,
        parentChapterTitle: seed.parentChapterTitle,
        placementMode: 'content-inline-v2',
      },
      ...(pipelineVersion ? { pipelineVersion } : {}),
    });
    const created = await exposeProcessingErrors(() =>
      this.repository.createRun({
        ownerId,
        bookId,
        operation: 'illustration-conversion',
        idempotencyKey: `conversion:${requestHash}`,
        requestHash,
        configuration,
        stages: ['art-plan', 'convert', 'assemble'],
      }),
    );
    return this.view(ownerId, created.run);
  }

  async lookup(ownerId: string, bookId: string, key: unknown) {
    await this.ownedBook(ownerId, bookId);
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(key))
      throw businessError('INVALID_IDEMPOTENCY_KEY');
    let alias: unknown;
    try {
      alias = await this.readSmall(
        `conversion-submissions/${conversionHash(ownerId)}/${key}.json`,
      );
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return null;
      throw error;
    }
    const { requestHash } = z
      .object({ requestHash: conversionSha })
      .strict()
      .parse(alias);
    const run = await this.repository.findRunByKey(
      ownerId,
      'illustration-conversion',
      `conversion:${requestHash}`,
    );
    if (run && run.bookId !== bookId) throw businessError('RUN_NOT_FOUND', 404);
    return run ? this.view(ownerId, run) : null;
  }
  async get(ownerId: string, id: string) {
    return this.view(ownerId, await this.ownedRun(ownerId, id));
  }
  async cancel(ownerId: string, id: string) {
    await this.ownedRun(ownerId, id);
    const run = await this.repository.requestCancel(ownerId, id);
    return this.view(ownerId, run);
  }
  async image(ownerId: string, id: string, chapterId: string) {
    if (!conversionSha.safeParse(chapterId).success)
      throw businessError('ARTIFACT_NOT_FOUND', 404);
    const run = await this.ownedRun(ownerId, id);
    const progress = await this.worker.readProgress(run);
    const unit = progress?.chapters.find(
      (ch) => ch.id === chapterId && ch.status === 'SUCCEEDED',
    );
    if (!unit?.image) throw businessError('ARTIFACT_NOT_FOUND', 404);
    if (
      conversionRequiresReview(
        conversionConfigurationSchema.parse(run.configuration).pipelineVersion,
      ) &&
      unit.visualReview?.status !== 'PASSED'
    )
      throw businessError('ARTIFACT_NOT_FOUND', 404);
    if (
      !/^conversion-assets\/[a-f0-9]{64}\/[a-f0-9]{64}\.png$/.test(
        unit.image.storageKey,
      )
    )
      throw businessError('ARTIFACT_NOT_FOUND', 404);
    const file = this.storage.path(unit.image.storageKey);
    const info = await lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== unit.image.byteSize ||
      info.size > this.config.get('IMAGE_MAX_BYTES')
    )
      throw businessError('ARTIFACT_NOT_FOUND', 404);
    const described = await this.storage.describe(unit.image.storageKey);
    if (described.sha256 !== unit.image.sha256)
      throw businessError('ILLUSTRATION_OUTPUT_INVALID', 409);
    return { file, byteSize: info.size };
  }

  private async prepare(ownerId: string, bookId: string, input: unknown) {
    const valid = conversionInputSchema.safeParse(input);
    if (!valid.success) throw businessError('INVALID_ILLUSTRATION_INPUT');
    const book = await this.ownedBook(ownerId, bookId);
    const catalog = await this.catalog(book);
    const parsed = valid.data;
    if (catalog.catalogId !== parsed.catalogId)
      throw businessError('ILLUSTRATION_CATALOG_CHANGED', 409);
    const chosen = new Set(parsed.chapterIds);
    const chapters = catalog.chapters.filter((ch) => chosen.has(ch.id));
    if (
      chapters.length !== chosen.size ||
      chapters.some((ch) => !ch.selectable || ch.index < 0 || ch.index > 500)
    )
      throw businessError('UNSUPPORTED_CHAPTER_STRUCTURE', 409);
    const selection = conversionSelectionSchema.parse({
      catalogId: catalog.catalogId,
      sourceSha256: book.sourceHash,
      title: catalog.title,
      chapters: chapters.map((ch) => ({
        id: ch.id,
        index: ch.index,
        title: ch.title,
        ...(ch.scope === 'section'
          ? {
              scope: 'section',
              sectionId: ch.sectionId,
              parentChapterTitle: ch.parentChapterTitle,
              placementMode: 'content-inline-v2',
            }
          : {}),
      })),
    });
    const requestHash = conversionHash({
      ownerId,
      bookId,
      sourceHash: book.sourceHash,
      catalogId: catalog.catalogId,
      chapterIds: selection.chapters.map((ch) => ch.id),
      maxCostMicros: parsed.maxCostMicros,
      styleVersion: CONVERSION_CONTENT_STYLE_VERSION,
      bookArtPolicyVersion: CONVERSION_BOOK_ART_POLICY_VERSION,
      pipelineVersion: CONVERSION_UNREVIEWED_PIPELINE_VERSION,
      imageReviewMode: 'disabled',
      planningPolicy: CONVERSION_PEOPLE_PLANNING_POLICY,
    });
    return { book, catalog, selection, requestHash, parsed };
  }

  private async ownedBook(ownerId: string, id: string) {
    if (!z.uuid().safeParse(id).success)
      throw businessError('BOOK_NOT_FOUND', 404);
    return exposeProcessingErrors(() => this.repository.getBook(ownerId, id));
  }
  private async ownedRun(ownerId: string, id: string) {
    if (!z.uuid().safeParse(id).success)
      throw businessError('RUN_NOT_FOUND', 404);
    const run = await exposeProcessingErrors(() =>
      this.repository.getRun(ownerId, id),
    );
    if (run.operation !== 'illustration-conversion')
      throw businessError('RUN_NOT_FOUND', 404);
    const book = await this.ownedBook(ownerId, run.bookId);
    if (
      conversionConfigurationSchema.parse(run.configuration).sourceHash !==
      book.sourceHash
    )
      throw businessError('SOURCE_CHANGED', 409);
    return run;
  }
  private async catalog(book: ProcessingBook): Promise<Catalog> {
    const cacheKey = `conversion-catalogs/${book.id}/${ILLUSTRATION_SECTION_PARSER_VERSION}.json`;
    try {
      const saved = catalogSchema.parse(await this.readSmall(cacheKey));
      if (
        saved.sourceSha256 !== book.sourceHash ||
        saved.parserVersion !== ILLUSTRATION_SECTION_PARSER_VERSION
      )
        throw businessError('SOURCE_CHANGED', 409);
      return saved;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw error;
    }
    const existing = this.catalogs.get(book.id);
    if (existing) return existing;
    if (this.catalogs.size >= 2) throw businessError('OWNER_ACTIVE_LIMIT', 429);
    const pending = (async () => {
      if (
        (await this.storage.describe(book.sourceKey)).sha256 !== book.sourceHash
      )
        throw businessError('SOURCE_CHANGED', 409);
      let raw: Awaited<ReturnType<typeof inspectIllustrationCatalog>>;
      try {
        raw = await inspectIllustrationCatalog({
          sourcePath: this.storage.path(book.sourceKey),
          scope: 'section',
          limits: {
            maxSourceBytes:
              this.config.get('PROCESSING_UPLOAD_MAX_MIB') * 1024 * 1024,
          },
        });
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          typeof error.code === 'string' &&
          /^[A-Z0-9_]{1,64}$/.test(error.code)
        )
          throw businessError(error.code, 409);
        throw error;
      }
      if (raw.sourceSha256 !== book.sourceHash)
        throw businessError('SOURCE_CHANGED', 409);
      const result = catalogSchema.parse({
        ...raw,
        chapters: raw.chapters.map((ch) =>
          ch.selectable && ch.index > 500
            ? { ...ch, selectable: false, reasonCode: 'CHAPTER_INDEX_LIMIT' }
            : ch,
        ),
        catalogId: conversionHash(raw),
      });
      await this.freeze(cacheKey, result);
      return result;
    })().finally(() => this.catalogs.delete(book.id));
    this.catalogs.set(book.id, pending);
    return pending;
  }
  private async freeze(key: string, value: unknown) {
    try {
      return await this.storage.storeJson(key, value);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'EEXIST'
      )
        throw error;
      if (conversionHash(await this.readSmall(key)) !== conversionHash(value))
        throw businessError('IDEMPOTENCY_CONFLICT', 409);
      return this.storage.describe(key);
    }
  }
  private async readSmall(key: string) {
    const path = this.storage.path(key);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024)
      throw new ProcessingError('ILLUSTRATION_OUTPUT_INVALID');
    const bytes = await readFile(path);
    if (bytes.length !== info.size)
      throw new ProcessingError('ILLUSTRATION_OUTPUT_INVALID');
    return JSON.parse(bytes.toString('utf8')) as unknown;
  }
  private async selection(run: ProcessingRun): Promise<ConversionSelection> {
    const settings = conversionConfigurationSchema.parse(run.configuration);
    if (
      !new RegExp(
        `^conversion-selections/${run.bookId}/[a-f0-9]{64}\\.json$`,
      ).test(settings.selectionKey)
    )
      throw businessError('ILLUSTRATION_OUTPUT_INVALID', 409);
    const bytes = await readFile(this.storage.path(settings.selectionKey));
    if (
      bytes.length !== settings.selectionByteSize ||
      bytes.length > 2 * 1024 * 1024 ||
      createHash('sha256').update(bytes).digest('hex') !==
        settings.selectionHash
    )
      throw businessError('ILLUSTRATION_OUTPUT_INVALID', 409);
    return conversionSelectionSchema.parse(JSON.parse(bytes.toString('utf8')));
  }
  private async view(ownerId: string, run: ProcessingRun) {
    const book = await this.ownedBook(ownerId, run.bookId);
    const settings = conversionConfigurationSchema.parse(run.configuration);
    const selection = await this.selection(run);
    if (
      selection.sourceSha256 !== book.sourceHash ||
      selection.catalogId !== settings.catalogId
    )
      throw businessError('SOURCE_CHANGED', 409);
    const saved = await this.worker.readProgress(run);
    const bookArtPlan =
      settings.styleVersion === CONVERSION_CONTENT_STYLE_VERSION
        ? await this.worker.readBookArtPlan(run)
        : null;
    const directionSettings = bookArtPlan
      ? {
          artDirection: bookArtPlan.artDirection,
          artDirectionHash: artDirectionHash(bookArtPlan.artDirection),
        }
      : settings;
    const progress: ConversionProgress = saved ?? {
      schemaVersion: 1,
      sourceSha256: book.sourceHash,
      catalogId: settings.catalogId,
      chapters: selection.chapters.map((ch) => ({
        ...ch,
        status: 'WAITING',
        errorCode: null,
        image: null,
        anchor: null,
        alt: null,
      })),
    };
    const reviewed = conversionRequiresReview(settings.pipelineVersion);
    const counts = conversionCounts(progress, reviewed);
    const artifacts: {
      epub: string | null;
      report: string | null;
      cover: null;
    } = { epub: null, report: null, cover: null };
    if (run.status === 'SUCCEEDED')
      for (const id of run.artifactIds) {
        const artifact = await this.repository.getArtifact(ownerId, id);
        if (artifact.kind === 'export')
          artifacts.epub = `/api/v1/artifacts/${id}/download`;
        if (artifact.kind === 'report')
          artifacts.report = `/api/v1/artifacts/${id}/download`;
      }
    return {
      id: run.id,
      bookId: run.bookId,
      catalogId: settings.catalogId,
      status: run.status,
      stage: run.stage,
      originalName: book.originalName,
      title: selection.title,
      imageReview: {
        enabled: reviewed,
        description: reviewed
          ? '此历史任务仅插入通过 AI 视觉复核的图片；自动复核不代表人工审美批准。'
          : CONVERSION_UNREVIEWED_DESCRIPTION,
      },
      ...(directionSettings.artDirection
        ? { artDirection: conversionArtDirectionView(directionSettings) }
        : {}),
      ...(bookArtPlan
        ? {
            bookArtPlan: {
              reading: bookArtPlan.reading.temperament,
              rationale: bookArtPlan.reading.rationale,
              coverage: {
                mode: bookArtPlan.coverage.mode,
                totalSupportedSections:
                  bookArtPlan.coverage.totalSupportedSections,
                sampledSections: bookArtPlan.coverage.sampledSections,
                sampledParagraphs: bookArtPlan.coverage.sampledParagraphs,
              },
              medium: bookArtPlan.artDirection.medium,
              palette: bookArtPlan.artDirection.palette,
              lineLanguage: bookArtPlan.artDirection.lineLanguage,
              shapeLanguage: bookArtPlan.artDirection.shapeLanguage,
              negativeSpace: bookArtPlan.artDirection.negativeSpace,
              characterTreatment: bookArtPlan.artDirection.characterTreatment,
            },
          }
        : {}),
      chapters: progress.chapters.map((ch) => ({
        id: ch.id,
        index: ch.index,
        title: ch.title,
        ...(ch.scope === 'section'
          ? {
              scope: ch.scope,
              sectionId: ch.sectionId,
              parentChapterTitle: ch.parentChapterTitle,
            }
          : {}),
        ...(ch.anchor && ch.layout
          ? { placement: { kind: 'after-paragraph' as const, ...ch.layout } }
          : {}),
        ...(ch.visualPlan
          ? {
              visualPlan: {
                concepts: ch.visualPlan.concepts.map(
                  ({ id, idea, composition, emotionalIntent }) => ({
                    id,
                    idea,
                    composition,
                    emotionalIntent,
                  }),
                ),
                selectedConceptId: ch.visualPlan.selectedConceptId,
                selectionReason: ch.visualPlan.selectionReason,
              },
            }
          : {}),
        status: ch.status,
        ...(ch.visualReview ? { visualReview: ch.visualReview } : {}),
        error: ch.errorCode
          ? { code: ch.errorCode, message: safeProcessingMessage(ch.errorCode) }
          : null,
        imageUrl:
          ch.status === 'SUCCEEDED' &&
          ch.image &&
          (!reviewed || ch.visualReview?.status === 'PASSED')
            ? `/api/v1/illustration-conversions/${run.id}/chapters/${ch.id}/image`
            : null,
      })),
      counts,
      budget: {
        currency: 'CNY' as const,
        maxCostMicros: settings.maxCostMicros,
        upperBoundMicros: settings.upperBoundMicros,
        enforced: settings.budgetEnforced !== false,
      },
      artifacts,
      partial:
        (counts.succeeded > 0 || (reviewed && run.status === 'SUCCEEDED')) &&
        counts.succeeded < counts.total,
      error: run.errorCode
        ? { code: run.errorCode, message: safeProcessingMessage(run.errorCode) }
        : null,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  }
}
