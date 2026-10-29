import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import type { AppConfig } from '../src/config/app-config.module.js';
import {
  bookArtPlanHash,
  type BookArtPlan,
} from '../src/ai/book-art-planner.js';
import { compileContentIllustrationPrompt } from '../src/ai/chapter-illustration-planner.js';
import { visualReviewPolicyVersion } from '../src/ai/illustration-visual-reviewer.js';
import {
  getIllustrationArtDirection,
  artDirectionHash,
  composeArtDirectedPrompt,
  contentArtDirectionSchema,
} from '../src/ai/illustration-art-direction.js';
import { validateEnvironment } from '../src/config/environment.js';
import type { IllustrationChapterIndex } from '../src/documents/chapter-illustration-index.js';
import { LocalProcessingPersistence } from '../src/processing/local-processing.persistence.js';
import { ProcessingRepository } from '../src/processing/processing.repository.js';
import {
  ProcessingError,
  type ClaimedStep,
} from '../src/processing/processing.types.js';
import { LocalArtifactStorage } from '../src/business/artifact-storage.js';
import type { EpubCheckService } from '../src/business/epubcheck.service.js';
import {
  CONVERSION_INLINE_PIPELINE_VERSION,
  CONVERSION_ART_PIPELINE_VERSION,
  CONVERSION_ART_STYLE_VERSION,
  CONVERSION_CONTENT_STYLE_VERSION,
  CONVERSION_CONTENT_PIPELINE_VERSION,
  CONVERSION_REVIEW_PIPELINE_VERSION,
  CONVERSION_PEOPLE_PIPELINE_VERSION,
  CONVERSION_UNREVIEWED_PIPELINE_VERSION,
  CONVERSION_PEOPLE_PLANNING_POLICY,
  CONVERSION_BOOK_ART_POLICY_VERSION,
  conversionHash,
  conversionPricing,
  conversionConfigurationSchema,
} from '../src/business/conversion.types.js';
import {
  ConversionWorkerService,
  type ConversionDocuments,
  type ConversionVisualReviewer,
} from '../src/business/conversion-worker.service.js';
import type { IllustrationCliRunner } from '../src/business/illustration-worker.service.js';

const hash = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const format = {
  checkerVersion: 'test',
  errors: 0,
  warnings: 0,
  fatal: 0,
  errorSignatures: [],
};

it('constructs with disabled processing and unconfigured storage without eagerly opening visual-review paths', () => {
  const path = vi.fn(() => {
    throw new Error('unconfigured storage');
  });
  const readConfig = vi.fn(() => {
    throw new Error('configuration should remain unused');
  });
  const config = { get: readConfig } as unknown as AppConfig;
  expect(
    () =>
      new ConversionWorkerService(
        config,
        { path } as unknown as LocalArtifactStorage,
        {} as ProcessingRepository,
        {} as EpubCheckService,
      ),
  ).not.toThrow();
  expect(path).not.toHaveBeenCalled();
  expect(readConfig).not.toHaveBeenCalled();
});

async function fixture(
  options: {
    unknownChapter?: number;
    changedPlan?: boolean;
    failureCode?: string;
    sections?: boolean;
    artDirected?: boolean;
    contentDirected?: boolean;
    bookArtFailure?: boolean;
    tamperArt?: 'missing' | 'hash' | 'prompt';
    reviewed?: boolean;
    peopleDirected?: boolean;
    unreviewed?: boolean;
    tamperPlanningPolicy?: 'missing' | 'unexpected';
    reviewOutcomes?: Array<'PASSED' | 'REJECTED' | 'UNCERTAIN' | 'UNKNOWN'>;
    reviewTamper?:
      'imageSha256' | 'sourcePlanHash' | 'artDirectionHash' | 'planningPolicy';
    reviewFailure?: string;
  } = {},
) {
  if (options.unreviewed)
    options = {
      ...options,
      peopleDirected: true,
      reviewed: false,
      sections: true,
      contentDirected: true,
    };
  else if (options.peopleDirected) options = { ...options, reviewed: true };
  if (options.reviewed)
    options = { ...options, sections: true, contentDirected: true };
  const root = await mkdtemp(join(tmpdir(), 'epub-conversion-worker-'));
  const env = validateEnvironment({
    NODE_ENV: 'test',
    PROCESSING_ENABLED: true,
    PROCESSING_AI_ENABLED: true,
    PROCESSING_DATA_DIR: join(root, 'data'),
    QWEN_ENABLED: true,
    QWEN_API_KEY: 'placeholder',
    QWEN_BASE_URL: 'https://example.com/v1',
    QWEN_MODEL: 'test',
    IMAGE_GENERATION_ENABLED: true,
    VISUAL_REVIEW_ENABLED: true,
    IMAGE_API_KEY: 'placeholder',
    IMAGE_DATA_DIR: join(root, 'images'),
    ILLUSTRATION_BATCH_BUDGET_MICROS: 2000000,
    EPUBCHECK_JAR_PATH: join(root, 'checker.jar'),
  });
  const config = { get: (key: keyof typeof env) => env[key] } as AppConfig;
  const persistence = new LocalProcessingPersistence(env.PROCESSING_DATA_DIR);
  await persistence.initialize();
  cleanups.push(async () => {
    await persistence.close();
    await rm(root, { recursive: true, force: true });
  });
  const repository = new ProcessingRepository(persistence);
  const storage = new LocalArtifactStorage(config);
  const source = await storage.storeStream(
    'sources/book.epub',
    Readable.from(Buffer.from('PK-original-source')),
    1000,
  );
  const book = await repository.createBook({
    ownerId: 'owner',
    sourceKey: 'sources/book.epub',
    sourceHash: source.sha256,
    byteSize: source.byteSize,
    originalName: 'book.epub',
  });
  const chapters = [0, 1].map((index) => ({
    id: conversionHash(['chapter', index]),
    index,
    title: `第${index + 1}章`,
    ...(options.sections
      ? {
          scope: 'section' as const,
          sectionId: conversionHash(['chapter', index]),
          parentChapterTitle: '第一章',
          placementMode: 'content-inline-v2' as const,
        }
      : {}),
  }));
  const indexes: IllustrationChapterIndex[] = chapters.map((chapter) => ({
    schemaVersion: 1,
    parserVersion: options.sections
      ? 'illustration-sections-2'
      : 'illustration-chapters-1',
    ...(options.sections
      ? { scope: 'section' as const, sectionId: chapter.id }
      : {}),
    sourceSha256: source.sha256,
    chapterId: chapter.id,
    chapterIndex: chapter.index,
    title: chapter.title,
    covered: 'COMPLETE',
    documents: [
      {
        documentPath: `c${chapter.index}.xhtml`,
        sha256: conversionHash(['doc', chapter.index]),
        spineIndex: chapter.index,
        start: 0,
        end: 100,
      },
    ],
    blocks: [
      {
        id: conversionHash(['block', chapter.index]),
        text: '清晨的石桥',
        documentPath: `c${chapter.index}.xhtml`,
        start: 20,
        end: 50,
        contentSha256: conversionHash(['p', chapter.index]),
        order: 0,
        kind: 'paragraph',
      },
    ],
    anchors: [
      {
        id: conversionHash(['anchor', chapter.index]),
        kind: options.sections ? 'after-paragraph' : 'chapter-end',
        documentPath: `c${chapter.index}.xhtml`,
        blockId: conversionHash(['block', chapter.index]),
        sourceStart: 20,
        sourceEnd: 50,
        contentSha256: conversionHash(['p', chapter.index]),
        readingOrder: 0,
      },
    ],
  }));
  const catalogId = conversionHash(['catalog', source.sha256]);
  const selection = {
    catalogId,
    sourceSha256: source.sha256,
    title: '样本',
    chapters,
  };
  const selectionKey = 'conversion-selections/selection.json';
  const selectionDescription = await storage.storeJson(selectionKey, selection);
  const direction = contentArtDirectionSchema.parse({
    schemaVersion: 2,
    id: 'book-art',
    version: 1,
    status: 'provisional',
    sourceSha256: source.sha256,
    evidenceSha256: conversionHash('book-art-evidence'),
    medium: 'monochrome-ink',
    palette: [
      { colorName: '墨黑', hex: '#222222' },
      { colorName: '纸白', hex: '#FAF8F0' },
    ],
    lineLanguage: '轻重变化的线条',
    shapeLanguage: '简化轮廓与空间关系',
    texture: '少量排线',
    detailDensity: 'selective',
    negativeSpace: 'generous',
    characterTreatment: '人物以概括轮廓呈现',
  });
  const artPlan: BookArtPlan = {
    schemaVersion: 1,
    sourceSha256: source.sha256,
    evidenceSha256: direction.evidenceSha256,
    reading: {
      temperament: '宁静的环境中存在微妙距离',
      rationale: '以线条与留白表达距离和宁静',
      evidenceIds: ['e1'],
    },
    artDirection: direction,
    coverage: {
      mode: 'representative-samples',
      strategy: 'uniform-sections-first-middle-last-paragraphs',
      totalSupportedSections: 2,
      sampledSections: 2,
      sampledParagraphs: 2,
      maxSections: 12,
      maxParagraphsPerSection: 3,
      maxParagraphCodepoints: 100,
    },
    modelCalls: [
      {
        runId: randomUUID(),
        callId: randomUUID(),
        stage: 'book-art',
        model: 'test',
        status: 'SUCCEEDED',
        budgetDisposition: 'SETTLED',
        reservedMicros: 31744,
        estimatedCostMicros: 200,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        reused: false,
        result: {
          storageKey: 'private/result.json',
          sha256: conversionHash('test-art-response'),
          byteSize: 1000,
        },
      },
    ],
  };
  const pricing = conversionPricing(
    config,
    options.sections
      ? options.unreviewed
        ? CONVERSION_UNREVIEWED_PIPELINE_VERSION
        : options.peopleDirected
          ? CONVERSION_PEOPLE_PIPELINE_VERSION
          : options.reviewed
            ? CONVERSION_REVIEW_PIPELINE_VERSION
            : options.contentDirected
              ? CONVERSION_CONTENT_PIPELINE_VERSION
              : options.artDirected
                ? CONVERSION_ART_PIPELINE_VERSION
                : CONVERSION_INLINE_PIPELINE_VERSION
      : undefined,
    options.contentDirected
      ? CONVERSION_CONTENT_STYLE_VERSION
      : options.artDirected
        ? CONVERSION_ART_STYLE_VERSION
        : 'literary-v1',
  );
  const configuration = {
    catalogId,
    sourceHash: source.sha256,
    selectionKey,
    selectionHash: selectionDescription.sha256,
    selectionByteSize: selectionDescription.byteSize,
    maxCostMicros: 2000000,
    upperBoundMicros:
      2 * pricing.perChapterUpperMicros + (pricing.bookArtUpperMicros ?? 0),
    pricingHash: pricing.pricingHash,
    perChapterUpperMicros: pricing.perChapterUpperMicros,
    styleVersion: options.contentDirected
      ? CONVERSION_CONTENT_STYLE_VERSION
      : options.artDirected
        ? CONVERSION_ART_STYLE_VERSION
        : 'literary-v1',
    ...(options.artDirected
      ? {
          artDirection: getIllustrationArtDirection(),
          artDirectionHash: artDirectionHash(),
        }
      : {}),
    ...(options.contentDirected
      ? {
          bookArtPolicyVersion: CONVERSION_BOOK_ART_POLICY_VERSION,
          bookArtUpperMicros: pricing.bookArtUpperMicros,
          artSeed: chapters[0],
          ...(options.reviewed ? { visualReviewPolicyVersion } : {}),
          ...(options.unreviewed ? { imageReviewMode: 'disabled' } : {}),
          ...(options.peopleDirected
            ? { planningPolicy: CONVERSION_PEOPLE_PLANNING_POLICY }
            : {}),
        }
      : {}),
    ...(options.sections
      ? {
          pipelineVersion: options.unreviewed
            ? CONVERSION_UNREVIEWED_PIPELINE_VERSION
            : options.peopleDirected
              ? CONVERSION_PEOPLE_PIPELINE_VERSION
              : options.reviewed
                ? CONVERSION_REVIEW_PIPELINE_VERSION
                : options.contentDirected
                  ? CONVERSION_CONTENT_PIPELINE_VERSION
                  : options.artDirected
                    ? CONVERSION_ART_PIPELINE_VERSION
                    : CONVERSION_INLINE_PIPELINE_VERSION,
        }
      : {}),
  };
  async function createRun(key = 'conversion-key') {
    const { run } = await repository.createRun({
      ownerId: 'owner',
      bookId: book.id,
      operation: 'illustration-conversion',
      idempotencyKey: key,
      requestHash: conversionHash([key]),
      configuration,
      stages: options.contentDirected
        ? ['art-plan', 'convert', 'assemble']
        : ['convert', 'assemble'],
    });
    return run;
  }
  const run = await createRun();
  const claim = async (runId = run.id) => {
    const current = await repository.getRun('owner', runId);
    const step = current.steps.find((entry) => entry.status === 'PENDING')!;
    return (await repository.claim(
      {
        payloadVersion: 1,
        runId,
        stepId: step.id,
        dispatchGeneration: step.dispatchGeneration,
      },
      'worker',
      30000,
    ))!;
  };
  const png = await sharp({
    create: { width: 8, height: 8, channels: 3, background: 'white' },
  })
    .png()
    .toBuffer();
  const requests: Array<{
    until: string;
    outputDirectory: string;
    operationId: string;
    chapterIndex: number;
    imageBudget: string | undefined;
    artDirectionHash?: string;
  }> = [];
  const runner: IllustrationCliRunner = {
    run: vi.fn(async (input) => {
      const request = JSON.parse(await readFile(input.requestPath, 'utf8')) as {
        outputDirectory: string;
        operationId: string;
        chapterIndex: number;
      };
      requests.push({
        ...request,
        until: input.until,
        imageBudget: input.environment.IMAGE_OPERATION_BUDGET_MICROS,
      });
      if (input.until === 'book-art') {
        if (options.bookArtFailure)
          throw new ProcessingError('BOOK_ART_PLAN_INVALID');
        await mkdir(request.outputDirectory, { recursive: true });
        await writeFile(
          join(request.outputDirectory, 'book-art-plan.json'),
          JSON.stringify(artPlan),
        );
        await writeFile(
          join(request.outputDirectory, 'stage-receipt.json'),
          JSON.stringify({
            stage: 'book-art',
            sourceSha256: source.sha256,
            chapterId: indexes[0]!.chapterId,
            bookArtPlanHash: bookArtPlanHash(artPlan),
          }),
        );
        return;
      }
      if (options.unknownChapter === request.chapterIndex)
        throw new ProcessingError(options.failureCode ?? 'AI_RESPONSE_UNKNOWN');
      const index = indexes[request.chapterIndex]!;
      const planningPolicy =
        (options.peopleDirected &&
          options.tamperPlanningPolicy !== 'missing') ||
        options.tamperPlanningPolicy === 'unexpected'
          ? CONVERSION_PEOPLE_PLANNING_POLICY
          : undefined;
      const visualPlan = {
        concepts: [
          {
            id: 'c1',
            idea: '用桥与空白组织距离',
            composition: '近处桥栏与远处空白形成轻重对照',
            emotionalIntent: '以留白表达宁静',
            sourceBlockIds: [index.blocks[0]!.id],
          },
          {
            id: 'c2',
            idea: '通过水面反射组织关系',
            composition: '将水面与桥影上下并置',
            emotionalIntent: '以反射形成安静节奏',
            sourceBlockIds: [index.blocks[0]!.id],
          },
        ],
        selectedConceptId: 'c1',
        selectionReason: '更贴合有据的桥与空间关系',
      };
      const plan = {
        schemaVersion: 1,
        decision: 'ILLUSTRATE',
        coverage: 'COMPLETE',
        sourceSha256: source.sha256,
        chapterId: index.chapterId,
        anchorId: index.anchors[0]!.id,
        summary: '清晨的石桥',
        emotionalReading: '宁静',
        facts: [{ text: '清晨有石桥', sourceBlockIds: [index.blocks[0]!.id] }],
        concept: '留白表现宁静',
        imagePrompt: options.contentDirected
          ? compileContentIllustrationPrompt(
              {
                sceneDescription: '清晨的石桥',
                visualPlan,
                depicts: 'no-people',
                ...(planningPolicy ? { planningPolicy } : {}),
              },
              direction,
            )
          : options.artDirected && options.tamperArt !== 'prompt'
            ? composeArtDirectedPrompt('清晨的石桥')
            : '独立文学插画，清晨的石桥',
        alt: '石桥',
        ...(planningPolicy ? { planningPolicy } : {}),
        ...(options.sections
          ? {
              layout: 'compact' as const,
              settingEvidenceBlockIds: [index.blocks[0]!.id],
              sceneEvidenceBlockIds: [index.blocks[0]!.id],
            }
          : {}),
        modelCalls: [{ reused: input.until === 'image' }],
        ...(options.contentDirected
          ? {
              artDirection: direction,
              artDirectionHash: artDirectionHash(direction),
              visualPlan,
              sceneDescription: '清晨的石桥',
              depicts: 'no-people',
            }
          : {}),
        ...(options.artDirected && options.tamperArt !== 'missing'
          ? {
              artDirection: getIllustrationArtDirection(),
              artDirectionHash:
                options.tamperArt === 'hash'
                  ? '0'.repeat(64)
                  : artDirectionHash(),
            }
          : {}),
      };
      const sourcePlanHash = conversionHash({
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
              sceneEvidenceBlockIds: plan.sceneEvidenceBlockIds,
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
      await mkdir(request.outputDirectory, { recursive: true });
      await writeFile(
        join(request.outputDirectory, 'plan.json'),
        JSON.stringify(plan),
      );
      if (input.until === 'plan') {
        await writeFile(
          join(request.outputDirectory, 'stage-receipt.json'),
          JSON.stringify({
            stage: 'plan',
            sourceSha256: source.sha256,
            chapterId: index.chapterId,
            chapterTitle: index.title,
            sourcePlanHash: options.changedPlan
              ? '0'.repeat(64)
              : sourcePlanHash,
            planPath: join(request.outputDirectory, 'plan.json'),
          }),
        );
        return;
      }
      const callId = randomUUID();
      const path = join(env.IMAGE_DATA_DIR, 'assets', `${callId}.png`);
      await mkdir(join(env.IMAGE_DATA_DIR, 'assets'), { recursive: true });
      await writeFile(path, png);
      await writeFile(
        join(request.outputDirectory, 'image-receipt.json'),
        JSON.stringify({
          callId,
          asset: {
            path,
            sha256: hash(png),
            byteSize: png.length,
            width: 8,
            height: 8,
            mediaType: 'image/png',
          },
        }),
      );
      await writeFile(
        join(request.outputDirectory, 'stage-receipt.json'),
        JSON.stringify({
          stage: 'image',
          callId,
          sourceSha256: source.sha256,
          chapterId: index.chapterId,
          sourcePlanHash,
          anchorId: plan.anchorId,
        }),
      );
    }),
  };
  const integrity = {
    sourceUnchanged: true as const,
    bodyBytesPreserved: false as const,
    originalBodySourceFragmentsPreserved: true as const,
    exactAllowlistedInsertion: true as const,
    originalImagesPreserved: true as const,
    originalIdsPreserved: true as const,
    spineOrderPreserved: true as const,
    navigationTargetsPreserved: true as const,
    internalReferencesChecked: true as const,
    writtenArchiveHashesVerified: true as const,
  };
  const documentOperations: ConversionDocuments = {
    inspect: vi.fn((input) => Promise.resolve(indexes[input.chapterIndex]!)),
    insert: vi.fn<ConversionDocuments['insert']>(async (input) => {
      const outputPath = join(input.outputDirectory, 'illustrated.epub'),
        reportPath = join(input.outputDirectory, 'report.json');
      const bytes = Buffer.from('PK-once-assembled');
      await writeFile(outputPath, bytes);
      return {
        outputPath,
        reportPath,
        report: {
          schemaVersion: 1,
          pipelineVersion: 'chapter-illustration-batch-1',
          sourceSha256: source.sha256,
          outputSha256: hash(bytes),
          illustrations: input.insertions.map((insertion) => ({
            documentPath: insertion.anchor.documentPath,
            anchorContentSha256: insertion.anchor.contentSha256,
            imagePath: 'image.png',
            imageSha256: insertion.image.sha256,
            width: 8,
            height: 8,
            sourceStart: insertion.anchor.sourceStart,
            sourceEnd: insertion.anchor.sourceEnd,
          })),
          integrity,
          phases: {
            baseline: {
              originalBodyBytesPreserved: true,
              allowedChanges: [],
              warningCodes: [],
            },
            insertion: {
              changedResources: [],
              addedResources: [],
              insertedBodyElements: input.insertions.length,
            },
          },
          validation: {
            epubcheck: 'not-run',
            device: 'not-tested',
            aesthetic: 'not-approved',
          },
        },
      };
    }),
  };
  const check = vi.fn(() => Promise.resolve(format));
  const checker = { check } as unknown as EpubCheckService;
  const reviewer: ConversionVisualReviewer = {
    review: vi.fn<ConversionVisualReviewer['review']>(async (input) => {
      if (options.reviewFailure && input.chapter === indexes[0])
        throw new ProcessingError(options.reviewFailure);
      const outcome =
        options.reviewOutcomes?.[input.chapter === indexes[0] ? 0 : 1] ??
        'PASSED';
      if (outcome === 'UNKNOWN')
        throw new ProcessingError('VISUAL_REVIEW_UNKNOWN_OUTCOME');
      const firstResult =
        outcome === 'REJECTED'
          ? 'FAIL'
          : outcome === 'UNCERTAIN'
            ? 'UNCERTAIN'
            : 'PASS';
      return {
        schemaVersion: 1,
        policyVersion: visualReviewPolicyVersion,
        sourceSha256: source.sha256,
        chapterId: input.chapter.chapterId,
        sourcePlanHash: input.sourcePlanHash,
        artDirectionHash: artDirectionHash(direction),
        imageSha256: input.image.sha256,
        reviewImageSha256: conversionHash('review-thumbnail'),
        ...(options.reviewTamper && options.reviewTamper !== 'planningPolicy'
          ? { [options.reviewTamper]: '0'.repeat(64) }
          : {}),
        ...(input.context.planningPolicy &&
        options.reviewTamper !== 'planningPolicy'
          ? { planningPolicy: input.context.planningPolicy }
          : {}),
        status: outcome,
        summary:
          outcome === 'PASSED'
            ? '图片符合画面要求'
            : '图片存在需要拒绝或确认的问题',
        checks: (
          ['source', 'people', 'style', 'composition', 'artifacts'] as const
        ).map((aspect, index) => ({
          aspect,
          result: index === 0 ? firstResult : 'PASS',
          reason:
            index === 0 && firstResult !== 'PASS'
              ? '画面出现没有依据的人物'
              : '符合要求',
        })),
        modelCalls: [
          {
            ...artPlan.modelCalls[0]!,
            stage: 'visual-review',
            status: 'SUCCEEDED',
            budgetDisposition: 'SETTLED',
          },
        ],
      };
    }),
  };
  const worker = new ConversionWorkerService(
    config,
    storage,
    repository,
    checker,
    runner,
    documentOperations,
    reviewer,
  );
  const context = (claimed: ClaimedStep) => ({
    ...claimed,
    signal: new AbortController().signal,
  });
  return {
    root,
    env,
    run,
    book,
    configuration,
    config,
    repository,
    storage,
    indexes,
    requests,
    runner,
    checker,
    check,
    worker,
    documentOperations,
    claim,
    context,
    createRun,
    artPlan,
    reviewer,
  };
}

it('runs two independent chapters and assembles once from the immutable original with only export/report publication', async () => {
  const f = await fixture();
  const conversion = await f.claim();
  const result = await f.worker.handle(f.context(conversion));
  expect(result.artifacts).toBeUndefined();
  expect(f.requests.map((request) => request.until)).toEqual([
    'plan',
    'image',
    'plan',
    'image',
  ]);
  expect(new Set(f.requests.map((request) => request.operationId)).size).toBe(
    2,
  );
  expect(
    f.requests.every(
      (request) => request.imageBudget === String(f.env.IMAGE_PRICE_MICROS),
    ),
  ).toBe(true);
  await f.repository.completeStep(conversion.lease, result.result, {
    artifacts: result.artifacts,
  });
  const assembly = await f.claim();
  const completed = await f.worker.handle(f.context(assembly));
  expect(completed.artifacts?.map((artifact) => artifact.kind)).toEqual([
    'export',
    'report',
  ]);
  expect(f.documentOperations.insert).toHaveBeenCalledTimes(1);
  expect(
    vi.mocked(f.documentOperations.insert).mock.calls[0]![0],
  ).toMatchObject({
    sourcePath: f.storage.path(f.book.sourceKey),
    sourceSha256: f.book.sourceHash,
  });
  expect(
    vi.mocked(f.documentOperations.insert).mock.calls[0]![0].insertions,
  ).toHaveLength(2);
  expect(f.check).toHaveBeenCalledTimes(1);
});

it('freezes one registered art direction throughout a new conversion and reports visual review honestly', async () => {
  const f = await fixture({ sections: true, artDirected: true });
  const claimed = await f.claim();
  const result = await f.worker.handle(f.context(claimed));
  expect(f.requests).toHaveLength(4);
  expect(
    f.requests.every(
      (request) => request.artDirectionHash === artDirectionHash(),
    ),
  ).toBe(true);
  const legacyPricing = conversionPricing(
    f.config,
    CONVERSION_INLINE_PIPELINE_VERSION,
  );
  const legacyChild = conversionHash([
    'owner',
    f.book.id,
    f.book.sourceHash,
    f.indexes[0]!.chapterId,
    'literary-v1',
    legacyPricing.pricingHash,
    CONVERSION_INLINE_PIPELINE_VERSION,
  ]);
  expect(f.requests[0]!.operationId).not.toBe(legacyChild);
  await f.repository.completeStep(claimed.lease, result.result, {});
  const assembled = await f.worker.handle(f.context(await f.claim()));
  const report = assembled.artifacts!.find(
    (artifact) => artifact.kind === 'report',
  )!;
  const body = JSON.parse(
    await readFile(f.storage.path(report.storageKey), 'utf8'),
  );
  expect(body.artDirectionHash).toBe(artDirectionHash());
  expect(body.artDirection).toEqual(getIllustrationArtDirection());
  expect(body.visualReview).toBe('unreviewed');
});

it('plans book art before subsection concepts and exports the same content-derived direction', async () => {
  const f = await fixture({ sections: true, contentDirected: true });
  const art = await f.claim();
  expect(art.step.stage).toBe('art-plan');
  const planned = await f.worker.handle(f.context(art));
  expect(f.requests.map((request) => request.until)).toEqual(['book-art']);
  expect(planned.artifacts).toBeUndefined();
  await f.repository.completeStep(art.lease, planned.result, {});
  expect(await f.worker.readBookArtPlan(f.run)).toEqual(f.artPlan);
  const conversion = await f.claim();
  const converted = await f.worker.handle(f.context(conversion));
  expect(f.requests.map((request) => request.until)).toEqual([
    'book-art',
    'plan',
    'image',
    'plan',
    'image',
  ]);
  expect(
    f.requests
      .slice(1)
      .every(
        (request) =>
          request.artDirectionHash === artDirectionHash(f.artPlan.artDirection),
      ),
  ).toBe(true);
  const frozen = JSON.parse(
    await readFile(
      join(f.requests[1]!.outputDirectory, 'request.json'),
      'utf8',
    ),
  );
  expect(frozen.bookArtPlanHash).toBe(bookArtPlanHash(f.artPlan));
  const progress = await f.worker.readProgress(f.run);
  expect(
    progress?.chapters.every(
      (entry) => entry.visualPlan?.selectedConceptId === 'c1',
    ),
  ).toBe(true);
  await f.repository.completeStep(conversion.lease, converted.result, {});
  const assembled = await f.worker.handle(f.context(await f.claim()));
  const report = assembled.artifacts!.find(
    (artifact) => artifact.kind === 'report',
  )!;
  const body = JSON.parse(
    await readFile(f.storage.path(report.storageKey), 'utf8'),
  );
  expect(body.artDirection).toEqual(f.artPlan.artDirection);
  expect(body.bookArtPlan.reading).toEqual(f.artPlan.reading);
  expect(body.visualReview).toBe('unreviewed');
  expect(f.documentOperations.insert).toHaveBeenCalledTimes(1);
});

it('does not begin subsection planning when the book art step fails', async () => {
  const f = await fixture({
    sections: true,
    contentDirected: true,
    bookArtFailure: true,
  });
  await expect(
    f.worker.handle(f.context(await f.claim())),
  ).rejects.toMatchObject({ code: 'BOOK_ART_PLAN_INVALID' });
  expect(f.requests.map((request) => request.until)).toEqual(['book-art']);
  expect(f.documentOperations.insert).not.toHaveBeenCalled();
});

it('rejects a changed private book-art plan before sending any image work', async () => {
  const f = await fixture({ sections: true, contentDirected: true });
  const art = await f.claim();
  const planned = await f.worker.handle(f.context(art));
  await f.repository.completeStep(art.lease, planned.result, {});
  const pointer = planned.result as { bookArtPlan: { storageKey: string } };
  await writeFile(
    f.storage.path(pointer.bookArtPlan.storageKey),
    JSON.stringify({
      ...f.artPlan,
      reading: { ...f.artPlan.reading, temperament: '被替换的内容' },
    }),
  );
  await expect(
    f.worker.handle(f.context(await f.claim())),
  ).rejects.toMatchObject({ code: 'CONVERSION_PROGRESS_INVALID' });
  expect(f.requests).toHaveLength(1);
});

it('reuses stable book-art and styled subsection workspaces across completed batches', async () => {
  const f = await fixture({ sections: true, contentDirected: true });
  for (let stage = 0; stage < 3; stage += 1) {
    const claimed = await f.claim();
    const output = await f.worker.handle(f.context(claimed));
    await f.repository.completeStep(claimed.lease, output.result, {
      artifacts: output.artifacts,
    });
  }
  const next = await f.createRun('content-next-batch');
  for (let stage = 0; stage < 2; stage += 1) {
    const claimed = await f.claim(next.id);
    const output = await f.worker.handle(f.context(claimed));
    await f.repository.completeStep(claimed.lease, output.result, {});
  }
  expect(
    f.requests.slice(5).map(({ operationId, outputDirectory }) => ({
      operationId,
      outputDirectory,
    })),
  ).toEqual(
    f.requests.slice(0, 5).map(({ operationId, outputDirectory }) => ({
      operationId,
      outputDirectory,
    })),
  );
});

it.each(['missing', 'hash', 'prompt'] as const)(
  'refuses a %s art binding before invoking the paid image child',
  async (tamperArt) => {
    const f = await fixture({ sections: true, artDirected: true, tamperArt });
    await f.worker.handle(f.context(await f.claim()));
    expect(f.requests.map((request) => request.until)).toEqual([
      'plan',
      'plan',
    ]);
    const progress = await f.worker.readProgress(f.run);
    expect(progress?.chapters.map((chapter) => chapter.errorCode)).toEqual([
      'ART_DIRECTION_INVALID',
      'ART_DIRECTION_INVALID',
    ]);
  },
);

it('keeps an unknown chapter terminal and includes the successful chapter in a partial archive', async () => {
  const f = await fixture({ unknownChapter: 0 });
  const conversion = await f.claim();
  const result = await f.worker.handle(f.context(conversion));
  const progress = await f.worker.readProgress(f.run);
  expect(progress?.chapters.map((chapter) => chapter.status)).toEqual([
    'UNKNOWN',
    'SUCCEEDED',
  ]);
  // Resuming the same lease never retries a terminal unknown or a completed image.
  await f.worker.handle(f.context(conversion));
  expect(f.requests).toHaveLength(3);
  await f.repository.completeStep(conversion.lease, result.result, {
    artifacts: result.artifacts,
  });
  const completed = await f.worker.handle(f.context(await f.claim()));
  expect(completed.artifacts).toHaveLength(2);
  expect(
    vi.mocked(f.documentOperations.insert).mock.calls[0]![0].insertions,
  ).toHaveLength(1);
});

it('uses the same source/chapter/pricing workspace across batches so child ledgers can reuse paid successes', async () => {
  const f = await fixture();
  const conversion = await f.claim();
  const result = await f.worker.handle(f.context(conversion));
  await f.repository.completeStep(conversion.lease, result.result, {
    artifacts: result.artifacts,
  });
  const assembly = await f.claim();
  const final = await f.worker.handle(f.context(assembly));
  await f.repository.completeStep(assembly.lease, final.result, {
    artifacts: final.artifacts,
  });
  const next = await f.createRun('next-batch');
  await f.worker.handle(f.context(await f.claim(next.id)));
  expect(f.requests.slice(4).map((request) => request.outputDirectory)).toEqual(
    f.requests.slice(0, 4).map((request) => request.outputDirectory),
  );
  expect(f.requests.slice(4).map((request) => request.operationId)).toEqual(
    f.requests.slice(0, 4).map((request) => request.operationId),
  );
});

it('rejects pricing changes before invoking a paid child', async () => {
  const f = await fixture();
  f.env.IMAGE_PRICE_MICROS += 1;
  await expect(
    f.worker.handle(f.context(await f.claim())),
  ).rejects.toMatchObject({ code: 'CONVERSION_PRICING_CHANGED' });
  expect(f.runner.run).not.toHaveBeenCalled();
});

it('stops immediately on cancellation and does not publish or call a child', async () => {
  const f = await fixture();
  const signal = new AbortController();
  signal.abort();
  await expect(
    f.worker.handle({ ...(await f.claim()), signal: signal.signal }),
  ).rejects.toMatchObject({ code: 'PROCESSING_CANCELLED' });
  expect(f.runner.run).not.toHaveBeenCalled();
  expect(f.documentOperations.insert).not.toHaveBeenCalled();
});

it('rejects tampered plan bindings before image generation', async () => {
  const f = await fixture({ changedPlan: true });
  await f.worker.handle(f.context(await f.claim()));
  expect(f.requests.every((request) => request.until === 'plan')).toBe(true);
  expect(
    (await f.worker.readProgress(f.run))?.chapters.every(
      (chapter) => chapter.status !== 'SUCCEEDED',
    ),
  ).toBe(true);
});

it('refuses to publish an archive with EPUBCheck errors', async () => {
  const f = await fixture();
  const conversion = await f.claim();
  const result = await f.worker.handle(f.context(conversion));
  await f.repository.completeStep(conversion.lease, result.result, {
    artifacts: result.artifacts,
  });
  f.check.mockResolvedValue({ ...format, errors: 1 });
  await expect(
    f.worker.handle(f.context(await f.claim())),
  ).rejects.toMatchObject({ code: 'ILLUSTRATION_OUTPUT_INVALID' });
});

it('fences a cancelled lease after the first child completes, before sending image work', async () => {
  const f = await fixture();
  const original = vi.mocked(f.runner.run).getMockImplementation()!;
  vi.mocked(f.runner.run).mockImplementation(async (input) => {
    await original(input);
    await f.repository.requestCancel('owner', f.run.id);
  });
  await expect(
    f.worker.handle(f.context(await f.claim())),
  ).rejects.toMatchObject({ code: 'STALE_PROCESSING_LEASE' });
  expect(f.requests.map((request) => request.until)).toEqual(['plan']);
  expect(f.documentOperations.insert).not.toHaveBeenCalled();
});

it('rejects corrupt progress pointers instead of accepting a partial plan from disk', async () => {
  const f = await fixture();
  const claimed = await f.claim();
  await f.worker.handle(f.context(claimed));
  const current = await f.repository.getRun('owner', f.run.id);
  const result = current.steps[0]!.result as {
    progress: { storageKey: string };
  };
  await writeFile(f.storage.path(result.progress.storageKey), '{}');
  await expect(f.worker.readProgress(f.run)).rejects.toMatchObject({
    code: 'CONVERSION_PROGRESS_INVALID',
  });
});

it('marks a known budget rejection failed without misrepresenting it as an uncertain paid outcome', async () => {
  const f = await fixture({
    unknownChapter: 0,
    failureCode: 'IMAGE_DAILY_BUDGET_EXCEEDED',
  });
  await f.worker.handle(f.context(await f.claim()));
  const progress = await f.worker.readProgress(f.run);
  expect(progress?.chapters[0]).toMatchObject({
    status: 'FAILED',
    errorCode: 'IMAGE_DAILY_BUDGET_EXCEEDED',
    image: null,
  });
  expect(progress?.chapters[1]?.status).toBe('SUCCEEDED');
});

it('carries real subsection scope and selected inline layout through both CLI stages into final assembly', async () => {
  const f = await fixture({ sections: true });
  const conversion = await f.claim();
  const converted = await f.worker.handle(f.context(conversion));
  expect(f.documentOperations.inspect).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ sectionId: f.indexes[0]!.sectionId }),
  );
  expect(f.requests).toHaveLength(4);
  const frozen = JSON.parse(
    await readFile(
      join(f.requests[0]!.outputDirectory, 'request.json'),
      'utf8',
    ),
  );
  expect(frozen).toMatchObject({
    sectionId: f.indexes[0]!.sectionId,
    placementMode: 'content-inline-v2',
  });
  await f.repository.completeStep(conversion.lease, converted.result ?? {}, {
    artifacts: converted.artifacts,
  });
  const assembly = await f.claim();
  await f.worker.handle(f.context(assembly));
  expect(f.documentOperations.insert).toHaveBeenCalledWith(
    expect.objectContaining({
      insertions: expect.arrayContaining([
        expect.objectContaining({
          layout: { size: 'compact', alignment: 'center' },
        }),
      ]),
    }),
  );
});

it('inserts only a passed V7 image and preserves the rejected quality reasons across recovery', async () => {
  const f = await fixture({
    reviewed: true,
    reviewOutcomes: ['REJECTED', 'PASSED'],
  });
  const art = await f.claim();
  const plan = await f.worker.handle(f.context(art));
  await f.repository.completeStep(art.lease, plan.result, {});
  const conversion = await f.claim();
  const converted = await f.worker.handle(f.context(conversion));
  expect(f.reviewer.review).toHaveBeenCalledTimes(2);
  const progress = await f.worker.readProgress(f.run);
  expect(progress?.chapters.map(({ status }) => status)).toEqual([
    'REJECTED',
    'SUCCEEDED',
  ]);
  expect(progress?.chapters[0]?.visualReview?.checks[0]).toMatchObject({
    aspect: 'source',
    result: 'FAIL',
  });
  expect(progress?.chapters[0]?.errorCode).toBe('VISUAL_REVIEW_REJECTED');
  await f.worker.handle(f.context(conversion));
  expect(f.reviewer.review).toHaveBeenCalledTimes(2);
  await f.repository.completeStep(conversion.lease, converted.result, {});
  const assembled = await f.worker.handle(f.context(await f.claim()));
  expect(assembled.artifacts?.map(({ kind }) => kind)).toEqual([
    'export',
    'report',
  ]);
  expect(
    vi.mocked(f.documentOperations.insert).mock.calls[0]?.[0].insertions,
  ).toHaveLength(1);
  const report = assembled.artifacts!.find(({ kind }) => kind === 'report')!;
  const body = JSON.parse(
    await readFile(f.storage.path(report.storageKey), 'utf8'),
  );
  expect(body.visualReviewPolicyVersion).toBe(visualReviewPolicyVersion);
  expect(body.chapters[0]).toMatchObject({
    status: 'REJECTED',
    image: null,
    visualReview: { status: 'REJECTED' },
  });
  expect(body.chapters[1]).toMatchObject({
    status: 'SUCCEEDED',
    visualReview: { status: 'PASSED' },
  });
});

it('publishes a quality report without an EPUB when all V7 images are rejected or uncertain', async () => {
  const f = await fixture({
    reviewed: true,
    reviewOutcomes: ['REJECTED', 'UNCERTAIN'],
  });
  for (let i = 0; i < 2; i += 1) {
    const claimed = await f.claim();
    const result = await f.worker.handle(f.context(claimed));
    await f.repository.completeStep(claimed.lease, result.result, {});
  }
  const assembled = await f.worker.handle(f.context(await f.claim()));
  expect(f.documentOperations.insert).not.toHaveBeenCalled();
  expect(f.check).not.toHaveBeenCalled();
  expect(assembled.artifacts?.map(({ kind }) => kind)).toEqual(['report']);
  const report = JSON.parse(
    await readFile(f.storage.path(assembled.artifacts![0]!.storageKey), 'utf8'),
  );
  expect(report).toMatchObject({
    insertedIllustrations: 0,
    outputSha256: null,
    visualReview: 'no-approved-images',
  });
  expect(
    report.chapters.map((entry: { errorCode: string }) => entry.errorCode),
  ).toEqual(['VISUAL_REVIEW_REJECTED', 'VISUAL_REVIEW_UNCERTAIN']);
});

it('keeps an unknown visual call terminal and continues to review later sections without resending it on recovery', async () => {
  const f = await fixture({
    reviewed: true,
    reviewOutcomes: ['UNKNOWN', 'PASSED'],
  });
  const art = await f.claim();
  const planned = await f.worker.handle(f.context(art));
  await f.repository.completeStep(art.lease, planned.result, {});
  const conversion = await f.claim();
  await f.worker.handle(f.context(conversion));
  expect(
    (await f.worker.readProgress(f.run))?.chapters.map(({ status }) => status),
  ).toEqual(['UNKNOWN', 'SUCCEEDED']);
  await f.worker.handle(f.context(conversion));
  expect(f.reviewer.review).toHaveBeenCalledTimes(2);
});

it('treats an upstream review network failure as an unknown paid outcome and never resends that chapter on recovery', async () => {
  const f = await fixture({
    reviewed: true,
    reviewFailure: 'VISUAL_REVIEW_UPSTREAM_ERROR',
  });
  const art = await f.claim();
  const planned = await f.worker.handle(f.context(art));
  await f.repository.completeStep(art.lease, planned.result, {});
  const conversion = await f.claim();
  await f.worker.handle(f.context(conversion));
  const progress = await f.worker.readProgress(f.run);
  expect(progress?.chapters[0]).toMatchObject({
    status: 'UNKNOWN',
    errorCode: 'VISUAL_REVIEW_UPSTREAM_ERROR',
    image: null,
  });
  expect(progress?.chapters[1]?.status).toBe('SUCCEEDED');
  await f.worker.handle(f.context(conversion));
  expect(f.reviewer.review).toHaveBeenCalledTimes(2);
});

it.each(['imageSha256', 'sourcePlanHash', 'artDirectionHash'] as const)(
  'does not accept a passed review bound to a different %s',
  async (reviewTamper) => {
    const f = await fixture({ reviewed: true, reviewTamper });
    for (let i = 0; i < 2; i += 1) {
      const claimed = await f.claim();
      const result = await f.worker.handle(f.context(claimed));
      await f.repository.completeStep(claimed.lease, result.result, {});
    }
    expect(
      (await f.worker.readProgress(f.run))?.chapters.every(
        ({ status, errorCode }) =>
          status === 'FAILED' && errorCode === 'VISUAL_REVIEW_INVALID',
      ),
    ).toBe(true);
    const result = await f.worker.handle(f.context(await f.claim()));
    expect(result.artifacts?.map(({ kind }) => kind)).toEqual(['report']);
    expect(f.documentOperations.insert).not.toHaveBeenCalled();
  },
);

it.each(['image', 'plan', 'review'] as const)(
  'refuses to assemble a passed image after its %s file is changed',
  async (target) => {
    const f = await fixture({ reviewed: true });
    for (let i = 0; i < 2; i += 1) {
      const claimed = await f.claim();
      const result = await f.worker.handle(f.context(claimed));
      await f.repository.completeStep(claimed.lease, result.result, {});
    }
    const progress = (await f.worker.readProgress(f.run))!;
    if (target === 'image') {
      await writeFile(
        f.storage.path(progress.chapters[0]!.image!.storageKey),
        Buffer.from('changed-image'),
      );
    } else if (target === 'review') {
      await writeFile(
        f.storage.path(progress.chapters[0]!.visualReviewReference!.storageKey),
        '{}',
      );
    } else {
      const path = join(f.requests[1]!.outputDirectory, 'plan.json');
      const plan = JSON.parse(await readFile(path, 'utf8'));
      await writeFile(
        path,
        JSON.stringify({ ...plan, imagePrompt: 'different prompt' }),
      );
    }
    await expect(
      f.worker.handle(f.context(await f.claim())),
    ).rejects.toBeInstanceOf(ProcessingError);
    expect(f.documentOperations.insert).not.toHaveBeenCalled();
  },
);

it('fences cancellation after visual review before accepting its result or assembling an image', async () => {
  const f = await fixture({ reviewed: true });
  const art = await f.claim();
  const planned = await f.worker.handle(f.context(art));
  await f.repository.completeStep(art.lease, planned.result, {});
  const original = vi.mocked(f.reviewer.review).getMockImplementation()!;
  vi.mocked(f.reviewer.review).mockImplementation(async (input) => {
    const result = await original(input);
    await f.repository.requestCancel('owner', f.run.id);
    return result;
  });
  await expect(
    f.worker.handle(f.context(await f.claim())),
  ).rejects.toMatchObject({ code: 'STALE_PROCESSING_LEASE' });
  expect(f.reviewer.review).toHaveBeenCalledTimes(1);
  expect(f.documentOperations.insert).not.toHaveBeenCalled();
});

it('preserves V6 behavior when visual review is disabled, while new V7 work stops before any paid child', async () => {
  const legacy = await fixture({ sections: true, contentDirected: true });
  legacy.env.VISUAL_REVIEW_ENABLED = false;
  for (let i = 0; i < 3; i += 1) {
    const claimed = await legacy.claim();
    const result = await legacy.worker.handle(legacy.context(claimed));
    await legacy.repository.completeStep(claimed.lease, result.result, {
      artifacts: result.artifacts,
    });
  }
  expect(legacy.documentOperations.insert).toHaveBeenCalledTimes(1);
  expect(legacy.reviewer.review).not.toHaveBeenCalled();
  const reviewed = await fixture({ reviewed: true });
  reviewed.env.VISUAL_REVIEW_ENABLED = false;
  await expect(
    reviewed.worker.handle(reviewed.context(await reviewed.claim())),
  ).rejects.toMatchObject({ code: 'VISUAL_REVIEW_DISABLED' });
  expect(reviewed.runner.run).not.toHaveBeenCalled();
});

it('freezes visual pricing and model settings before V7 book planning or image calls', async () => {
  const f = await fixture({ reviewed: true });
  f.env.VISUAL_REVIEW_MODEL = 'changed-visual-model';
  await expect(
    f.worker.handle(f.context(await f.claim())),
  ).rejects.toMatchObject({ code: 'CONVERSION_PRICING_CHANGED' });
  expect(f.runner.run).not.toHaveBeenCalled();
});

it('isolates V8 planning requests and inserts only its passed image with the same planning policy in the report', async () => {
  const f = await fixture({
    peopleDirected: true,
    reviewOutcomes: ['REJECTED', 'PASSED'],
  });
  expect(f.configuration).toMatchObject({
    pipelineVersion: CONVERSION_PEOPLE_PIPELINE_VERSION,
    planningPolicy: CONVERSION_PEOPLE_PLANNING_POLICY,
  });
  const oldPricing = conversionPricing(
    f.config,
    CONVERSION_REVIEW_PIPELINE_VERSION,
    CONVERSION_CONTENT_STYLE_VERSION,
  );
  expect(f.configuration.pricingHash).not.toBe(oldPricing.pricingHash);
  for (let stage = 0; stage < 2; stage += 1) {
    const claimed = await f.claim();
    const output = await f.worker.handle(f.context(claimed));
    await f.repository.completeStep(claimed.lease, output.result, {});
  }
  const request = JSON.parse(
    await readFile(
      join(f.requests[1]!.outputDirectory, 'request.json'),
      'utf8',
    ),
  );
  expect(request.planningPolicy).toBe(CONVERSION_PEOPLE_PLANNING_POLICY);
  expect(f.reviewer.review).toHaveBeenCalledWith(
    expect.objectContaining({
      context: expect.objectContaining({
        planningPolicy: CONVERSION_PEOPLE_PLANNING_POLICY,
        parentRunId: f.run.id,
      }),
    }),
  );
  const progress = (await f.worker.readProgress(f.run))!;
  expect(progress.chapters.map(({ status }) => status)).toEqual([
    'REJECTED',
    'SUCCEEDED',
  ]);
  const assembled = await f.worker.handle(f.context(await f.claim()));
  expect(
    vi.mocked(f.documentOperations.insert).mock.calls[0]?.[0].insertions,
  ).toHaveLength(1);
  const artifact = assembled.artifacts!.find(({ kind }) => kind === 'report')!;
  const report = JSON.parse(
    await readFile(f.storage.path(artifact.storageKey), 'utf8'),
  );
  expect(report.planningPolicy).toBe(CONVERSION_PEOPLE_PLANNING_POLICY);
});

it('requires V8 planning policy and refuses it on V7 persisted configurations', async () => {
  const f = await fixture({ peopleDirected: true });
  expect(
    conversionConfigurationSchema.safeParse({
      ...f.configuration,
      planningPolicy: undefined,
    }).success,
  ).toBe(false);
  expect(
    conversionConfigurationSchema.safeParse({
      ...f.configuration,
      pipelineVersion: CONVERSION_REVIEW_PIPELINE_VERSION,
    }).success,
  ).toBe(false);
  expect(
    conversionConfigurationSchema.safeParse({
      ...f.configuration,
      pipelineVersion: CONVERSION_REVIEW_PIPELINE_VERSION,
      planningPolicy: undefined,
    }).success,
  ).toBe(true);
});

it.each(['missing', 'unexpected'] as const)(
  'rejects %s planning-policy cache bindings before any image or review call',
  async (tamperPlanningPolicy) => {
    const f = await fixture({
      reviewed: true,
      peopleDirected: tamperPlanningPolicy === 'missing',
      tamperPlanningPolicy,
    });
    const art = await f.claim();
    const output = await f.worker.handle(f.context(art));
    await f.repository.completeStep(art.lease, output.result, {});
    await f.worker.handle(f.context(await f.claim()));
    expect(f.requests.map(({ until }) => until)).toEqual([
      'book-art',
      'plan',
      'plan',
    ]);
    expect(f.reviewer.review).not.toHaveBeenCalled();
    expect(
      (await f.worker.readProgress(f.run))?.chapters.every(
        ({ status }) => status !== 'SUCCEEDED',
      ),
    ).toBe(true);
  },
);

it('refuses a legacy passed-review result on a V8 planning policy', async () => {
  const f = await fixture({
    peopleDirected: true,
    reviewTamper: 'planningPolicy',
  });
  for (let stage = 0; stage < 2; stage += 1) {
    const claimed = await f.claim();
    const output = await f.worker.handle(f.context(claimed));
    await f.repository.completeStep(claimed.lease, output.result, {});
  }
  expect(
    (await f.worker.readProgress(f.run))?.chapters.every(
      ({ status, errorCode }) =>
        status === 'FAILED' && errorCode === 'VISUAL_REVIEW_INVALID',
    ),
  ).toBe(true);
  const assembled = await f.worker.handle(f.context(await f.claim()));
  expect(assembled.artifacts?.map(({ kind }) => kind)).toEqual(['report']);
  expect(f.documentOperations.insert).not.toHaveBeenCalled();
});

it.each([false, true])(
  'V9 inserts generated images without a visual call even when VISUAL_REVIEW_ENABLED is %s',
  async (enabled) => {
    const f = await fixture({
      unreviewed: true,
      reviewOutcomes: ['REJECTED', 'UNKNOWN'],
    });
    f.env.VISUAL_REVIEW_ENABLED = enabled;
    f.env.VISUAL_REVIEW_MODEL = 'unused-visual-model';
    expect(f.configuration).toMatchObject({
      pipelineVersion: CONVERSION_UNREVIEWED_PIPELINE_VERSION,
      imageReviewMode: 'disabled',
      planningPolicy: CONVERSION_PEOPLE_PLANNING_POLICY,
    });
    expect(f.configuration).not.toHaveProperty('visualReviewPolicyVersion');
    const previousPricing = conversionPricing(
      f.config,
      CONVERSION_PEOPLE_PIPELINE_VERSION,
      CONVERSION_CONTENT_STYLE_VERSION,
    );
    expect(f.configuration.pricingHash).not.toBe(previousPricing.pricingHash);
    expect(f.configuration.perChapterUpperMicros).toBe(500000);
    for (let stage = 0; stage < 2; stage += 1) {
      const claimed = await f.claim();
      const result = await f.worker.handle(f.context(claimed));
      await f.repository.completeStep(claimed.lease, result.result, {});
    }
    const progress = (await f.worker.readProgress(f.run))!;
    expect(progress.chapters.map(({ status }) => status)).toEqual([
      'SUCCEEDED',
      'SUCCEEDED',
    ]);
    for (const chapter of progress.chapters) {
      expect(chapter.sourcePlanHash).toMatch(/^[a-f0-9]{64}$/);
      expect(chapter.visualReview).toBeUndefined();
      expect(chapter.visualReviewReference).toBeUndefined();
    }
    const firstRequest = JSON.parse(
      await readFile(
        join(f.requests[1]!.outputDirectory, 'request.json'),
        'utf8',
      ),
    );
    expect(firstRequest.planningPolicy).toBe(CONVERSION_PEOPLE_PLANNING_POLICY);
    const priorChildId = conversionHash([
      'owner',
      f.book.id,
      f.book.sourceHash,
      f.indexes[0]!.chapterId,
      CONVERSION_CONTENT_STYLE_VERSION,
      previousPricing.pricingHash,
      artDirectionHash(f.artPlan.artDirection),
      bookArtPlanHash(f.artPlan),
      CONVERSION_PEOPLE_PIPELINE_VERSION,
    ]);
    expect(firstRequest.operationId).not.toBe(priorChildId);
    const result = await f.worker.handle(f.context(await f.claim()));
    expect(f.reviewer.review).not.toHaveBeenCalled();
    expect(f.requests.map(({ until }) => until)).toEqual([
      'book-art',
      'plan',
      'image',
      'plan',
      'image',
    ]);
    expect(
      vi.mocked(f.documentOperations.insert).mock.calls[0]?.[0].insertions,
    ).toHaveLength(2);
    expect(f.check).toHaveBeenCalledTimes(1);
    const report = result.artifacts!.find(({ kind }) => kind === 'report')!;
    const body = JSON.parse(
      await readFile(f.storage.path(report.storageKey), 'utf8'),
    );
    expect(body).toMatchObject({
      schemaVersion: 1,
      pipelineVersion: 'chapter-illustration-conversion-3',
      imageReviewMode: 'disabled',
      visualReview: 'disabled-by-request',
      insertedIllustrations: 2,
    });
    expect(body.visualReviewPolicyVersion).toBeUndefined();
    expect(
      body.chapters.every(
        (chapter: { visualReview?: unknown }) => !chapter.visualReview,
      ),
    ).toBe(true);
  },
);

it.each(['image', 'plan', 'receipt'] as const)(
  'V9 keeps deterministic source/plan/image binding when a %s changes before assembly',
  async (target) => {
    const f = await fixture({ unreviewed: true });
    for (let stage = 0; stage < 2; stage += 1) {
      const claimed = await f.claim();
      const result = await f.worker.handle(f.context(claimed));
      await f.repository.completeStep(claimed.lease, result.result, {});
    }
    const progress = (await f.worker.readProgress(f.run))!;
    if (target === 'image') {
      await writeFile(
        f.storage.path(progress.chapters[0]!.image!.storageKey),
        Buffer.from('changed-image'),
      );
    } else {
      const path = join(
        f.requests[1]!.outputDirectory,
        target === 'plan' ? 'plan.json' : 'image-receipt.json',
      );
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (target === 'plan') value.imagePrompt = 'changed prompt';
      else value.callId = randomUUID();
      await writeFile(path, JSON.stringify(value));
    }
    await expect(
      f.worker.handle(f.context(await f.claim())),
    ).rejects.toBeInstanceOf(ProcessingError);
    expect(f.documentOperations.insert).not.toHaveBeenCalled();
    expect(f.reviewer.review).not.toHaveBeenCalled();
  },
);

it('V9 does not retry unknown generation outcomes or review them on a resumed conversion', async () => {
  const f = await fixture({ unreviewed: true, unknownChapter: 0 });
  const art = await f.claim();
  const planned = await f.worker.handle(f.context(art));
  await f.repository.completeStep(art.lease, planned.result, {});
  const conversion = await f.claim();
  await f.worker.handle(f.context(conversion));
  const calls = f.requests.length;
  const resumed = await f.worker.handle(f.context(conversion));
  expect(f.requests).toHaveLength(calls);
  await f.repository.completeStep(conversion.lease, resumed.result, {});
  const progress = (await f.worker.readProgress(f.run))!;
  expect(progress.chapters.map(({ status }) => status)).toEqual([
    'UNKNOWN',
    'SUCCEEDED',
  ]);
  await f.worker.handle(f.context(await f.claim()));
  expect(
    vi.mocked(f.documentOperations.insert).mock.calls[0]?.[0].insertions,
  ).toHaveLength(1);
  expect(f.reviewer.review).not.toHaveBeenCalled();
});

it('V9 requires explicit disabled-review configuration without accepting legacy review claims', async () => {
  const f = await fixture({ unreviewed: true });
  expect(conversionConfigurationSchema.safeParse(f.configuration).success).toBe(
    true,
  );
  for (const changed of [
    { imageReviewMode: undefined },
    { visualReviewPolicyVersion },
    { planningPolicy: undefined },
    { pipelineVersion: CONVERSION_PEOPLE_PIPELINE_VERSION },
  ])
    expect(
      conversionConfigurationSchema.safeParse({
        ...f.configuration,
        ...changed,
      }).success,
    ).toBe(false);
});

it('V9 fences cancellation after image generation before accepting or inserting the output', async () => {
  const f = await fixture({ unreviewed: true });
  const art = await f.claim();
  const planned = await f.worker.handle(f.context(art));
  await f.repository.completeStep(art.lease, planned.result, {});
  const runChild = vi.mocked(f.runner.run).getMockImplementation()!;
  vi.mocked(f.runner.run).mockImplementation(async (input) => {
    await runChild(input);
    if (input.until === 'image')
      await f.repository.requestCancel('owner', f.run.id);
  });
  await expect(
    f.worker.handle(f.context(await f.claim())),
  ).rejects.toMatchObject({ code: 'STALE_PROCESSING_LEASE' });
  expect(f.requests.map(({ until }) => until)).toEqual([
    'book-art',
    'plan',
    'image',
  ]);
  expect(f.documentOperations.insert).not.toHaveBeenCalled();
  expect(f.reviewer.review).not.toHaveBeenCalled();
});
