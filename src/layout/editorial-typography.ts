import postcss from 'postcss';
import { createHash } from 'node:crypto';
import type { XmlDocument, XmlElement } from '../documents/epub-xml.js';

export const EDITORIAL_PROFILE = 'editorial-1' as const;
export const editorialRoles = [
  'body',
  'opening',
  'quote',
  'poem',
  'caption',
  'note',
  'separator',
] as const;
export type EditorialRole = (typeof editorialRoles)[number];
export const emptyEditorialCounts = () =>
  Object.fromEntries(editorialRoles.map((role) => [role, 0])) as Record<
    EditorialRole,
    number
  >;
export interface EditorialSummary {
  profile: typeof EDITORIAL_PROFILE;
  totalParagraphs: number;
  styledParagraphs: number;
  preservedParagraphs: number;
  styledHeadings: number;
  roleCounts: Record<EditorialRole, number>;
}
export interface EditorialAssignment {
  selector: string;
  role: EditorialRole | 'heading' | 'chapter-label' | 'inline-emphasis';
  source: string;
  sourceStart: number;
  sourceEnd: number;
  sourceSha256: string;
}
export interface EditorialDocument {
  css: string;
  assignments: EditorialAssignment[];
  roleCounts: Record<EditorialRole, number>;
  styledParagraphs: number;
  styledHeadings: number;
  reasons: string[];
  language: {
    policy: 'english-prose' | 'chinese-prose' | 'neutral-prose' | 'conflict';
    package: string[];
    document: string[];
  };
}
const plainInline = new Set([
  'span',
  'em',
  'strong',
  'b',
  'i',
  'br',
  'small',
  'sup',
  'sub',
  'a',
  'img',
]);
const typographyClasses =
  /^(?:kindle-cn-(?:heading[1-6]?(?:-[a-z0-9]+)*|kai|italic|bold|underline|ref|signature|para-(?:left|right|center|align-center|no-indent)|poem-(?:left|center)|caption|note|footnote|endnote|bodycontent-image-alone\d+)|sigil_not_in_toc|quote|poem|caption|note|footnote|endnote|no-indent|text-left|text-right|text-center|italic|bold|underline)$/iu;
const dangerousLayout =
  /^(?:display|position|float|columns|column-count|column-width|writing-mode|transform|overflow|contain|content|visibility)$/iu;
// A byte limit alone does not bound selector matching or positional-selector
// construction. Keep this admission check ahead of all document-wide scans;
// over-budget documents retain their original styles and report the reason.
const complexityLimits = {
  documentElements: 5_000,
  stylesheets: 16,
  stylesheetBytes: 256 * 1024,
  matchingWork: 2_000_000,
} as const;
function classes(element: XmlElement) {
  return (element.attrs.class ?? '').split(/\s+/u).filter(Boolean);
}
function simpleMatches(
  selector: string,
  element: XmlElement,
): boolean | undefined {
  // This one existence selector is used by the audited Gutenberg template.
  // Other attribute selectors remain unproved rather than being approximated.
  if (/^a\[href\]$/iu.test(selector.trim()))
    return element.local === 'a' && 'href' in element.attrs;
  const match = selector
    .trim()
    .match(
      /^(\*|[a-z][a-z0-9-]*)?((?:[.#][a-z_][a-z0-9_-]*)*)(?::(?:link|visited|hover))?$/iu,
    );
  if (!match || (!match[1] && !match[2])) return undefined;
  if (
    match[1] &&
    match[1] !== '*' &&
    match[1].toLowerCase() !== element.local.toLowerCase()
  )
    return false;
  return [...match[2]!.matchAll(/([.#])([a-z_][a-z0-9_-]*)/giu)].every(
    (token) =>
      token[1] === '#'
        ? element.attrs.id === token[2]
        : classes(element).includes(token[2]!),
  );
}
function knownAbsent(selector: string, elements: XmlElement[]) {
  // A missing positive leading class/id proves absence, even before a pseudo.
  const leading = selector
    .trim()
    .match(/^(?:[a-z][a-z0-9-]*)?([.#])([a-z_][a-z0-9_-]*)/iu);
  if (
    leading &&
    !elements.some((element) =>
      leading[1] === '#'
        ? element.attrs.id === leading[2]
        : classes(element).includes(leading[2]!),
    )
  )
    return true;
  if (!/[:[\\]/u.test(selector))
    return selector
      .trim()
      .split(/\s*[>+~]\s*|\s+/u)
      .some(
        (part) =>
          simpleMatches(part, elements[0]!) !== undefined &&
          !elements.some((element) => simpleMatches(part, element) === true) &&
          part !== 'html',
      );
  return false;
}
function selectorOf(
  element: XmlElement,
  body: XmlElement,
  document: XmlDocument,
): string {
  if (element === body) return 'body';
  const parent = element.parent!;
  const children = document.elements.filter((entry) => entry.parent === parent);
  const prefix = parent === body ? 'body' : selectorOf(parent, body, document);
  return `${prefix} > ${element.local}:nth-child(${children.indexOf(element) + 1})`;
}
function roleOf(
  element: XmlElement,
  inQuote: boolean,
): {
  role: EditorialRole;
  source: string;
  alignment?: string;
  noIndent?: boolean;
} {
  const names = classes(element);
  const semantic = `${element.attrs['epub:type'] ?? ''} ${element.attrs.role ?? ''}`;
  if (names.includes('asterism'))
    return { role: 'separator', source: 'publisher-class-and-separator-text' };
  if (inQuote || names.some((name) => /^(?:quote|kindle-cn-ref)$/iu.test(name)))
    return {
      role: 'quote',
      source: inQuote ? 'blockquote' : 'publisher-class',
    };
  if (
    names.some((name) =>
      /^(?:poem|kindle-cn-poem-(?:left|center))$/iu.test(name),
    )
  )
    return { role: 'poem', source: 'publisher-class' };
  if (names.some((name) => /^(?:caption|kindle-cn-caption)$/iu.test(name)))
    return { role: 'caption', source: 'publisher-class' };
  if (
    /(?:footnote|endnote)/iu.test(semantic) ||
    names.some((name) =>
      /^(?:(?:foot|end)?note|kindle-cn-(?:footnote|endnote|note))$/iu.test(
        name,
      ),
    )
  )
    return { role: 'note', source: 'explicit-note' };
  if (
    names.includes('kindle-cn-kai') &&
    /^\s*[*＊]?\s*(?:载于|发表于|原载|选自|本文发表于)/u.test(element.text) &&
    Array.from(element.text).length <= 180
  )
    return { role: 'note', source: 'source-marker-and-publisher-class' };
  const alignment = names.some((name) =>
    /(?:para-right|signature|text-right)$/iu.test(name),
  )
    ? 'right'
    : names.some((name) =>
          /(?:para-(?:align-)?center|text-center|^center)$/iu.test(name),
        )
      ? 'center'
      : undefined;
  return {
    role: 'body',
    source: names.length ? 'publisher-prose' : 'paragraph',
    ...(alignment ? { alignment } : {}),
    noIndent: names.some((name) => /(?:no-indent|^noindent)$/iu.test(name)),
  };
}

function languageOf(document: XmlDocument, packageLanguages: string[]) {
  const roots = document.elements.filter((element) =>
    [
      'html',
      'body',
      'div',
      'blockquote',
      'p',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
    ].includes(element.local),
  );
  const normalize = (values: string[]) => [
    ...new Set(
      values.map((value) => value.trim().toLowerCase()).filter(Boolean),
    ),
  ];
  const declared = normalize(
    roots.flatMap((element) =>
      [element.attrs.lang, element.attrs['xml:lang']].filter(
        (value): value is string => value !== undefined,
      ),
    ),
  );
  const packaged = normalize(packageLanguages);
  const all = [...packaged, ...declared];
  const valid = all.every((value) =>
    /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u.test(value),
  );
  const primary = new Set(all.map((value) => value.split('-')[0]));
  const policy: EditorialDocument['language']['policy'] =
    !valid || primary.size > 1
      ? 'conflict'
      : primary.has('en')
        ? 'english-prose'
        : primary.has('zh')
          ? 'chinese-prose'
          : 'neutral-prose';
  return { policy, package: packaged, document: declared };
}

function readerOnlyMedia(rule: postcss.AtRule) {
  return (
    rule.name.toLowerCase() === 'media' &&
    rule.params.trim().toLowerCase() === 'screen' &&
    !!rule.nodes?.length &&
    rule.nodes.every(
      (node) =>
        node.type === 'comment' ||
        (node.type === 'rule' &&
          /^(?:body|html)$/iu.test(node.selector.trim()) &&
          node.nodes.every(
            (child) =>
              child.type === 'comment' ||
              (child.type === 'decl' &&
                /^(?:margin-left|margin-right)$/iu.test(child.prop) &&
                /^(?:0|\d+(?:\.\d+)?(?:%|em|rem|px))$/iu.test(child.value)),
          )),
    )
  );
}

/** Source-bound CSS only; no text, HTML, invented labels or model decisions. */
export function editorialTypography(
  document: XmlDocument,
  body: XmlElement,
  sheets: string[],
  packageLanguages: string[] = [],
): EditorialDocument {
  const result: EditorialDocument = {
    css: '',
    assignments: [],
    roleCounts: emptyEditorialCounts(),
    styledParagraphs: 0,
    styledHeadings: 0,
    reasons: [],
    language: languageOf(document, packageLanguages),
  };
  const elements = document.elements.filter(
    (entry) => entry.start >= body.start && entry.end <= body.end,
  );
  const exceedsWork = (selectors: number) =>
    elements.length * (document.elements.length + selectors) >
    complexityLimits.matchingWork;
  if (
    document.elements.length > complexityLimits.documentElements ||
    sheets.length > complexityLimits.stylesheets ||
    sheets.reduce((bytes, source) => bytes + Buffer.byteLength(source), 0) >
      complexityLimits.stylesheetBytes ||
    exceedsWork(0)
  ) {
    result.reasons.push('EDITORIAL_COMPLEXITY_LIMIT');
    return result;
  }
  const parsedSheets: ReturnType<typeof postcss.parse>[] = [];
  let selectorCount = 0;
  for (const source of sheets) {
    const root = postcss.parse(source);
    let overBudget = false;
    root.walkRules((rule) => {
      selectorCount += rule.selector.split(',').length;
      if (exceedsWork(selectorCount)) {
        overBudget = true;
        return false;
      }
      return undefined;
    });
    if (overBudget) {
      result.reasons.push('EDITORIAL_COMPLEXITY_LIMIT');
      return result;
    }
    parsedSheets.push(root);
  }
  const bodyChildren = elements.filter((entry) => entry.parent === body);
  // Admit a single ordinary chapter wrapper, not arbitrary nested layouts.
  const wrapper =
    bodyChildren.length === 1 &&
    bodyChildren[0]!.local === 'div' &&
    classes(bodyChildren[0]!).length === 1 &&
    classes(bodyChildren[0]!)[0] === 'chapter'
      ? bodyChildren[0]
      : undefined;
  const container = wrapper ?? body;
  const children = elements.filter((entry) => entry.parent === container);
  const headings = children.filter((entry) => /^h[1-6]$/u.test(entry.local));
  const paragraphs = elements.filter((entry) => entry.local === 'p');
  const reject = (reason: string) => {
    if (!result.reasons.includes(reason)) result.reasons.push(reason);
  };
  if (result.language.policy === 'conflict')
    reject('EDITORIAL_LANGUAGE_CONFLICT');
  if (!headings.length || !paragraphs.length) reject('EDITORIAL_NO_PROSE');
  for (const element of elements) {
    if (element.attrs.style || element.local === 'style')
      reject('EDITORIAL_INLINE_STYLE');
    const auditedClass = (name: string) =>
      typographyClasses.test(name) ||
      (element === body && /^x-ebookmaker(?:-[23])?$/u.test(name)) ||
      (element === wrapper && name === 'chapter') ||
      (element.local === 'p' &&
        ['noindent', 'center', 'asterism'].includes(name));
    if (classes(element).some((name) => !auditedClass(name)))
      reject('EDITORIAL_UNKNOWN_CLASS');
    if (
      classes(element).includes('asterism') &&
      (!/^[\s*⁂•·]+$/u.test(element.text) ||
        !/[*⁂•·]/u.test(element.text) ||
        element.text.length > 256 ||
        elements.some(
          (child) =>
            child.start > element.start &&
            child.end <= element.end &&
            child.local !== 'br',
        ))
    )
      reject('EDITORIAL_UNPROVEN_SEPARATOR');
    if (element === body) continue;
    if (element === wrapper) continue;
    const top = element.parent === container;
    const quote = element.local === 'blockquote' && top;
    const empty =
      element.local === 'div' &&
      top &&
      !element.text.trim() &&
      !elements.some((child) => child.parent === element);
    const paragraph =
      element.local === 'p' &&
      (top ||
        (element.parent?.local === 'blockquote' &&
          element.parent.parent === container));
    const heading = /^h[1-6]$/u.test(element.local) && top;
    if (
      !quote &&
      !empty &&
      !paragraph &&
      !heading &&
      !(top && ['hr', 'img'].includes(element.local)) &&
      !plainInline.has(element.local)
    )
      reject('EDITORIAL_COMPLEX_STRUCTURE');
    if (
      plainInline.has(element.local) &&
      element.parent !== container &&
      !elements.some(
        (parent) =>
          ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(parent.local) &&
          element.start > parent.start &&
          element.end <= parent.end,
      )
    )
      reject('EDITORIAL_COMPLEX_STRUCTURE');
  }
  let outside = document.source.slice(
    container.openingEnd,
    container.closingStart,
  );
  for (const child of [...children].reverse())
    outside =
      outside.slice(0, child.start - container.openingEnd) +
      outside.slice(child.end - container.openingEnd);
  if (outside.replace(/<!--[\s\S]*?-->/gu, '').trim())
    reject('EDITORIAL_UNSCOPED_TEXT');
  if (wrapper && body.text.trim()) reject('EDITORIAL_UNSCOPED_TEXT');
  for (const quote of children.filter(
    (entry) => entry.local === 'blockquote',
  )) {
    let rest = document.source.slice(quote.openingEnd, quote.closingStart);
    for (const child of elements
      .filter((entry) => entry.parent === quote)
      .reverse())
      rest =
        rest.slice(0, child.start - quote.openingEnd) +
        rest.slice(child.end - quote.openingEnd);
    if (rest.trim()) reject('EDITORIAL_UNSCOPED_TEXT');
  }
  const emphasis = new Map<XmlElement, Map<string, string>>();
  for (const root of parsedSheets) {
    root.walkAtRules((rule) => {
      if (
        !['font-face', 'charset'].includes(rule.name.toLowerCase()) &&
        !readerOnlyMedia(rule)
      )
        reject('EDITORIAL_COMPLEX_CSS');
    });
    root.walkRules((rule) => {
      for (const selector of rule.selector.split(',')) {
        const matched = elements.filter(
          (element) => simpleMatches(selector, element) === true,
        );
        const rootMatch =
          simpleMatches(selector, { ...body, local: 'html', attrs: {} }) ===
          true;
        const supported = simpleMatches(selector, body) !== undefined;
        // The editorial theme deliberately replaces conditional publisher font
        // and colour overrides with reader defaults. Do not infer a language,
        // and never discard conditional emphasis or layout this way.
        const readerLanguageOverride =
          /^:lang\([a-z][a-z0-9-]*\)$/iu.test(selector.trim()) &&
          rule.nodes.every(
            (node) =>
              node.type === 'comment' ||
              (node.type === 'decl' &&
                ['font-family', 'color'].includes(node.prop.toLowerCase())),
          );
        if (readerLanguageOverride) continue;
        if (!supported && !knownAbsent(selector, elements)) {
          reject('EDITORIAL_UNPROVEN_SELECTOR');
          continue;
        }
        if (!matched.length && !rootMatch) continue;
        for (const declaration of rule.nodes.filter(
          (node) => node.type === 'decl',
        )) {
          if (
            dangerousLayout.test(declaration.prop) &&
            !(
              /^(?:display)$/iu.test(declaration.prop) &&
              /^(?:block|inline)$/iu.test(declaration.value)
            )
          )
            reject('EDITORIAL_MATCHED_LAYOUT');
          if (/url\s*\(|var\s*\(|attr\s*\(|env\s*\(/iu.test(declaration.value))
            reject('EDITORIAL_DYNAMIC_STYLE');
          if (
            [
              'font-weight',
              'font-style',
              'text-decoration',
              'vertical-align',
            ].includes(declaration.prop.toLowerCase())
          ) {
            if (
              !/^(?:normal|bold|bolder|lighter|[1-9]00|italic|oblique|none|underline|line-through|baseline|super|sub)$/iu.test(
                declaration.value,
              )
            ) {
              reject('EDITORIAL_UNPROVEN_EMPHASIS');
              continue;
            }
            for (const element of matched) {
              if (!plainInline.has(element.local)) continue;
              const map = emphasis.get(element) ?? new Map();
              map.set(declaration.prop.toLowerCase(), declaration.value);
              emphasis.set(element, map);
            }
          }
        }
      }
    });
  }
  if (result.reasons.length) return result;
  const css = [
    '/* epub-ai editorial-1: source-bound typography */',
    `/* paragraph policy: ${result.language.policy} */`,
    'html, body { margin-left: 0; margin-right: 0; padding-left: 0; padding-right: 0; }',
    'img { max-width: 100%; height: auto; }',
  ];
  const assign = (
    element: XmlElement,
    role: EditorialAssignment['role'],
    source: string,
    style: string,
  ) => {
    const selector = selectorOf(element, body, document);
    css.push(`${selector} { ${style} }`);
    result.assignments.push({
      selector,
      role,
      source,
      sourceStart: element.start,
      sourceEnd: element.end,
      sourceSha256: createHash('sha256')
        .update(document.source.slice(element.start, element.end))
        .digest('hex'),
    });
  };
  let opening = true;
  for (const element of children) {
    if (/^h[1-6]$/u.test(element.local)) {
      const level =
        wrapper && element === headings[0] ? 1 : Number(element.local.slice(1));
      const next = children[children.indexOf(element) + 1];
      const chapterLabel =
        level === 1 &&
        /^(?:第[\d一二三四五六七八九十百千万零〇两]+章|chapter\s+[\divxlc]+)$/iu.test(
          element.text.trim(),
        ) &&
        !!next &&
        /^h[1-6]$/u.test(next.local);
      const size = chapterLabel
        ? '.95em'
        : level === 1
          ? '1.65em'
          : level === 2
            ? '1.35em'
            : level === 3
              ? '1.16em'
              : level === 4
                ? '1.08em'
                : '1em';
      assign(
        element,
        chapterLabel ? 'chapter-label' : 'heading',
        wrapper && element === headings[0]
          ? 'chapter-container-heading'
          : 'heading-tag',
        `font-family: inherit; font-size: ${size}; font-weight: ${chapterLabel ? 'normal' : 'bold'}; text-indent: 0; text-align: left; margin: ${level === 1 ? '2.8em' : '1.8em'} 0 ${level === 1 ? '1.35em' : '.8em'}; padding: 0 0 ${level === 1 ? '.7em' : '0'}; ${level === 1 && !chapterLabel ? 'border-bottom: .045em solid; ' : ''}page-break-after: avoid; break-after: avoid;`,
      );
      result.styledHeadings++;
      opening = true;
      continue;
    }
    if (element.local === 'hr') {
      assign(
        element,
        'separator',
        'hr-tag',
        'width: 20%; margin: 1.8em auto; border: 0; border-top: .05em solid;',
      );
      result.roleCounts.separator++;
      opening = true;
      continue;
    }
    const items =
      element.local === 'p'
        ? [element]
        : element.local === 'blockquote'
          ? elements.filter(
              (entry) => entry.parent === element && entry.local === 'p',
            )
          : [];
    if (element.local === 'blockquote')
      css.push(
        `${selectorOf(element, body, document)} { margin: 1.2em 5%; padding: 0; }`,
      );
    for (const paragraph of items) {
      const info = roleOf(paragraph, element.local === 'blockquote');
      let role = info.role;
      if (role === 'body' && opening && !info.alignment && !info.noIndent)
        role = 'opening';
      let style =
        'margin-top: .35em; margin-bottom: .35em; orphans: 2; widows: 2; ';
      if (role === 'body')
        style += `text-indent: ${info.noIndent || info.alignment || result.language.policy === 'neutral-prose' ? '0' : result.language.policy === 'english-prose' ? '1.2em' : '2em'}; ${info.alignment ? `text-align: ${info.alignment};` : ''}`;
      if (role === 'opening')
        style += 'text-indent: 0; margin-top: .6em; margin-bottom: .6em;';
      if (role === 'quote') style += 'text-indent: 0; margin: 1em 5%;';
      if (role === 'poem')
        style += 'text-indent: 0; margin: .35em 5%; white-space: pre-line;';
      if (role === 'caption')
        style +=
          'text-indent: 0; text-align: center; font-size: .85em; margin: .6em 0 1em;';
      if (role === 'note')
        style +=
          'text-indent: 0; font-size: .88em; margin-top: .9em; margin-bottom: .9em;';
      if (role === 'separator')
        style += 'text-indent: 0; text-align: center; margin: 1.5em 0;';
      assign(
        paragraph,
        role,
        role === 'opening' ? 'after-heading' : info.source,
        style,
      );
      result.roleCounts[role]++;
      result.styledParagraphs++;
      opening = role === 'separator';
    }
  }
  for (const [element, styles] of emphasis)
    assign(
      element,
      'inline-emphasis',
      'source-css',
      [...styles].map(([key, value]) => `${key}: ${value};`).join(' '),
    );
  result.css = css.join('\n') + '\n';
  return result;
}
