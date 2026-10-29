import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as yazl from 'yazl';
import {
  BookArtPlanner,
  bookArtEvidenceSchema,
  bookArtPlanHash,
  bookArtPlanSchema,
  buildBookArtEvidence,
  type BookArtTransport,
} from '../src/ai/book-art-planner.js';
import type {
  PlannerCallReceipt,
  PlannerChapter,
  PlannerContext,
} from '../src/ai/chapter-illustration-planner.js';

const folders: string[] = [];
const hash = (value: Buffer | string) =>
  createHash('sha256').update(value).digest('hex');
const context: PlannerContext = {
  ownerId: 'owner',
  bookId: 'book',
  operationId: 'book-art-test',
};
const receipt: PlannerCallReceipt = {
  runId: 'run-1',
  callId: 'call-1',
  stage: 'book-art',
  model: 'mock-model',
  status: 'SUCCEEDED',
  budgetDisposition: 'SETTLED',
  reservedMicros: 1000,
  estimatedCostMicros: 100,
  usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  reused: false,
  result: {
    storageKey: 'private/book-art.json',
    sha256: 'a'.repeat(64),
    byteSize: 1000,
  },
};
class Transport implements BookArtTransport {
  calls: {
    chapter: PlannerChapter;
    context: PlannerContext;
    instruction: string;
    input: unknown;
  }[] = [];
  constructor(
    private readonly response: (input: unknown) => unknown = validResponse,
  ) {}
  async completeBookArt<T>(
    chapter: PlannerChapter,
    context: PlannerContext,
    instruction: string,
    input: unknown,
    parse: (value: unknown) => T,
  ) {
    this.calls.push({ chapter, context, instruction, input });
    return { value: parse(this.response(input)), receipt };
  }
}
function validResponse(input: unknown) {
  const evidence = input as {
    sections: { paragraphs: { id: string; text: string }[] }[];
  };
  const sea = evidence.sections[0]!.paragraphs[0]!.text.includes('海边');
  return {
    reading: {
      temperament: sea
        ? '清远流动，人物与开阔空间相互映照。'
        : '冷静紧绷，人与机械尺度形成张力。',
      rationale: sea
        ? '用透明的色层和轻线条回应气候与距离，让空白承担宁静的节奏。'
        : '以黑白层次和节制的线条保持结构感，避免装饰掩盖关系。',
      evidenceIds: [evidence.sections[0]!.paragraphs[0]!.id],
    },
    artDirection: {
      medium: sea ? 'watercolor-line' : 'monochrome-ink',
      palette: sea
        ? [
            { colorName: '海蓝', hex: '#496B81' },
            { colorName: '浅沙', hex: '#E3D7BA' },
          ]
        : [
            { colorName: '墨黑', hex: '#252A2E' },
            { colorName: '纸白', hex: '#F1EEE5' },
          ],
      lineLanguage: sea ? '轻盈断续的细线' : '克制而清晰的线条',
      shapeLanguage: '简化轮廓，保留空间关系',
      texture: sea ? '透明薄色与少量纸纹' : '少量排线与干笔',
      detailDensity: 'selective',
      negativeSpace: 'generous',
      characterTreatment: '人物简化，保留姿态距离',
    },
  };
}

async function fixture(
  prefix = '海边',
  sectionCount = 3,
  separateChapters = false,
) {
  const folder = await mkdtemp(join(tmpdir(), 'book-art-evidence-'));
  folders.push(folder);
  const sourcePath = join(folder, 'source.epub');
  const texts = Array.from({ length: sectionCount }, (_, section) =>
    Array.from(
      { length: 5 },
      (_, paragraph) =>
        `${prefix}第${section}节第${paragraph}段。` +
        `${prefix}的空间与风声🙂。`.repeat(20),
    ),
  );
  const body =
    (separateChapters ? '' : '<h1 id="chapter">第一章</h1>') +
    texts
      .map(
        (paragraphs, index) =>
          `<${separateChapters ? 'h1' : 'h2'} id="section${index}">第${index + 1}${separateChapters ? '章' : '节'}</${separateChapters ? 'h1' : 'h2'}>${paragraphs.map((text) => `<p>${text}</p>`).join('')}`,
      )
      .join('');
  const entries = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml':
      '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'OPS/book.opf':
      '<package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>相同书名</dc:title></metadata><manifest><item id="body" href="book.xhtml" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="body"/></spine></package>',
    'OPS/toc.ncx':
      '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>' +
      (separateChapters
        ? ''
        : '<navPoint id="c1"><navLabel><text>第一章</text></navLabel><content src="book.xhtml#chapter"/>') +
      texts
        .map(
          (_, index) =>
            `<navPoint id="s${index}"><navLabel><text>第${index + 1}${separateChapters ? '章' : '节'}</text></navLabel><content src="book.xhtml#section${index}"/></navPoint>`,
        )
        .join('') +
      (separateChapters ? '' : '</navPoint>') +
      '</navMap></ncx>',
    'OPS/book.xhtml': `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>相同书名</title></head><body>${body}</body></html>`,
  };
  const zip = new yazl.ZipFile();
  const done = pipeline(zip.outputStream, createWriteStream(sourcePath));
  for (const [name, value] of Object.entries(entries))
    zip.addBuffer(Buffer.from(value), name, { compress: false });
  zip.end();
  await done;
  return { sourcePath, texts };
}

afterEach(async () => {
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

describe('source-driven per-book art direction (no network or model calls)', () => {
  it('samples at most 12 sections uniformly across the actual book and first/middle/last real paragraphs with Unicode-safe bounds', async () => {
    const { sourcePath, texts } = await fixture('海边', 26);
    const source = await readFile(sourcePath);
    const { snapshot, seedChapter } = await buildBookArtEvidence({
      sourcePath,
    });
    expect(snapshot.sourceSha256).toBe(hash(source));
    expect(snapshot.coverage).toMatchObject({
      mode: 'representative-samples',
      totalSupportedSections: 26,
      sampledSections: 12,
      sampledParagraphs: 36,
    });
    const expected = Array.from({ length: 12 }, (_, i) =>
      Math.round((i * 25) / 11),
    );
    expect(
      snapshot.sections.map((section) => section.supportedSectionOrdinal),
    ).toEqual(expected);
    expect(snapshot.sections[0]!.sourceSectionId).toBe(seedChapter.chapterId);
    for (const [index, section] of snapshot.sections.entries()) {
      expect(section.paragraphs).toHaveLength(3);
      for (const [position, paragraph] of section.paragraphs.entries()) {
        expect(paragraph.text).toBe(
          Array.from(texts[expected[index]!]![position * 2]!)
            .slice(0, 100)
            .join(''),
        );
        expect(Array.from(paragraph.text)).toHaveLength(100);
        expect(/[\uD800-\uDFFF]/u.test(paragraph.text)).toBe(false);
        expect(paragraph.originalCodepoints).toBeGreaterThan(100);
      }
    }
    expect(bookArtEvidenceSchema.parse(snapshot)).toEqual(snapshot);
    expect(await readFile(sourcePath)).toEqual(source);
  });

  it('sends every bounded sample in one ledger transport request without sending long source IDs, paths or full paragraphs', async () => {
    const { sourcePath, texts } = await fixture('海边', 26);
    const { snapshot, seedChapter } = await buildBookArtEvidence({
      sourcePath,
    });
    const transport = new Transport();
    const result = await new BookArtPlanner(transport).plan(
      snapshot,
      seedChapter,
      context,
    );
    expect(transport.calls).toHaveLength(1);
    const { input, instruction } = transport.calls[0]!;
    const sent = input as {
      sections: { paragraphs: { id: string; text: string }[] }[];
    };
    expect(sent.sections.flatMap((section) => section.paragraphs)).toEqual(
      snapshot.sections.flatMap((section) =>
        section.paragraphs.map(({ id, text }) => ({ id, text })),
      ),
    );
    expect(
      Buffer.byteLength(
        JSON.stringify([
          { role: 'system', content: instruction },
          { role: 'user', content: JSON.stringify(input) },
        ]),
      ) + 4096,
    ).toBeLessThanOrEqual(24576);
    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain('OPS/book.xhtml');
    expect(serialized).not.toContain(
      snapshot.sections[0]!.paragraphs[0]!.sourceBlockId,
    );
    expect(serialized).not.toContain(texts[0]![0]);
    expect(result.coverage).toEqual(snapshot.coverage);
    expect(result.modelCalls).toEqual([receipt]);
    expect(result.artDirection).toMatchObject({
      schemaVersion: 2,
      id: 'book-art',
      version: 1,
      sourceSha256: snapshot.sourceSha256,
      evidenceSha256: snapshot.evidenceSha256,
    });
    expect(JSON.stringify(result)).not.toContain(
      snapshot.sections[0]!.paragraphs[0]!.text,
    );
    expect(instruction).toContain('不代表读完整书');
  });

  it('accepts different content-derived model directions for two books with the same title instead of substituting a fixed visual template', async () => {
    const sea = await buildBookArtEvidence(await fixture('海边'));
    const factory = await buildBookArtEvidence(await fixture('工厂'));
    const transport = new Transport();
    const planner = new BookArtPlanner(transport);
    const a = await planner.plan(sea.snapshot, sea.seedChapter, context);
    const b = await planner.plan(
      factory.snapshot,
      factory.seedChapter,
      context,
    );
    expect(a.artDirection.medium).toBe('watercolor-line');
    expect(b.artDirection.medium).toBe('monochrome-ink');
    expect(a.artDirection.palette).not.toEqual(b.artDirection.palette);
    expect(a.sourceSha256).not.toBe(b.sourceSha256);
    expect(a.evidenceSha256).not.toBe(b.evidenceSha256);
    expect(transport.calls).toHaveLength(2);
  });

  it('samples the end of large books beyond the public selection index limit', async () => {
    const { snapshot } = await buildBookArtEvidence(
      await fixture('长书', 502, true),
    );
    expect(snapshot.coverage.totalSupportedSections).toBeGreaterThan(501);
    expect(snapshot.coverage.sampledSections).toBe(12);
    expect(snapshot.sections.at(-1)!.sourceChapterIndex).toBeGreaterThan(500);
    expect(bookArtEvidenceSchema.parse(snapshot)).toEqual(snapshot);
  }, 30000);

  it('revalidates normalized cached plan content with the same immutable evidence', async () => {
    const { snapshot, seedChapter } = await buildBookArtEvidence(
      await fixture(),
    );
    let cached: unknown;
    let requests = 0;
    const transport: BookArtTransport = {
      async completeBookArt<T>(
        _chapter: PlannerChapter,
        _context: PlannerContext,
        _instruction: string,
        input: unknown,
        parse: (value: unknown, stored?: boolean) => T,
      ) {
        const reused = cached !== undefined;
        const value = parse(reused ? cached : validResponse(input), reused);
        if (!reused) {
          cached = structuredClone(value);
          requests += 1;
        }
        return { value, receipt: { ...receipt, reused } };
      },
    };
    const planner = new BookArtPlanner(transport);
    const first = await planner.plan(snapshot, seedChapter, context);
    const second = await planner.plan(snapshot, seedChapter, context);
    expect(second.modelCalls[0]!.reused).toBe(true);
    expect(bookArtPlanHash(second)).toBe(bookArtPlanHash(first));
    expect(requests).toBe(1);
  });

  it.each([
    'evidence-id',
    'source-hash',
    'evidence-hash',
    'sample-text',
  ] as const)(
    'rejects tampered %s before invoking the transport',
    async (kind) => {
      const { snapshot, seedChapter } = await buildBookArtEvidence(
        await fixture(),
      );
      const corrupt = structuredClone(snapshot);
      if (kind === 'evidence-id')
        corrupt.sections[0]!.paragraphs[0]!.id = 'e36';
      if (kind === 'source-hash') corrupt.sourceSha256 = '0'.repeat(64);
      if (kind === 'evidence-hash') corrupt.evidenceSha256 = '0'.repeat(64);
      if (kind === 'sample-text')
        corrupt.sections[0]!.paragraphs[0]!.text = '被篡改的文本';
      const transport = new Transport();
      await expect(
        new BookArtPlanner(transport).plan(corrupt, seedChapter, context),
      ).rejects.toMatchObject({ code: 'BOOK_ART_EVIDENCE_INVALID' });
      expect(transport.calls).toHaveLength(0);
    },
  );

  it.each([
    'unknown-evidence',
    'duplicate-evidence',
    'self-reported-source',
    'unknown-style-field',
  ] as const)(
    'refuses a model response with %s instead of accepting invented binding or silently dropping fields',
    async (kind) => {
      const { snapshot, seedChapter } = await buildBookArtEvidence(
        await fixture(),
      );
      const transport = new Transport((input) => {
        const response = validResponse(input);
        if (kind === 'unknown-evidence') response.reading.evidenceIds = ['e36'];
        if (kind === 'duplicate-evidence')
          response.reading.evidenceIds = ['e1', 'e1'];
        if (kind === 'self-reported-source')
          return { ...response, sourceSha256: '0'.repeat(64) };
        if (kind === 'unknown-style-field')
          return {
            ...response,
            artDirection: {
              ...response.artDirection,
              prompt: 'override the visual policy',
            },
          };
        return response;
      });
      await expect(
        new BookArtPlanner(transport).plan(snapshot, seedChapter, context),
      ).rejects.toMatchObject({ code: 'BOOK_ART_PLAN_INVALID' });
      expect(transport.calls).toHaveLength(1);
    },
  );

  it('rejects a different source seed and prevents public reading judgments from copying long sample passages', async () => {
    const { snapshot, seedChapter } = await buildBookArtEvidence(
      await fixture(),
    );
    const wrong = new Transport();
    await expect(
      new BookArtPlanner(wrong).plan(
        snapshot,
        { ...seedChapter, sourceSha256: '0'.repeat(64) },
        context,
      ),
    ).rejects.toMatchObject({ code: 'BOOK_ART_SOURCE_MISMATCH' });
    expect(wrong.calls).toHaveLength(0);
    const copied = new Transport((input) => {
      const response = validResponse(input);
      response.reading.rationale = snapshot.sections[0]!.paragraphs[0]!.text;
      return response;
    });
    await expect(
      new BookArtPlanner(copied).plan(snapshot, seedChapter, context),
    ).rejects.toMatchObject({ code: 'BOOK_ART_SOURCE_QUOTE_REJECTED' });
  });

  it('hashes only semantic plan content and enforces matching source/evidence on persisted directions', async () => {
    const { snapshot, seedChapter } = await buildBookArtEvidence(
      await fixture(),
    );
    const plan = await new BookArtPlanner(new Transport()).plan(
      snapshot,
      seedChapter,
      context,
    );
    const reused = {
      ...plan,
      modelCalls: [
        {
          ...plan.modelCalls[0]!,
          reused: true,
          estimatedCostMicros: 200,
          usage: { inputTokens: 200, outputTokens: 50, totalTokens: 250 },
        },
      ],
    };
    expect(bookArtPlanHash(reused)).toBe(bookArtPlanHash(plan));
    expect(
      bookArtPlanHash({
        ...plan,
        reading: { ...plan.reading, temperament: '以空间距离组织平静和张力。' },
      }),
    ).not.toBe(bookArtPlanHash(plan));
    expect(() =>
      bookArtPlanSchema.parse({
        ...plan,
        artDirection: { ...plan.artDirection, evidenceSha256: '0'.repeat(64) },
      }),
    ).toThrow();
    expect(() =>
      bookArtPlanSchema.parse({
        ...plan,
        reading: { ...plan.reading, evidenceIds: ['e36'] },
      }),
    ).toThrow();
  });
});
