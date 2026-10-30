import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as yazl from 'yazl';
import {
  inspectEpubStructure,
  processEpub,
} from '../src/documents/epub-engine.js';
import { unpackArchive } from '../src/documents/epub-archive.js';
import {
  DEFAULT_EPUB_LIMITS,
  type EpubStructurePlan,
  type EpubStructureRole,
} from '../src/documents/epub.types.js';
import { onlyElement, parseXml } from '../src/documents/epub-xml.js';
import { prepareReaderCss } from '../src/layout/reader-first.js';
import postcss from 'postcss';

const body =
  '<body>\n<h1 id="chapter">第一章 🐬</h1><h2>1. 开始</h2><p>正文必须原样保留：空格、标点、🐬和图片<img src="cover.png" alt="" />都不能丢。</p><p class="poem">这是短行</p>\n</body>';
const chapter = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><head><title>测试</title><link rel="stylesheet" href="book.css" type="text/css" /></head>${body}</html>`;
const css =
  'body { font-size: 14px; line-height: 2; color: black; padding: 2em; } p { text-indent: 2em; } .poem { color: blue; font-size: .85em; }';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cJ1kAAAAASUVORK5CYII=',
  'base64',
);

function fixture(
  overrides: Record<string, string | Buffer> = {},
): Record<string, string | Buffer> {
  return {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml':
      '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml" /></rootfiles></container>',
    'OEBPS/book.opf':
      '<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">test-book</dc:identifier><dc:title>测试书</dc:title><dc:language>zh-CN</dc:language><meta name="cover" content="cover" /></metadata><manifest><item id="c1" href="one.xhtml" media-type="application/xhtml+xml" /><item id="css" href="book.css" media-type="text/css" /><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" /><item id="cover" href="cover.png" media-type="image/png" /></manifest><spine toc="ncx"><itemref idref="c1" /></spine></package>',
    'OEBPS/toc.ncx':
      '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="wrong-id" /></head><docTitle><text>测试书</text></docTitle><navMap><navPoint id="n1" playOrder="3"><navLabel><text>第一章</text></navLabel><content src="one.xhtml#chapter" /></navPoint><navPoint id="n2" playOrder="4"><navLabel><text>重复目录目标</text></navLabel><content src="one.xhtml#chapter" /></navPoint></navMap></ncx>',
    'OEBPS/one.xhtml': chapter,
    'OEBPS/book.css': css,
    'OEBPS/cover.png': png,
    ...overrides,
  };
}

const temporary: string[] = [];
async function setup(entries = fixture()) {
  const root = await mkdtemp(join(tmpdir(), 'epub-engine-test-'));
  temporary.push(root);
  const sourcePath = join(root, 'source.epub');
  const outputDirectory = join(root, 'output');
  const zip = new yazl.ZipFile();
  const done = pipeline(zip.outputStream, createWriteStream(sourcePath));
  for (const [name, content] of Object.entries(entries))
    zip.addBuffer(
      Buffer.isBuffer(content) ? content : Buffer.from(content),
      name,
      { compress: false },
    );
  zip.end();
  await done;
  return { root, sourcePath, outputDirectory };
}
async function outputEntries(
  path: string,
  root: string,
): Promise<Map<string, Buffer>> {
  const scratch = await mkdtemp(join(root, 'unpack-'));
  const entries = await unpackArchive(path, scratch, DEFAULT_EPUB_LIMITS);
  return new Map(
    await Promise.all(
      [...entries].map(
        async ([name, resource]) =>
          [name, await readFile(resource.filePath)] as const,
      ),
    ),
  );
}
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('deterministic EPUB engine', () => {
  it('applies opt-in editorial typography to ordinary publisher prose while preserving source/body/resources and reader controls', async () => {
    const prose =
      '<body><div></div><h1 id="chapter" class="kindle-cn-heading-1">篇名</h1><h3 class="kindle-cn-heading3-c sigil_not_in_toc">一</h3><p>开篇<span class="kindle-cn-italic">强调</span>。</p><p>连续正文。</p><p class="kindle-cn-kai">*发表于某刊。</p><p class="kindle-cn-ref">对白引文。</p><p class="kindle-cn-para-right">作者与日期</p></body>';
    const publisherCss =
      'body{font-size:18px;line-height:2;color:black} h1.kindle-cn-heading-1{font-size:3em!important} p{text-indent:2em} .unused{float:right} :lang(ja){font-family:JapaneseFont;color:orange} .kindle-cn-italic{font-style:italic}';
    const options = await setup(
      fixture({
        'OEBPS/one.xhtml': chapter.replace(body, prose),
        'OEBPS/book.css': publisherCss,
      }),
    );
    const source = await readFile(options.sourcePath);
    const legacy = await processEpub(options);
    expect(legacy.report.summary.styledDocuments).toBe(0);
    const result = await processEpub({
      ...options,
      outputDirectory: join(options.root, 'editorial'),
      typographyProfile: 'editorial-1',
    });
    expect(result.report.summary.styledDocuments).toBe(1);
    expect(result.report.typography).toMatchObject({
      styledParagraphs: 5,
      preservedParagraphs: 0,
      styledHeadings: 2,
      roleCounts: { opening: 1, body: 2, note: 1, quote: 1, poem: 0 },
    });
    const output = await outputEntries(result.outputPath, options.root);
    const doc = parseXml(output.get('OEBPS/one.xhtml')!);
    const exportedBody = onlyElement(doc, 'body');
    expect(doc.source.slice(exportedBody.start, exportedBody.end)).toBe(prose);
    expect(output.get('OEBPS/book.css')!.toString()).toBe(publisherCss);
    expect(output.get('OEBPS/cover.png')).toEqual(png);
    expect(await readFile(options.sourcePath)).toEqual(source);
    const stylePath = result.report.documents[0]!.editorial!.cssPath!;
    const cssSource = output.get(stylePath)!.toString();
    expect(cssSource).toContain('font-style: italic');
    for (const assignment of result.report.documents[0]!.editorial!.assignments.filter(
      (a) => ['body', 'opening'].includes(a.role),
    )) {
      const rule = postcss
        .parse(cssSource)
        .nodes.find(
          (node) =>
            node.type === 'rule' && node.selector === assignment.selector,
        );
      expect(rule?.type).toBe('rule');
      if (rule?.type === 'rule')
        expect(
          rule.nodes
            .filter((node) => node.type === 'decl')
            .map((node) => node.prop),
        ).not.toEqual(expect.arrayContaining(['font-size']));
      if (rule?.type === 'rule')
        expect(
          rule.nodes
            .filter((node) => node.type === 'decl')
            .map((node) => node.prop),
        ).not.toEqual(expect.arrayContaining(['line-height']));
    }
  });

  it('binds the OPF language and single English chapter wrapper to exported CSS and report evidence', async () => {
    const prose =
      '<body class="x-ebookmaker x-ebookmaker-3"><div class="chapter"><h2 id="chapter">Chapter I</h2><p>The opening.</p><p>The following paragraph.</p></div></body>';
    const entries = fixture({
      'OEBPS/one.xhtml': chapter.replace(body, prose),
      'OEBPS/book.css':
        '@media screen { body {margin-left:10%;margin-right:10%} } div.chapter{margin-top:4em} p{text-indent:1em}',
    });
    entries['OEBPS/book.opf'] = (entries['OEBPS/book.opf'] as string).replace(
      'zh-CN',
      'en',
    );
    const options = await setup(entries);
    const result = await processEpub({
      ...options,
      typographyProfile: 'editorial-1',
    });
    expect(result.report.summary.styledDocuments).toBe(1);
    expect(result.report.documents[0]?.editorial?.language).toEqual({
      policy: 'english-prose',
      package: ['en'],
      document: [],
    });
    const output = await outputEntries(result.outputPath, options.root);
    const parsed = parseXml(output.get('OEBPS/one.xhtml')!);
    const exportedBody = onlyElement(parsed, 'body');
    expect(parsed.source.slice(exportedBody.start, exportedBody.end)).toBe(
      prose,
    );
    expect(
      output.get(result.report.documents[0]!.editorial!.cssPath!)!.toString(),
    ).toContain('text-indent: 1.2em');
    expect(
      result.report.warnings.every(
        (warning) => !/[\u3400-\u9fff]/u.test(warning.message),
      ),
    ).toBe(true);
  });

  it.each([
    ['conditional emphasis', ':lang(ja){font-weight:bold}'],
    ['used positioning', 'p{position:absolute}'],
    ['unproven selector', 'p:not(.unknown){display:none}'],
  ])(
    'preserves editorial documents with %s instead of dropping meaningful source styling',
    async (_name, unsafeCss) => {
      const options = await setup(fixture({ 'OEBPS/book.css': unsafeCss }));
      const result = await processEpub({
        ...options,
        typographyProfile: 'editorial-1',
      });
      expect(result.report.summary.styledDocuments).toBe(0);
      expect(result.report.typography?.preservedParagraphs).toBe(2);
      expect(result.report.documents[0]!.reasons.length).toBeGreaterThan(0);
    },
  );

  it('repairs only an unused missing all-X font-face with exact source ranges and hashes, preserving the source/body/images', async () => {
    const face =
      '@font-face { font-family: yinbiao; src: url(XXXXXXXXXXXXXXXX); }';
    const originalCss = `${face}\nspan.unused-pronunciation { font-family: yinbiao; color: orange; }\n${css}`;
    const options = await setup(fixture({ 'OEBPS/book.css': originalCss }));
    const source = await readFile(options.sourcePath);
    const result = await processEpub(options);
    const output = await outputEntries(result.outputPath, options.root);
    expect(output.get('OEBPS/book.css')!.toString('utf8')).toBe(
      originalCss.slice(face.length),
    );
    expect(result.report.sourceRepairs).toEqual({
      policyVersion: 'unused-font-placeholder-1',
      stylesheets: [
        {
          path: 'OEBPS/book.css',
          sourceSha256: createHash('sha256').update(originalCss).digest('hex'),
          outputSha256: createHash('sha256')
            .update(originalCss.slice(face.length))
            .digest('hex'),
          removedFontFaces: [
            {
              family: 'yinbiao',
              reference: 'XXXXXXXXXXXXXXXX',
              sourceStart: 0,
              sourceEnd: face.length,
              removedSha256: createHash('sha256').update(face).digest('hex'),
            },
          ],
        },
      ],
    });
    expect(result.report.warnings).toContainEqual(
      expect.objectContaining({
        code: 'UNUSED_FONT_PLACEHOLDER_REMOVED',
        document: 'OEBPS/book.css',
      }),
    );
    expect(result.report.integrity.originalResourcesPreserved).toBe(false);
    expect(result.report.integrity.bodyBytesPreserved).toBe(true);
    expect(output.get('OEBPS/cover.png')).toEqual(png);
    const exported = parseXml(output.get('OEBPS/one.xhtml')!);
    const exportedBody = onlyElement(exported, 'body');
    expect(exported.source.slice(exportedBody.start, exportedBody.end)).toBe(
      body,
    );
    expect(await readFile(options.sourcePath)).toEqual(source);
    const again = await processEpub({
      ...options,
      sourcePath: result.outputPath,
      outputDirectory: join(options.root, 'again'),
    });
    expect(again.report.sourceRepairs).toBeUndefined();
    expect(again.report.integrity.originalResourcesPreserved).toBe(true);
  });

  it.each([
    ['used class', 'span.poem { font-family: yinbiao; }'],
    ['generic selector', 'p { font-family: yinbiao; }'],
    [
      'uncertain selector',
      'p span.unused-pronunciation { font-family: yinbiao; }',
    ],
    [
      'dynamic attr',
      'body { font-family: attr(data-font type(<custom-ident>)); }',
    ],
    ['dynamic env', 'body { font-family: env(custom-font); }'],
    ['dynamic var', 'body { font-family: var(--custom-font); }'],
    ['custom property', '.unused { --font: yinbiao; }'],
  ])(
    'does not repair an actually used or uncertain %s font consumer',
    async (_name, consumer) => {
      const options = await setup(
        fixture({
          'OEBPS/book.css': `@font-face { font-family: yinbiao; src: url(XXXXXXXXXXXXXXXX); } ${consumer}`,
        }),
      );
      await expect(processEpub(options)).rejects.toMatchObject({
        code: 'MISSING_RESOURCE',
      });
    },
  );

  it('does not omit a stylesheet consumer declared with an unsupported manifest media type from the unused proof', async () => {
    const opf = String(fixture()['OEBPS/book.opf']).replace(
      'id="css" href="book.css" media-type="text/css"',
      'id="css" href="book.css" media-type="text/css"/><item id="other-css" href="other.css" media-type="text/plain"',
    );
    const html = chapter.replace(
      '</head>',
      '<link rel="stylesheet" href="other.css"/></head>',
    );
    const options = await setup(
      fixture({
        'OEBPS/book.opf': opf,
        'OEBPS/one.xhtml': html,
        'OEBPS/book.css':
          '@font-face { font-family: yinbiao; src: url(XXXXXXXXXXXXXXXX); }',
        'OEBPS/other.css': 'body { font-family: yinbiao; }',
      }),
    );
    await expect(processEpub(options)).rejects.toMatchObject({
      code: 'MISSING_RESOURCE',
    });
  });

  it('keeps a missing real font and a missing image fatal instead of treating them as unused placeholders', async () => {
    const font = await setup(
      fixture({
        'OEBPS/book.css':
          '@font-face { font-family: yinbiao; src: url(missing.woff2); }',
      }),
    );
    await expect(processEpub(font)).rejects.toMatchObject({
      code: 'MISSING_RESOURCE',
    });
    const image = await setup(
      fixture({
        'OEBPS/one.xhtml': chapter.replace(
          'src="cover.png"',
          'src="missing.png"',
        ),
      }),
    );
    await expect(processEpub(image)).rejects.toMatchObject({
      code: 'MISSING_RESOURCE',
    });
  });

  it.each(['"cover-image"', "' cover-image '"])(
    'removes only a redundant EPUB 2 cover property %s while preserving the existing cover, source, body, navigation and spine',
    async (propertyValue) => {
      const originalPackage = String(fixture()['OEBPS/book.opf']).replace(
        'id="cover" href=',
        `id="cover" properties=${propertyValue} href=`,
      );
      const options = await setup(
        fixture({ 'OEBPS/book.opf': originalPackage }),
      );
      const sourceBytes = await readFile(options.sourcePath);
      const result = await processEpub(options);
      const output = await outputEntries(result.outputPath, options.root);
      const before = parseXml(Buffer.from(originalPackage));
      const after = parseXml(output.get('OEBPS/book.opf')!);
      const originalCover = before.elements.find(
        (element) => element.local === 'item' && element.attrs.id === 'cover',
      )!;
      const cover = after.elements.find(
        (element) => element.local === 'item' && element.attrs.id === 'cover',
      )!;
      expect(after.source.slice(cover.start, cover.end)).toBe(
        before.source
          .slice(originalCover.start, originalCover.end)
          .replace(` properties=${propertyValue}`, ''),
      );
      for (const local of ['metadata', 'spine']) {
        const original = onlyElement(before, local);
        const exported = onlyElement(after, local);
        expect(after.source.slice(exported.start, exported.end)).toBe(
          before.source.slice(original.start, original.end),
        );
      }
      expect(
        after.elements.some(
          (element) =>
            element.local === 'item' &&
            element.attrs.href === 'epub-ai-reader-first.css',
        ),
      ).toBe(true);
      const exportedChapter = parseXml(output.get('OEBPS/one.xhtml')!);
      const exportedBody = onlyElement(exportedChapter, 'body');
      expect(
        exportedChapter.source.slice(exportedBody.start, exportedBody.end),
      ).toBe(body);
      const targets = (document: ReturnType<typeof parseXml>) =>
        document.elements
          .filter((element) => element.local === 'content')
          .map((element) => element.attrs.src);
      expect(targets(parseXml(output.get('OEBPS/toc.ncx')!))).toEqual(
        targets(parseXml(Buffer.from(String(fixture()['OEBPS/toc.ncx'])))),
      );
      expect(output.get('OEBPS/cover.png')).toEqual(png);
      expect(await readFile(result.cover!.path)).toEqual(png);
      expect(await readFile(options.sourcePath)).toEqual(sourceBytes);
      expect(
        result.report.warnings.filter(
          (warning) => warning.code === 'OPF_EPUB2_COVER_PROPERTY_REPAIRED',
        ),
      ).toEqual([expect.objectContaining({ document: 'OEBPS/book.opf' })]);
    },
  );

  it.each([
    'epub3',
    'missing-cover-meta',
    'conflicting-cover-meta',
    'duplicate-cover-meta',
    'unknown-property-token',
    'duplicate-cover-property-token',
    'multiple-cover-items',
    'namespaced-property',
    'namespaced-cover-meta',
    'namespaced-version',
    'non-raster-media-type',
  ])(
    'leaves ambiguous or unsupported %s cover properties for the format gate',
    async (mutation) => {
      let originalPackage = String(fixture()['OEBPS/book.opf']).replace(
        'id="cover" href=',
        'id="cover" properties="cover-image" href=',
      );
      if (mutation === 'epub3')
        originalPackage = originalPackage.replace(
          'version="2.0"',
          'version="3.0"',
        );
      if (mutation === 'missing-cover-meta')
        originalPackage = originalPackage.replace(
          '<meta name="cover" content="cover" />',
          '',
        );
      if (mutation === 'conflicting-cover-meta')
        originalPackage = originalPackage.replace(
          '<meta name="cover" content="cover" />',
          '<meta name="cover" content="c1" />',
        );
      if (mutation === 'duplicate-cover-meta')
        originalPackage = originalPackage.replace(
          '<meta name="cover" content="cover" />',
          '<meta name="cover" content="cover" /><meta name="cover" content="c1" />',
        );
      if (mutation === 'unknown-property-token')
        originalPackage = originalPackage.replace(
          'properties="cover-image"',
          'properties="cover-image unknown"',
        );
      if (mutation === 'duplicate-cover-property-token')
        originalPackage = originalPackage.replace(
          'properties="cover-image"',
          'properties="cover-image cover-image"',
        );
      if (mutation === 'multiple-cover-items')
        originalPackage = originalPackage.replace(
          '</manifest>',
          '<item id="other-cover" href="other.png" media-type="image/png" properties="cover-image" /></manifest>',
        );
      if (mutation === 'namespaced-property')
        originalPackage = originalPackage.replace(
          'properties="cover-image"',
          'xmlns:test="urn:test" test:properties="cover-image"',
        );
      if (mutation === 'namespaced-cover-meta')
        originalPackage = originalPackage.replace(
          '<meta name="cover"',
          '<meta xmlns:test="urn:test" test:name="cover"',
        );
      if (mutation === 'namespaced-version')
        originalPackage = originalPackage.replace(
          'version="2.0"',
          'xmlns:test="urn:test" test:version="2.0"',
        );
      if (mutation === 'non-raster-media-type')
        originalPackage = originalPackage.replace(
          'href="cover.png" media-type="image/png"',
          'href="cover.png" media-type="application/octet-stream"',
        );
      const options = await setup(
        fixture({
          'OEBPS/book.opf': originalPackage,
          ...(mutation === 'multiple-cover-items'
            ? { 'OEBPS/other.png': png }
            : {}),
        }),
      );
      const result = await processEpub(options);
      const output = await outputEntries(result.outputPath, options.root);
      const before = parseXml(Buffer.from(originalPackage));
      const after = parseXml(output.get('OEBPS/book.opf')!);
      for (const original of before.elements.filter(
        (element) => element.local === 'item',
      )) {
        const exported = after.elements.find(
          (element) =>
            element.local === 'item' && element.attrs.id === original.attrs.id,
        )!;
        expect(after.source.slice(exported.start, exported.end)).toBe(
          before.source.slice(original.start, original.end),
        );
      }
      expect(
        result.report.warnings.some(
          (warning) => warning.code === 'OPF_EPUB2_COVER_PROPERTY_REPAIRED',
        ),
      ).toBe(false);
    },
  );

  it('applies validated quote, caption and section-title recipes to exact top-level paragraphs without changing body bytes', async () => {
    const structureBody =
      '<body>\n<h1 id="chapter">第一章</h1><!-- comment is not an nth-child --><p class="mystery">小节标题</p><p>他说：<em>读书是一场旅行。</em></p><img src="cover.png" alt=""/><p class="unknown">图一：旅行起点</p><p>普通正文保持不变。</p>\n</body>';
    const options = await setup(
      fixture({ 'OEBPS/one.xhtml': chapter.replace(body, structureBody) }),
    );
    const sourceBytes = await readFile(options.sourcePath);
    const snapshot = await inspectEpubStructure(options);
    expect(snapshot).toEqual(await inspectEpubStructure(options));
    expect(snapshot.sourceSha256).toBe(
      createHash('sha256').update(sourceBytes).digest('hex'),
    );
    expect(snapshot.blocks.map((block) => block.position.childIndex)).toEqual([
      2, 3, 5, 6,
    ]);
    expect(snapshot.blocks[1].excerpt).toBe('他说：读书是一场旅行。');
    const roles: EpubStructureRole[] = [
      'section-title',
      'quote',
      'caption',
      'body',
    ];
    const structurePlan: EpubStructurePlan = {
      schemaVersion: 1,
      sourceSha256: snapshot.sourceSha256,
      snapshotFingerprint: snapshot.fingerprint,
      roles: snapshot.blocks.map((block, index) => ({
        id: block.id,
        role: roles[index],
      })),
    };
    const result = await processEpub({ ...options, structurePlan });
    expect(result.report.structure).toMatchObject({
      planned: true,
      sampledBlocks: 4,
      appliedBlocks: 4,
      preservedBlocks: 0,
      roleCounts: {
        body: 1,
        quote: 1,
        poem: 0,
        caption: 1,
        'section-title': 1,
      },
    });
    const output = await outputEntries(result.outputPath, options.root);
    const newChapter = parseXml(output.get('OEBPS/one.xhtml')!);
    const newBody = onlyElement(newChapter, 'body');
    expect(newChapter.source.slice(newBody.start, newBody.end)).toBe(
      structureBody,
    );
    const generated = [...output]
      .find(([path]) => /epub-ai-structure-[\da-f]{12}\.css$/.test(path))![1]
      .toString();
    expect(generated).toContain('body > p:nth-child(2)');
    expect(generated).toContain('body > p:nth-child(3)');
    expect(generated).toContain('body > p:nth-child(5)');
    expect(generated).toContain('page-break-after: avoid');
    expect(generated).toContain('margin-left: 1em');
    expect(generated).toContain('font-size: 0.85em');
    expect(newChapter.source).toContain('epub-ai-structure-');
    expect(output.get('OEBPS/book.css')!.toString()).toBe(css);
    expect(output.get('OEBPS/cover.png')).toEqual(png);
    expect(await readFile(options.sourcePath)).toEqual(sourceBytes);
  });

  it('lets a validated structure plan classify plain paragraphs while preserving complex chapters', async () => {
    const plainBody =
      '<body><p id="chapter" class="unknown">章节标题</p><p class="unknown">“这是引文。”</p></body>';
    const options = await setup(
      fixture({ 'OEBPS/one.xhtml': chapter.replace(body, plainBody) }),
    );
    const snapshot = await inspectEpubStructure(options);
    const result = await processEpub({
      ...options,
      structurePlan: {
        schemaVersion: 1,
        sourceSha256: snapshot.sourceSha256,
        snapshotFingerprint: snapshot.fingerprint,
        roles: snapshot.blocks.map((block, index) => ({
          id: block.id,
          role: index === 0 ? 'section-title' : 'quote',
        })),
      },
    });
    expect(result.report.summary.styledChapters).toBe(1);
    expect(result.report.structure.appliedBlocks).toBe(2);
    const complexOptions = await setup(
      fixture({
        'OEBPS/book.css': css + '@media (width:600px){ p { color:red } }',
      }),
    );
    const complexSnapshot = await inspectEpubStructure(complexOptions);
    expect(complexSnapshot.blocks).toEqual([]);
    const complexResult = await processEpub({
      ...complexOptions,
      structurePlan: {
        schemaVersion: 1,
        sourceSha256: complexSnapshot.sourceSha256,
        snapshotFingerprint: complexSnapshot.fingerprint,
        roles: [],
      },
    });
    expect(complexResult.report.structure.appliedBlocks).toBe(0);
    expect(complexResult.report.summary.preservedChapters).toBe(1);
  });

  it('bounds samples by block count, Unicode codepoints and total UTF-8 bytes', async () => {
    const longBody = `<body><h1 id="chapter">第一章</h1>${Array.from({ length: 50 }, (_, index) => `<p class="unknown">${index}${'🐬'.repeat(300)}</p>`).join('')}</body>`;
    const options = await setup(
      fixture({ 'OEBPS/one.xhtml': chapter.replace(body, longBody) }),
    );
    const snapshot = await inspectEpubStructure(options);
    expect(snapshot.blocks.length).toBeLessThanOrEqual(32);
    expect(
      snapshot.blocks.every(
        (block) =>
          Array.from(block.excerpt).length <= 240 &&
          !block.excerpt.includes('\ufffd'),
      ),
    ).toBe(true);
    expect(
      snapshot.blocks.reduce(
        (sum, block) => sum + Buffer.byteLength(block.excerpt),
        0,
      ),
    ).toBeLessThanOrEqual(16 * 1024);
    expect(snapshot.truncated).toBe(true);
    for (const block of snapshot.blocks) {
      const source = chapter
        .replace(body, longBody)
        .slice(block.position.start, block.position.end);
      expect(createHash('sha256').update(source).digest('hex')).toBe(
        block.contentSha256,
      );
    }
  });

  it.each([
    'source',
    'fingerprint',
    'missing',
    'duplicate',
    'unknown',
    'role',
    'css',
    'path',
    'extra-assignment',
  ])(
    'rejects a %s structure-plan mismatch without publishing outputs',
    async (mutation) => {
      const options = await setup(
        fixture({
          'OEBPS/one.xhtml': chapter.replace(
            '</body>',
            '<p>第二个候选。</p></body>',
          ),
        }),
      );
      const snapshot = await inspectEpubStructure(options);
      const plan: EpubStructurePlan & { css?: string; path?: string } = {
        schemaVersion: 1,
        sourceSha256: snapshot.sourceSha256,
        snapshotFingerprint: snapshot.fingerprint,
        roles: snapshot.blocks.map((block) => ({ id: block.id, role: 'poem' })),
      };
      if (mutation === 'source') plan.sourceSha256 = '0'.repeat(64);
      if (mutation === 'fingerprint') plan.snapshotFingerprint = '0'.repeat(64);
      if (mutation === 'missing') plan.roles = [];
      if (mutation === 'duplicate') plan.roles[1] = plan.roles[0];
      if (mutation === 'unknown') plan.roles[0].id = 'unknown-id';
      if (mutation === 'role')
        plan.roles[0].role = 'javascript' as EpubStructureRole;
      if (mutation === 'css') plan.css = 'body{display:none}';
      if (mutation === 'path') plan.path = '../escape';
      if (mutation === 'extra-assignment')
        Object.assign(plan.roles[0], { css: 'display:none' });
      await expect(
        processEpub({ ...options, structurePlan: plan }),
      ).rejects.toMatchObject({ code: 'INVALID_STRUCTURE_PLAN' });
      expect(await readdir(options.outputDirectory)).toEqual([]);
    },
  );

  it('splits mixed ordinary/special selectors without changing special paragraph declarations', () => {
    const result = prepareReaderCss(
      'body, p.poem { line-height: 2; color: red; } p, p.block { font-size: 18px; }',
    );
    expect(result.complex).toBe(false);
    const parsed = postcss.parse(result.css);
    const rules: string[] = [];
    parsed.walkRules((rule) => {
      rules.push(rule.selector);
    });
    expect(rules).toEqual(['p.poem', 'p.block']);
    expect(result.css).toContain('line-height: 2');
    expect(result.css).toContain('font-size: 18px');
  });

  it('preserves UTF-8 astral characters before and inside the body using exact offsets', async () => {
    const options = await setup(
      fixture({
        'OEBPS/one.xhtml': chapter.replace(
          '<title>测试</title>',
          '<title>🐬测试𠮷</title>',
        ),
      }),
    );
    const result = await processEpub(options);
    const output = await outputEntries(result.outputPath, options.root);
    const parsed = parseXml(output.get('OEBPS/one.xhtml')!);
    const bodyElement = onlyElement(parsed, 'body');
    expect(parsed.source.slice(bodyElement.start, bodyElement.end)).toBe(body);
  });

  it('audits style CDATA, encoded traversal and resources missing from the manifest', async () => {
    const cdata = await setup(
      fixture({
        'OEBPS/one.xhtml': chapter.replace(
          '</head>',
          '<style><![CDATA[p{background-image:url(http://127.0.0.1/private)}]]></style></head>',
        ),
      }),
    );
    await expect(processEpub(cdata)).rejects.toMatchObject({
      code: 'REMOTE_RESOURCE',
    });
    const traversal = await setup(
      fixture({
        'OEBPS/one.xhtml': chapter.replace(
          'src="cover.png"',
          'src="%2e%2e/%2e%2e/private"',
        ),
      }),
    );
    await expect(processEpub(traversal)).rejects.toMatchObject({
      code: 'UNSAFE_ARCHIVE_PATH',
    });
    const unlisted = await setup(
      fixture({
        'OEBPS/one.xhtml': chapter.replace(
          'src="cover.png"',
          'src="extra.png"',
        ),
        'OEBPS/extra.png': png,
      }),
    );
    await expect(processEpub(unlisted)).rejects.toMatchObject({
      code: 'UNMANIFESTED_RESOURCE',
    });
  });

  it('produces identical archive bytes on repeated runs and accepts its own exported EPUB conservatively', async () => {
    const options = await setup();
    const first = await processEpub(options);
    const second = await processEpub({
      ...options,
      outputDirectory: join(options.root, 'second'),
    });
    expect(first.report.outputSha256).toBe(second.report.outputSha256);
    const repeated = await processEpub({
      sourcePath: first.outputPath,
      outputDirectory: join(options.root, 'reprocessed'),
    });
    expect(repeated.report.integrity.bodyBytesPreserved).toBe(true);
  });

  it('only normalizes legacy encoding within CSS comments and rejects unknown encoding in values', async () => {
    const legacyComments = await setup(
      fixture({
        'OEBPS/book.css': Buffer.concat([
          Buffer.from(css + '/* '),
          Buffer.from([0xb0, 0xb1]),
          Buffer.from(' */'),
        ]),
      }),
    );
    const result = await processEpub(legacyComments);
    expect(result.report.summary.styledChapters).toBe(1);
    expect(
      result.report.warnings.some(
        (warning) => warning.code === 'CSS_COMMENT_ENCODING_NORMALIZED',
      ),
    ).toBe(true);
    const legacyValues = await setup(
      fixture({
        'OEBPS/book.css': Buffer.concat([
          Buffer.from('body { font-family: "'),
          Buffer.from([0xb0, 0xb1]),
          Buffer.from('"; }'),
        ]),
      }),
    );
    await expect(processEpub(legacyValues)).rejects.toMatchObject({
      code: 'UNSUPPORTED_ENCODING',
    });
  });

  it('cleans its private scratch data when aborted and never overwrites prior published outputs', async () => {
    const options = await setup();
    await expect(
      processEpub({ ...options, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'PROCESSING_CANCELLED' });
    expect(await readdir(options.outputDirectory)).toEqual([]);
    const original = await processEpub(options);
    const bytes = await readFile(original.outputPath);
    await expect(processEpub(options)).rejects.toMatchObject({
      code: 'PROCESSING_FAILED',
    });
    expect(await readFile(original.outputPath)).toEqual(bytes);
  });

  it('styles semantic prose while preserving original body bytes, original CSS, images and source', async () => {
    const options = await setup();
    const original = await readFile(options.sourcePath);
    const result = await processEpub(options);
    expect(result.report.summary).toMatchObject({
      title: '测试书',
      chapters: 1,
      styledChapters: 1,
      bodyBytesPreserved: true,
    });
    expect(result.report.validation.epubcheck).toBe('not-run');
    expect(result.report.sourceSha256).toBe(
      createHash('sha256').update(original).digest('hex'),
    );
    expect(await readFile(options.sourcePath)).toEqual(original);
    expect(result.cover?.mediaType).toBe('image/png');
    expect(await readFile(result.cover!.path)).toEqual(png);
    const output = await outputEntries(result.outputPath, options.root);
    const newChapter = parseXml(output.get('OEBPS/one.xhtml')!);
    const newBody = onlyElement(newChapter, 'body');
    expect(newChapter.source.slice(newBody.start, newBody.end)).toBe(body);
    expect(output.get('OEBPS/book.css')!.toString()).toBe(css);
    expect(output.get('OEBPS/cover.png')).toEqual(png);
    expect(newChapter.source).toContain('XHTML 1.1');
    expect(newChapter.source).toContain('epub-ai-reader-first.css');
    const clonedCss = [...output]
      .find(([name]) => /epub-ai-[\da-f]{12}\.css$/.test(name))![1]
      .toString();
    expect(clonedCss).not.toContain('line-height: 2');
    expect(clonedCss).toContain('.poem');
    expect(clonedCss).toContain('color: blue');
    const ncx = parseXml(output.get('OEBPS/toc.ncx')!);
    expect(
      ncx.elements.find((element) => element.local === 'meta')?.attrs.content,
    ).toBe('test-book');
    expect(
      ncx.elements
        .filter((element) => element.local === 'navPoint')
        .map((element) => element.attrs.playOrder),
    ).toEqual(['1', '1']);
    expect(
      JSON.parse(await readFile(result.reportPath, 'utf8')).integrity
        .bodyBytesPreserved,
    ).toBe(true);
    expect(await readdir(options.outputDirectory)).toEqual(
      expect.arrayContaining(['output.epub', 'report.json', 'cover.png']),
    );
    expect(
      (await readdir(options.outputDirectory)).some((name) =>
        name.startsWith('.epub-work'),
      ),
    ).toBe(false);
  });

  it('preserves complex CSS and inline formatting instead of imposing a theme', async () => {
    const options = await setup(
      fixture({
        'OEBPS/book.css': css + '@media (width: 600px) { p { color: red } }',
      }),
    );
    const result = await processEpub(options);
    expect(result.report.summary.preservedChapters).toBe(1);
    expect(result.report.documents[0].reasons).toContain('COMPLEX_CSS');
    const output = await outputEntries(result.outputPath, options.root);
    expect(output.has('OEBPS/epub-ai-reader-first.css')).toBe(false);
    expect(output.get('OEBPS/one.xhtml')!.toString()).toContain(
      'href="book.css"',
    );
  });

  it.each([
    [
      'script',
      chapter.replace('<p>', '<script>alert(1)</script><p>'),
      'ACTIVE_CONTENT',
    ],
    [
      'event',
      chapter.replace('<body>', '<body onload="alert(1)">'),
      'ACTIVE_CONTENT',
    ],
    [
      'entity',
      chapter.replace(
        '<!DOCTYPE html PUBLIC',
        '<!ENTITY evil SYSTEM "file:///etc/passwd"><!DOCTYPE html PUBLIC',
      ),
      'XML_ENTITY_FORBIDDEN',
    ],
    [
      'remote image',
      chapter.replace('src="cover.png"', 'src="http://127.0.0.1/private"'),
      'REMOTE_RESOURCE',
    ],
    [
      'missing image',
      chapter.replace('src="cover.png"', 'src="missing.png"'),
      'MISSING_RESOURCE',
    ],
    [
      'invalid fragment',
      chapter.replace('<p>', '<a href="#missing">引用</a><p>'),
      'BROKEN_REFERENCE',
    ],
  ])(
    'rejects %s safely without publishing partial outputs',
    async (_name, document, code) => {
      const options = await setup(fixture({ 'OEBPS/one.xhtml': document }));
      await expect(processEpub(options)).rejects.toMatchObject({ code });
      expect(await readdir(options.outputDirectory)).toEqual([]);
    },
  );

  it('enforces entry, expansion and per-document limits', async () => {
    const options = await setup();
    await expect(
      processEpub({ ...options, limits: { maxEntries: 2 } }),
    ).rejects.toMatchObject({ code: 'ARCHIVE_LIMIT' });
    await expect(
      processEpub({ ...options, limits: { maxExpandedBytes: 100 } }),
    ).rejects.toMatchObject({ code: 'ARCHIVE_LIMIT' });
    await expect(
      processEpub({ ...options, limits: { maxXmlBytes: 100 } }),
    ).rejects.toMatchObject({ code: 'DOCUMENT_SIZE_LIMIT' });
  });

  it('rejects canonical duplicate paths and ZIP corruption', async () => {
    const duplicate = await setup(fixture({ 'OEBPS/BOOK.CSS': 'duplicate' }));
    await expect(processEpub(duplicate)).rejects.toMatchObject({
      code: 'UNSAFE_ARCHIVE_PATH',
    });
    const corrupt = await setup();
    const bytes = await readFile(corrupt.sourcePath);
    const location = bytes.indexOf(Buffer.from('test-book'));
    bytes[location] ^= 1;
    await writeFile(corrupt.sourcePath, bytes);
    await expect(processEpub(corrupt)).rejects.toMatchObject({
      code: 'ARCHIVE_INTEGRITY',
    });
  });

  it('rejects traversal and symlink entries', async () => {
    const traversal = await setup(fixture({ 'bad/x': 'unsafe' }));
    const bytes = await readFile(traversal.sourcePath);
    await writeFile(
      traversal.sourcePath,
      Buffer.from(
        bytes.toString('latin1').replaceAll('bad/x', '../xx'),
        'latin1',
      ),
    );
    await expect(processEpub(traversal)).rejects.toMatchObject({
      code: 'INVALID_ARCHIVE',
    });
    const symlink = await setup();
    const linkZip = new yazl.ZipFile();
    const done = pipeline(
      linkZip.outputStream,
      createWriteStream(symlink.sourcePath),
    );
    linkZip.addBuffer(Buffer.from('/outside'), 'link', { mode: 0o120777 });
    linkZip.end();
    await done;
    await expect(processEpub(symlink)).rejects.toMatchObject({
      code: 'UNSAFE_ARCHIVE_PATH',
    });
  });

  it('rejects DRM and fixed layout packages', async () => {
    const drm = await setup(
      fixture({ 'META-INF/encryption.xml': '<encryption />' }),
    );
    await expect(processEpub(drm)).rejects.toMatchObject({
      code: 'ENCRYPTED_EPUB',
    });
    const entries = fixture();
    entries['OEBPS/book.opf'] = String(entries['OEBPS/book.opf']).replace(
      '</metadata>',
      '<meta property="rendition:layout">pre-paginated</meta></metadata>',
    );
    const fixed = await setup(entries);
    await expect(processEpub(fixed)).rejects.toMatchObject({
      code: 'FIXED_LAYOUT_EPUB',
    });
  });
});
