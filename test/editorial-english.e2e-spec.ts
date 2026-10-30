import { createHash } from 'node:crypto';
import postcss from 'postcss';
import { onlyElement, parseXml } from '../src/documents/epub-xml.js';
import { editorialTypography } from '../src/layout/editorial-typography.js';

const chapter =
  '<div class="chapter"><h2 id="chapter">Chapter I<br/>An ordinary morning</h2><p>First paragraph with <i>emphasis</i>.</p><p>A second paragraph.</p><p class="asterism">*&#160;&#160;*&#160;&#160;*<br/>*&#160;&#160;*</p><p>A new scene.</p><p class="noindent">A deliberate continuation.</p><p class="center">A centered line.</p></div>';
const templateCss =
  '@media screen { body { margin-left: 10%; margin-right: 10%; } } div.chapter { page-break-before: always; margin-top: 4em; } p { text-indent: 1em; } .center {text-align:center} a:link {text-decoration:none} a[href] {text-decoration:underline}';

function render(
  content = chapter,
  css = templateCss,
  declarations = 'lang="en"',
  languages = ['en'],
) {
  const source = `<html xmlns="http://www.w3.org/1999/xhtml" ${declarations}><head></head><body class="x-ebookmaker x-ebookmaker-3">${content}</body></html>`;
  const parsed = parseXml(Buffer.from(source));
  const result = editorialTypography(
    parsed,
    onlyElement(parsed, 'body'),
    [css],
    languages,
  );
  return { result, parsed, source };
}

describe('source-bound English prose admission', () => {
  it('styles an audited single chapter wrapper without changing its source or reader controls', () => {
    const { result, parsed, source } = render();
    expect(result.reasons).toEqual([]);
    expect(result.language).toEqual({
      policy: 'english-prose',
      package: ['en'],
      document: ['en'],
    });
    expect(result.styledHeadings).toBe(1);
    expect(result.roleCounts).toMatchObject({
      opening: 2,
      body: 3,
      separator: 1,
    });
    expect(result.css).toContain('body > div:nth-child(1) > h2:nth-child(1)');
    expect(result.css).toContain('font-size: 1.65em');
    expect(result.css).toContain('text-indent: 1.2em');
    expect(parsed.source).toBe(source);
    for (const assignment of result.assignments) {
      expect(
        createHash('sha256')
          .update(source.slice(assignment.sourceStart, assignment.sourceEnd))
          .digest('hex'),
      ).toBe(assignment.sourceSha256);
      const rule = postcss
        .parse(result.css)
        .nodes.find(
          (node) =>
            node.type === 'rule' && node.selector === assignment.selector,
        );
      expect(rule?.type).toBe('rule');
      if (
        rule?.type === 'rule' &&
        ['body', 'opening'].includes(assignment.role)
      )
        for (const property of [
          'font-size',
          'line-height',
          'color',
          'background',
        ])
          expect(
            rule.nodes
              .filter((node) => node.type === 'decl')
              .map((node) => node.prop),
          ).not.toContain(property);
    }
  });

  it.each([
    ['root conflict', 'lang="fr"', ['en']],
    ['XML/HTML conflict', 'lang="en" xml:lang="zh"', ['en']],
    ['multiple metadata languages', 'lang="en"', ['en', 'fr']],
    ['invalid metadata', 'lang="en"', ['en_US']],
  ])(
    'preserves %s instead of guessing from publisher class names',
    (_label, attrs, metadata) => {
      const { result } = render(chapter, templateCss, attrs, metadata);
      expect(result.reasons).toContain('EDITORIAL_LANGUAGE_CONFLICT');
      expect(result.css).toBe('');
      expect(result.assignments).toEqual([]);
    },
  );

  it('uses the OPF language when root declarations are absent, and accepts regional English variants', () => {
    expect(
      render(chapter, templateCss, '', ['en']).result.language.policy,
    ).toBe('english-prose');
    expect(
      render(chapter, templateCss, 'lang="en-GB"', ['en-US']).result.reasons,
    ).toEqual([]);
  });

  it.each([
    [
      'chapter wrapper',
      chapter.replace('class="chapter"', 'class="chapter" xml:lang="zh"'),
    ],
    [
      'paragraph override',
      chapter.replace(
        '<p>A second paragraph.',
        '<p lang="fr">A second paragraph.',
      ),
    ],
    [
      'heading override',
      chapter.replace('<h2 id="chapter"', '<h2 lang="fr" id="chapter"'),
    ],
  ])('protects a conflicting block language on %s', (_label, content) => {
    const { result } = render(content);
    expect(result.reasons).toContain('EDITORIAL_LANGUAGE_CONFLICT');
    expect(result.css).toBe('');
  });

  it('accepts regional block declarations and does not reinterpret a foreign inline phrase as the chapter language', () => {
    const content = chapter
      .replace('class="chapter"', 'class="chapter" lang="en-GB"')
      .replace('<i>emphasis</i>', '<i lang="fr">a foreign phrase</i>');
    const { result } = render(content);
    expect(result.reasons).toEqual([]);
    expect(result.language).toEqual({
      policy: 'english-prose',
      package: ['en'],
      document: ['en', 'en-gb'],
    });
  });

  it('uses neutral spacing when language is missing or unsupported without guessing from the chapter class', () => {
    for (const [attrs, languages] of [
      ['', []],
      ['lang="fr"', ['fr']],
    ] as const) {
      const { result } = render(chapter, templateCss, attrs, [...languages]);
      expect(result.reasons).toEqual([]);
      expect(result.language.policy).toBe('neutral-prose');
      expect(result.css).not.toContain('text-indent: 1.2em');
      expect(result.css).not.toContain('text-indent: 2em');
    }
  });

  it('keeps the existing Chinese paragraph policy when declared Chinese', () => {
    const { result } = render(chapter, templateCss, 'lang="zh-CN"', ['zh']);
    expect(result.language.policy).toBe('chinese-prose');
    expect(result.css).toContain('text-indent: 2em');
  });

  it.each([
    [
      'conditional emphasis',
      '@media screen { p { font-weight: bold } }',
      'EDITORIAL_COMPLEX_CSS',
    ],
    [
      'responsive hiding',
      '@media screen { body { display: none } }',
      'EDITORIAL_COMPLEX_CSS',
    ],
    [
      'different media',
      '@media print { body { margin-left:10% } }',
      'EDITORIAL_COMPLEX_CSS',
    ],
    [
      'attribute value selector',
      'p[class="noindent"] { font-style: italic }',
      'EDITORIAL_UNPROVEN_SELECTOR',
    ],
    ['matched layout', 'p { position:absolute }', 'EDITORIAL_MATCHED_LAYOUT'],
  ])('keeps %s protected', (_label, css, reason) => {
    const { result } = render(chapter, css);
    expect(result.reasons).toContain(reason);
    expect(result.assignments).toEqual([]);
  });

  it.each([
    [
      'unknown class',
      chapter.replace('class="noindent"', 'class="calibre12"'),
      'EDITORIAL_UNKNOWN_CLASS',
    ],
    [
      'nested containers',
      `<div class="chapter">${chapter}</div>`,
      'EDITORIAL_COMPLEX_STRUCTURE',
    ],
    [
      'preformatted verse',
      chapter.replace('</div>', '<pre>Keep this spacing.</pre></div>'),
      'EDITORIAL_COMPLEX_STRUCTURE',
    ],
    [
      'unscoped wrapper text',
      chapter.replace(
        '<div class="chapter">',
        '<div class="chapter">Outside prose',
      ),
      'EDITORIAL_UNSCOPED_TEXT',
    ],
    [
      'body text outside wrapper',
      `Outside prose${chapter}`,
      'EDITORIAL_UNSCOPED_TEXT',
    ],
    [
      'mislabelled separator',
      chapter.replace('*&#160;&#160;*&#160;&#160;*', 'Ordinary words'),
      'EDITORIAL_UNPROVEN_SEPARATOR',
    ],
    [
      'separator with nested prose',
      chapter.replace(
        '*&#160;&#160;*&#160;&#160;*',
        '*<span>Ordinary words</span>',
      ),
      'EDITORIAL_UNPROVEN_SEPARATOR',
    ],
    [
      'separator containing an image',
      chapter.replace(
        '*&#160;&#160;*&#160;&#160;*',
        '*<img src="picture.png" alt="A picture"/>',
      ),
      'EDITORIAL_UNPROVEN_SEPARATOR',
    ],
    [
      'empty separator',
      chapter.replace(
        '*&#160;&#160;*&#160;&#160;*<br/>*&#160;&#160;*',
        '  <br/>  ',
      ),
      'EDITORIAL_UNPROVEN_SEPARATOR',
    ],
  ])('preserves %s', (_label, content, reason) => {
    const { result } = render(content);
    expect(result.reasons).toContain(reason);
    expect(result.css).toBe('');
  });
});
