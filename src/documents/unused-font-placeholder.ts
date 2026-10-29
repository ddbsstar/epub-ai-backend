import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postcss, { type AtRule, type Root } from 'postcss';
import { resolveResource, type ArchiveResource } from './epub-archive.js';
import { parseXml } from './epub-xml.js';
import type { EpubLimits, EpubSourceRepair } from './epub.types.js';

export const UNUSED_FONT_PLACEHOLDER_POLICY =
  'unused-font-placeholder-1' as const;
const digest = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
type Item = { path: string; mediaType: string };
export interface UnusedFontPlaceholderRepair {
  css: string;
  record: EpubSourceRepair;
}

/**
 * A deliberately narrow source repair, not a missing-resource fallback.
 * Only a top-level two-descriptor font face with a missing all-X placeholder
 * can be removed, after every font consumer has been proved unused.
 */
export async function unusedFontPlaceholderRepairs(
  resources: Map<string, ArchiveResource>,
  items: Item[],
  limits: EpubLimits,
  signal?: AbortSignal,
): Promise<Map<string, UnusedFontPlaceholderRepair>> {
  const styles: { path?: string; source: string; root: Root }[] = [];
  const classes = new Set<string>();
  const attributeFonts: string[] = [];
  const knownStylesheets = new Set(
    items
      .filter((item) => item.mediaType === 'text/css')
      .map((item) => item.path),
  );
  try {
    for (const item of items) {
      signal?.throwIfAborted();
      if (
        ![
          'text/css',
          'application/xhtml+xml',
          'text/html',
          'image/svg+xml',
        ].includes(item.mediaType)
      )
        continue;
      const resource = resources.get(item.path);
      if (!resource || resource.size > limits.maxXmlBytes) return new Map();
      const bytes = await readFile(resource.filePath);
      if (item.mediaType === 'text/css') {
        const source = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
        styles.push({ path: item.path, source, root: postcss.parse(source) });
      } else {
        const document = parseXml(bytes);
        for (const element of document.elements) {
          if (
            element.local === 'link' &&
            /(?:^|\s)stylesheet(?:\s|$)/iu.test(element.attrs.rel ?? '')
          ) {
            if (
              !element.attrs.href ||
              !knownStylesheets.has(
                resolveResource(item.path, element.attrs.href).path,
              )
            )
              return new Map();
          }
          for (const name of (element.attrs.class ?? '').split(/\s+/u))
            if (name) classes.add(name);
          for (const name of ['font', 'font-family', 'face'])
            if (element.attrs[name]) attributeFonts.push(element.attrs[name]);
          if (element.attrs.style) {
            const source = `x {${element.attrs.style}}`;
            styles.push({ source, root: postcss.parse(source) });
          }
          if (element.local === 'style')
            styles.push({
              source: element.text,
              root: postcss.parse(element.text),
            });
        }
      }
    }
  } catch {
    // Unsupported encodings/syntax continue through the normal strict engine;
    // incomplete evidence must never authorize a repair.
    return new Map();
  }
  let uncertain = false;
  for (const { root } of styles) {
    root.walkAtRules((rule) => {
      if (rule.name.toLowerCase() === 'import') uncertain = true;
    });
    root.walkDecls((declaration) => {
      if (
        /^(?:font(?:-family)?|--)/iu.test(declaration.prop) &&
        /\\|[a-z_-][a-z0-9_-]*\s*\(/iu.test(declaration.value)
      )
        uncertain = true;
    });
  }
  if (
    uncertain ||
    attributeFonts.some((value) => /\\|[a-z_-][a-z0-9_-]*\s*\(/iu.test(value))
  )
    return new Map();
  const repairs = new Map<string, UnusedFontPlaceholderRepair>();
  for (const sheet of styles) {
    if (!sheet.path) continue;
    const candidates: {
      rule: AtRule;
      family: string;
      reference: string;
      start: number;
      end: number;
    }[] = [];
    sheet.root.walkAtRules((rule) => {
      if (
        rule.name.toLowerCase() !== 'font-face' ||
        rule.parent?.type !== 'root'
      )
        return;
      const nodes = (rule.nodes ?? []).filter(
        (node) => node.type !== 'comment',
      );
      if (nodes.length !== 2 || nodes.some((node) => node.type !== 'decl'))
        return;
      const declarations = nodes.filter((node) => node.type === 'decl');
      const family = declarations
        .find((node) => node.prop.toLowerCase() === 'font-family')
        ?.value.match(
          /^(?:([a-z_][a-z0-9_-]*)|"([a-z_][a-z0-9_-]*)"|'([a-z_][a-z0-9_-]*)')$/iu,
        );
      const src = declarations
        .find((node) => node.prop.toLowerCase() === 'src')
        ?.value.match(/^url\(\s*(["']?)(X{8,64})\1\s*\)$/u);
      const start = rule.source?.start?.offset;
      const end = rule.source?.end?.offset;
      if (
        !family ||
        !src ||
        start === undefined ||
        end === undefined ||
        resources.has(resolveResource(sheet.path!, src[2]!).path) ||
        sheet.source.slice(start, end) !== rule.toString()
      )
        return;
      candidates.push({
        rule,
        family: (family[1] ?? family[2] ?? family[3])!,
        reference: src[2]!,
        start,
        end,
      });
    });
    const accepted = candidates.filter((candidate) => {
      const token = new RegExp(
        `(?:^|[^a-z0-9_-])${candidate.family}(?:$|[^a-z0-9_-])`,
        'iu',
      );
      if (attributeFonts.some((value) => token.test(value))) return false;
      let usedOrUncertain = false;
      for (const { root } of styles)
        root.walkDecls((declaration) => {
          if (!token.test(declaration.value)) return;
          if (
            declaration.parent?.type === 'atrule' &&
            declaration.parent.name.toLowerCase() === 'font-face' &&
            declaration.prop.toLowerCase() === 'font-family'
          )
            return;
          if (
            !['font', 'font-family'].includes(declaration.prop.toLowerCase()) ||
            declaration.parent?.type !== 'rule' ||
            declaration.parent.parent?.type !== 'root'
          ) {
            usedOrUncertain = true;
            return;
          }
          for (const selector of declaration.parent.selector.split(',')) {
            const match = selector
              .trim()
              .match(/^(?:[a-z][a-z0-9_-]*)?\.([a-z_][a-z0-9_-]*)$/iu);
            if (!match || classes.has(match[1]!)) usedOrUncertain = true;
          }
        });
      return !usedOrUncertain;
    });
    if (!accepted.length) continue;
    let css = sheet.source;
    for (const candidate of [...accepted].sort((a, b) => b.start - a.start))
      css = css.slice(0, candidate.start) + css.slice(candidate.end);
    repairs.set(sheet.path, {
      css,
      record: {
        path: sheet.path,
        sourceSha256: digest(sheet.source),
        outputSha256: digest(css),
        removedFontFaces: accepted.map((candidate) => ({
          family: candidate.family,
          reference: candidate.reference,
          sourceStart: candidate.start,
          sourceEnd: candidate.end,
          removedSha256: digest(
            sheet.source.slice(candidate.start, candidate.end),
          ),
        })),
      },
    });
  }
  return repairs;
}
