import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import * as yazl from 'yazl';
import { hashFile, unpackArchive } from '../src/documents/epub-archive.js';
import {
  insertEpubIllustration,
  insertEpubIllustrations,
  type IllustrationLayout,
} from '../src/documents/illustrated-epub.js';
import { DEFAULT_EPUB_LIMITS } from '../src/documents/epub.types.js';
import { processEpub } from '../src/documents/epub-engine.js';
import { onlyElement, parseXml } from '../src/documents/epub-xml.js';

const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const paragraph = '<p id="anchor">末段🐬，<em>原文</em>与标点保留。</p>';
const originalBody = `<body><h1 id="chapter">章名</h1>${paragraph}<p>下一段。</p></body>`;
const originalChapter = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><head><title>测试</title><link rel="stylesheet" href="book.css" type="text/css" /></head>${originalBody}</html>`;
const temporary: string[] = [];

async function setup(overrides: Record<string, string | Buffer> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'epub-illustration-test-'));
  temporary.push(root);
  const png = await sharp({
    create: { width: 8, height: 6, channels: 3, background: '#cab' },
  })
    .png()
    .toBuffer();
  const entries = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml':
      '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml" /></rootfiles></container>',
    'OEBPS/book.opf':
      '<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">test</dc:identifier><dc:title>测试</dc:title><dc:language>zh-CN</dc:language></metadata><manifest><item id="c1" href="one.xhtml" media-type="application/xhtml+xml" /><item id="css" href="book.css" media-type="text/css" /><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" /><item id="cover" href="cover.png" media-type="image/png" /></manifest><spine toc="ncx"><itemref idref="c1" /></spine></package>',
    'OEBPS/toc.ncx':
      '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="test" /></head><docTitle><text>测试</text></docTitle><navMap><navPoint id="n1" playOrder="1"><navLabel><text>章名</text></navLabel><content src="one.xhtml#chapter" /></navPoint></navMap></ncx>',
    'OEBPS/one.xhtml': originalChapter,
    'OEBPS/book.css': 'p {text-indent:2em} body {line-height:2}',
    'OEBPS/cover.png': png,
    ...overrides,
  };
  const sourcePath = join(root, 'source.epub');
  const imagePath = join(root, 'image.png');
  await writeFile(imagePath, png);
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
  const sourceStart = originalChapter.indexOf(paragraph);
  return {
    root,
    png,
    entries,
    options: {
      sourcePath,
      sourceSha256: await hashFile(sourcePath),
      outputDirectory: join(root, 'result'),
      anchor: {
        documentPath: 'OEBPS/one.xhtml',
        sourceStart,
        sourceEnd: sourceStart + paragraph.length,
        contentSha256: hash(paragraph),
      },
      image: { path: imagePath, sha256: hash(png) },
      alt: '人物与空间 & 光线 "示意" <图>',
    },
  };
}

async function entriesOf(path: string, root: string) {
  const scratch = await mkdtemp(join(root, 'read-'));
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

it('audits the exact unused font-placeholder repair again during assembly and reports changed CSS honestly', async () => {
  const face = '@font-face {font-family: yinbiao; src:url(XXXXXXXXXXXXXXXX);}';
  const originalCss = `${face}\nspan.unused-font {font-family:yinbiao} p {text-indent:2em}`;
  const f = await setup({ 'OEBPS/book.css': originalCss });
  const sourceBytes = await readFile(f.options.sourcePath);
  const result = await insertEpubIllustration(f.options);
  const output = await entriesOf(result.outputPath, f.root);
  expect(output.get('OEBPS/book.css')!.toString('utf8')).toBe(
    originalCss.slice(face.length),
  );
  expect(result.report.phases.baseline.sourceRepairs).toMatchObject({
    policyVersion: 'unused-font-placeholder-1',
    stylesheets: [
      {
        path: 'OEBPS/book.css',
        sourceSha256: hash(originalCss),
        outputSha256: hash(originalCss.slice(face.length)),
      },
    ],
  });
  expect(result.report.phases.baseline.originalResourcesPreserved).toBe(false);
  expect(result.report.integrity.originalImagesPreserved).toBe(true);
  expect(output.get('OEBPS/cover.png')).toEqual(f.png);
  expect(await readFile(f.options.sourcePath)).toEqual(sourceBytes);
});

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('source-bound single-image EPUB insertion', () => {
  it('inserts exactly one wrapper after the Unicode source paragraph and preserves every original source fragment', async () => {
    const { options, entries, root, png } = await setup();
    const sourceBytes = await readFile(options.sourcePath);
    const result = await insertEpubIllustration(options);
    const output = await entriesOf(result.outputPath, root);
    const document = parseXml(output.get('OEBPS/one.xhtml')!);
    const body = onlyElement(document, 'body');
    const inserted = document.elements.find(
      (element) => element.attrs.class === 'epub-ai-chapter-illustration',
    )!;
    const actualBody = document.source.slice(body.start, body.end);
    expect(
      actualBody.replace(
        document.source.slice(inserted.start - 1, inserted.end + 1),
        '',
      ),
    ).toBe(originalBody);
    expect(
      document.source.slice(
        inserted.start - paragraph.length - 1,
        inserted.start - 1,
      ),
    ).toBe(paragraph);
    expect(
      document.elements.filter((element) => element.local === 'img'),
    ).toHaveLength(1);
    expect(
      document.elements.find((element) => element.local === 'img')!.attrs.alt,
    ).toBe(options.alt);
    expect(output.get(result.report.illustration.imagePath)).toEqual(png);
    expect(output.get('OEBPS/cover.png')).toEqual(entries['OEBPS/cover.png']);
    expect(output.get('OEBPS/toc.ncx')!.toString()).toBe(
      entries['OEBPS/toc.ncx'],
    );
    expect(document.ids).toEqual(new Set(['chapter', 'anchor']));
    expect(await readFile(options.sourcePath)).toEqual(sourceBytes);
    expect(result.report.integrity.bodyBytesPreserved).toBe(false);
    expect(result.report.integrity.exactAllowlistedInsertion).toBe(true);
    expect(result.report.outputSha256).toBe(await hashFile(result.outputPath));
    const style = output.get('OEBPS/epub-ai-illustrations.css')!.toString();
    expect(style).not.toContain('nth-child');
    expect(style).toContain('height: auto');
    expect(JSON.stringify(result.report)).not.toContain('末段');
    expect(result.report.illustration).not.toHaveProperty('layout');
    expect(style).not.toContain('epub-ai-illustration-compact');
  });

  it.each(['source', 'paragraph', 'image'] as const)(
    'refuses a stale %s hash without publishing a book',
    async (kind) => {
      const { options } = await setup();
      if (kind === 'source') options.sourceSha256 = '0'.repeat(64);
      if (kind === 'paragraph') options.anchor.contentSha256 = '0'.repeat(64);
      if (kind === 'image') options.image.sha256 = '0'.repeat(64);
      await expect(insertEpubIllustration(options)).rejects.toThrow();
      expect(await readdir(options.outputDirectory)).toEqual([]);
    },
  );

  it('rejects a partial or nested paragraph anchor even when its substring hash matches', async () => {
    const { options } = await setup();
    options.anchor.sourceStart++;
    options.anchor.contentSha256 = hash(paragraph.slice(1));
    await expect(insertEpubIllustration(options)).rejects.toMatchObject({
      code: 'INVALID_ILLUSTRATION_ANCHOR',
    });
  });

  it.each([
    'body > p:nth-child(2){color:red}',
    '/* epub-ai validated structure roles */ p{color:red}',
  ])(
    'rejects positional paragraph styling before a new body child changes selectors',
    async (css) => {
      const { options } = await setup({ 'OEBPS/book.css': css });
      await expect(insertEpubIllustration(options)).rejects.toMatchObject({
        code: 'POSITIONAL_ROLE_CSS',
      });
    },
  );

  it('rejects unsafe archive anchor paths and XML control characters in alternative text', async () => {
    const { options } = await setup();
    await expect(
      insertEpubIllustration({
        ...options,
        anchor: { ...options.anchor, documentPath: '../secret' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ILLUSTRATION_ANCHOR' });
    await expect(
      insertEpubIllustration({ ...options, alt: '\u0000' }),
    ).rejects.toMatchObject({ code: 'INVALID_ILLUSTRATION_ALT' });
  });

  it('rebuilds fragment references and rejects a broken original target', async () => {
    const { options } = await setup({
      'OEBPS/one.xhtml': originalChapter.replace(
        '</body>',
        '<p><a href="#missing">链接</a></p></body>',
      ),
    });
    await expect(insertEpubIllustration(options)).rejects.toMatchObject({
      code: 'BROKEN_REFERENCE',
    });
  });

  it('never overwrites an existing published output', async () => {
    const { options } = await setup();
    const first = await insertEpubIllustration(options);
    const original = await readFile(first.outputPath);
    await expect(insertEpubIllustration(options)).rejects.toThrow();
    expect(await readFile(first.outputPath)).toEqual(original);
  });

  it('fully decodes the PNG rather than trusting a supplied hash or filename', async () => {
    const { options } = await setup();
    const invalid = Buffer.from('not a PNG');
    await writeFile(options.image.path, invalid);
    options.image.sha256 = hash(invalid);
    await expect(insertEpubIllustration(options)).rejects.toMatchObject({
      code: 'IMAGE_ASSET_REJECTED',
    });
    expect(await readdir(options.outputDirectory)).toEqual([]);
  });

  it('rejects positional CSS even when the manifest style has a non-CSS extension', async () => {
    const source = await setup();
    const { options } = await setup({
      'OEBPS/book.opf': source.entries['OEBPS/book.opf'].replace(
        'href="book.css"',
        'href="style.dat"',
      ),
      'OEBPS/style.dat': 'p:nth-of-type(2){color:red}',
    });
    await expect(insertEpubIllustration(options)).rejects.toMatchObject({
      code: 'POSITIONAL_ROLE_CSS',
    });
  });
});

describe('single-assembly source-bound multi-image EPUB insertion', () => {
  it('places three registered sizes after their matching paragraphs in one document without changing original text or navigation', async () => {
    const paragraphs = [paragraph, '<p>下一段。</p>', '<p>最后一段。</p>'];
    const sourceBody = originalBody.replace(
      '</body>',
      `${paragraphs[2]}</body>`,
    );
    const sourceDocument = originalChapter.replace(originalBody, sourceBody);
    const { options, entries, root, png } = await setup({
      'OEBPS/one.xhtml': sourceDocument,
    });
    const layouts: IllustrationLayout[] = [
      { size: 'compact', alignment: 'center' },
      { size: 'medium', alignment: 'center' },
      { size: 'wide', alignment: 'center' },
    ];
    const result = await insertEpubIllustrations({
      ...options,
      insertions: paragraphs.map((content, index) => {
        const start = sourceDocument.indexOf(content);
        return {
          anchor: {
            documentPath: options.anchor.documentPath,
            sourceStart: start,
            sourceEnd: start + content.length,
            contentSha256: hash(content),
          },
          image: options.image,
          alt: `段落插画 ${index + 1}`,
          layout: layouts[index],
        };
      }),
    });
    const output = await entriesOf(result.outputPath, root);
    const document = parseXml(output.get('OEBPS/one.xhtml')!);
    const body = onlyElement(document, 'body');
    const children = document.elements.filter(
      (element) => element.parent === body,
    );
    expect(children.map((element) => element.local)).toEqual([
      'h1',
      'p',
      'div',
      'p',
      'div',
      'p',
      'div',
    ]);
    const wrappers = children.filter((element) => element.local === 'div');
    expect(wrappers.map((element) => element.attrs.class)).toEqual(
      layouts.map(
        (layout) =>
          `epub-ai-chapter-illustration epub-ai-illustration-${layout.size}`,
      ),
    );
    let restored = document.source.slice(body.start, body.end);
    for (const wrapper of [...wrappers].reverse()) {
      const start = wrapper.start - body.start - 1;
      const end = wrapper.end - body.start + 1;
      restored = restored.slice(0, start) + restored.slice(end);
    }
    expect(restored).toBe(sourceBody);
    expect(result.report.illustrations.map((entry) => entry.layout)).toEqual(
      layouts,
    );
    const style = output.get('OEBPS/epub-ai-illustrations.css')!.toString();
    for (const [size, percentage] of [
      ['compact', 45],
      ['medium', 70],
      ['wide', 100],
    ] as const) {
      expect(style).toContain(
        `epub-ai-illustration-${size} > img { width: ${percentage}%; max-width: 100%; height: auto; }`,
      );
    }
    expect(style).not.toMatch(/float:|position:|!important|nth-child/);
    expect(output.get('OEBPS/toc.ncx')!.toString()).toBe(
      entries['OEBPS/toc.ncx'],
    );
    expect(output.get('OEBPS/cover.png')).toEqual(png);
    expect(document.ids).toEqual(new Set(['chapter', 'anchor']));
    const beforePackage = parseXml(Buffer.from(entries['OEBPS/book.opf']));
    const afterPackage = parseXml(output.get('OEBPS/book.opf')!);
    const beforeSpine = onlyElement(beforePackage, 'spine');
    const afterSpine = onlyElement(afterPackage, 'spine');
    expect(afterPackage.source.slice(afterSpine.start, afterSpine.end)).toBe(
      beforePackage.source.slice(beforeSpine.start, beforeSpine.end),
    );
    expect(result.report.integrity.exactAllowlistedInsertion).toBe(true);
  });

  it.each([
    null,
    [],
    { size: 'compact' },
    { size: 'huge', alignment: 'center' },
    { size: 'wide', alignment: 'left' },
    { size: 'wide', alignment: 'center', style: 'width:9999px' },
  ])('rejects an unregistered layout %j before publishing', async (layout) => {
    const { options } = await setup();
    const invalid = layout as unknown as IllustrationLayout;
    await expect(
      insertEpubIllustrations({
        ...options,
        insertions: [
          {
            anchor: options.anchor,
            image: options.image,
            alt: options.alt,
            layout: invalid,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ILLUSTRATION_LAYOUT' });
    await expect(
      insertEpubIllustration({ ...options, layout: invalid }),
    ).rejects.toMatchObject({
      code: 'INVALID_ILLUSTRATION_LAYOUT',
    });
    await expect(readdir(options.outputDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each(['baseline', 'single', 'batch'] as const)(
    'supports a deeply nested conversion publication path for %s without nesting scratch directories',
    async (kind) => {
      const { options, root } = await setup();
      const original = await readFile(options.sourcePath);
      const outputDirectory = join(
        root,
        'runtime-workspace-'.repeat(3),
        'conversion-chapters',
        'a'.repeat(64),
        'private',
        'insertion-preflight-ABCDEF',
      );
      expect(
        join(
          outputDirectory,
          '.illustration-work-ABCDEF',
          'baseline',
          '.epub-work-ABCDEF',
        ).length,
      ).toBeGreaterThan(260);
      let outputPath: string;
      if (kind === 'baseline') {
        outputPath = (
          await processEpub({ sourcePath: options.sourcePath, outputDirectory })
        ).outputPath;
      } else if (kind === 'single') {
        const result = await insertEpubIllustration({
          ...options,
          outputDirectory,
        });
        expect(result.report.pipelineVersion).toBe(
          'chapter-illustration-trial-1',
        );
        outputPath = result.outputPath;
      } else {
        const nextParagraph = '<p>下一段。</p>';
        const start = originalChapter.indexOf(nextParagraph);
        const insertion = {
          anchor: options.anchor,
          image: options.image,
          alt: options.alt,
        };
        const result = await insertEpubIllustrations({
          ...options,
          outputDirectory,
          insertions: [
            insertion,
            {
              ...insertion,
              anchor: {
                ...options.anchor,
                sourceStart: start,
                sourceEnd: start + nextParagraph.length,
                contentSha256: hash(nextParagraph),
              },
            },
          ],
        });
        expect(result.report.illustrations).toHaveLength(2);
        outputPath = result.outputPath;
      }
      expect((await readFile(outputPath)).length).toBeGreaterThan(0);
      expect(await readFile(options.sourcePath)).toEqual(original);
      expect(
        (await readdir(outputDirectory)).some((name) => name.includes('work-')),
      ).toBe(false);
    },
  );
  it('aligns the batch ceiling with all 501 supported zero-based chapter indices', async () => {
    const { options } = await setup();
    const insertion = {
      anchor: options.anchor,
      image: options.image,
      alt: options.alt,
    };
    await expect(
      insertEpubIllustrations({
        ...options,
        insertions: Array.from({ length: 501 }, () => insertion),
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_ILLUSTRATION_ANCHOR' });
    await expect(
      insertEpubIllustrations({
        ...options,
        insertions: Array.from({ length: 502 }, () => insertion),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ILLUSTRATION_ANCHOR' });
  });
  it('inserts multiple chapters in one document and another document from the same original offsets', async () => {
    const source = await setup();
    const secondParagraph = '<p id="second">另一个文件的章末。</p>';
    const secondBody = `<body><h1 id="second-chapter">第二章</h1>${secondParagraph}</body>`;
    const secondChapter = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章</title></head>${secondBody}</html>`;
    const { options, root, png } = await setup({
      'OEBPS/book.opf': source.entries['OEBPS/book.opf']
        .replace(
          '</manifest>',
          '<item id="c2" href="two.xhtml" media-type="application/xhtml+xml" /></manifest>',
        )
        .replace('</spine>', '<itemref idref="c2" /></spine>'),
      'OEBPS/two.xhtml': secondChapter,
    });
    const sourceBytes = await readFile(options.sourcePath);
    const nextParagraph = '<p>下一段。</p>';
    const nextStart = originalChapter.indexOf(nextParagraph);
    const crossStart = secondChapter.indexOf(secondParagraph);
    const insertions = [
      {
        anchor: {
          documentPath: 'OEBPS/two.xhtml',
          sourceStart: crossStart,
          sourceEnd: crossStart + secondParagraph.length,
          contentSha256: hash(secondParagraph),
        },
        image: options.image,
        alt: '第二文件',
      },
      {
        anchor: {
          ...options.anchor,
          sourceStart: nextStart,
          sourceEnd: nextStart + nextParagraph.length,
          contentSha256: hash(nextParagraph),
        },
        image: options.image,
        alt: '同一文件后章',
      },
      { anchor: options.anchor, image: options.image, alt: '同一文件前章' },
    ];
    const result = await insertEpubIllustrations({ ...options, insertions });
    const output = await entriesOf(result.outputPath, root);
    expect(result.report.illustrations).toHaveLength(3);
    expect(
      new Set(result.report.illustrations.map((entry) => entry.imagePath)).size,
    ).toBe(3);
    for (const illustration of result.report.illustrations)
      expect(output.get(illustration.imagePath)).toEqual(png);
    for (const [name, expectedBody, expectedAlts] of [
      ['OEBPS/one.xhtml', originalBody, ['同一文件前章', '同一文件后章']],
      ['OEBPS/two.xhtml', secondBody, ['第二文件']],
    ] as const) {
      const document = parseXml(output.get(name)!);
      const body = onlyElement(document, 'body');
      const wrappers = document.elements.filter(
        (element) => element.attrs.class === 'epub-ai-chapter-illustration',
      );
      let actualBody = document.source.slice(body.start, body.end);
      for (const wrapper of [...wrappers].reverse()) {
        const start = wrapper.start - body.start - 1;
        const end = wrapper.end - body.start + 1;
        actualBody = actualBody.slice(0, start) + actualBody.slice(end);
      }
      expect(actualBody).toBe(expectedBody);
      expect(
        document.elements
          .filter((element) => element.local === 'img')
          .map((element) => element.attrs.alt),
      ).toEqual(expectedAlts);
      expect(
        document.elements.filter(
          (element) =>
            element.local === 'link' &&
            element.attrs.href === 'epub-ai-illustrations.css',
        ),
      ).toHaveLength(1);
    }
    const packageDocument = parseXml(output.get('OEBPS/book.opf')!);
    const addedItems = packageDocument.elements.filter(
      (element) =>
        element.local === 'item' &&
        element.attrs.href.startsWith('epub-ai-illustration'),
    );
    expect(addedItems).toHaveLength(4);
    expect(new Set(addedItems.map((entry) => entry.attrs.id)).size).toBe(4);
    expect(result.report.integrity).toMatchObject({
      exactAllowlistedInsertion: true,
      originalBodySourceFragmentsPreserved: true,
      bodyBytesPreserved: false,
    });
    expect(result.report.phases.insertion.insertedBodyElements).toBe(3);
    expect(result.report.phases.insertion.changedResources).toEqual([
      'OEBPS/two.xhtml',
      'OEBPS/one.xhtml',
      'OEBPS/book.opf',
    ]);
    expect(result.report.outputSha256).toBe(await hashFile(result.outputPath));
    expect(output.get('OEBPS/cover.png')).toEqual(png);
    expect(await readFile(options.sourcePath)).toEqual(sourceBytes);
    expect(JSON.parse(await readFile(result.reportPath, 'utf8'))).toEqual(
      result.report,
    );
  });

  it('rejects duplicate and overlapping anchors before publishing any partial result', async () => {
    const { options } = await setup();
    const insertion = {
      anchor: options.anchor,
      image: options.image,
      alt: options.alt,
    };
    await expect(
      insertEpubIllustrations({
        ...options,
        insertions: [insertion, insertion],
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_ILLUSTRATION_ANCHOR' });
    await expect(
      insertEpubIllustrations({
        ...options,
        insertions: [
          insertion,
          {
            ...insertion,
            anchor: {
              ...insertion.anchor,
              sourceStart: insertion.anchor.sourceStart + 1,
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_ILLUSTRATION_ANCHOR' });
    await expect(readdir(options.outputDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects the entire batch when a later image or source anchor has changed', async () => {
    const { options } = await setup();
    const insertion = {
      anchor: options.anchor,
      image: options.image,
      alt: options.alt,
    };
    const nextParagraph = '<p>下一段。</p>';
    const start = originalChapter.indexOf(nextParagraph);
    const second = {
      ...insertion,
      anchor: {
        ...insertion.anchor,
        sourceStart: start,
        sourceEnd: start + nextParagraph.length,
        contentSha256: '0'.repeat(64),
      },
    };
    await expect(
      insertEpubIllustrations({ ...options, insertions: [insertion, second] }),
    ).rejects.toMatchObject({ code: 'INVALID_ILLUSTRATION_ANCHOR' });
    expect(await readdir(options.outputDirectory)).toEqual([]);
    await expect(
      insertEpubIllustrations({
        ...options,
        insertions: [
          insertion,
          {
            ...second,
            anchor: { ...second.anchor, contentSha256: hash(nextParagraph) },
            image: { ...second.image, sha256: '0'.repeat(64) },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'IMAGE_ASSET_CHANGED' });
    expect(await readdir(options.outputDirectory)).toEqual([]);
  });

  it('checks final resource limits before publishing the combined archive', async () => {
    const { options } = await setup();
    const nextParagraph = '<p>下一段。</p>';
    const start = originalChapter.indexOf(nextParagraph);
    const insertion = {
      anchor: options.anchor,
      image: options.image,
      alt: options.alt,
    };
    await expect(
      insertEpubIllustrations({
        ...options,
        limits: { maxEntries: 10 },
        insertions: [
          insertion,
          {
            ...insertion,
            anchor: {
              ...options.anchor,
              sourceStart: start,
              sourceEnd: start + nextParagraph.length,
              contentSha256: hash(nextParagraph),
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'ARCHIVE_LIMIT' });
    expect(await readdir(options.outputDirectory)).toEqual([]);
  });
});
