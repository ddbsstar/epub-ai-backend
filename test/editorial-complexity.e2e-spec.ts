import { editorialTypography } from '../src/layout/editorial-typography.js';
import { onlyElement, parseXml } from '../src/documents/epub-xml.js';

function document(paragraphs: number, head = '') {
  const source = `<html xmlns="http://www.w3.org/1999/xhtml"><head>${head}</head><body><h1>篇名</h1>${'<p>正文。</p>'.repeat(paragraphs)}</body></html>`;
  const parsed = parseXml(Buffer.from(source));
  return { parsed, body: onlyElement(parsed, 'body'), source };
}

function expectPreserved(result: ReturnType<typeof editorialTypography>) {
  expect(result.reasons).toContain('EDITORIAL_COMPLEXITY_LIMIT');
  expect(result.css).toBe('');
  expect(result.assignments).toEqual([]);
  expect(result.styledParagraphs).toBe(0);
  expect(result.styledHeadings).toBe(0);
}

describe('editorial complexity admission', () => {
  it('preserves a small-byte document with excessive positional-selector work', () => {
    const { parsed, body, source } = document(10_000);
    expect(Buffer.byteLength(source)).toBeLessThan(200_000);
    const before = parsed.source;
    const result = editorialTypography(parsed, body, []);
    expectPreserved(result);
    expect(parsed.source).toBe(before);
  }, 2000);

  it('preserves small CSS/XML whose selector cross-product exceeds the work budget', () => {
    const { parsed, body, source } = document(500);
    const css = 'p { color: black; }\n'.repeat(5000);
    expect(Buffer.byteLength(source) + Buffer.byteLength(css)).toBeLessThan(
      200_000,
    );
    expectPreserved(editorialTypography(parsed, body, [css]));
  }, 2000);

  it('counts comma selectors and all linked stylesheets together', () => {
    const { parsed, body } = document(500);
    const css = `${Array.from({ length: 2000 }, () => 'p').join(',')} { color: black; }`;
    expectPreserved(editorialTypography(parsed, body, [css, css]));
  });

  it('bounds CSS parsing volume even if a sheet contains only comments', () => {
    const { parsed, body } = document(3);
    expectPreserved(
      editorialTypography(parsed, body, ['/*' + 'x'.repeat(256 * 1024) + '*/']),
    );
    expectPreserved(editorialTypography(parsed, body, Array(17).fill('')));
  });

  it('includes head elements in positional-selector construction cost', () => {
    const { parsed, body } = document(
      500,
      '<meta name="example" content="value" />'.repeat(4000),
    );
    expectPreserved(editorialTypography(parsed, body, []));
  });

  it('keeps ordinary admitted prose and publisher emphasis styled', () => {
    const source =
      '<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body><h1>篇名</h1><p>开篇<span class="italic">强调</span>。</p><p>正文。</p></body></html>';
    const parsed = parseXml(Buffer.from(source));
    const result = editorialTypography(parsed, onlyElement(parsed, 'body'), [
      'body {font-size: 14px; line-height: 2;} p {text-indent: 2em;} .italic {font-style: italic;}',
    ]);
    expect(result.reasons).toEqual([]);
    expect(result.styledParagraphs).toBe(2);
    expect(result.styledHeadings).toBe(1);
    expect(result.roleCounts).toMatchObject({ opening: 1, body: 1 });
    expect(
      result.assignments.some((item) => item.role === 'inline-emphasis'),
    ).toBe(true);
    expect(parsed.source).toBe(source);
  });
});
