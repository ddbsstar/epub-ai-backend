import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { AiGatewayError } from '../src/ai/ai-structure.types.js';
import type { AiService } from '../src/ai/ai.service.js';
import {
  compileContentIllustrationPrompt,
  type PlannerChapter,
} from '../src/ai/chapter-illustration-planner.js';
import {
  artDirectionHash,
  contentArtDirectionSchema,
} from '../src/ai/illustration-art-direction.js';
import {
  IllustrationVisualReviewer,
  illustrationVisualReviewSchema,
  publicVisualReviewSchema,
  reviewUpperMicros,
  visualReviewSourcePlanHash,
  type VisualReviewInput,
} from '../src/ai/illustration-visual-reviewer.js';
import type { AppConfig } from '../src/config/app-config.module.js';
import {
  validateEnvironment,
  type Environment,
} from '../src/config/environment.js';
import { LocalProcessingPersistence } from '../src/processing/local-processing.persistence.js';
import { ProcessingRepository } from '../src/processing/processing.repository.js';

const hash = (value: Uint8Array | string) =>
  createHash('sha256').update(value).digest('hex');
const aspects = [
  'source',
  'people',
  'style',
  'composition',
  'artifacts',
] as const;
const response = (result: 'PASS' | 'FAIL' | 'UNCERTAIN' = 'PASS') => ({
  summary:
    result === 'PASS'
      ? '画面与场景及艺术方案相符。'
      : '画面出现了需要处理的问题。',
  checks: aspects.map((aspect) => ({
    aspect,
    result: aspect === 'people' ? result : ('PASS' as const),
    reason:
      aspect === 'people' && result !== 'PASS'
        ? '画面中出现了额外人物。'
        : '可见内容符合该项要求。',
  })),
});

describe('source/image-bound visual review with a real isolated ledger (no network)', () => {
  let root: string;
  let env: Environment;
  let repository: ProcessingRepository;
  let input: VisualReviewInput;
  let completeVisual = vi.fn<AiService['completeVisual']>();
  function config(extra: Partial<Environment> = {}): AppConfig {
    const values = { ...env, ...extra };
    return { get: (key: keyof Environment) => values[key] } as AppConfig;
  }
  const reviewer = (extra: Partial<Environment> = {}) =>
    new IllustrationVisualReviewer(
      config(extra),
      repository,
      { completeVisual },
      join(root, 'visual-reviews'),
    );
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'epub-visual-review-'));
    env = validateEnvironment({
      NODE_ENV: 'test',
      PROCESSING_ENABLED: true,
      PROCESSING_AI_ENABLED: true,
      PROCESSING_DATA_DIR: root,
      EPUBCHECK_JAR_PATH: join(root, 'checker.jar'),
      QWEN_ENABLED: true,
      QWEN_API_KEY: 'test-private-key',
      QWEN_BASE_URL: 'https://example.com/v1',
      QWEN_MODEL: 'qwen3.8-flash',
      VISUAL_REVIEW_ENABLED: true,
    });
    const persistence = new LocalProcessingPersistence(root);
    await persistence.initialize();
    repository = new ProcessingRepository(persistence);
    const source = hash('book');
    const book = await repository.createBook({
      ownerId: 'owner',
      sourceKey: 'sources/book.epub',
      sourceHash: source,
      byteSize: 100,
      originalName: 'private-book.epub',
    });
    const block = {
      id: hash('block'),
      text: '清晨的空桥横过河面，远处是山谷。桥上没有行人。',
      kind: 'paragraph' as const,
      documentPath: 'OPS/body.xhtml',
      start: 100,
      end: 250,
      contentSha256: hash('paragraph'),
      order: 0,
    };
    const chapter: PlannerChapter = {
      schemaVersion: 1,
      parserVersion: 'illustration-sections-2',
      sourceSha256: source,
      chapterId: hash('chapter'),
      scope: 'section',
      sectionId: hash('chapter'),
      title: '第一节',
      covered: 'COMPLETE',
      blocks: [block],
      documents: [
        {
          documentPath: block.documentPath,
          sha256: hash('doc'),
          spineIndex: 0,
          start: 0,
          end: 300,
        },
      ],
      anchors: [
        {
          id: hash('anchor'),
          kind: 'after-paragraph',
          documentPath: block.documentPath,
          blockId: block.id,
          sourceStart: block.start,
          sourceEnd: block.end,
          contentSha256: block.contentSha256,
          readingOrder: 0,
        },
      ],
    };
    const artDirection = contentArtDirectionSchema.parse({
      schemaVersion: 2,
      id: 'book-art',
      version: 1,
      status: 'provisional',
      sourceSha256: source,
      evidenceSha256: hash('evidence'),
      medium: 'monochrome-ink',
      palette: [
        { colorName: '墨黑', hex: '#222222' },
        { colorName: '纸白', hex: '#FAF8F0' },
      ],
      lineLanguage: '克制线条',
      shapeLanguage: '简化轮廓',
      texture: '少量排线',
      detailDensity: 'selective',
      negativeSpace: 'generous',
      characterTreatment: '简化剪影',
    });
    const visualPlan = {
      concepts: [
        {
          id: 'c1',
          idea: '桥与空白形成距离',
          composition: '空桥位于前景，远处山谷留白',
          emotionalIntent: '以距离表达宁静',
          sourceBlockIds: [block.id],
        },
        {
          id: 'c2',
          idea: '水面与桥影形成关系',
          composition: '上下安排桥与水面',
          emotionalIntent: '以水面关系表达平静',
          sourceBlockIds: [block.id],
        },
      ],
      selectedConceptId: 'c1',
      selectionReason: '更贴合原文有据的距离关系',
    };
    const plan = {
      schemaVersion: 1,
      decision: 'ILLUSTRATE',
      coverage: 'COMPLETE',
      sourceSha256: source,
      chapterId: chapter.chapterId,
      anchorId: chapter.anchors[0]!.id,
      summary: '清晨桥与山谷。',
      emotionalReading: '宁静。',
      facts: [{ text: '桥边有河流和山谷。', sourceBlockIds: [block.id] }],
      concept: '通过空桥与山谷关系表达宁静。',
      imagePrompt: compileContentIllustrationPrompt(
        {
          sceneDescription: '清晨的空桥与远处山谷。',
          visualPlan,
          depicts: 'no-people',
        },
        artDirection,
      ),
      alt: '空桥与山谷',
      layout: 'medium',
      layoutSource: 'model',
      settingEvidenceBlockIds: [block.id],
      sceneEvidenceBlockIds: [block.id],
      artDirection,
      artDirectionHash: artDirectionHash(artDirection),
      visualPlan,
      sceneDescription: '清晨的空桥与远处山谷。',
      depicts: 'no-people',
    };
    const bytes = await sharp({
      create: { width: 768, height: 768, channels: 4, background: '#f2eee5' },
    })
      .png()
      .toBuffer();
    const path = join(root, 'assets', 'test.png');
    await mkdir(join(root, 'assets'));
    await writeFile(path, bytes);
    input = {
      chapter,
      plan,
      sourcePlanHash: visualReviewSourcePlanHash(plan),
      image: { path, sha256: hash(bytes), byteSize: bytes.length },
      context: {
        ownerId: book.ownerId,
        bookId: book.id,
        operationId: 'stable-section-review',
      },
    };
    completeVisual = vi
      .fn<AiService['completeVisual']>()
      .mockImplementation(async () => {
        const active = await repository.persistence.listActive(100);
        expect(active.some((run) => run.modelCall?.status === 'SENT')).toBe(
          true,
        );
        return {
          content: JSON.stringify(response()),
          finishReason: 'stop',
          usage: { inputTokens: 100, outputTokens: 80, totalTokens: 180 },
        };
      });
  });
  afterEach(async () => {
    await repository.close();
    await rm(root, { recursive: true, force: true });
  });

  it('reviews a real metadata-free bounded JPEG, settles supplied usage, and reuses one source/image-bound success', async () => {
    const first = await reviewer().review(input);
    expect(first.status).toBe('PASSED');
    expect(first.modelCalls[0]).toMatchObject({
      stage: 'visual-review',
      status: 'SUCCEEDED',
      budgetDisposition: 'SETTLED',
      usage: { inputTokens: 100, outputTokens: 80, totalTokens: 180 },
      reused: false,
      reservedMicros: reviewUpperMicros(config()),
    });
    const [messages, image] = completeVisual.mock.calls[0]!;
    expect(messages[0]!.content).toContain('必须实际查看');
    expect(messages[1]!.content).toContain(input.image.sha256);
    expect(messages[1]!.content).not.toContain(input.image.path);
    expect(messages[1]!.content).not.toContain(input.chapter.blocks[0]!.id);
    const metadata = await sharp(image.bytes).metadata();
    expect(metadata).toMatchObject({ format: 'jpeg', width: 512, height: 512 });
    expect(metadata.exif).toBeUndefined();
    expect(image.bytes.byteLength).toBeLessThanOrEqual(262144);
    expect(hash(image.bytes)).toBe(first.reviewImageSha256);
    const second = await reviewer().review(input);
    expect(second.modelCalls[0]!.reused).toBe(true);
    expect(second.modelCalls[0]!.callId).toBe(first.modelCalls[0]!.callId);
    expect(second.imageSha256).toBe(input.image.sha256);
    expect(completeVisual).toHaveBeenCalledTimes(1);
    const state = await readFile(join(root, 'metadata/state.json'), 'utf8');
    expect(state).not.toContain('data:image');
    expect(state).not.toContain('清晨的空桥');
    const ref = first.modelCalls[0]!.result;
    expect(ref.storageKey).toMatch(/^visual-reviews\//);
    expect(hash(await readFile(join(root, ref.storageKey)))).toBe(ref.sha256);
  });

  async function runningParent(people = false) {
    const { run } = await repository.createRun({
      ownerId: input.context.ownerId,
      bookId: input.context.bookId,
      operation: 'illustration-conversion',
      idempotencyKey: 'parent',
      requestHash: hash('parent'),
      configuration: {
        pipelineVersion: people ? 'subsection-inline-8' : 'subsection-inline-7',
        visualReviewPolicyVersion: 'visual-review-1',
        ...(people ? { planningPolicy: 'content-people-1' } : {}),
      },
      stages: ['convert', 'assemble'],
    });
    await repository.claim(
      {
        payloadVersion: 1,
        runId: run.id,
        stepId: run.steps[0]!.id,
        dispatchGeneration: 1,
      },
      'main-worker',
      30000,
    );
    return run;
  }

  function peopleInput(longFields = false): VisualReviewInput {
    const old = input.plan as {
      sceneDescription: string;
      visualPlan: Parameters<
        typeof compileContentIllustrationPrompt
      >[0]['visualPlan'];
      depicts: 'adults-only' | 'no-people';
      artDirection: Parameters<typeof compileContentIllustrationPrompt>[1];
    };
    const visualPlan = structuredClone(old.visualPlan);
    if (longFields)
      visualPlan.concepts[0]!.composition = '空桥与远山间留白。'.repeat(9);
    const sceneDescription = longFields
      ? '空桥与山谷。'.repeat(20)
      : old.sceneDescription;
    const plan = {
      ...(input.plan as Record<string, unknown>),
      planningPolicy: 'content-people-1' as const,
      sceneDescription,
      visualPlan,
      imagePrompt: compileContentIllustrationPrompt(
        {
          sceneDescription,
          visualPlan,
          depicts: old.depicts,
          planningPolicy: 'content-people-1',
        },
        old.artDirection,
      ),
    };
    return {
      ...input,
      plan,
      sourcePlanHash: visualReviewSourcePlanHash(plan),
      context: { ...input.context, planningPolicy: 'content-people-1' },
    };
  }

  it('executes a real inline review while its parent occupies the default one-owner active slot', async () => {
    const parent = await runningParent();
    const review = await reviewer().review({
      ...input,
      context: { ...input.context, parentRunId: parent.id },
    });
    expect(review.status).toBe('PASSED');
    expect(completeVisual).toHaveBeenCalledTimes(1);
    const ledger = await repository.getRun(
      input.context.ownerId,
      review.modelCalls[0]!.runId,
    );
    expect(ledger.operation).toBe('illustration-visual-review');
    expect(ledger.configuration).toMatchObject({ parentRunId: parent.id });
    expect(
      (await repository.getRun(input.context.ownerId, parent.id)).status,
    ).toBe('RUNNING');
  });

  it.each(['PASS', 'FAIL'] as const)(
    'reviews V8 with a matching nested parent and preserves the %s verdict/cache binding',
    async (result) => {
      const changed = peopleInput();
      const parent = await runningParent(true);
      changed.context.parentRunId = parent.id;
      completeVisual.mockResolvedValue({
        content: JSON.stringify(response(result)),
        finishReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 80, totalTokens: 180 },
      });
      const value = await reviewer().review(changed);
      expect(value).toMatchObject({
        status: result === 'PASS' ? 'PASSED' : 'REJECTED',
        planningPolicy: 'content-people-1',
        sourcePlanHash: changed.sourcePlanHash,
      });
      const run = await repository.getRun(
        changed.context.ownerId,
        value.modelCalls[0]!.runId,
      );
      expect(run.configuration).toMatchObject({
        parentRunId: parent.id,
        planningPolicy: 'content-people-1',
      });
      expect((await reviewer().review(changed)).modelCalls[0]?.reused).toBe(
        true,
      );
      expect(completeVisual).toHaveBeenCalledTimes(1);
      expect(await repository.listDispatchable()).toHaveLength(0);
    },
  );

  it('accepts the V8 extended scene/composition bounds while leaving legacy hash and schema limits unchanged', async () => {
    const original = structuredClone(input);
    const changed = peopleInput(true);
    const plan = changed.plan as {
      sceneDescription: string;
      visualPlan: { concepts: { composition: string }[] };
    };
    expect(Array.from(plan.sceneDescription).length).toBeGreaterThan(110);
    expect(
      Array.from(plan.visualPlan.concepts[0]!.composition).length,
    ).toBeGreaterThan(80);
    expect((await reviewer().review(changed)).planningPolicy).toBe(
      'content-people-1',
    );
    const legacy = { ...plan, planningPolicy: undefined };
    expect(() => visualReviewSourcePlanHash(legacy)).toThrow();
    expect(visualReviewSourcePlanHash(original.plan)).toBe(
      original.sourcePlanHash,
    );
  });

  it('separates V7 and V8 paid-review caches even for the same source image and operation', async () => {
    const oldHash = input.sourcePlanHash;
    const legacy = await reviewer().review(input);
    const changed = peopleInput();
    const next = await reviewer().review(changed);
    expect(next.sourcePlanHash).not.toBe(oldHash);
    expect(next.modelCalls[0]?.callId).not.toBe(legacy.modelCalls[0]?.callId);
    expect(legacy).not.toHaveProperty('planningPolicy');
    expect(completeVisual).toHaveBeenCalledTimes(2);
  });

  it.each(['plan', 'context', 'hash', 'prompt', 'parent'] as const)(
    'refuses a mismatched V8 planning-policy %s before a paid review',
    async (kind) => {
      const changed = peopleInput();
      if (kind === 'plan') {
        (changed.plan as Record<string, unknown>).planningPolicy = undefined;
      } else if (kind === 'context') {
        changed.context.planningPolicy = undefined;
      } else if (kind === 'hash') {
        changed.sourcePlanHash = input.sourcePlanHash;
      } else if (kind === 'prompt') {
        (changed.plan as Record<string, unknown>).imagePrompt = (
          input.plan as { imagePrompt: string }
        ).imagePrompt;
        changed.sourcePlanHash = visualReviewSourcePlanHash(changed.plan);
      } else {
        const parent = await runningParent();
        changed.context.parentRunId = parent.id;
      }
      await expect(reviewer().review(changed)).rejects.toHaveProperty('code');
      expect(completeVisual).not.toHaveBeenCalled();
    },
  );

  it('does not admit a legacy review under a V8 parent without its required planning policy', async () => {
    const parent = await runningParent(true);
    await expect(
      reviewer().review({
        ...input,
        context: { ...input.context, parentRunId: parent.id },
      }),
    ).rejects.toHaveProperty('code');
    expect(completeVisual).not.toHaveBeenCalled();
  });

  it('keeps inline work off generic dispatch and admits at most one active child without relaxing normal owner capacity', async () => {
    const parent = await runningParent();
    const create = {
      ownerId: input.context.ownerId,
      bookId: input.context.bookId,
      operation: 'illustration-visual-review',
      idempotencyKey: 'child-one',
      requestHash: hash('child'),
      configuration: {
        version: 'illustration-visual-review-1',
        inputHash: hash('input'),
        parentRunId: parent.id,
      },
      stages: ['analyze'],
    };
    const child = (await repository.createRun(create)).run;
    expect(await repository.listDispatchable()).toHaveLength(0);
    await expect(
      repository.createRun({ ...create, idempotencyKey: 'child-two' }),
    ).rejects.toMatchObject({ code: 'PROCESSING_CAPACITY_EXCEEDED' });
    await expect(
      repository.createRun({
        ...create,
        operation: 'beautify',
        idempotencyKey: 'external',
        configuration: {},
        stages: ['process'],
      }),
    ).rejects.toMatchObject({ code: 'PROCESSING_CAPACITY_EXCEEDED' });
    await repository.requestCancel(input.context.ownerId, child.id);
    await expect(
      repository.createRun({
        ...create,
        idempotencyKey: 'bad-parent',
        configuration: {
          ...create.configuration,
          parentRunId: '00000000-0000-0000-0000-000000000000',
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INLINE_REVIEW' });
    await repository.requestCancel(input.context.ownerId, parent.id);
    await expect(
      repository.createRun({ ...create, idempotencyKey: 'cancelled-parent' }),
    ).rejects.toMatchObject({ code: 'INVALID_INLINE_REVIEW' });
  });

  it.each(['FAIL', 'UNCERTAIN'] as const)(
    'preserves a %s judgment as a successfully accounted call without approving the image',
    async (result) => {
      completeVisual.mockResolvedValue({
        content: JSON.stringify(response(result)),
        finishReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 80, totalTokens: 180 },
      });
      const value = await reviewer().review(input);
      expect(value.status).toBe(result === 'FAIL' ? 'REJECTED' : 'UNCERTAIN');
      expect(value.modelCalls[0]!.status).toBe('SUCCEEDED');
      expect((await reviewer().review(input)).status).toBe(value.status);
      expect(completeVisual).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    'plan',
    'source',
    'image-hash',
    'image-bytes',
    'outside-root',
  ] as const)(
    'rejects tampered %s before reserving or sending a model call',
    async (kind) => {
      const changed = structuredClone(input);
      if (kind === 'plan') changed.sourcePlanHash = '0'.repeat(64);
      if (kind === 'source') changed.chapter.sourceSha256 = '0'.repeat(64);
      if (kind === 'image-hash') changed.image.sha256 = '0'.repeat(64);
      if (kind === 'image-bytes')
        await writeFile(changed.image.path, Buffer.from('changed'));
      if (kind === 'outside-root')
        changed.image.path = join(tmpdir(), 'unrelated-secret.png');
      await expect(reviewer().review(changed)).rejects.toHaveProperty('code');
      expect(completeVisual).not.toHaveBeenCalled();
      expect(await repository.persistence.listActive(100)).toHaveLength(0);
    },
  );

  it('holds an invalid received response UNKNOWN and never resends it on refresh/recovery', async () => {
    completeVisual.mockResolvedValue({
      content: JSON.stringify({
        ...response(),
        checks: response().checks.slice(0, 4),
      }),
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 80, totalTokens: 180 },
    });
    await expect(reviewer().review(input)).rejects.toMatchObject({
      code: 'VISUAL_REVIEW_INVALID_RESPONSE',
    });
    await expect(reviewer().review(input)).rejects.toMatchObject({
      code: 'VISUAL_REVIEW_UNKNOWN_OUTCOME',
    });
    expect(completeVisual).toHaveBeenCalledTimes(1);
    const state = JSON.parse(
      await readFile(join(root, 'metadata/state.json'), 'utf8'),
    );
    const call = Object.values(state.runs)
      .map((run: unknown) => (run as { modelCall: unknown }).modelCall)
      .find(Boolean);
    expect(call).toMatchObject({
      status: 'UNKNOWN',
      budgetDisposition: 'HELD',
    });
  });

  it('never automatically resends a timed-out visual call', async () => {
    completeVisual.mockRejectedValue(
      new AiGatewayError('VISUAL_REVIEW_TIMEOUT'),
    );
    await expect(reviewer().review(input)).rejects.toMatchObject({
      code: 'VISUAL_REVIEW_TIMEOUT',
    });
    await expect(reviewer().review(input)).rejects.toMatchObject({
      code: 'VISUAL_REVIEW_UNKNOWN_OUTCOME',
    });
    expect(completeVisual).toHaveBeenCalledTimes(1);
  });

  it('changes the paid-review fingerprint when model or configured price changes', async () => {
    const a = await reviewer().review(input);
    const b = await reviewer({
      VISUAL_REVIEW_MODEL: 'another-vision-model',
    }).review(input);
    const c = await reviewer({
      VISUAL_REVIEW_PRICE_VERSION: 'new-configured-price',
    }).review(input);
    expect(
      new Set([
        a.modelCalls[0]!.callId,
        b.modelCalls[0]!.callId,
        c.modelCalls[0]!.callId,
      ]).size,
    ).toBe(3);
    expect(completeVisual).toHaveBeenCalledTimes(3);
  });

  it('rejects inconsistent or incomplete public verdicts and never equates model success to image approval', () => {
    expect(
      publicVisualReviewSchema.safeParse({
        ...response('FAIL'),
        status: 'PASSED',
      }).success,
    ).toBe(false);
    expect(
      publicVisualReviewSchema.safeParse({
        ...response('UNCERTAIN'),
        status: 'PASSED',
      }).success,
    ).toBe(false);
    const duplicates = response();
    duplicates.checks[1]!.aspect = 'source';
    expect(
      publicVisualReviewSchema.safeParse({ ...duplicates, status: 'PASSED' })
        .success,
    ).toBe(false);
    expect(
      illustrationVisualReviewSchema.safeParse({
        ...response(),
        status: 'PASSED',
      }).success,
    ).toBe(false);
  });
});
