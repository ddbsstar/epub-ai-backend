import postcss from 'postcss';
import { EpubProcessingError } from '../documents/epub.types.js';
import type { EpubStructureRole } from '../documents/epub.types.js';

const roleStyles: Record<EpubStructureRole, string> = {
  body: 'margin-top: 0.25em; margin-bottom: 0.25em; text-indent: 2em;',
  quote:
    'margin-top: 1em; margin-bottom: 1em; margin-left: 1em; margin-right: 1em; text-indent: 0;',
  poem: 'margin-top: 0.25em; margin-bottom: 0.25em; text-indent: 0;',
  caption:
    'margin-top: 0.5em; margin-bottom: 1em; text-indent: 0; text-align: center; font-size: 0.85em;',
  'section-title':
    'margin-top: 1.6em; margin-bottom: 0.8em; text-indent: 0; font-size: 1.12em; font-weight: bold; page-break-after: avoid;',
};

/** Values come from validated snapshot positions and fixed role recipes, never model CSS. */
export function structureRoleCss(
  assignments: { childIndex: number; role: EpubStructureRole }[],
): string {
  return (
    '/* epub-ai validated structure roles */\n' +
    assignments
      .map(({ childIndex, role }) => {
        if (
          !Number.isSafeInteger(childIndex) ||
          childIndex < 1 ||
          !Object.hasOwn(roleStyles, role)
        )
          throw new EpubProcessingError(
            'INVALID_STRUCTURE_PLAN',
            'AI 结构方案与原书不匹配，未应用方案',
          );
        return `body > p:nth-child(${childIndex}) { ${roleStyles[role]} }`;
      })
      .join('\n') +
    '\n'
  );
}

export const READER_FIRST_CSS = `/* epub-ai reader-first-1: reader controls normal text */
html, body { margin-left: 0; margin-right: 0; padding-left: 0; padding-right: 0; }
h1, h2 { font-family: inherit; text-align: center; text-indent: 0; page-break-after: avoid; }
h1 { display: table; margin: 2em auto 0.8em; padding-bottom: 0.6em; border-bottom: 0.05em solid; font-size: 0.92em; font-weight: normal; letter-spacing: 0.16em; }
h2 { margin: 1.8em 0 1.5em; font-size: 1.4em; font-weight: bold; }
h1 + h2 { margin-top: 0; }
p:not([class]) { margin-top: 0.25em; margin-bottom: 0.25em; text-indent: 2em; }
img { max-width: 100%; height: auto; }
`;

const readerProperties = new Set([
  'font',
  'font-family',
  'font-size',
  'line-height',
  'color',
  'background',
  'background-color',
  'text-align',
  'margin',
  'padding',
  'margin-left',
  'margin-right',
  'padding-left',
  'padding-right',
  'width',
  'min-width',
  'max-width',
  'height',
  'min-height',
  'max-height',
  'margin-inline',
  'margin-inline-start',
  'margin-inline-end',
  'padding-inline',
  'padding-inline-start',
  'padding-inline-end',
  'inline-size',
  'min-inline-size',
  'max-inline-size',
]);

export interface ReaderCssResult {
  css: string;
  references: string[];
  complex: boolean;
}

/** Preserve special selectors; only remove reader overrides from explicit base selectors. */
export function prepareReaderCss(source: string): ReaderCssResult {
  let root;
  try {
    root = postcss.parse(source, { from: undefined });
  } catch {
    throw new EpubProcessingError('INVALID_CSS', 'EPUB 中存在无法解析的样式');
  }
  const references: string[] = [];
  let complex = false;
  root.walkAtRules((rule) => {
    if (rule.params.includes('\\'))
      throw new EpubProcessingError(
        'UNSUPPORTED_CSS',
        '首版不支持含转义资源地址的样式',
      );
    if (!['charset', 'font-face'].includes(rule.name.toLowerCase()))
      complex = true;
    if (rule.name.toLowerCase() === 'import') {
      const reference = rule.params.match(
        /^(?:url\(\s*)?["']?([^\s"'()]+)["']?/i,
      )?.[1];
      if (reference) references.push(reference);
      else complex = true;
    }
  });
  root.walkDecls((declaration) => {
    if (declaration.value.includes('\\'))
      throw new EpubProcessingError(
        'UNSUPPORTED_CSS',
        '首版不支持含转义资源地址的样式',
      );
    if (
      /expression\s*\(|javascript\s*:/i.test(declaration.value) ||
      /^(?:behavior|-moz-binding)$/i.test(declaration.prop)
    )
      throw new EpubProcessingError('ACTIVE_CONTENT', '首版不支持动态 CSS');
    if (declaration.important) complex = true;
    const urls = [
      ...declaration.value.matchAll(/url\(\s*["']?([^"'()]+?)["']?\s*\)/gi),
    ];
    if ([...declaration.value.matchAll(/\burl\s*\(/gi)].length !== urls.length)
      throw new EpubProcessingError(
        'UNSUPPORTED_CSS',
        '样式含首版无法安全解析的资源地址',
      );
    for (const match of urls) references.push(match[1].trim());
  });
  root.walkRules((rule) => {
    const selectors = rule.selector
      .split(',')
      .map((selector) => selector.trim());
    if (
      selectors.some((selector) => selector.includes('#')) &&
      rule.nodes.some(
        (node) =>
          node.type === 'decl' && readerProperties.has(node.prop.toLowerCase()),
      )
    )
      complex = true;
    if (
      rule.nodes.some(
        (node) =>
          node.type === 'decl' &&
          /^(?:display|position|float|columns|column-count|writing-mode|transform|overflow|contain)$/i.test(
            node.prop,
          ),
      )
    )
      complex = true;
    if (
      selectors.some(
        (selector) =>
          !/^(?:[a-z][\w-]*(?:\.[\w-]+)?|[.#][\w-]+|a:(?:link|visited|hover))$/i.test(
            selector,
          ),
      )
    )
      complex = true;
    const base = selectors.filter((selector) =>
      /^(html|body|p)$/i.test(selector),
    );
    if (base.length === 0) return;
    const others = selectors.filter(
      (selector) => !/^(html|body|p)$/i.test(selector),
    );
    const target =
      others.length > 0
        ? rule.cloneBefore({ selector: base.join(', ') })
        : rule;
    if (others.length > 0) rule.selector = others.join(', ');
    target.each((node) => {
      if (
        node.type === 'decl' &&
        (readerProperties.has(node.prop.toLowerCase()) ||
          node.prop.toLowerCase().startsWith('background-'))
      )
        node.remove();
    });
    if (target.nodes.length === 0) target.remove();
  });
  return { css: root.toString(), references, complex };
}
