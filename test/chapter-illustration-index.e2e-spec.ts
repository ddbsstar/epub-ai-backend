import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as yazl from 'yazl';
import {
  inspectIllustrationCatalog,
  inspectIllustrationChapter,
} from '../src/documents/chapter-illustration-index.js';

const scratch: string[] = [];
const document = (body: string) =>
  `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>测试</title></head><body>${body}</body></html>`;
const first = document(
  '<h1 id="one">第一章</h1><h2 id="s1">第一节</h2><p>同一段🐬</p><p>同一段🐬</p>',
);
const second = document(
  '<h2 id="s2">第二节</h2><p>第二文件<em>完整内容</em>。</p><p>章末。</p>',
);
const third = document('\n\n<h1 id="two">第二章</h1><p>不要进入第一章。</p>');
const ncx =
  '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="c1"><navLabel><text>第一章</text></navLabel><content src="a.xhtml#one"/><navPoint id="s1"><navLabel><text>第一节</text></navLabel><content src="a.xhtml#s1"/></navPoint><navPoint id="s2"><navLabel><text>第二节</text></navLabel><content src="b.xhtml#s2"/></navPoint></navPoint><navPoint id="c2"><navLabel><text>第二章</text></navLabel><content src="c.xhtml#two"/></navPoint></navMap></ncx>';

async function fixture(overrides: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'chapter-index-test-'));
  scratch.push(root);
  const sourcePath = join(root, 'source.epub');
  const entries = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml':
      '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'book/package.opf':
      '<package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata/><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="a"/><itemref idref="b"/><itemref idref="c"/></spine></package>',
    'book/toc.ncx': ncx,
    'book/a.xhtml': first,
    'book/b.xhtml': second,
    'book/c.xhtml': third,
    ...overrides,
  };
  const zip = new yazl.ZipFile();
  const done = pipeline(zip.outputStream, createWriteStream(sourcePath));
  for (const [name, content] of Object.entries(entries))
    zip.addBuffer(Buffer.from(content), name, { compress: false });
  zip.end();
  await done;
  return { sourcePath, chapterIndex: 0 };
}

afterEach(async () => {
  await Promise.all(
    scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('complete logical-chapter illustration index', () => {
  it('joins consecutive section documents, stops at the next chapter, and binds duplicate paragraphs to distinct offsets', async () => {
    const options = await fixture();
    const original = await readFile(options.sourcePath);
    const result = await inspectIllustrationChapter(options);
    expect(result).toEqual(await inspectIllustrationChapter(options));
    expect(result.covered).toBe('COMPLETE');
    expect(result.documents.map((entry) => entry.documentPath)).toEqual([
      'book/a.xhtml',
      'book/b.xhtml',
    ]);
    expect(result.blocks.map((block) => block.text)).toEqual([
      '第一章',
      '第一节',
      '同一段🐬',
      '同一段🐬',
      '第二节',
      '第二文件完整内容。',
      '章末。',
    ]);
    expect(result.blocks[2].contentSha256).toBe(result.blocks[3].contentSha256);
    expect(result.blocks[2].id).not.toBe(result.blocks[3].id);
    for (const anchor of result.anchors) {
      const source = anchor.documentPath === 'book/a.xhtml' ? first : second;
      const element = source.slice(anchor.sourceStart, anchor.sourceEnd);
      expect(element).toMatch(/^<p>/u);
      expect(createHash('sha256').update(element).digest('hex')).toBe(
        anchor.contentSha256,
      );
    }
    expect(result.anchors.at(-1)).toMatchObject({
      kind: 'chapter-end',
      documentPath: 'book/b.xhtml',
      blockId: result.blocks.at(-1)!.id,
    });
    expect(await readFile(options.sourcePath)).toEqual(original);
    expect(result.sourceSha256).toBe(
      createHash('sha256').update(original).digest('hex'),
    );
  });

  it('extracts all paragraphs instead of using the 32-sample structure snapshot', async () => {
    const options = await fixture({
      'book/b.xhtml': document(
        `<h2 id="s2">第二节</h2>${'<p>完整段落。</p>'.repeat(40)}`,
      ),
    });
    const result = await inspectIllustrationChapter(options);
    expect(
      result.blocks.filter((block) => block.kind === 'paragraph'),
    ).toHaveLength(42);
    expect(new Set(result.blocks.map((block) => block.id)).size).toBe(
      result.blocks.length,
    );
  });

  it('supports two logical chapters inside one XHTML without including the next heading', async () => {
    const merged = document(
      '<h1 id="one">第一章</h1><h2 id="s1">第一节</h2><h2 id="s2">第二节</h2><p>一章。</p><h1 id="two">第二章</h1><p>二章。</p>',
    );
    const options = await fixture({
      'book/a.xhtml': merged,
      'book/b.xhtml': document(''),
      'book/c.xhtml': document(''),
      'book/toc.ncx': ncx
        .replaceAll('b.xhtml', 'a.xhtml')
        .replaceAll('c.xhtml', 'a.xhtml'),
    });
    const result = await inspectIllustrationChapter(options);
    expect(result.blocks.at(-1)?.text).toBe('一章。');
    expect(result.documents).toHaveLength(1);
    expect(
      (
        await inspectIllustrationChapter({ ...options, chapterIndex: 1 })
      ).blocks.map((block) => block.text),
    ).toEqual(['第二章', '二章。']);
  });

  it('supports EPUB3 toc nav with source-bound heading references', async () => {
    const options = await fixture({
      'book/package.opf':
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata/><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="a"/><itemref idref="b"/><itemref idref="c"/></spine></package>',
      'book/nav.xhtml':
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="a.xhtml#one">第一章</a></li><li><a href="c.xhtml#two">第二章</a></li></ol></nav></body></html>',
    });
    expect((await inspectIllustrationChapter(options)).documents).toHaveLength(
      2,
    );
  });

  it.each([
    [
      'duplicate navigation',
      {
        'book/toc.ncx': ncx.replace(
          '</navMap>',
          '<navPoint id="dup"><navLabel><text>第一章</text></navLabel><content src="a.xhtml#one"/></navPoint></navMap>',
        ),
      },
      'AMBIGUOUS_CHAPTER_NAVIGATION',
    ],
    [
      'missing chapter boundary',
      {
        'book/toc.ncx': ncx.replace(
          '<navPoint id="c2"><navLabel><text>第二章</text></navLabel><content src="c.xhtml#two"/></navPoint>',
          '',
        ),
      },
      'AMBIGUOUS_CHAPTER_NAVIGATION',
    ],
    [
      'nested prose',
      {
        'book/b.xhtml': document(
          '<h2 id="s2">第二节</h2><div><p>不能偷偷遗漏。</p></div>',
        ),
      },
      'UNSUPPORTED_CHAPTER_STRUCTURE',
    ],
    [
      'direct body text',
      {
        'book/b.xhtml': document(
          '<h2 id="s2">第二节</h2>不能遗漏<p>正文。</p>',
        ),
      },
      'UNSUPPORTED_CHAPTER_STRUCTURE',
    ],
    [
      'active content',
      {
        'book/b.xhtml': document(
          '<h2 id="s2">第二节</h2><p onclick="bad()">正文。</p>',
        ),
      },
      'ACTIVE_CONTENT',
    ],
    [
      'remote navigation',
      {
        'book/toc.ncx': ncx.replace(
          'a.xhtml#one',
          'https://example.com/chapter',
        ),
      },
      'REMOTE_RESOURCE',
    ],
  ])(
    'rejects %s rather than claiming complete coverage',
    async (_name, overrides, code) => {
      await expect(
        inspectIllustrationChapter(
          await fixture(overrides as Record<string, string>),
        ),
      ).rejects.toMatchObject({ code });
    },
  );

  it('fails rather than truncating a chapter that exceeds the explicit text bound', async () => {
    const options = await fixture();
    await expect(
      inspectIllustrationChapter({
        ...options,
        limits: { maxChapterTextBytes: 8 },
      }),
    ).rejects.toMatchObject({ code: 'CHAPTER_TEXT_LIMIT' });
    await expect(
      inspectIllustrationChapter({
        ...options,
        limits: { maxChapterBlocks: 2 },
      }),
    ).rejects.toMatchObject({ code: 'CHAPTER_TEXT_LIMIT' });
    await expect(
      inspectIllustrationChapter({ ...options, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not mislabel an anchor before a trailing image as the chapter end', async () => {
    const options = await fixture({
      'book/b.xhtml': document(
        '<h2 id="s2">第二节</h2><p>末段。</p><img src="cover.png" alt=""/>',
      ),
    });
    const result = await inspectIllustrationChapter(options);
    expect(result.covered).toBe('COMPLETE');
    expect(
      result.anchors.every((anchor) => anchor.kind === 'after-paragraph'),
    ).toBe(true);
  });
});

describe('free complete illustration catalog', () => {
  it('retains nested navigation rows and binds selectable IDs to the exact single-chapter contract', async () => {
    const options = await fixture();
    const before = await readFile(options.sourcePath);
    const catalog = await inspectIllustrationCatalog(options);
    expect(
      catalog.chapters.map((chapter) => [
        chapter.title,
        chapter.level,
        chapter.index,
        chapter.selectable,
      ]),
    ).toEqual([
      ['第一章', 0, 0, true],
      ['第一节', 1, -1, false],
      ['第二节', 1, -1, false],
      ['第二章', 0, 1, true],
    ]);
    for (const chapter of catalog.chapters.filter(
      (entry) => entry.selectable,
    )) {
      const single = await inspectIllustrationChapter({
        ...options,
        chapterIndex: chapter.index,
      });
      expect(chapter.id).toBe(single.chapterId);
      expect(chapter.reasonCode).toBeNull();
      expect(catalog.sourceSha256).toBe(single.sourceSha256);
    }
    expect(catalog.chapters[1].reasonCode).toBe('NOT_LOGICAL_CHAPTER');
    expect(catalog).toEqual(await inspectIllustrationCatalog(options));
    expect(await readFile(options.sourcePath)).toEqual(before);
    expect(JSON.stringify(catalog)).not.toContain('同一段');
  });

  it('keeps non-chapter front matter visible without guessing it is a chapter', async () => {
    const options = await fixture({
      'book/toc.ncx': ncx.replace(
        '<navMap>',
        '<navMap><navPoint id="front"><navLabel><text>前言</text></navLabel><content src="a.xhtml#s1"/></navPoint>',
      ),
    });
    const catalog = await inspectIllustrationCatalog(options);
    expect(catalog.chapters[0]).toMatchObject({
      title: '前言',
      index: -1,
      selectable: false,
      reasonCode: 'NOT_LOGICAL_CHAPTER',
    });
    expect(catalog.chapters.filter((entry) => entry.selectable)).toHaveLength(
      2,
    );
  });

  it('shows all ambiguous duplicate rows but does not enable paid processing for any of them', async () => {
    const options = await fixture({
      'book/toc.ncx': ncx.replace(
        '</navMap>',
        '<navPoint id="duplicate"><navLabel><text>第一章</text></navLabel><content src="a.xhtml#one"/></navPoint></navMap>',
      ),
    });
    const catalog = await inspectIllustrationCatalog(options);
    expect(catalog.chapters).toHaveLength(5);
    expect(catalog.chapters.some((entry) => entry.selectable)).toBe(false);
    expect(
      catalog.chapters.filter((entry) => entry.title === '第一章'),
    ).toHaveLength(2);
    expect(catalog.chapters[0].reasonCode).toBe('AMBIGUOUS_CHAPTER_NAVIGATION');
  });

  it('shows unlisted chapter boundaries as disabled instead of silently dropping them', async () => {
    const options = await fixture({
      'book/c.xhtml': document(
        '<h1 id="two">第二章</h1><p>第二章内容。</p><h1 id="three">第三章</h1><p>第三章内容。</p>',
      ),
    });
    const catalog = await inspectIllustrationCatalog(options);
    expect(catalog.chapters.at(-1)).toMatchObject({
      title: '第三章',
      index: -1,
      selectable: false,
      reasonCode: 'AMBIGUOUS_CHAPTER_NAVIGATION',
    });
    expect(catalog.chapters.every((entry) => !entry.selectable)).toBe(true);
  });

  it('disables only the chapter whose complete body cannot be supported', async () => {
    const options = await fixture({
      'book/b.xhtml': document(
        '<h2 id="s2">第二节</h2><div><p>复杂正文不能忽略。</p></div>',
      ),
    });
    const catalog = await inspectIllustrationCatalog(options);
    expect(catalog.chapters[0]).toMatchObject({
      index: 0,
      selectable: false,
      reasonCode: 'UNSUPPORTED_CHAPTER_STRUCTURE',
    });
    expect(catalog.chapters.at(-1)).toMatchObject({
      index: 1,
      selectable: true,
      reasonCode: null,
    });
  });

  it('lists every chapter above an arbitrary UI page size without truncation', async () => {
    const count = 502;
    const chapters = Array.from({ length: count }, (_, index) => ({
      id: `c${index}`,
      title: `第${index + 1}章`,
    }));
    const options = await fixture({
      'book/a.xhtml': document(
        chapters
          .map(
            (entry) =>
              `<h1 id="${entry.id}">${entry.title}</h1><p>短篇正文。</p>`,
          )
          .join(''),
      ),
      'book/b.xhtml': document(''),
      'book/c.xhtml': document(''),
      'book/toc.ncx': `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>${chapters.map((entry) => `<navPoint id="${entry.id}"><navLabel><text>${entry.title}</text></navLabel><content src="a.xhtml#${entry.id}"/></navPoint>`).join('')}</navMap></ncx>`,
    });
    const catalog = await inspectIllustrationCatalog(options);
    expect(catalog.chapters).toHaveLength(count);
    expect(catalog.chapters.every((entry) => entry.selectable)).toBe(true);
    expect(catalog.chapters.at(-1)?.index).toBe(count - 1);
  });
});

describe('real subsection illustration scope', () => {
  it('lists actual section headings, scopes complete text and exact paragraph anchors, leaving chapters as labels', async () => {
    const options = await fixture();
    const catalog = await inspectIllustrationCatalog({
      ...options,
      scope: 'section',
    });
    expect(catalog.parserVersion).toBe('illustration-sections-3');
    const rows = catalog.chapters.filter((row) => row.selectable);
    expect(rows.map((row) => row.title)).toEqual([
      '第一节',
      '第二节',
      '第二章 · 第1节（文档边界）',
    ]);
    expect(
      catalog.chapters.find((row) => row.title === '第一章'),
    ).toMatchObject({ selectable: false, scope: 'chapter' });
    const second = await inspectIllustrationChapter({
      ...options,
      sectionId: rows[1]!.sectionId,
    });
    expect(second).toMatchObject({
      scope: 'section',
      chapterId: rows[1]!.id,
      parentChapterTitle: '第一章',
      covered: 'COMPLETE',
    });
    expect(second.documents.map((document) => document.documentPath)).toEqual([
      'book/b.xhtml',
    ]);
    expect(second.blocks.map((block) => block.text)).toEqual([
      '第二节',
      '第二文件完整内容。',
      '章末。',
    ]);
    expect(
      second.anchors.every((anchor) => anchor.kind === 'after-paragraph'),
    ).toBe(true);
    expect(second.anchors).toHaveLength(2);
    await expect(
      inspectIllustrationChapter({ ...options, sectionId: 'f'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'INVALID_ILLUSTRATION_SECTION' });
  });
  it('keeps two section headings in the same XHTML independent and excludes explicit notes', async () => {
    const options = await fixture({
      'book/a.xhtml': document(
        '<h1 id="one">第一章</h1><h2 id="s1">第一节</h2><p>甲。</p><h2>小节二</h2><p>乙。</p><h2>注释</h2><p role="doc-footnote">不做插画。</p>',
      ),
    });
    const catalog = await inspectIllustrationCatalog({
      ...options,
      scope: 'section',
    });
    expect(
      catalog.chapters.some((row) => row.selectable && row.title === '注释'),
    ).toBe(false);
    const row = catalog.chapters.find(
      (row) => row.selectable && row.title === '小节二',
    )!;
    const index = await inspectIllustrationChapter({
      ...options,
      sectionId: row.sectionId,
    });
    expect(index.blocks.map((block) => block.text)).toEqual(['小节二', '乙。']);
    expect(index.anchors).toHaveLength(1);
  });
});

async function essayFixture(overrides: Record<string, string> = {}) {
  return fixture({
    'book/package.opf':
      '<package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata/><manifest><item id="front" href="front.xhtml" media-type="application/xhtml+xml"/><item id="copyright" href="copyright.xhtml" media-type="application/xhtml+xml"/><item id="intro" href="intro.xhtml" media-type="application/xhtml+xml"/><item id="plate" href="plate.xhtml" media-type="application/xhtml+xml"/><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="front"/><itemref idref="copyright"/><itemref idref="intro"/><itemref idref="plate"/><itemref idref="a"/><itemref idref="b"/><itemref idref="c"/></spine></package>',
    'book/toc.ncx':
      '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="front"><navLabel><text>扉页</text></navLabel><content src="front.xhtml"/></navPoint><navPoint id="toc"><navLabel><text>目录</text></navLabel><content src="front.xhtml"/></navPoint><navPoint id="copyright"><navLabel><text>版权页</text></navLabel><content src="copyright.xhtml"/></navPoint><navPoint id="intro"><navLabel><text>自序</text></navLabel><content src="intro.xhtml"/></navPoint><navPoint id="a"><navLabel><text>思考的乐趣</text></navLabel><content src="a.xhtml"/></navPoint><navPoint id="b"><navLabel><text>生活与艺术</text></navLabel><content src="b.xhtml"/></navPoint><navPoint id="c"><navLabel><text>关于阅读</text></navLabel><content src="c.xhtml"/></navPoint></navMap></ncx>',
    'book/front.xhtml': document(
      '<div>目录</div><div><a href="a.xhtml">思考的乐趣</a></div>',
    ),
    'book/copyright.xhtml': document(
      '<h1 class="kindle-cn-copyright-title">版权信息</h1><p>出版信息。</p>',
    ),
    'book/intro.xhtml': document('<div></div><h1>自序</h1><p>序言正文。</p>'),
    'book/plate.xhtml': document(
      '<div><img src="plate-one.png" alt=""/></div><div><img src="plate-two.png" alt=""/></div>',
    ),
    'book/a.xhtml': document(
      '<div></div><h1 class="kindle-cn-heading-1">思考的乐趣</h1><h3>一</h3><p>第一小节。</p><h3>二</h3><p>第二小节。</p>',
    ),
    'book/b.xhtml': document(
      '<div></div><h1>生活与艺术</h1><p>下一篇正文。</p>',
    ),
    'book/c.xhtml': document('<div></div><h1>关于阅读</h1><p>最后一篇。</p>'),
    ...overrides,
  });
}

describe('source-bound flat essay collection catalog', () => {
  it('enumerates named h1 articles and real h3 subsections, excluding explicit front matter', async () => {
    const options = await essayFixture();
    const before = await readFile(options.sourcePath);
    const catalog = await inspectIllustrationCatalog({
      ...options,
      scope: 'section',
    });
    expect(catalog.parserVersion).toBe('illustration-sections-3');
    expect(
      catalog.chapters.filter((row) => row.selectable).map((row) => row.title),
    ).toEqual(['自序', '一', '二', '生活与艺术', '关于阅读']);
    expect(
      catalog.chapters
        .filter((row) => row.scope === 'chapter')
        .map((row) => row.title),
    ).toEqual(['自序', '思考的乐趣', '生活与艺术', '关于阅读']);
    expect(
      catalog.chapters.some((row) => /扉页|目录|版权/.test(row.title)),
    ).toBe(false);
    const intro = await inspectIllustrationChapter({
      ...options,
      chapterIndex: 0,
    });
    expect(
      intro.documents.some(
        (entry) => entry.documentPath === 'book/plate.xhtml',
      ),
    ).toBe(true);
    expect(intro.blocks.map((block) => block.text)).toEqual([
      '自序',
      '序言正文。',
    ]);
    for (const row of catalog.chapters.filter((entry) => entry.selectable)) {
      const single = await inspectIllustrationChapter({
        ...options,
        chapterIndex: row.index,
        sectionId: row.sectionId,
      });
      expect(single).toMatchObject({
        parserVersion: 'illustration-sections-3',
        sectionId: row.id,
        scope: 'section',
        covered: 'COMPLETE',
      });
      for (const anchor of single.anchors) {
        expect(anchor.kind).toBe('after-paragraph');
        expect(single.blocks.some((block) => block.id === anchor.blockId)).toBe(
          true,
        );
      }
    }
    expect(await readFile(options.sourcePath)).toEqual(before);
    expect(JSON.stringify(catalog)).not.toContain('小节。');
  });

  it.each([
    [
      'mismatched label',
      { 'book/b.xhtml': document('<h1>另外一篇</h1><p>完整正文。</p>') },
    ],
    [
      'unlisted article boundary',
      {
        'book/c.xhtml': document(
          '<h1>关于阅读</h1><p>正文。</p><h1>未列出的文章</h1><p>不能漏掉。</p>',
        ),
      },
    ],
    [
      'reordered article navigation',
      {
        'book/b.xhtml': document('<h1>关于阅读</h1><p>正文。</p>'),
        'book/c.xhtml': document('<h1>生活与艺术</h1><p>正文。</p>'),
      },
    ],
  ] as const)('does not enable ambiguous %s', async (_reason, overrides) => {
    const options = await essayFixture(overrides);
    const catalog = await inspectIllustrationCatalog({
      ...options,
      scope: 'section',
    });
    expect(catalog.chapters.some((row) => row.selectable)).toBe(false);
    await expect(inspectIllustrationChapter(options)).rejects.toMatchObject({
      code: 'AMBIGUOUS_CHAPTER_NAVIGATION',
    });
  });

  it('rejects duplicate article references instead of silently merging them', async () => {
    const options = await essayFixture();
    // Duplicate discovery is covered using a separate small package; front
    // matter duplicates in the realistic fixture above are intentionally inert.
    const duplicate = await fixture({
      'book/a.xhtml': document('<h1 id="one">文章甲</h1><p>完整正文。</p>'),
      'book/b.xhtml': document(''),
      'book/c.xhtml': document(''),
      'book/toc.ncx':
        '<ncx><navMap><navPoint><navLabel><text>文章甲</text></navLabel><content src="a.xhtml#one"/></navPoint><navPoint><navLabel><text>文章甲</text></navLabel><content src="a.xhtml#one"/></navPoint></navMap></ncx>',
    });
    expect(
      (
        await inspectIllustrationCatalog({ ...options, scope: 'section' })
      ).chapters.some((row) => row.selectable),
    ).toBe(true);
    expect(
      (
        await inspectIllustrationCatalog({ ...duplicate, scope: 'section' })
      ).chapters.some((row) => row.selectable),
    ).toBe(false);
  });

  it.each([
    '<div><p>不能跳过嵌套正文。</p></div>',
    '<div>不能跳过直接正文。</div>',
    '<table><tr><td>不能跳过表格。</td></tr></table>',
  ])('keeps nested or substantive body containers protected', async (body) => {
    const options = await essayFixture({
      'book/b.xhtml': document(`<div></div><h1>生活与艺术</h1>${body}`),
    });
    const catalog = await inspectIllustrationCatalog({
      ...options,
      scope: 'section',
    });
    expect(
      catalog.chapters.find((row) => row.title === '生活与艺术'),
    ).toMatchObject({
      selectable: false,
      reasonCode: 'UNSUPPORTED_CHAPTER_STRUCTURE',
    });
    expect(
      catalog.chapters.some(
        (row) => row.selectable && row.parentChapterTitle === '关于阅读',
      ),
    ).toBe(true);
  });

  it('retains legacy numbered subsection IDs and its V2 index contract under the new catalog cache version', async () => {
    const options = await fixture();
    const chapter = await inspectIllustrationChapter(options);
    const catalog = await inspectIllustrationCatalog({
      ...options,
      scope: 'section',
    });
    const row = catalog.chapters.find((entry) => entry.selectable)!;
    const scoped = await inspectIllustrationChapter({
      ...options,
      sectionId: row.sectionId,
    });
    const first = scoped.blocks[0]!,
      last = scoped.blocks.at(-1)!;
    const legacyId = createHash('sha256')
      .update(
        JSON.stringify([
          'illustration-sections-2',
          chapter.sourceSha256,
          chapter.chapterId,
          first.documentPath,
          first.start,
          last.documentPath,
          last.end,
        ]),
      )
      .digest('hex');
    expect(scoped.parserVersion).toBe('illustration-sections-2');
    expect(row.id).toBe(legacyId);
    expect(row.sectionId).toBe(legacyId);
  });
});
