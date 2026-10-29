import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SaxesParser } from 'saxes';
import { prepareReaderCss } from '../layout/reader-first.js';
import { resolveResource, type ArchiveResource } from './epub-archive.js';
import { unusedFontPlaceholderRepairs } from './unused-font-placeholder.js';
import {
  onlyElement,
  parseXml,
  type XmlDocument,
  type XmlElement,
} from './epub-xml.js';
import {
  EPUB_STRUCTURE_ROLES,
  EpubProcessingError,
  type EpubLimits,
  type EpubStructureBlock,
  type EpubStructurePlan,
  type EpubStructureRole,
  type EpubStructureSnapshot,
} from './epub.types.js';

const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const allowedInline = new Set([
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
]);
const complex = new Set([
  'table',
  'pre',
  'svg',
  'math',
  'ruby',
  'audio',
  'video',
  'canvas',
  'blockquote',
  'nav',
]);
const active = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'applet',
]);

function cssText(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    const withoutComments = bytes
      .toString('latin1')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    if (Array.from(withoutComments).some((point) => point.charCodeAt(0) > 127))
      throw new Error('Unsupported CSS encoding');
    return withoutComments;
  }
}

function fail(): never {
  throw new EpubProcessingError(
    'INVALID_STRUCTURE_PLAN',
    'AI 结构方案与原书不匹配，未应用方案',
  );
}

/** Revalidate every role against a fresh, bounded snapshot, including runtime-only extra fields. */
export function validateStructurePlan(
  snapshot: EpubStructureSnapshot,
  value: unknown,
): Map<string, EpubStructureRole> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const plan = value as EpubStructurePlan;
  if (
    Object.keys(plan).some(
      (key) =>
        ![
          'schemaVersion',
          'sourceSha256',
          'snapshotFingerprint',
          'roles',
        ].includes(key),
    ) ||
    plan.schemaVersion !== 1 ||
    plan.sourceSha256 !== snapshot.sourceSha256 ||
    plan.snapshotFingerprint !== snapshot.fingerprint ||
    !Array.isArray(plan.roles) ||
    plan.roles.length !== snapshot.blocks.length
  )
    fail();
  const blocks = new Map(snapshot.blocks.map((block) => [block.id, block]));
  const roles = new Map<string, EpubStructureRole>();
  for (const assignment of plan.roles) {
    if (
      !assignment ||
      typeof assignment !== 'object' ||
      Array.isArray(assignment) ||
      Object.keys(assignment).some((key) => !['id', 'role'].includes(key)) ||
      typeof assignment.id !== 'string' ||
      typeof assignment.role !== 'string'
    )
      fail();
    const block = blocks.get(assignment.id);
    if (
      !block ||
      roles.has(assignment.id) ||
      !block.allowedRoles.includes(assignment.role)
    )
      fail();
    roles.set(assignment.id, assignment.role);
  }
  return roles;
}

function textOf(document: XmlDocument, element: XmlElement): string {
  let text = '';
  const parser = new SaxesParser();
  parser.on('text', (value) => {
    text += value;
  });
  parser.on('cdata', (value) => {
    text += value;
  });
  parser
    .write(
      `<sample>${document.source.slice(element.openingEnd, element.closingStart)}</sample>`,
    )
    .close();
  return text.replace(/\s+/gu, ' ').trim();
}

/** Only inspect plain, top-level paragraphs in documents the deterministic layout can safely style. */
export async function buildStructureSnapshot(
  resources: Map<string, ArchiveResource>,
  sourceSha256: string,
  limits: EpubLimits,
  signal?: AbortSignal,
): Promise<EpubStructureSnapshot> {
  const xml = async (path: string): Promise<XmlDocument> => {
    const resource = resources.get(path);
    if (!resource)
      throw new EpubProcessingError(
        'MISSING_RESOURCE',
        'EPUB 引用了缺失的书内资源',
      );
    if (resource.size > limits.maxXmlBytes)
      throw new EpubProcessingError(
        'DOCUMENT_SIZE_LIMIT',
        '单个文档超出处理限制',
      );
    return parseXml(await readFile(resource.filePath));
  };
  if (
    [...resources.keys()].some((path) =>
      /^META-INF\/(?:encryption|signatures)\.xml$/i.test(path),
    )
  )
    throw new EpubProcessingError(
      'ENCRYPTED_EPUB',
      '首版不支持加密、混淆字体或签名 EPUB',
    );
  const container = await xml('META-INF/container.xml');
  const roots = container.elements.filter(
    (element) =>
      element.local === 'rootfile' &&
      element.attrs['media-type'] === 'application/oebps-package+xml',
  );
  if (roots.length !== 1 || !roots[0].attrs['full-path'])
    throw new EpubProcessingError(
      'INVALID_EPUB_STRUCTURE',
      '首版仅支持单一 EPUB 内容包',
    );
  const packagePath = resolveResource(
    'container.xml',
    roots[0].attrs['full-path'],
  ).path;
  const packageDocument = await xml(packagePath);
  const manifest = onlyElement(packageDocument, 'manifest');
  const spine = onlyElement(packageDocument, 'spine');
  const items = packageDocument.elements.filter(
    (element) => element.parent === manifest && element.local === 'item',
  );
  const byId = new Map(items.map((item) => [item.attrs.id, item]));
  const cssRepairs = await unusedFontPlaceholderRepairs(
    resources,
    items.map((item) => ({
      path: resolveResource(packagePath, item.attrs.href).path,
      mediaType: item.attrs['media-type'],
    })),
    limits,
    signal,
  );
  if (
    packageDocument.elements.some(
      (element) =>
        (element.attrs.property === 'rendition:layout' &&
          element.text.trim() === 'pre-paginated') ||
        (element.attrs.properties ?? '').includes(
          'rendition:layout-pre-paginated',
        ),
    )
  )
    throw new EpubProcessingError(
      'FIXED_LAYOUT_EPUB',
      '首版仅支持可重排文字 EPUB',
    );
  const candidates: {
    block: Omit<EpubStructureBlock, 'excerpt'>;
    text: string;
    priority: number;
    order: number;
    textTruncated: boolean;
  }[] = [];
  let totalCandidates = 0;
  let order = 0;
  const cssSafety = new Map<string, boolean>();
  for (const ref of packageDocument.elements.filter(
    (element) => element.parent === spine && element.local === 'itemref',
  )) {
    signal?.throwIfAborted();
    const item = byId.get(ref.attrs.idref);
    if (
      !item ||
      !['application/xhtml+xml', 'text/html'].includes(item.attrs['media-type'])
    )
      throw new EpubProcessingError(
        'UNSUPPORTED_SPINE',
        '阅读顺序中存在不支持的文档类型',
      );
    const path = resolveResource(packagePath, item.attrs.href).path;
    const document = await xml(path);
    const body = onlyElement(document, 'body');
    if (
      body.uri !== 'http://www.w3.org/1999/xhtml' ||
      (item.attrs.properties ?? '').split(/\s+/).includes('nav')
    )
      continue;
    if (
      document.elements.some(
        (element) =>
          complex.has(element.local) ||
          active.has(element.local.toLowerCase()) ||
          element.attrs.style ||
          element.local === 'style' ||
          element.local === 'base' ||
          element.attrs['xml:base'] ||
          Object.keys(element.attrs).some((name) => /^on[a-z]/i.test(name)) ||
          ((element.local === 'div' ||
            element.local === 'body' ||
            /^h[12]$/.test(element.local)) &&
            element.attrs.class),
      )
    )
      continue;
    let unsafeCss = false;
    for (const link of document.elements.filter(
      (element) =>
        element.local === 'link' &&
        /(?:^|\s)stylesheet(?:\s|$)/i.test(element.attrs.rel ?? ''),
    )) {
      if (!link.attrs.href) {
        unsafeCss = true;
        break;
      }
      const cssPath = resolveResource(path, link.attrs.href).path;
      if (!cssSafety.has(cssPath)) {
        const resource = resources.get(cssPath);
        if (!resource || resource.size > limits.maxXmlBytes) {
          unsafeCss = true;
          break;
        }
        try {
          cssSafety.set(
            cssPath,
            !prepareReaderCss(
              cssRepairs.get(cssPath)?.css ??
                cssText(await readFile(resource.filePath)),
            ).complex,
          );
        } catch {
          cssSafety.set(cssPath, false);
        }
      }
      if (!cssSafety.get(cssPath)) {
        unsafeCss = true;
        break;
      }
    }
    if (unsafeCss) continue;
    const children = document.elements.filter(
      (element) => element.parent === body,
    );
    const elementIndexes = new Map(
      document.elements.map((element, index) => [element, index]),
    );
    for (const [index, element] of children.entries()) {
      if (element.local !== 'p' || element.uri !== body.uri) continue;
      let unsafeDescendant = false;
      for (
        let descendantIndex = elementIndexes.get(element)! + 1;
        descendantIndex < document.elements.length;
        descendantIndex++
      ) {
        const child = document.elements[descendantIndex];
        if (child.start >= element.end) break;
        if (!allowedInline.has(child.local) || child.uri !== body.uri) {
          unsafeDescendant = true;
          break;
        }
      }
      if (unsafeDescendant) continue;
      const text = textOf(document, element);
      if (!text) continue;
      const points = Array.from(text).length;
      const originalClass = element.attrs.class ?? '';
      const priority = originalClass
        ? 3
        : points <= 120
          ? 2
          : index <= 2
            ? 1
            : 0;
      if (!priority || (!originalClass && points > 240)) continue;
      const contentSha256 = hash(
        document.source.slice(element.start, element.end),
      );
      const position = {
        childIndex: index + 1,
        start: element.start,
        end: element.end,
      };
      const block = {
        id: hash(
          JSON.stringify([sourceSha256, path, position, contentSha256]),
        ).slice(0, 32),
        documentPath: path,
        position,
        contentSha256,
        originalClass: Array.from(originalClass).slice(0, 200).join(''),
        allowedRoles: [...EPUB_STRUCTURE_ROLES],
      };
      totalCandidates++;
      candidates.push({
        block,
        text: Array.from(text).slice(0, 240).join(''),
        priority,
        order: order++,
        textTruncated: points > 240,
      });
      candidates.sort((a, b) => b.priority - a.priority || a.order - b.order);
      if (candidates.length > 32) candidates.pop();
    }
  }
  const blocks: EpubStructureBlock[] = [];
  let remainingBytes = 16 * 1024;
  for (const candidate of candidates.sort((a, b) => a.order - b.order)) {
    let excerpt = '';
    for (const point of candidate.text) {
      const size = Buffer.byteLength(point);
      if (size > remainingBytes) break;
      excerpt += point;
      remainingBytes -= size;
    }
    if (!excerpt) break;
    blocks.push({ ...candidate.block, excerpt });
  }
  const truncated =
    totalCandidates > blocks.length ||
    candidates.some(
      (candidate, index) =>
        candidate.textTruncated || blocks[index]?.excerpt !== candidate.text,
    );
  const snapshot = {
    schemaVersion: 1 as const,
    analyzerVersion: 'structure-samples-1' as const,
    sourceSha256,
    blocks,
    truncated,
  };
  return { ...snapshot, fingerprint: hash(JSON.stringify(snapshot)) };
}
