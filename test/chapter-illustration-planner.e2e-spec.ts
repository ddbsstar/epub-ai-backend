import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChapterIllustrationPlanner,
  compileContentIllustrationPrompt,
  type PlannerChapter,
  type PlannerContext,
} from '../src/ai/chapter-illustration-planner.js';
import {
  AiGatewayError,
  type StructureMessage,
} from '../src/ai/ai-structure.types.js';
import type { AiService } from '../src/ai/ai.service.js';
import type { AppConfig } from '../src/config/app-config.module.js';
import {
  validateEnvironment,
  type Environment,
} from '../src/config/environment.js';
import { LocalProcessingPersistence } from '../src/processing/local-processing.persistence.js';
import { ProcessingRepository } from '../src/processing/processing.repository.js';
import {
  artDirectionHash,
  assertArtDirectedPrompt,
  composeArtDirectedPrompt,
  getIllustrationArtDirection,
  contentArtDirectionSchema,
  type IllustrationArtDirection,
} from '../src/ai/illustration-art-direction.js';

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
function chapter(
  texts = [
    '完整的起始段落。',
    '山地夜晚，成年人围火跳舞。',
    '屋内的成年亲属安静地哀悼。',
  ],
): PlannerChapter {
  const blocks = texts.map((text, order) => ({
    id: hash(`block-${order}`),
    text,
    documentPath: 'OPS/private-chapter.xhtml',
    start: order * 100,
    end: order * 100 + 50,
    contentSha256: hash(`body-${order}`),
    order,
    kind: 'paragraph' as const,
  }));
  const last = blocks.at(-1)!;
  return {
    schemaVersion: 1,
    parserVersion: 'illustration-chapters-1',
    sourceSha256: 'a'.repeat(64),
    chapterId: 'chapter-one',
    title: '第一章',
    covered: 'COMPLETE',
    documents: [
      {
        documentPath: 'OPS/private-chapter.xhtml',
        sha256: 'b'.repeat(64),
        spineIndex: 0,
        start: 0,
        end: texts.length * 100,
      },
    ],
    blocks,
    anchors: [
      {
        id: hash('chapter-end'),
        kind: 'chapter-end',
        documentPath: last.documentPath,
        blockId: last.id,
        sourceStart: last.start,
        sourceEnd: last.end,
        contentSha256: last.contentSha256,
        readingOrder: last.order,
      },
    ],
  };
}

function validResponse(messages: StructureMessage[]) {
  const input = JSON.parse(messages[1]!.content) as {
    anchorId?: string;
    task?: string;
    pieces?: { blockId: string; text: string }[];
    summaries?: { facts: { sourceBlockIds: string[] }[] }[];
  };
  const firstId =
    input.pieces?.[0]?.blockId ??
    input.summaries![0]!.facts[0]!.sourceBlockIds[0]!;
  if (!input.anchorId && input.task !== 'plan-inline')
    return {
      summary: '连续片段里的活动与人物关系。',
      emotionalReading: '热闹与安静并存。',
      facts: [{ text: '成年人的活动。', sourceBlockIds: [firstId] }],
      sceneCandidate: {
        synopsis: '克制地描绘环境与成年人的活动。',
        sourceBlockIds: [firstId],
      },
    };
  return {
    decision: 'ILLUSTRATE',
    summary: '章末同时有庆祝与哀悼。',
    emotionalReading: '欢乐与失落并置，这是阅读解释。',
    facts: [{ text: '围火舞蹈。', sourceBlockIds: [firstId] }],
    ...(input.task === 'plan-inline'
      ? { layout: 'medium', sceneEvidenceBlockIds: [firstId] }
      : { anchorId: input.anchorId }),
    concept: '用两处人群的距离表现各自的情绪，突出空白。',
    imagePrompt:
      '克制的文学插画，山地夜晚，成年人的舞蹈在远处，近处是安静的成年亲属。少量暖色与灰色，大块留白，人物简化。',
    alt: '远处舞蹈与近处安静的人群。',
    settingEvidenceBlockIds: [firstId],
    depicts: 'adults-only',
    safety: 'NON_GRAPHIC',
  };
}

describe('chapter illustration planner (isolated ledger, no paid calls)', () => {
  let directory: string;
  let repository: ProcessingRepository;
  let context: PlannerContext;
  let model = vi.fn<AiService['completeStructure']>();

  function config(extra: Record<string, unknown> = {}): AppConfig {
    const environment = validateEnvironment({
      NODE_ENV: 'test',
      PROCESSING_ENABLED: true,
      PROCESSING_DATA_DIR: directory,
      EPUBCHECK_JAR_PATH: join(directory, 'epubcheck.jar'),
      PROCESSING_AI_ENABLED: true,
      QWEN_ENABLED: true,
      QWEN_API_KEY: 'private-fake-key',
      QWEN_BASE_URL: 'https://example.com/v1',
      QWEN_MODEL: 'qwen3.8-flash',
      ...extra,
    });
    return {
      get: <K extends keyof Environment>(key: K) => environment[key],
    } as AppConfig;
  }
  const planner = (extra: Record<string, unknown> = {}) =>
    new ChapterIllustrationPlanner(
      config(extra),
      repository,
      { completeStructure: model },
      join(directory, 'private'),
    );

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'epub-chapter-plan-'));
    repository = new ProcessingRepository(
      new LocalProcessingPersistence(directory),
    );
    const book = await repository.createBook({
      ownerId: 'trial-owner',
      sourceKey: 'inputs/source.epub',
      sourceHash: 'a'.repeat(64),
      byteSize: 100,
      originalName: 'private.epub',
    });
    context = {
      ownerId: book.ownerId,
      bookId: book.id,
      operationId: 'trial-1',
    };
    model = vi
      .fn<AiService['completeStructure']>()
      .mockImplementation(async (messages: StructureMessage[]) => {
        const active = await repository.persistence.listActive(100);
        expect(active.at(-1)?.modelCall?.status).toBe('SENT');
        return {
          content: JSON.stringify(validResponse(messages)),
          finishReason: 'stop',
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        };
      });
  });
  afterEach(async () => {
    await repository.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('plans a complete short chapter, settles real supplied usage, and reuses private results', async () => {
    const value = await planner().plan(chapter(), context);
    expect(value).toMatchObject({
      coverage: 'COMPLETE',
      sourceSha256: 'a'.repeat(64),
      modelCalls: [
        {
          status: 'SUCCEEDED',
          budgetDisposition: 'SETTLED',
          reservedMicros: 31744,
          estimatedCostMicros: 215,
          reused: false,
        },
      ],
    });
    expect(value.imagePrompt).toContain('所有人物均为成年人');
    expect(Array.from(value.imagePrompt).length).toBeLessThanOrEqual(800);
    expect(value.coverageProof.blockCount).toBe(3);
    const sent = JSON.parse(model.mock.calls[0]![0][1]!.content);
    expect(
      sent.pieces.map((piece: { blockId: string }) => piece.blockId),
    ).toEqual(['b1', 'b2', 'b3']);
    expect(sent.anchorId).toBe('a1');
    expect(value.facts[0]!.sourceBlockIds).toEqual([chapter().blocks[0]!.id]);
    expect(value.settingEvidenceBlockIds).toEqual([chapter().blocks[0]!.id]);
    expect(value.anchorId).toBe(chapter().anchors[0]!.id);
    const again = await planner().plan(chapter(), context);
    expect(again.modelCalls[0]!.reused).toBe(true);
    expect(model).toHaveBeenCalledTimes(1);
    const metadata = await readFile(
      join(directory, 'metadata', 'state.json'),
      'utf8',
    );
    expect(metadata).not.toContain('屋内的成年亲属');
    expect(metadata).not.toContain('private-chapter.xhtml');
    expect(metadata).not.toContain('所有人物均为成年人');
    expect(JSON.stringify(model.mock.calls)).not.toContain(
      'private-chapter.xhtml',
    );
  });

  const subsection = (texts?: string[]) => {
    const source = chapter(texts);
    source.parserVersion = 'illustration-sections-2';
    source.scope = 'section';
    source.sectionId = source.chapterId;
    source.anchors = source.blocks.map((block, index) => ({
      id: hash(`inline-${index}`),
      kind: 'after-paragraph' as const,
      documentPath: block.documentPath,
      blockId: block.id,
      sourceStart: block.start,
      sourceEnd: block.end,
      contentSha256: block.contentSha256,
      readingOrder: block.order,
    }));
    return source;
  };
  const contentDirection = () =>
    contentArtDirectionSchema.parse({
      schemaVersion: 2,
      id: 'book-art',
      version: 1,
      status: 'provisional',
      sourceSha256: 'a'.repeat(64),
      evidenceSha256: 'c'.repeat(64),
      medium: 'monochrome-ink',
      palette: [
        { colorName: '墨黑', hex: '#222222' },
        { colorName: '纸白', hex: '#FAF8F0' },
      ],
      lineLanguage: '克制而清晰的线条',
      shapeLanguage: '简化轮廓与空间关系',
      texture: '少量排线',
      detailDensity: 'selective',
      negativeSpace: 'generous',
      characterTreatment: '人物概括轮廓',
    });
  function contentResponse(messages: StructureMessage[]) {
    const base = validResponse(messages);
    const id = base.facts[0]!.sourceBlockIds[0]!;
    return {
      ...base,
      imagePrompt: '山地夜晚，成年人的舞蹈与安静人群。',
      visualPlan: {
        concepts: [
          {
            id: 'c1',
            idea: '通过两处人群的距离表达情绪',
            composition: '远处舞蹈与近处安静的人群分置',
            emotionalIntent: '用距离表现欢乐与失落',
            sourceBlockIds: [id],
          },
          {
            id: 'c2',
            idea: '通过空间的明暗形成关系',
            composition: '两处人群位于画面上下位置',
            emotionalIntent: '用空间层次表现并存的情绪',
            sourceBlockIds: [id],
          },
        ],
        selectedConceptId: 'c1',
        selectionReason: '空间距离更贴合有据的人物关系',
      },
    };
  }
  it('compiles the chosen grounded concept into the V6 image prompt and reuses its persisted result', async () => {
    model.mockImplementation(async (messages) => ({
      content: JSON.stringify(contentResponse(messages)),
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 80, totalTokens: 180 },
    }));
    const direction = contentDirection();
    const ctx = { ...context, artDirection: direction };
    const result = await planner().plan(subsection(), ctx);
    expect(result.visualPlan?.concepts).toHaveLength(2);
    expect(result.visualPlan?.concepts[0]!.sourceBlockIds).toEqual([
      chapter().blocks[0]!.id,
    ]);
    expect(result.sceneDescription).toBe('山地夜晚，成年人的舞蹈与安静人群。');
    expect(result.imagePrompt).toBe(
      compileContentIllustrationPrompt(
        {
          sceneDescription: result.sceneDescription!,
          visualPlan: result.visualPlan!,
          depicts: 'adults-only',
        },
        direction,
      ),
    );
    expect(result.imagePrompt).toContain(
      result.visualPlan!.concepts[0]!.composition,
    );
    expect(result.imagePrompt).not.toContain(
      result.visualPlan!.concepts[1]!.composition,
    );
    const again = await planner().plan(subsection(), ctx);
    expect(again.modelCalls[0]!.reused).toBe(true);
    expect(again.imagePrompt).toBe(result.imagePrompt);
    expect(model).toHaveBeenCalledTimes(1);
    const state = JSON.parse(
      await readFile(join(directory, 'metadata', 'state.json'), 'utf8'),
    );
    expect(state.runs[result.modelCalls[0]!.runId].configuration.version).toBe(
      'subsection-illustration-plan-6',
    );
  });

  function noPeopleResponse(messages: StructureMessage[]) {
    const response = contentResponse(messages);
    return {
      ...response,
      depicts: 'no-people',
      facts: [
        {
          text: '空屋中有窗台。',
          sourceBlockIds: response.facts[0]!.sourceBlockIds,
        },
      ],
      concept: '用空屋的留白表达安静',
      imagePrompt: '空屋的窗台，窗外树枝的剪影。',
      alt: '空屋和窗外树枝。',
      visualPlan: {
        ...response.visualPlan,
        concepts: response.visualPlan.concepts.map((item, index) => ({
          ...item,
          idea: index ? '强调窗外的距离' : '用空屋和窗台表现安静',
          composition: index
            ? '窗台偏向一侧，另一侧留白。'
            : '窗台居中，树枝剪影在远处，屋内留白。',
          emotionalIntent: '通过空间留白表现安静',
        })),
        selectionReason: '与窗台的来源关系一致',
      },
    };
  }

  it('isolates new people-policy fingerprints, retains the art snapshot and reuses only the matching policy result', async () => {
    model.mockImplementation(async (messages) => ({
      content: JSON.stringify(noPeopleResponse(messages)),
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 80, totalTokens: 180 },
    }));
    const source = subsection(['空屋中有窗台，窗外有树枝。']);
    const direction = contentDirection();
    const ctx = { ...context, artDirection: direction };
    const old = await planner().plan(source, ctx);
    const before = JSON.parse(
      await readFile(join(directory, 'metadata', 'state.json'), 'utf8'),
    );
    const oldRecord = before.runs[old.modelCalls[0]!.runId];
    const currentContext = {
      ...ctx,
      planningPolicy: 'content-people-1',
    } as const;
    const current = await planner().plan(source, currentContext);
    expect(current.planningPolicy).toBe('content-people-1');
    expect(current.artDirection).toEqual(old.artDirection);
    expect(current.artDirectionHash).toBe(old.artDirectionHash);
    expect(current.imagePrompt).not.toContain(direction.characterTreatment);
    expect(old.imagePrompt).toContain(direction.characterTreatment);
    expect(current.imagePrompt).toBe(
      compileContentIllustrationPrompt(
        {
          sceneDescription: current.sceneDescription!,
          visualPlan: current.visualPlan!,
          depicts: current.depicts,
          planningPolicy: current.planningPolicy,
        },
        direction,
      ),
    );
    const again = await planner().plan(source, currentContext);
    expect(again.imagePrompt).toBe(current.imagePrompt);
    expect(again.modelCalls[0]!.reused).toBe(true);
    expect(model).toHaveBeenCalledTimes(2);
    const after = JSON.parse(
      await readFile(join(directory, 'metadata', 'state.json'), 'utf8'),
    );
    expect(after.runs[old.modelCalls[0]!.runId]).toEqual(oldRecord);
    expect(
      after.runs[current.modelCalls[0]!.runId].configuration,
    ).toMatchObject({
      version: 'subsection-illustration-plan-7',
      planningPolicy: 'content-people-1',
    });
    expect(oldRecord.configuration.version).toBe(
      'subsection-illustration-plan-6',
    );
    expect(oldRecord.configuration).not.toHaveProperty('planningPolicy');
    expect(current.modelCalls[0]!.runId).not.toBe(old.modelCalls[0]!.runId);
    const prompt = model.mock.calls[1]![0][0]!.content;
    expect(prompt).toContain('年龄不确定不能推定成年');
    expect(prompt).toContain('小节中含敏感段落不等于整节没有安全画面');
    expect(prompt).not.toContain('"depicts":"no-people"');
  });

  it.each([
    'scene',
    'chosen-composition',
    'chosen-idea',
    'chosen-emotion',
  ] as const)(
    'rejects a no-people contradiction in %s before accepting a paid plan and never automatically resends it',
    async (field) => {
      model.mockImplementation(async (messages) => {
        const response = noPeopleResponse(messages);
        if (field === 'scene')
          response.imagePrompt = '窗台旁有三个站立的人形剪影。';
        if (field === 'chosen-composition')
          response.visualPlan.concepts[0]!.composition =
            '人物仅作为边缘剪影存在。';
        if (field === 'chosen-idea')
          response.visualPlan.concepts[0]!.idea = '用远处骑马者形成主次';
        if (field === 'chosen-emotion')
          response.visualPlan.concepts[0]!.emotionalIntent =
            '用人群疏密表达紧张';
        return {
          content: JSON.stringify(response),
          finishReason: 'stop',
          usage: { inputTokens: 100, outputTokens: 80, totalTokens: 180 },
        };
      });
      const bound = {
        ...context,
        artDirection: contentDirection(),
        planningPolicy: 'content-people-1',
      } as const;
      await expect(planner().plan(subsection(), bound)).rejects.toMatchObject({
        code: 'ILLUSTRATION_PEOPLE_CONFLICT',
      });
      await expect(planner().plan(subsection(), bound)).rejects.toMatchObject({
        code: 'AI_UNKNOWN_OUTCOME',
      });
      expect(model).toHaveBeenCalledTimes(1);
      const state = JSON.parse(
        await readFile(join(directory, 'metadata', 'state.json'), 'utf8'),
      );
      expect(Object.values(state.runs)).toEqual([
        expect.objectContaining({
          modelCall: expect.objectContaining({
            status: 'UNKNOWN',
            budgetDisposition: 'HELD',
            reasonCode: 'ILLUSTRATION_PEOPLE_CONFLICT',
          }),
        }),
      ]);
    },
  );

  it('keeps supported adult scenes and does not silently relabel a no-people plan', async () => {
    model.mockImplementation(async (messages) => ({
      content: JSON.stringify(contentResponse(messages)),
      finishReason: 'stop',
    }));
    const direction = contentDirection();
    const plan = await planner().plan(subsection(), {
      ...context,
      artDirection: direction,
      planningPolicy: 'content-people-1',
    });
    expect(plan.depicts).toBe('adults-only');
    expect(plan.imagePrompt).toContain(direction.characterTreatment);
    expect(plan.imagePrompt).toContain('所有人物均为成年人');
  });

  it('accepts bounded scene and composition overruns only under the explicit new policy without truncating them', async () => {
    model.mockImplementation(async (messages) => {
      const response = noPeopleResponse(messages);
      response.imagePrompt = '景'.repeat(133);
      response.visualPlan.concepts[0]!.composition = '构'.repeat(81);
      return { content: JSON.stringify(response), finishReason: 'stop' };
    });
    const direction = contentDirection();
    const ctx = { ...context, artDirection: direction };
    await expect(planner().plan(subsection(), ctx)).rejects.toMatchObject({
      code: 'ILLUSTRATION_INVALID_RESPONSE',
    });
    const plan = await planner().plan(subsection(), {
      ...ctx,
      planningPolicy: 'content-people-1',
    });
    expect(plan.sceneDescription).toBe('景'.repeat(133));
    expect(plan.visualPlan!.concepts[0]!.composition).toBe('构'.repeat(81));
    expect(plan.imagePrompt).toContain('景'.repeat(133));
    expect(plan.imagePrompt).toContain('构'.repeat(81));
    expect(Array.from(plan.imagePrompt).length).toBeLessThanOrEqual(800);
    expect(() =>
      compileContentIllustrationPrompt(
        {
          sceneDescription: plan.sceneDescription!,
          visualPlan: plan.visualPlan!,
          depicts: plan.depicts,
        },
        direction,
      ),
    ).toThrow();
    expect(() =>
      compileContentIllustrationPrompt(
        {
          sceneDescription: '景'.repeat(141),
          visualPlan: plan.visualPlan!,
          depicts: plan.depicts,
          planningPolicy: 'content-people-1',
        },
        direction,
      ),
    ).toThrow();
    const tooLong = structuredClone(plan.visualPlan!);
    tooLong.concepts[0]!.composition = '构'.repeat(101);
    expect(() =>
      compileContentIllustrationPrompt(
        {
          sceneDescription: '景',
          visualPlan: tooLong,
          depicts: plan.depicts,
          planningPolicy: 'content-people-1',
        },
        direction,
      ),
    ).toThrow();
  });

  it('binds the new policy to inline review ledger configuration without changing old review fingerprints', async () => {
    model.mockResolvedValue({
      content: JSON.stringify({ accepted: true }),
      finishReason: 'stop',
    });
    const parse = (value: unknown) => value as { accepted: boolean };
    const legacy = await planner().completeVisualReview(
      chapter(),
      context,
      'check image',
      { imageHash: 'c'.repeat(64) },
      parse,
    );
    const before = JSON.parse(
      await readFile(join(directory, 'metadata', 'state.json'), 'utf8'),
    );
    const current = await planner().completeVisualReview(
      chapter(),
      { ...context, planningPolicy: 'content-people-1' },
      'check image',
      { imageHash: 'c'.repeat(64) },
      parse,
    );
    const after = JSON.parse(
      await readFile(join(directory, 'metadata', 'state.json'), 'utf8'),
    );
    expect(after.runs[legacy.receipt.runId]).toEqual(
      before.runs[legacy.receipt.runId],
    );
    expect(after.runs[current.receipt.runId].configuration.planningPolicy).toBe(
      'content-people-1',
    );
    expect(after.runs[legacy.receipt.runId].configuration).not.toHaveProperty(
      'planningPolicy',
    );
    expect(current.receipt.callId).not.toBe(legacy.receipt.callId);
    expect(model).toHaveBeenCalledTimes(2);
  });

  it('rejects an unsupported policy or non-content use before a provider call', async () => {
    await expect(
      planner().plan(subsection(), {
        ...context,
        planningPolicy: 'unknown',
      } as unknown as PlannerContext),
    ).rejects.toBeDefined();
    await expect(
      planner().plan(subsection(), {
        ...context,
        planningPolicy: 'content-people-1',
      }),
    ).rejects.toMatchObject({ code: 'ART_DIRECTION_INVALID' });
    expect(model).not.toHaveBeenCalled();
  });

  it('keeps the complete prompt within 800 codepoints at the maximum profile and concept sizes', () => {
    const direction = contentArtDirectionSchema.parse({
      ...contentDirection(),
      medium: 'graphite-contour',
      palette: Array.from({ length: 4 }, (_, index) => ({
        colorName: '色'.repeat(20),
        hex: ['#111111', '#222222', '#333333', '#444444'][index],
      })),
      lineLanguage: '线'.repeat(24),
      shapeLanguage: '形'.repeat(24),
      texture: '纹'.repeat(20),
      characterTreatment: '人'.repeat(24),
      detailDensity: 'selective',
      negativeSpace: 'compact',
    });
    const visualPlan = {
      concepts: [
        {
          id: 'c1',
          idea: '意'.repeat(60),
          composition: '构'.repeat(80),
          emotionalIntent: '情'.repeat(50),
          sourceBlockIds: ['b1'],
        },
        {
          id: 'c2',
          idea: '另',
          composition: '别',
          emotionalIntent: '情',
          sourceBlockIds: ['b1'],
        },
      ],
      selectedConceptId: 'c1',
      selectionReason: '有据',
    };
    expect(
      Array.from(
        compileContentIllustrationPrompt(
          {
            sceneDescription: '景'.repeat(110),
            visualPlan,
            depicts: 'adults-only',
          },
          direction,
        ),
      ).length,
    ).toBeLessThanOrEqual(800);
  });
  it('rejects a concept with an invented block reference and does not automatically repeat its paid request', async () => {
    model.mockImplementation(async (messages) => {
      const response = contentResponse(messages);
      response.visualPlan.concepts[0]!.sourceBlockIds = ['b999'];
      return {
        content: JSON.stringify(response),
        finishReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 80, totalTokens: 180 },
      };
    });
    const ctx = { ...context, artDirection: contentDirection() };
    await expect(planner().plan(subsection(), ctx)).rejects.toBeDefined();
    await expect(planner().plan(subsection(), ctx)).rejects.toBeDefined();
    expect(model).toHaveBeenCalledTimes(1);
  });
  it('uses the same fenced ledger for book-art calls and never resends an UNKNOWN result', async () => {
    const parse = (value: unknown) => value as { reading: string };
    model.mockResolvedValueOnce({
      content: JSON.stringify({ reading: '宁静而克制' }),
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });
    const first = await planner().completeBookArt(
      subsection(),
      context,
      '制定本书艺术方案',
      { sample: '有据的样本' },
      parse,
    );
    const reused = await planner().completeBookArt(
      subsection(),
      context,
      '制定本书艺术方案',
      { sample: '有据的样本' },
      parse,
    );
    expect(reused.value).toEqual(first.value);
    expect(reused.receipt.reused).toBe(true);
    expect(model).toHaveBeenCalledTimes(1);
    const uncertain = { ...context, operationId: 'uncertain-book-art' };
    model.mockRejectedValue(new AiGatewayError('AI_RESPONSE_UNKNOWN'));
    await expect(
      planner().completeBookArt(
        subsection(),
        uncertain,
        '制定方案',
        { sample: '另一样本' },
        parse,
      ),
    ).rejects.toBeDefined();
    await expect(
      planner().completeBookArt(
        subsection(),
        uncertain,
        '制定方案',
        { sample: '另一样本' },
        parse,
      ),
    ).rejects.toBeDefined();
    expect(model).toHaveBeenCalledTimes(2);
  });
  it('binds the registered art direction to planning input, versioned receipts, and the exact final image prompt', async () => {
    const source = subsection();
    const direction = getIllustrationArtDirection();
    const styleHash = artDirectionHash(direction);
    const value = await planner().plan(source, {
      ...context,
      artDirection: direction,
      artDirectionHash: styleHash,
    });
    const messages = model.mock.calls[0]![0];
    const input = JSON.parse(messages[1]!.content);
    expect(input.artDirection).toEqual(direction);
    expect(input.artDirectionHash).toBe(styleHash);
    expect(messages[0]!.content).toContain('最多300字');
    expect(messages[0]!.content).toContain(
      'medium、palette、contours、shading、density、emotionPolicy和sourcePolicy',
    );
    expect(value.artDirection).toBe(direction);
    expect(value.artDirectionHash).toBe(styleHash);
    const raw = validResponse(messages) as { imagePrompt: string };
    expect(value.imagePrompt).toBe(
      composeArtDirectedPrompt(
        `${raw.imagePrompt}\n画面中所有人物均为成年人；没有裸露、性行为、伤口或尸体。独立文字生图，无文字、标题、水印。`,
        direction,
      ),
    );
    expect(() =>
      assertArtDirectedPrompt(value.imagePrompt, direction),
    ).not.toThrow();
    expect(Array.from(value.imagePrompt).length).toBeLessThanOrEqual(800);
    const metadata = JSON.parse(
      await readFile(join(directory, 'metadata', 'state.json'), 'utf8'),
    );
    const run = metadata.runs[value.modelCalls[0]!.runId];
    expect(run.configuration).toMatchObject({
      version: 'subsection-illustration-plan-5',
      artDirectionHash: styleHash,
    });
    expect(run.modelCall.promptVersion).toBe('subsection-illustration-plan-5');
    expect(run.modelCall.schemaVersion).toBe('subsection-illustration-plan-5');
  });

  it('keeps legacy unstyled caches separate and reuses the same canonical style snapshot without another request', async () => {
    const source = subsection();
    const legacy = await planner().plan(source, context);
    expect(legacy).not.toHaveProperty('artDirection');
    expect(legacy).not.toHaveProperty('artDirectionHash');
    expect(JSON.parse(model.mock.calls[0]![0][1]!.content)).not.toHaveProperty(
      'artDirection',
    );
    const direction = getIllustrationArtDirection();
    const styled = await planner().plan(source, {
      ...context,
      artDirection: direction,
    });
    expect(styled.modelCalls[0]!.runId).not.toBe(legacy.modelCalls[0]!.runId);
    expect(styled.modelCalls[0]!.reused).toBe(false);
    const reordered = Object.fromEntries(
      Object.entries(direction).reverse(),
    ) as unknown as IllustrationArtDirection;
    const again = await planner().plan(source, {
      ...context,
      artDirection: reordered,
      artDirectionHash: artDirectionHash(direction),
    });
    expect(again.modelCalls[0]!.callId).toBe(styled.modelCalls[0]!.callId);
    expect(again.modelCalls[0]!.reused).toBe(true);
    expect(again.imagePrompt).toBe(styled.imagePrompt);
    const oldAgain = await planner().plan(source, context);
    expect(oldAgain.modelCalls[0]!.callId).toBe(legacy.modelCalls[0]!.callId);
    expect(oldAgain.imagePrompt).toBe(legacy.imagePrompt);
    expect(model).toHaveBeenCalledTimes(2);
    const metadata = JSON.parse(
      await readFile(join(directory, 'metadata', 'state.json'), 'utf8'),
    );
    expect(
      metadata.runs[legacy.modelCalls[0]!.runId].configuration.version,
    ).toBe('subsection-illustration-plan-4');
    expect(
      metadata.runs[legacy.modelCalls[0]!.runId].modelCall,
    ).not.toHaveProperty('artDirectionHash');
  });

  it('passes the exact same registered style through every bounded map and reducer without omitting source text', async () => {
    const source = subsection(['积雪与山谷🙂'.repeat(1400)]);
    const direction = getIllustrationArtDirection();
    const result = await planner().plan(source, {
      ...context,
      artDirection: direction,
    });
    expect(result.modelCalls.length).toBeGreaterThan(1);
    for (const [messages] of model.mock.calls) {
      const input = JSON.parse(messages[1]!.content);
      expect(input.artDirection).toEqual(direction);
      expect(input.artDirectionHash).toBe(artDirectionHash(direction));
      expect(
        Buffer.byteLength(JSON.stringify(messages), 'utf8'),
      ).toBeLessThanOrEqual(config().get('AI_MAX_MESSAGE_BYTES'));
    }
    const pieces = model.mock.calls
      .slice(0, -1)
      .flatMap(
        ([messages]) =>
          JSON.parse(messages[1]!.content).pieces as { text: string }[],
      );
    expect(pieces.map((piece) => piece.text).join('')).toBe(
      source.blocks[0]!.text,
    );
    expect(result.coverageProof.codepoints).toBe(
      Array.from(source.blocks[0]!.text).length,
    );
    expect(() =>
      assertArtDirectedPrompt(result.imagePrompt, direction),
    ).not.toThrow();
    expect(
      (
        await planner().plan(source, { ...context, artDirection: direction })
      ).modelCalls.every((call) => call.reused),
    ).toBe(true);
  });

  it.each(['snapshot', 'hash', 'hash-without-snapshot'] as const)(
    'rejects an invalid art direction %s before admitting any model request',
    async (kind) => {
      const direction = getIllustrationArtDirection();
      const input =
        kind === 'snapshot'
          ? {
              ...context,
              artDirection: {
                ...direction,
                palette: 'unregistered neon palette',
              } as unknown as IllustrationArtDirection,
            }
          : kind === 'hash'
            ? {
                ...context,
                artDirection: direction,
                artDirectionHash: '0'.repeat(64),
              }
            : { ...context, artDirectionHash: artDirectionHash(direction) };
      await expect(planner().plan(subsection(), input)).rejects.toMatchObject({
        code: 'ART_DIRECTION_INVALID',
      });
      expect(model).not.toHaveBeenCalled();
      expect(await repository.persistence.listActive(100)).toHaveLength(0);
    },
  );

  it.each(['摄影照片写实，采用相机镜头效果。', '电影级3D渲染场景。'])(
    'rejects a conflicting styled image prompt without erasing its words or requesting it again: %s',
    async (prompt) => {
      model.mockImplementation(async (messages) => ({
        content: JSON.stringify({
          ...validResponse(messages),
          imagePrompt: prompt,
        }),
        finishReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      }));
      const bound = { ...context, artDirection: getIllustrationArtDirection() };
      await expect(planner().plan(subsection(), bound)).rejects.toMatchObject({
        code: 'ART_DIRECTION_CONFLICT',
      });
      await expect(planner().plan(subsection(), bound)).rejects.toMatchObject({
        code: 'ART_DIRECTION_CONFLICT',
      });
      expect(model).toHaveBeenCalledTimes(1);
    },
  );

  it('enforces the final 800-codepoint bound after adding style and safety instead of truncating the model scene', async () => {
    model.mockImplementation(async (messages) => ({
      content: JSON.stringify({
        ...validResponse(messages),
        imagePrompt: '景'.repeat(650),
      }),
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    }));
    const bound = { ...context, artDirection: getIllustrationArtDirection() };
    await expect(planner().plan(subsection(), bound)).rejects.toMatchObject({
      code: 'ILLUSTRATION_PROMPT_LIMIT',
    });
    await expect(planner().plan(subsection(), bound)).rejects.toMatchObject({
      code: 'ILLUSTRATION_PROMPT_LIMIT',
    });
    expect(model).toHaveBeenCalledTimes(1);
  });
  it('retains an UNKNOWN styled attempt across equivalent snapshot objects without resetting its accounting or resending', async () => {
    model.mockResolvedValue({ content: '{malformed', finishReason: 'stop' });
    const direction = getIllustrationArtDirection();
    const bound = { ...context, artDirection: direction };
    await expect(planner().plan(subsection(), bound)).rejects.toMatchObject({
      code: 'ILLUSTRATION_PLANNING_FAILED',
    });
    const stateBefore = await readFile(
      join(directory, 'metadata', 'state.json'),
      'utf8',
    );
    const runs = Object.values(JSON.parse(stateBefore).runs) as {
      modelCall: {
        status: string;
        budgetDisposition: string;
        promptVersion: string;
      };
      configuration: { artDirectionHash: string };
    }[];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      modelCall: {
        status: 'UNKNOWN',
        budgetDisposition: 'HELD',
        promptVersion: 'subsection-illustration-plan-5',
      },
      configuration: { artDirectionHash: artDirectionHash(direction) },
    });
    const clone = JSON.parse(
      JSON.stringify(direction),
    ) as IllustrationArtDirection;
    await expect(
      planner().plan(subsection(), {
        ...context,
        artDirection: clone,
        artDirectionHash: artDirectionHash(direction),
      }),
    ).rejects.toMatchObject({ code: 'AI_UNKNOWN_OUTCOME' });
    expect(model).toHaveBeenCalledTimes(1);
    expect(
      await readFile(join(directory, 'metadata', 'state.json'), 'utf8'),
    ).toBe(stateBefore);
  });
  it.each(['illustration-sections-2', 'illustration-sections-3'] as const)(
    'resolves the actual matching interior paragraph from exact scene evidence for %s, with reusable versioned layout',
    async (parserVersion) => {
      const source = subsection();
      source.parserVersion = parserVersion;
      model.mockImplementation(async (messages) => ({
        content: JSON.stringify({
          ...validResponse(messages),
          layout: 'compact',
          facts: [{ text: '夜晚山地。', sourceBlockIds: ['b2'] }],
          settingEvidenceBlockIds: ['b2'],
          sceneEvidenceBlockIds: ['b2'],
        }),
        finishReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      }));
      const result = await planner().plan(source, context);
      expect(result.anchorId).toBe(source.anchors[1]!.id);
      expect(result.anchorId).not.toBe(source.anchors.at(-1)!.id);
      expect(result.layout).toBe('compact');
      expect(result.layoutSource).toBe('model');
      expect(result.sceneEvidenceBlockIds).toEqual([source.blocks[1]!.id]);
      const input = JSON.parse(model.mock.calls[0]![0][1]!.content);
      expect(input.task).toBe('plan-inline');
      expect(input.anchorId).toBeUndefined();
      expect(input.anchors).toBeUndefined();
      const again = await planner().plan(source, context);
      expect(again.anchorId).toBe(result.anchorId);
      expect(again.modelCalls[0]!.reused).toBe(true);
      expect(model).toHaveBeenCalledTimes(1);
    },
  );
  it('keeps a missing presentation field usable with an explicit medium default, without accepting an invalid preset', async () => {
    const source = subsection();
    model.mockImplementation(async (messages) => ({
      content: JSON.stringify({
        ...validResponse(messages),
        layout: undefined,
      }),
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    }));
    const result = await planner().plan(source, context);
    expect(result.layout).toBe('medium');
    expect(result.layoutSource).toBe('default');
    expect((await planner().plan(source, context)).layoutSource).toBe(
      'default',
    );
    expect(model).toHaveBeenCalledTimes(1);
  });
  it('uses the nearest safe paragraph after the latest source evidence rather than an earlier image location', async () => {
    const source = subsection();
    model.mockImplementation(async (messages) => ({
      content: JSON.stringify({
        ...validResponse(messages),
        facts: [{ text: '场景。', sourceBlockIds: ['b3'] }],
        settingEvidenceBlockIds: ['b1'],
        sceneEvidenceBlockIds: ['b3'],
      }),
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    }));
    expect((await planner().plan(source, context)).anchorId).toBe(
      source.anchors[2]!.id,
    );
  });
  it.each(['foreign-evidence', 'unexpected-anchor', 'invalid-layout'])(
    'rejects %s without guessing IDs, moving an invalid location, or replaying',
    async (mode) => {
      const source = subsection();
      model.mockImplementation(async (messages) => ({
        content: JSON.stringify({
          ...validResponse(messages),
          ...(mode === 'foreign-evidence'
            ? { sceneEvidenceBlockIds: ['b999'] }
            : mode === 'unexpected-anchor'
              ? { anchorId: 'a30' }
              : { layout: 'arbitrary-css' }),
        }),
        finishReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      }));
      await expect(planner().plan(source, context)).rejects.toMatchObject({
        code:
          mode === 'foreign-evidence'
            ? 'ILLUSTRATION_INVALID_EVIDENCE'
            : 'ILLUSTRATION_INVALID_RESPONSE',
      });
      await expect(planner().plan(source, context)).rejects.toMatchObject({
        code: 'AI_UNKNOWN_OUTCOME',
      });
      expect(model).toHaveBeenCalledTimes(1);
    },
  );
  it.each([93, 160])(
    'accepts a bounded %i-character subsection scene synopsis with full long-text coverage',
    async (length) => {
      const source = subsection(['积雪与屋檐🙂'.repeat(1600)]);
      model.mockImplementation(async (messages) => {
        const input = JSON.parse(messages[1]!.content);
        const response = validResponse(messages) as Record<string, unknown>;
        if (input.task !== 'plan-inline')
          response.sceneCandidate = {
            synopsis: '景'.repeat(length),
            sourceBlockIds: ['b1'],
          };
        return {
          content: JSON.stringify(response),
          finishReason: 'stop',
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        };
      });
      const result = await planner().plan(source, context);
      expect(result.modelCalls.length).toBeGreaterThan(1);
      expect(result.coverageProof.codepoints).toBe(
        Array.from(source.blocks[0]!.text).length,
      );
      const reducer = JSON.parse(model.mock.calls.at(-1)![0][1]!.content);
      expect(
        reducer.summaries.every(
          (summary: { sceneCandidate: { synopsis: string } }) =>
            summary.sceneCandidate.synopsis.length === length,
        ),
      ).toBe(true);
      expect(reducer.anchorId).toBeUndefined();
      expect(
        (await planner().plan(source, context)).modelCalls.every(
          (call) => call.reused,
        ),
      ).toBe(true);
    },
  );
  it('rejects a 161-character subsection synopsis instead of removing bounded output validation', async () => {
    const source = subsection(['积雪与屋檐🙂'.repeat(1600)]);
    model.mockImplementation(async (messages) => ({
      content: JSON.stringify({
        ...validResponse(messages),
        sceneCandidate: { synopsis: '景'.repeat(161), sourceBlockIds: ['b1'] },
      }),
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    }));
    await expect(planner().plan(source, context)).rejects.toMatchObject({
      code: 'ILLUSTRATION_INVALID_RESPONSE',
    });
    expect(model).toHaveBeenCalledTimes(1);
  });

  it('accepts a fact supported by four exact input aliases and restores all source IDs', async () => {
    const source = chapter(['雪晨。', '远山。', '鸟群。', '山谷。']);
    model.mockImplementation(async (messages) => {
      const response = validResponse(messages);
      response.facts[0]!.sourceBlockIds = ['b1', 'b2', 'b3', 'b4'];
      return {
        content: JSON.stringify(response),
        finishReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      };
    });
    const result = await planner().plan(source, context);
    expect(result.facts[0]!.sourceBlockIds).toEqual(
      source.blocks.map((block) => block.id),
    );
    expect(result.modelCalls[0]!.status).toBe('SUCCEEDED');
  });

  it('maps every character of a long Unicode paragraph without omission and reduces only summaries', async () => {
    const source = chapter(['山地夜晚🙂成年人的活动。'.repeat(1100)]);
    const result = await planner().plan(source, context);
    expect(result.modelCalls.length).toBeGreaterThan(2);
    const maps = model.mock.calls
      .slice(0, -1)
      .map((call) => JSON.parse((call[0] as StructureMessage[])[1]!.content));
    const pieces = maps.flatMap(
      (value) =>
        value.pieces as {
          text: string;
          blockId: string;
          startCodepoint: number;
          endCodepoint: number;
        }[],
    );
    expect(pieces.map((piece) => piece.text).join('')).toBe(
      source.blocks[0]!.text,
    );
    expect(new Set(pieces.map((piece) => piece.blockId))).toEqual(
      new Set(['b1']),
    );
    expect(pieces[0]!.startCodepoint).toBe(0);
    expect(pieces.at(-1)!.endCodepoint).toBe(
      Array.from(source.blocks[0]!.text).length,
    );
    expect(model.mock.calls.at(-1)![0][1].content).not.toContain('山地夜晚🙂');
    expect(
      result.coverageProof.chunks.reduce(
        (sum, chunk) => sum + chunk.codepoints,
        0,
      ),
    ).toBe(Array.from(source.blocks[0]!.text).length);
    expect(
      result.modelCalls.reduce((sum, call) => sum + call.reservedMicros, 0),
    ).toBeLessThanOrEqual(400000);
    for (const call of model.mock.calls)
      expect(
        Buffer.byteLength(JSON.stringify(call[0]), 'utf8'),
      ).toBeLessThanOrEqual(24576);
  });

  it.each([181, 191, 240])(
    'accepts a %i-codepoint map summary intact without changing paid inputs or reducer input bounds',
    async (length) => {
      const source = chapter(['山地夜晚🙂成年人的活动。'.repeat(1100)]);
      const summary = Array.from('景🙂 A1，'.repeat(50))
        .slice(0, length)
        .join('');
      expect(Array.from(summary)).toHaveLength(length);
      model.mockImplementation(async (messages) => {
        const response = validResponse(messages) as Record<string, unknown>;
        if (!JSON.parse(messages[1]!.content).anchorId)
          response.summary = summary;
        return {
          content: JSON.stringify(response),
          finishReason: 'stop',
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        };
      });
      const result = await planner().plan(source, context);
      expect(result.modelCalls.length).toBeGreaterThan(2);
      expect(
        result.modelCalls.every((call) => call.status === 'SUCCEEDED'),
      ).toBe(true);
      const reducer = JSON.parse(model.mock.calls.at(-1)![0][1]!.content);
      expect(
        reducer.summaries.every(
          (mapped: { summary: string }) => mapped.summary === summary,
        ),
      ).toBe(true);
      for (const [messages] of model.mock.calls) {
        const bytes = Buffer.byteLength(JSON.stringify(messages), 'utf8');
        expect(bytes).toBeLessThanOrEqual(config().get('AI_MAX_MESSAGE_BYTES'));
        expect(bytes + 4096).toBeLessThanOrEqual(
          config().get('AI_INPUT_TOKEN_BUDGET'),
        );
      }
      const mapInstruction = model.mock.calls[0]![0][0]!.content;
      expect(mapInstruction).toContain('summary(最多180字)');
      expect(mapInstruction).not.toContain('240');
      const state = JSON.parse(
        await readFile(join(directory, 'metadata', 'state.json'), 'utf8'),
      );
      for (const run of Object.values(state.runs) as {
        configuration: { version: string };
        modelCall: { promptVersion: string; schemaVersion: string };
      }[]) {
        expect(run.configuration.version).toBe('chapter-illustration-plan-2');
        expect(run.modelCall.promptVersion).toBe('chapter-illustration-plan-2');
        expect(run.modelCall.schemaVersion).toBe('chapter-illustration-plan-2');
      }
    },
  );

  it.each(['summary-241', 'unknown-evidence', 'duplicate-evidence'])(
    'rejects a map with %s and preserves UNKNOWN/HELD without resending',
    async (mutation) => {
      const source = chapter(['山地夜晚🙂成年人的活动。'.repeat(1100)]);
      model.mockImplementation(async (messages) => {
        const response = validResponse(messages) as Record<string, unknown>;
        response.summary = '景'.repeat(mutation === 'summary-241' ? 241 : 240);
        if (mutation !== 'summary-241') {
          const blockId = JSON.parse(messages[1]!.content).pieces[0].blockId;
          response.facts = [
            {
              text: '片段内有依据的环境。',
              sourceBlockIds:
                mutation === 'unknown-evidence'
                  ? ['outside-chunk']
                  : [blockId, blockId],
            },
          ];
        }
        return {
          content: JSON.stringify(response),
          finishReason: 'stop',
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        };
      });
      await expect(planner().plan(source, context)).rejects.toMatchObject({
        code:
          mutation === 'summary-241'
            ? 'ILLUSTRATION_PLANNING_FAILED'
            : 'ILLUSTRATION_INVALID_EVIDENCE',
      });
      const before = await readFile(
        join(directory, 'metadata', 'state.json'),
        'utf8',
      );
      expect(Object.values(JSON.parse(before).runs)).toMatchObject([
        { modelCall: { status: 'UNKNOWN', budgetDisposition: 'HELD' } },
      ]);
      await expect(planner().plan(source, context)).rejects.toMatchObject({
        code: 'AI_UNKNOWN_OUTCOME',
      });
      expect(model).toHaveBeenCalledTimes(1);
      expect(
        await readFile(join(directory, 'metadata', 'state.json'), 'utf8'),
      ).toBe(before);
    },
  );

  it('still rejects an oversized reducer input before sending even when all map fields satisfy bounded caps', async () => {
    const source = chapter(['景'.repeat(4000)]);
    model.mockImplementation(async (messages) => {
      const response = validResponse(messages) as Record<string, unknown>;
      const blockId = JSON.parse(messages[1]!.content).pieces[0].blockId;
      response.summary = '景'.repeat(240);
      response.emotionalReading = '情'.repeat(100);
      response.facts = Array.from({ length: 3 }, () => ({
        text: '景'.repeat(60),
        sourceBlockIds: [blockId],
      }));
      response.sceneCandidate = {
        synopsis: '景'.repeat(80),
        sourceBlockIds: [blockId],
      };
      return {
        content: JSON.stringify(response),
        finishReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      };
    });
    const instance = planner({ AI_MAX_MESSAGE_BYTES: 5120 });
    await expect(instance.plan(source, context)).rejects.toMatchObject({
      code: 'ILLUSTRATION_REDUCE_LIMIT',
    });
    const count = model.mock.calls.length;
    expect(count).toBeGreaterThan(1);
    for (const [messages] of model.mock.calls) {
      expect(JSON.parse(messages[1]!.content).anchorId).toBeUndefined();
      expect(
        Buffer.byteLength(JSON.stringify(messages), 'utf8'),
      ).toBeLessThanOrEqual(5120);
    }
    await expect(instance.plan(source, context)).rejects.toMatchObject({
      code: 'ILLUSTRATION_REDUCE_LIMIT',
    });
    expect(model).toHaveBeenCalledTimes(count);
  });

  it('uses the same exact short aliases across all map chunks and the reducer', async () => {
    const source = chapter([
      '雪'.repeat(5000),
      '山'.repeat(5000),
      '火'.repeat(5000),
    ]);
    const result = await planner().plan(source, context);
    const mappedPieces = model.mock.calls.slice(0, -1).flatMap(
      (call) =>
        JSON.parse(call[0][1]!.content).pieces as {
          blockId: string;
          text: string;
        }[],
    );
    expect(new Set(mappedPieces.map((piece) => piece.blockId))).toEqual(
      new Set(['b1', 'b2', 'b3']),
    );
    for (const [index, block] of source.blocks.entries()) {
      expect(
        mappedPieces
          .filter((piece) => piece.blockId === `b${index + 1}`)
          .map((piece) => piece.text)
          .join(''),
      ).toBe(block.text);
    }
    const reducer = JSON.parse(model.mock.calls.at(-1)![0][1]!.content);
    for (const summary of reducer.summaries)
      expect(summary.facts[0].sourceBlockIds[0]).toMatch(/^b[1-3]$/);
    expect(
      result.facts
        .flatMap((fact) => fact.sourceBlockIds)
        .every((id) => source.blocks.some((block) => block.id === id)),
    ).toBe(true);
    expect(
      result.settingEvidenceBlockIds.every((id) =>
        source.blocks.some((block) => block.id === id),
      ),
    ).toBe(true);
  });

  it.each(['b01', 'B1', 'b9999', 'block-1', 1])(
    'rejects an unknown or altered alias %s without fuzzy matching',
    async (alias) => {
      model.mockImplementation(async (messages: StructureMessage[]) => {
        const value = validResponse(messages) as Record<string, unknown>;
        value.facts = [{ text: '有雪', sourceBlockIds: [alias] }];
        return { content: JSON.stringify(value), finishReason: 'stop' };
      });
      await expect(planner().plan(chapter(), context)).rejects.toBeDefined();
      await expect(planner().plan(chapter(), context)).rejects.toMatchObject({
        code: 'AI_UNKNOWN_OUTCOME',
      });
      expect(model).toHaveBeenCalledTimes(1);
    },
  );

  it('checkpoints a bounded malformed provider payload with its fingerprints before parsing', async () => {
    const content = '{broken-private-provider-payload';
    model.mockResolvedValue({
      content,
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });
    await expect(planner().plan(chapter(), context)).rejects.toMatchObject({
      code: 'ILLUSTRATION_PLANNING_FAILED',
    });
    const folder = join(directory, 'private', 'illustration-plans');
    const files = (await readdir(folder, { recursive: true })).filter((name) =>
      name.endsWith('.json'),
    );
    expect(files).toHaveLength(1);
    const checkpoint = JSON.parse(
      await readFile(join(folder, files[0]!), 'utf8'),
    );
    expect(checkpoint).toMatchObject({
      kind: 'provider-response',
      promptVersion: 'chapter-illustration-plan-2',
      response: {
        content,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      },
    });
    expect(checkpoint.callFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(checkpoint.inputSha256).toMatch(/^[a-f0-9]{64}$/);
    const metadata = await readFile(
      join(directory, 'metadata', 'state.json'),
      'utf8',
    );
    expect(metadata).not.toContain(content);
    expect(
      JSON.parse(metadata).runs[Object.keys(JSON.parse(metadata).runs)[0]]
        .modelCall,
    ).toMatchObject({ status: 'UNKNOWN', budgetDisposition: 'HELD' });
    await expect(planner().plan(chapter(), context)).rejects.toMatchObject({
      code: 'AI_UNKNOWN_OUTCOME',
    });
    expect(model).toHaveBeenCalledTimes(1);
  });

  it.each(['evidence', 'anchor'] as const)(
    'rejects out-of-chapter %s and never retries a paid unknown result',
    async (kind) => {
      model.mockImplementation(async (messages: StructureMessage[]) => {
        const value = validResponse(messages) as Record<string, unknown>;
        if (kind === 'evidence')
          value.facts = [
            { text: '虚构事实', sourceBlockIds: ['outside-chapter'] },
          ];
        else value.anchorId = 'outside-anchor';
        return { content: JSON.stringify(value), finishReason: 'stop' };
      });
      await expect(planner().plan(chapter(), context)).rejects.toMatchObject({
        code:
          kind === 'evidence'
            ? 'ILLUSTRATION_INVALID_EVIDENCE'
            : 'ILLUSTRATION_INVALID_ANCHOR',
      });
      await expect(planner().plan(chapter(), context)).rejects.toMatchObject({
        code: 'AI_UNKNOWN_OUTCOME',
      });
      expect(model).toHaveBeenCalledTimes(1);
      const metadata = JSON.parse(
        await readFile(join(directory, 'metadata', 'state.json'), 'utf8'),
      );
      expect(Object.values(metadata.runs)).toMatchObject([
        { modelCall: { status: 'UNKNOWN', budgetDisposition: 'HELD' } },
      ]);
    },
  );

  it('records a safe refusal once and never generates a replacement plan on resume', async () => {
    model.mockResolvedValue({
      content: JSON.stringify({ decision: 'DECLINE', reason: 'NO_SAFE_SCENE' }),
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });
    await expect(planner().plan(chapter(), context)).rejects.toMatchObject({
      code: 'ILLUSTRATION_DECLINED',
    });
    await expect(planner().plan(chapter(), context)).rejects.toMatchObject({
      code: 'ILLUSTRATION_DECLINED',
    });
    expect(model).toHaveBeenCalledTimes(1);
  });

  it('keeps timeout outcomes unknown and excludes upstream error details', async () => {
    model.mockRejectedValue(new AiGatewayError('AI_TIMEOUT'));
    await expect(planner().plan(chapter(), context)).rejects.toMatchObject({
      code: 'AI_TIMEOUT',
    });
    await expect(planner().plan(chapter(), context)).rejects.toMatchObject({
      code: 'AI_UNKNOWN_OUTCOME',
    });
    expect(model).toHaveBeenCalledTimes(1);
  });

  it('does not resend if a successful immutable result was removed or changed', async () => {
    const result = await planner().plan(chapter(), context);
    await writeFile(
      join(directory, 'private', result.modelCalls[0]!.result.storageKey),
      '{}',
    );
    await expect(planner().plan(chapter(), context)).rejects.toMatchObject({
      code: 'AI_RESULT_UNAVAILABLE',
    });
    expect(model).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized chapters, changed sources, unsafe anchors, and total budget before calling', async () => {
    await expect(
      planner().plan(chapter(['文'.repeat(150000)]), context),
    ).rejects.toMatchObject({ code: 'ILLUSTRATION_CHAPTER_LIMIT' });
    await expect(
      planner().plan({ ...chapter(), sourceSha256: 'c'.repeat(64) }, context),
    ).rejects.toMatchObject({ code: 'ILLUSTRATION_SOURCE_MISMATCH' });
    const invalid = chapter();
    invalid.anchors[0]!.sourceEnd++;
    await expect(planner().plan(invalid, context)).rejects.toMatchObject({
      code: 'ILLUSTRATION_INVALID_ANCHOR',
    });
    await expect(
      planner({ AI_RUN_BUDGET_MICROS: 1 }).plan(chapter(), context),
    ).rejects.toMatchObject({ code: 'ILLUSTRATION_OPERATION_BUDGET_EXCEEDED' });
    expect(model).not.toHaveBeenCalled();
  });

  it('holds the full reservation when the provider omits trustworthy usage', async () => {
    model.mockImplementation(async (messages: StructureMessage[]) => ({
      content: JSON.stringify(validResponse(messages)),
      finishReason: 'stop',
    }));
    const result = await planner().plan(chapter(), context);
    expect(result.modelCalls[0]).toMatchObject({
      status: 'SUCCEEDED',
      budgetDisposition: 'HELD',
      usage: null,
      estimatedCostMicros: null,
    });
  });

  it('preserves a known daily-budget rejection before sending instead of reporting an unknown paid outcome', async () => {
    const instance = planner({
      AI_RUN_BUDGET_MICROS: 31744,
      AI_DAILY_BUDGET_MICROS: 31744,
    });
    await instance.plan(chapter(), context);
    await expect(
      instance.plan(chapter(), { ...context, operationId: 'second-operation' }),
    ).rejects.toMatchObject({ code: 'MODEL_DAILY_BUDGET_EXCEEDED' });
    expect(model).toHaveBeenCalledTimes(1);
  });

  async function receivedUnknown() {
    const completing = vi
      .spyOn(repository, 'completeModelCall')
      .mockResolvedValueOnce(false);
    await expect(planner().plan(chapter(), context)).rejects.toMatchObject({
      code: 'AI_STALE_LEASE',
    });
    completing.mockRestore();
    const state = JSON.parse(
      await readFile(join(directory, 'metadata', 'state.json'), 'utf8'),
    );
    const run = Object.values(state.runs)[0] as { modelCall: { id: string } };
    const folder = join(
      directory,
      'private',
      'illustration-plans',
      run.modelCall.id,
    );
    for (const filename of await readdir(folder)) {
      const payload = JSON.parse(
        await readFile(join(folder, filename), 'utf8'),
      );
      if (payload.kind === 'provider-response')
        return { folder, filename, payload };
    }
    throw new Error('Missing isolated fixture');
  }

  it('requires explicit offline opt-in and preserves the original UNKNOWN/HELD ledger without a model call', async () => {
    await receivedUnknown();
    const before = await readFile(
      join(directory, 'metadata', 'state.json'),
      'utf8',
    );
    await expect(planner().plan(chapter(), context)).rejects.toMatchObject({
      code: 'AI_UNKNOWN_OUTCOME',
    });
    const recovered = await planner().plan(chapter(), {
      ...context,
      recoverReceivedResponses: true,
    });
    expect(recovered.modelCalls[0]).toMatchObject({
      status: 'UNKNOWN',
      budgetDisposition: 'HELD',
      estimatedCostMicros: null,
      usage: null,
      reused: true,
      recoveredFromPrivateResponse: true,
      receivedResponseUsage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      },
    });
    const again = await planner().plan(chapter(), {
      ...context,
      recoverReceivedResponses: true,
    });
    expect(again.modelCalls[0]!.result).toEqual(
      recovered.modelCalls[0]!.result,
    );
    expect(
      await readFile(join(directory, 'metadata', 'state.json'), 'utf8'),
    ).toBe(before);
    expect(model).toHaveBeenCalledTimes(1);
    const recoveryRecord = JSON.parse(
      await readFile(
        join(directory, 'private', recovered.modelCalls[0]!.result.storageKey),
        'utf8',
      ),
    );
    expect(recoveryRecord).toMatchObject({
      kind: 'offline-recovery',
      callId: recovered.modelCalls[0]!.callId,
      providerResponse: recovered.modelCalls[0]!.recoverySource,
    });
  });

  it('reuses unchanged map inputs and creates one new reduce fingerprint for an explicit scene direction', async () => {
    const source = chapter(['雪山与窗外野画眉。'.repeat(1400)]);
    model.mockImplementation(async (messages: StructureMessage[]) => {
      const input = JSON.parse(messages[1]!.content);
      const value = validResponse(messages) as Record<string, unknown>;
      if (input.anchorId && !input.sceneDirection)
        return {
          content: JSON.stringify({
            decision: 'DECLINE',
            reason: 'NO_SAFE_SCENE',
          }),
          finishReason: 'stop',
        };
      if (input.sceneDirection) {
        value.depicts = 'no-people';
        value.imagePrompt =
          '下雪早晨，窗外的野画眉，留白克制的环境插画，完全无人。';
      }
      return { content: JSON.stringify(value), finishReason: 'stop' };
    });
    await expect(planner().plan(source, context)).rejects.toMatchObject({
      code: 'ILLUSTRATION_DECLINED',
    });
    const firstCalls = model.mock.calls.length;
    const originalMapMessages = model.mock.calls
      .slice(0, -1)
      .map((call) => JSON.stringify(call[0]));
    const before = JSON.parse(
      await readFile(join(directory, 'metadata', 'state.json'), 'utf8'),
    );
    const previousFingerprint = (
      Object.values(before.runs).at(-1) as {
        modelCall: { fingerprint: string };
      }
    ).modelCall.fingerprint;
    const direction =
      '只使用已有依据，选择下雪早晨与窗外野画眉，完全无人；无依据仍可拒绝。';
    const result = await planner().plan(source, {
      ...context,
      sceneDirection: direction,
    });
    expect(model).toHaveBeenCalledTimes(firstCalls + 1);
    expect(result.modelCalls.slice(0, -1).every((call) => call.reused)).toBe(
      true,
    );
    expect(
      originalMapMessages.every(
        (message) => !message.includes('sceneDirection'),
      ),
    ).toBe(true);
    expect(
      model.mock.calls
        .slice(0, firstCalls - 1)
        .map((call) => JSON.stringify(call[0])),
    ).toEqual(originalMapMessages);
    expect(
      JSON.parse(model.mock.calls.at(-1)![0][1]!.content).sceneDirection,
    ).toBe(direction);
    const newRun = await repository.getRun(
      context.ownerId,
      result.modelCalls.at(-1)!.runId,
    );
    expect(newRun.modelCall!.fingerprint).not.toBe(previousFingerprint);
    expect(result.depicts).toBe('no-people');
    expect(result.imagePrompt).toContain('画面中不出现人物');
  });

  it('allows a direction-constrained planner to decline and rejects an oversized direction before payment', async () => {
    await expect(
      planner().plan(chapter(), {
        ...context,
        sceneDirection: '字'.repeat(201),
      }),
    ).rejects.toMatchObject({ code: 'ILLUSTRATION_INVALID_CHAPTER' });
    expect(model).not.toHaveBeenCalled();
    model.mockResolvedValue({
      content: JSON.stringify({
        decision: 'DECLINE',
        reason: 'INSUFFICIENT_EVIDENCE',
      }),
      finishReason: 'stop',
    });
    const constrained = {
      ...context,
      sceneDirection: '仅画有依据的无人环境，否则拒绝。',
    };
    await expect(planner().plan(chapter(), constrained)).rejects.toMatchObject({
      code: 'ILLUSTRATION_DECLINED',
    });
    await expect(planner().plan(chapter(), constrained)).rejects.toMatchObject({
      code: 'ILLUSTRATION_DECLINED',
    });
    expect(model).toHaveBeenCalledTimes(1);
  });

  it.each([
    'hash',
    'callId',
    'input',
    'fingerprint',
    'evidence',
    'usage',
  ] as const)(
    'refuses offline recovery with mismatched %s and preserves the ledger',
    async (kind) => {
      const fixture = await receivedUnknown();
      const original = join(fixture.folder, fixture.filename);
      if (kind === 'callId')
        fixture.payload.callId = '00000000-0000-4000-8000-000000000000';
      if (kind === 'input') fixture.payload.inputSha256 = 'c'.repeat(64);
      if (kind === 'fingerprint')
        fixture.payload.callFingerprint = 'd'.repeat(64);
      if (kind === 'evidence') {
        const parsed = JSON.parse(fixture.payload.response.content);
        parsed.facts[0].sourceBlockIds = ['b9999'];
        fixture.payload.response.content = JSON.stringify(parsed);
      }
      if (kind === 'usage') fixture.payload.response.usage.totalTokens++;
      const bytes = JSON.stringify(fixture.payload);
      if (kind === 'hash') await writeFile(original, `${bytes} `);
      else {
        const filename = `${fixture.filename.slice(0, 36)}-${hash(bytes)}.json`;
        await writeFile(join(fixture.folder, filename), bytes, { flag: 'wx' });
        await rm(original);
      }
      const before = await readFile(
        join(directory, 'metadata', 'state.json'),
        'utf8',
      );
      await expect(
        planner().plan(chapter(), {
          ...context,
          recoverReceivedResponses: true,
        }),
      ).rejects.toMatchObject({ code: 'ILLUSTRATION_RECOVERY_UNAVAILABLE' });
      expect(
        await readFile(join(directory, 'metadata', 'state.json'), 'utf8'),
      ).toBe(before);
      expect(model).toHaveBeenCalledTimes(1);
    },
  );
});
