import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SaxesParser } from 'saxes';
import { hashFile, resolveResource, unpackArchive } from './epub-archive.js';
import {
  DEFAULT_EPUB_LIMITS,
  EpubProcessingError,
  type EpubLimits,
} from './epub.types.js';
import {
  onlyElement,
  parseXml,
  type XmlDocument,
  type XmlElement,
} from './epub-xml.js';

export const ILLUSTRATION_CHAPTER_PARSER_VERSION = 'illustration-chapters-1';
const LEGACY_SECTION_INDEX_VERSION = 'illustration-sections-2';
export const ILLUSTRATION_SECTION_PARSER_VERSION = 'illustration-sections-3';
const XHTML = 'http://www.w3.org/1999/xhtml';
const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const chapterLabel =
  /^(?:第[\d一二三四五六七八九十百千万零〇两]+章|chapter\s+[\divxlc]+)/iu;
const frontMatterLabel =
  /^(?:封面|扉页|书名页|版权(?:页|信息)?|目录|注释|注解|尾注|脚注|参考文献|索引|cover|title\s*page|copyright(?:\s*page)?|contents|table\s+of\s+contents|notes?|endnotes?|footnotes?|references|index)$/iu;
const inline = new Set([
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

export interface IllustrationChapterLimits extends EpubLimits {
  maxChapterTextBytes: number;
  maxChapterBlocks: number;
}

export interface IllustrationChapterBlock {
  id: string;
  text: string;
  documentPath: string;
  /** UTF-16 code-unit offsets into the original, decoded UTF-8 XHTML. */
  start: number;
  end: number;
  /** SHA-256 of the original element, including its tags, encoded as UTF-8. */
  contentSha256: string;
  order: number;
  kind: 'paragraph' | 'heading';
}

export interface IllustrationChapterAnchor {
  id: string;
  kind: 'after-paragraph' | 'chapter-end';
  documentPath: string;
  blockId: string;
  sourceStart: number;
  sourceEnd: number;
  contentSha256: string;
  readingOrder: number;
}

export interface IllustrationChapterIndex {
  schemaVersion: 1;
  parserVersion:
    | typeof ILLUSTRATION_CHAPTER_PARSER_VERSION
    | typeof LEGACY_SECTION_INDEX_VERSION
    | typeof ILLUSTRATION_SECTION_PARSER_VERSION;
  sourceSha256: string;
  chapterId: string;
  chapterIndex: number;
  scope?: 'section';
  sectionId?: string;
  parentChapterId?: string;
  parentChapterTitle?: string;
  boundaryKind?: 'heading' | 'document';
  title: string;
  covered: 'COMPLETE';
  documents: {
    documentPath: string;
    sha256: string;
    spineIndex: number;
    start: number;
    end: number;
  }[];
  blocks: IllustrationChapterBlock[];
  anchors: IllustrationChapterAnchor[];
}

export interface IllustrationCatalogChapter {
  id: string;
  /** The index accepted by inspectIllustrationChapter; -1 for non-chapter entries. */
  index: number;
  title: string;
  /** Zero-based navigation nesting depth. */
  level: number;
  selectable: boolean;
  reasonCode: string | null;
  scope?: 'chapter' | 'section';
  sectionId?: string;
  parentChapterTitle?: string;
  boundaryKind?: 'heading' | 'document';
}

export interface IllustrationCatalog {
  parserVersion:
    | typeof ILLUSTRATION_CHAPTER_PARSER_VERSION
    | typeof ILLUSTRATION_SECTION_PARSER_VERSION;
  sourceSha256: string;
  title: string | null;
  chapters: IllustrationCatalogChapter[];
}

interface SpineDocument {
  documentPath: string;
  document: XmlDocument;
  body: XmlElement;
  spineIndex: number;
  sha256: string;
  unsupportedCode?: string;
}

interface NavigationTarget {
  label: string;
  reference: string;
  hierarchical: boolean;
}

interface CatalogTarget {
  label: string;
  reference: string | null;
  level: number;
  hierarchical: boolean;
}

interface ChapterStart {
  document: SpineDocument;
  heading: XmlElement;
  title: string;
}

function fail(code = 'UNSUPPORTED_CHAPTER_STRUCTURE'): never {
  throw new EpubProcessingError(
    code,
    '章节结构不受支持或存在歧义，未提取不完整章节',
  );
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
  parser.on('opentag', (tag) => {
    if (tag.name.toLowerCase() === 'br') text += '\n';
  });
  parser
    .write(
      `<sample>${document.source.slice(element.openingEnd, element.closingStart)}</sample>`,
    )
    .close();
  return text
    .replace(/[\t\r ]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .trim();
}

function navigationTargets(
  document: XmlDocument,
  type: 'ncx' | 'nav',
): NavigationTarget[] {
  if (type === 'ncx') {
    const navMap = onlyElement(document, 'navMap');
    return document.elements
      .filter(
        (element) => element.parent === navMap && element.local === 'navPoint',
      )
      .map((point) => {
        const label = document.elements.find(
          (element) =>
            element.parent?.parent === point && element.local === 'text',
        );
        const content = document.elements.find(
          (element) => element.parent === point && element.local === 'content',
        );
        if (!label || !content?.attrs.src) fail('AMBIGUOUS_CHAPTER_NAVIGATION');
        return {
          label: textOf(document, label),
          reference: content.attrs.src,
          hierarchical: document.elements.some(
            (element) =>
              element.parent === point && element.local === 'navPoint',
          ),
        };
      });
  }
  const toc = document.elements.filter(
    (element) =>
      element.local === 'nav' &&
      (element.attrs['epub:type'] ?? element.attrs.type ?? '')
        .split(/\s+/u)
        .includes('toc'),
  );
  if (toc.length !== 1) fail('AMBIGUOUS_CHAPTER_NAVIGATION');
  const lists = document.elements.filter(
    (element) => element.parent === toc[0] && element.local === 'ol',
  );
  if (lists.length !== 1) fail('AMBIGUOUS_CHAPTER_NAVIGATION');
  return document.elements
    .filter((element) => element.parent === lists[0] && element.local === 'li')
    .map((item) => {
      const links = document.elements.filter(
        (element) => element.parent === item && element.local === 'a',
      );
      if (links.length !== 1 || !links[0].attrs.href)
        fail('AMBIGUOUS_CHAPTER_NAVIGATION');
      return {
        label: textOf(document, links[0]),
        reference: links[0].attrs.href,
        hierarchical: document.elements.some(
          (element) => element.parent === item && element.local === 'ol',
        ),
      };
    });
}

/** Retain every navigation row for display; strict resolution decides selectability. */
function catalogTargets(
  document: XmlDocument,
  type: 'ncx' | 'nav',
): CatalogTarget[] {
  const rows: CatalogTarget[] = [];
  const points = document.elements.filter((element) =>
    type === 'ncx'
      ? element.local === 'navPoint'
      : element.local === 'li' &&
        (() => {
          let parent = element.parent;
          while (parent) {
            if (
              parent.local === 'nav' &&
              (parent.attrs['epub:type'] ?? parent.attrs.type ?? '')
                .split(/\s+/u)
                .includes('toc')
            )
              return true;
            parent = parent.parent;
          }
          return false;
        })(),
  );
  for (const point of points) {
    let level = 0;
    let ancestor = point.parent;
    while (ancestor) {
      if (ancestor.local === (type === 'ncx' ? 'navPoint' : 'li')) level++;
      ancestor = ancestor.parent;
    }
    const label = document.elements.find((element) =>
      type === 'ncx'
        ? element.parent?.parent === point && element.local === 'text'
        : element.parent === point &&
          (element.local === 'a' || element.local === 'span'),
    );
    const link =
      type === 'ncx'
        ? document.elements.find(
            (element) =>
              element.parent === point && element.local === 'content',
          )
        : document.elements.find(
            (element) => element.parent === point && element.local === 'a',
          );
    rows.push({
      label: label ? textOf(document, label) : '',
      reference: (type === 'ncx' ? link?.attrs.src : link?.attrs.href) || null,
      level,
      hierarchical: document.elements.some(
        (element) =>
          element.parent === point &&
          element.local === (type === 'ncx' ? 'navPoint' : 'ol'),
      ),
    });
  }
  return rows;
}

/**
 * Conservative logical-chapter index, independent of the 32-paragraph AI sample.
 * Supports navigation-bound top-level h1 chapters and plain top-level prose.
 * Nested prose, ambiguous navigation, fixed layout and partial coverage fail closed.
 * The source is read only; private temporary archive resources are always removed.
 */
async function inspectIllustrationSource(options: {
  sourcePath: string;
  chapterIndex?: number;
  sectionId?: string;
  scope?: 'section';
  catalog?: boolean;
  limits?: Partial<IllustrationChapterLimits>;
  signal?: AbortSignal;
}): Promise<IllustrationChapterIndex | IllustrationCatalog> {
  const { signal } = options;
  signal?.throwIfAborted();
  if (
    !options.catalog &&
    (!Number.isSafeInteger(options.chapterIndex) || options.chapterIndex! < 0)
  )
    fail('INVALID_CHAPTER_INDEX');
  const limits: IllustrationChapterLimits = {
    ...DEFAULT_EPUB_LIMITS,
    maxChapterTextBytes: 2 * 1024 * 1024,
    maxChapterBlocks: 20_000,
    ...options.limits,
  };
  if (
    Object.values(limits).some(
      (value) => !Number.isSafeInteger(value) || value <= 0,
    )
  )
    fail('INVALID_CHAPTER_LIMITS');
  const scratch = await mkdtemp(join(tmpdir(), 'epub-illustration-index-'));
  try {
    const sourceStat = await stat(options.sourcePath);
    if (!sourceStat.isFile() || sourceStat.size > limits.maxSourceBytes)
      fail('SOURCE_SIZE_LIMIT');
    const sourceSha256 = await hashFile(options.sourcePath, signal);
    const resources = await unpackArchive(
      options.sourcePath,
      scratch,
      limits,
      signal,
    );
    if (
      [...resources.keys()].some((name) =>
        /^META-INF\/(?:encryption|signatures)\.xml$/iu.test(name),
      )
    )
      fail('ENCRYPTED_EPUB');
    const xmlCache = new Map<string, XmlDocument>();
    const xml = async (path: string): Promise<XmlDocument> => {
      signal?.throwIfAborted();
      const resource = resources.get(path);
      if (!resource) fail('MISSING_RESOURCE');
      if (resource.size > limits.maxXmlBytes) fail('DOCUMENT_SIZE_LIMIT');
      const existing = xmlCache.get(path);
      if (existing) return existing;
      const document = parseXml(await readFile(resource.filePath));
      xmlCache.set(path, document);
      return document;
    };
    const container = await xml('META-INF/container.xml');
    const roots = container.elements.filter(
      (element) =>
        element.local === 'rootfile' &&
        element.attrs['media-type'] === 'application/oebps-package+xml',
    );
    if (roots.length !== 1 || !roots[0].attrs['full-path'])
      fail('INVALID_EPUB_STRUCTURE');
    const packagePath = resolveResource(
      'container.xml',
      roots[0].attrs['full-path'],
    ).path;
    const packageDocument = await xml(packagePath);
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
      fail('FIXED_LAYOUT_EPUB');
    const manifest = onlyElement(packageDocument, 'manifest');
    const spine = onlyElement(packageDocument, 'spine');
    const items = packageDocument.elements.filter(
      (element) => element.parent === manifest && element.local === 'item',
    );
    const byId = new Map(items.map((item) => [item.attrs.id, item]));
    if (
      byId.size !== items.length ||
      items.some((item) => !item.attrs.id || !item.attrs.href)
    )
      fail('INVALID_EPUB_STRUCTURE');
    const documents: SpineDocument[] = [];
    const seen = new Set<string>();
    for (const ref of packageDocument.elements.filter(
      (element) => element.parent === spine && element.local === 'itemref',
    )) {
      if (ref.attrs.linear === 'no') continue;
      const item = byId.get(ref.attrs.idref);
      if (
        !item ||
        !['application/xhtml+xml', 'text/html'].includes(
          item.attrs['media-type'],
        )
      )
        fail('UNSUPPORTED_SPINE');
      if ((item.attrs.properties ?? '').split(/\s+/u).includes('nav')) continue;
      const documentPath = resolveResource(packagePath, item.attrs.href).path;
      if (seen.has(documentPath)) fail('AMBIGUOUS_CHAPTER_NAVIGATION');
      seen.add(documentPath);
      const document = await xml(documentPath);
      const body = onlyElement(document, 'body');
      let unsupportedCode: string | undefined;
      if (body.uri !== XHTML) unsupportedCode = 'UNSUPPORTED_CHAPTER_STRUCTURE';
      if (
        document.elements.some(
          (element) =>
            /^(?:script|iframe|object|embed|form|input|button|applet|base)$/iu.test(
              element.local,
            ) ||
            element.attrs['xml:base'] ||
            Object.keys(element.attrs).some((name) => /^on[a-z]/iu.test(name)),
        )
      )
        unsupportedCode = 'ACTIVE_CONTENT';
      if (unsupportedCode && !options.catalog) fail(unsupportedCode);
      documents.push({
        unsupportedCode,
        documentPath,
        document,
        body,
        spineIndex: documents.length,
        sha256: resources.get(documentPath)!.sha256,
      });
    }
    const byPath = new Map(
      documents.map((document) => [document.documentPath, document]),
    );
    const navigation = items.filter(
      (item) =>
        item.attrs['media-type'] === 'application/x-dtbncx+xml' ||
        (item.attrs.properties ?? '').split(/\s+/u).includes('nav'),
    );
    let starts: ChapterStart[] = [];
    let articleMode = false;
    let navigationError: string | null = null;
    try {
      if (navigation.length === 0 || navigation.length > 2)
        fail('AMBIGUOUS_CHAPTER_NAVIGATION');
      if (
        navigation.filter(
          (item) => item.attrs['media-type'] === 'application/x-dtbncx+xml',
        ).length > 1 ||
        navigation.filter((item) =>
          (item.attrs.properties ?? '').split(/\s+/u).includes('nav'),
        ).length > 1
      )
        fail('AMBIGUOUS_CHAPTER_NAVIGATION');
      const targetSets: NavigationTarget[][] = [];
      for (const item of navigation) {
        const path = resolveResource(packagePath, item.attrs.href).path;
        const nav = await xml(path);
        targetSets.push(
          navigationTargets(
            nav,
            item.attrs['media-type'] === 'application/x-dtbncx+xml'
              ? 'ncx'
              : 'nav',
          ),
        );
      }
      // A flat essay collection can have source-bound h1 article titles without
      // numbered chapters. Never mix this fallback into a numbered/hierarchical
      // book or manufacture a whole-book section from arbitrary body text.
      articleMode = targetSets.every((targets) =>
        targets.every(
          (target) => !chapterLabel.test(target.label) && !target.hierarchical,
        ),
      );
      const sets: ChapterStart[][] = [];
      for (const [navIndex, targets] of targetSets.entries()) {
        const path = resolveResource(
          packagePath,
          navigation[navIndex]!.attrs.href,
        ).path;
        const starts: ChapterStart[] = [];
        for (const target of targets) {
          const resolved = resolveResource(path, target.reference);
          const candidate = articleMode
            ? !frontMatterLabel.test(target.label)
            : chapterLabel.test(target.label) || target.hierarchical;
          if (!candidate) continue;
          const entry = byPath.get(resolved.path);
          if (!entry) {
            fail('AMBIGUOUS_CHAPTER_NAVIGATION');
          }
          const heading = resolved.fragment
            ? entry.document.elements.find(
                (element) => element.attrs.id === resolved.fragment,
              )
            : entry.document.elements.find(
                (element) =>
                  element.parent === entry?.body && element.local === 'h1',
              );
          if (
            !heading ||
            heading.local !== 'h1' ||
            heading.parent !== entry.body ||
            heading.uri !== XHTML ||
            textOf(entry.document, heading) !== target.label
          )
            fail('AMBIGUOUS_CHAPTER_NAVIGATION');
          if (
            starts.some(
              (start) => start.document === entry && start.heading === heading,
            )
          )
            fail('AMBIGUOUS_CHAPTER_NAVIGATION');
          const previous = starts.at(-1);
          if (
            previous &&
            (previous.document.spineIndex > entry.spineIndex ||
              (previous.document === entry &&
                previous.heading.start >= heading.start))
          )
            fail('AMBIGUOUS_CHAPTER_NAVIGATION');
          starts.push({ document: entry, heading, title: target.label });
        }
        if (!starts.length) fail('AMBIGUOUS_CHAPTER_NAVIGATION');
        sets.push(starts);
      }
      starts = sets[0];
      if (
        sets.some(
          (set) =>
            JSON.stringify(
              set.map((start) => [
                start.document.documentPath,
                start.heading.start,
              ]),
            ) !==
            JSON.stringify(
              starts.map((start) => [
                start.document.documentPath,
                start.heading.start,
              ]),
            ),
        )
      )
        fail('AMBIGUOUS_CHAPTER_NAVIGATION');
      for (const entry of documents) {
        for (const heading of entry.document.elements.filter(
          (element) =>
            element.parent === entry.body &&
            element.local === 'h1' &&
            (articleMode
              ? !frontMatterLabel.test(textOf(entry.document, element))
              : chapterLabel.test(textOf(entry.document, element))),
        )) {
          if (
            !starts.some(
              (start) => start.document === entry && start.heading === heading,
            )
          )
            fail('AMBIGUOUS_CHAPTER_NAVIGATION');
        }
      }
    } catch (error) {
      if (!options.catalog || !(error instanceof EpubProcessingError))
        throw error;
      navigationError = error.code;
    }
    const buildChapter = (chapterIndex: number): IllustrationChapterIndex => {
      const start = starts[chapterIndex];
      const next = starts[chapterIndex + 1];
      if (!start) fail('INVALID_CHAPTER_INDEX');
      const chapterId = chapterIdOf(sourceSha256, start);
      const result: IllustrationChapterIndex = {
        schemaVersion: 1,
        parserVersion: ILLUSTRATION_CHAPTER_PARSER_VERSION,
        sourceSha256,
        chapterId,
        chapterIndex,
        title: start.title,
        covered: 'COMPLETE',
        documents: [],
        blocks: [],
        anchors: [],
      };
      let textBytes = 0;
      let lastElement: XmlElement | undefined;
      for (const entry of documents) {
        if (
          entry.spineIndex < start.document.spineIndex ||
          (next && entry.spineIndex > next.document.spineIndex)
        )
          continue;
        if (entry.unsupportedCode) fail(entry.unsupportedCode);
        const rangeStart =
          entry === start.document
            ? start.heading.start
            : entry.body.openingEnd;
        const rangeEnd =
          entry === next?.document
            ? next.heading.start
            : entry.body.closingStart;
        if (rangeStart >= rangeEnd) continue;
        const children = entry.document.elements.filter(
          (element) =>
            element.parent === entry.body &&
            element.start >= rangeStart &&
            element.end <= rangeEnd,
        );
        // No silent skipping of body text or nested prose is allowed under COMPLETE.
        let outside = entry.document.source.slice(rangeStart, rangeEnd);
        for (const child of [...children].reverse())
          outside =
            outside.slice(0, child.start - rangeStart) +
            outside.slice(child.end - rangeStart);
        if (outside.replace(/<!--[\s\S]*?-->/gu, '').trim()) fail();
        if (!children.length) continue;
        result.documents.push({
          documentPath: entry.documentPath,
          sha256: entry.sha256,
          spineIndex: entry.spineIndex,
          start: rangeStart,
          end: rangeEnd,
        });
        for (const element of children) {
          signal?.throwIfAborted();
          lastElement = element;
          if (element.local === 'h1' && element !== start.heading) fail();
          const descendants = entry.document.elements.filter(
            (child) => child.start > element.start && child.end <= element.end,
          );
          const text = textOf(entry.document, element);
          const nonProseDecoration =
            articleMode &&
            element.local === 'div' &&
            !text &&
            descendants.every(
              (child) =>
                /^(?:img|br)$/u.test(child.local) && child.uri === XHTML,
            );
          if (
            (!/^(?:p|h[1-6]|hr|img)$/u.test(element.local) &&
              !nonProseDecoration) ||
            element.uri !== XHTML
          )
            fail();
          if (
            descendants.some(
              (child) => !inline.has(child.local) || child.uri !== XHTML,
            )
          )
            fail();
          if (!text) continue;
          textBytes += Buffer.byteLength(text);
          if (
            textBytes > limits.maxChapterTextBytes ||
            result.blocks.length >= limits.maxChapterBlocks
          )
            fail('CHAPTER_TEXT_LIMIT');
          const contentSha256 = hash(
            entry.document.source.slice(element.start, element.end),
          );
          const block: IllustrationChapterBlock = {
            id: hash(
              JSON.stringify([
                chapterId,
                entry.documentPath,
                element.start,
                element.end,
                contentSha256,
              ]),
            ),
            text,
            documentPath: entry.documentPath,
            start: element.start,
            end: element.end,
            contentSha256,
            order: result.blocks.length,
            kind: element.local === 'p' ? 'paragraph' : 'heading',
          };
          result.blocks.push(block);
          if (
            element.local === 'p' &&
            !descendants.some((child) => child.local === 'img') &&
            !/(?:footnote|endnote)/iu.test(
              `${element.attrs['epub:type'] ?? ''} ${element.attrs.role ?? ''}`,
            )
          ) {
            result.anchors.push({
              id: hash(JSON.stringify([block.id, 'after-paragraph'])),
              kind: 'after-paragraph',
              documentPath: entry.documentPath,
              blockId: block.id,
              sourceStart: element.start,
              sourceEnd: element.end,
              contentSha256,
              readingOrder: block.order,
            });
          }
        }
      }
      if (!result.blocks.length || !result.anchors.length)
        fail('NO_SAFE_ILLUSTRATION_ANCHOR');
      const lastBlock = result.blocks.at(-1)!;
      const lastAnchor = result.anchors.at(-1)!;
      if (
        lastAnchor.blockId === lastBlock.id &&
        lastElement?.local === 'p' &&
        lastElement.start === lastBlock.start &&
        lastElement.end === lastBlock.end
      ) {
        result.anchors.push({
          ...lastAnchor,
          id: hash(JSON.stringify([lastBlock.id, 'chapter-end'])),
          kind: 'chapter-end',
        });
      }
      return result;
    };
    let result: IllustrationChapterIndex | IllustrationCatalog;
    if (!options.catalog) {
      result = buildChapter(options.chapterIndex!);
      if (options.sectionId !== undefined) {
        const section = sectionIndexes(result, articleMode).find(
          (entry) => entry.sectionId === options.sectionId,
        );
        if (!section) fail('INVALID_ILLUSTRATION_SECTION');
        result = section;
      }
    } else {
      const rows: { target: CatalogTarget; path: string }[] = [];
      // Display one representation; strict discovery checked all navigation copies.
      const firstNavigation = navigation[0];
      if (firstNavigation) {
        const path = resolveResource(
          packagePath,
          firstNavigation.attrs.href,
        ).path;
        for (const target of catalogTargets(
          await xml(path),
          firstNavigation.attrs['media-type'] === 'application/x-dtbncx+xml'
            ? 'ncx'
            : 'nav',
        ))
          rows.push({ target, path });
      }
      const chapters: IllustrationCatalogChapter[] = [];
      const representedHeadings = new Set<XmlElement>();
      // Match the existing single-chapter contract's whole-spine admission rule.
      const sourceError = documents.find(
        (entry) => entry.unsupportedCode,
      )?.unsupportedCode;
      for (const { target, path } of rows) {
        let start: ChapterStart | undefined;
        let heading: XmlElement | undefined;
        let entry: SpineDocument | undefined;
        let resolutionError: string | null = null;
        if (target.reference) {
          try {
            const resolved = resolveResource(path, target.reference);
            entry = byPath.get(resolved.path);
            heading = resolved.fragment
              ? entry?.document.elements.find(
                  (element) => element.attrs.id === resolved.fragment,
                )
              : entry?.document.elements.find(
                  (element) =>
                    element.parent === entry?.body && element.local === 'h1',
                );
            start = starts.find(
              (candidate) =>
                candidate.document === entry && candidate.heading === heading,
            );
            if (heading) representedHeadings.add(heading);
          } catch (error) {
            if (!(error instanceof EpubProcessingError)) throw error;
            resolutionError = error.code;
          }
        }
        const candidate =
          target.level === 0 &&
          (articleMode
            ? !frontMatterLabel.test(target.label)
            : chapterLabel.test(target.label) || target.hierarchical);
        let reasonCode = candidate
          ? (navigationError ?? sourceError ?? resolutionError)
          : 'NOT_LOGICAL_CHAPTER';
        if (candidate && !start && !reasonCode)
          reasonCode = 'AMBIGUOUS_CHAPTER_NAVIGATION';
        const index = candidate && start ? starts.indexOf(start) : -1;
        if (candidate && start && !reasonCode) {
          try {
            buildChapter(index);
          } catch (error) {
            if (!(error instanceof EpubProcessingError)) throw error;
            reasonCode = error.code;
          }
        }
        chapters.push({
          id:
            start && candidate
              ? chapterIdOf(sourceSha256, start)
              : hash(
                  JSON.stringify([
                    ILLUSTRATION_CHAPTER_PARSER_VERSION,
                    sourceSha256,
                    path,
                    target.reference,
                    chapters.length,
                  ]),
                ),
          index,
          title: target.label || '未命名目录项',
          level: target.level,
          selectable: candidate && !!start && !reasonCode,
          reasonCode,
        });
      }
      // Do not silently lose source chapter boundaries missing from navigation.
      for (const entry of documents) {
        for (const heading of entry.document.elements.filter(
          (element) =>
            element.parent === entry.body &&
            element.local === 'h1' &&
            (articleMode
              ? !frontMatterLabel.test(textOf(entry.document, element))
              : chapterLabel.test(textOf(entry.document, element))),
        )) {
          if (representedHeadings.has(heading)) continue;
          chapters.push({
            id: chapterIdOf(sourceSha256, {
              document: entry,
              heading,
              title: textOf(entry.document, heading),
            }),
            index: -1,
            title: textOf(entry.document, heading),
            level: 0,
            selectable: false,
            reasonCode: 'AMBIGUOUS_CHAPTER_NAVIGATION',
          });
        }
      }
      const titleElement = packageDocument.elements.find(
        (element) =>
          element.local === 'title' &&
          element.uri === 'http://purl.org/dc/elements/1.1/',
      );
      result = {
        parserVersion: ILLUSTRATION_CHAPTER_PARSER_VERSION,
        sourceSha256,
        title: titleElement
          ? textOf(packageDocument, titleElement) || null
          : null,
        chapters:
          options.scope === 'section'
            ? chapters
                .flatMap((row) => {
                  if (!row.selectable) return [row];
                  const parent = {
                    ...row,
                    selectable: false,
                    reasonCode: 'SECTION_SELECTION_REQUIRED',
                    scope: 'chapter' as const,
                  };
                  const sections = sectionIndexes(
                    buildChapter(row.index),
                    articleMode,
                  );
                  return [
                    parent,
                    ...sections.map((section) => ({
                      id: section.sectionId!,
                      index: row.index,
                      title: section.title,
                      level: row.level + 1,
                      selectable: true,
                      reasonCode: null,
                      scope: 'section' as const,
                      sectionId: section.sectionId!,
                      parentChapterTitle: row.title,
                      boundaryKind: section.boundaryKind,
                    })),
                  ];
                })
                .filter(
                  (row) =>
                    row.scope || row.reasonCode !== 'NOT_LOGICAL_CHAPTER',
                )
            : chapters,
      };
      if (options.scope === 'section')
        result.parserVersion = ILLUSTRATION_SECTION_PARSER_VERSION;
    }
    if ((await hashFile(options.sourcePath, signal)) !== sourceSha256)
      fail('SOURCE_CHANGED');
    return result;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function chapterIdOf(sourceSha256: string, start: ChapterStart) {
  return hash(
    JSON.stringify([
      ILLUSTRATION_CHAPTER_PARSER_VERSION,
      sourceSha256,
      start.document.documentPath,
      start.heading.start,
    ]),
  );
}

/** Split only at actual heading/document boundaries, never invented text chunks. */
function sectionIndexes(
  chapter: IllustrationChapterIndex,
  articleMode = false,
): IllustrationChapterIndex[] {
  const parserVersion = articleMode
    ? ILLUSTRATION_SECTION_PARSER_VERSION
    : LEGACY_SECTION_INDEX_VERSION;
  const groups: IllustrationChapterBlock[][] = [];
  let current: IllustrationChapterBlock[] = [];
  for (const block of chapter.blocks) {
    const previous = current.at(-1);
    const isSectionHeading =
      block.kind === 'heading' && block !== chapter.blocks[0];
    if (
      previous &&
      (isSectionHeading || previous.documentPath !== block.documentPath)
    ) {
      // A chapter heading directly followed by its first section heading is metadata,
      // not an empty selectable section.
      if (current.some((entry) => entry.kind === 'paragraph'))
        groups.push(current);
      current = [];
    }
    current.push(block);
  }
  if (current.some((entry) => entry.kind === 'paragraph')) groups.push(current);
  return groups.flatMap((blocks, ordinal) => {
    const first = blocks[0]!;
    const last = blocks.at(-1)!;
    const titleBlock = blocks.find(
      (block) => block.kind === 'heading' && block !== chapter.blocks[0],
    );
    // Endnote/appendix-like sections are not prose illustration targets.
    if (
      titleBlock &&
      /^(?:注释|注解|尾注|脚注|参考文献|索引|notes?|endnotes?|footnotes?|references|index)$/iu.test(
        titleBlock.text.trim(),
      )
    )
      return [];
    const ids = new Set(blocks.map((block) => block.id));
    const anchors = chapter.anchors.filter(
      (anchor) => anchor.kind === 'after-paragraph' && ids.has(anchor.blockId),
    );
    if (!anchors.length) return [];
    const sectionId = hash(
      JSON.stringify([
        parserVersion,
        chapter.sourceSha256,
        chapter.chapterId,
        first.documentPath,
        first.start,
        last.documentPath,
        last.end,
      ]),
    );
    const documents = chapter.documents
      .filter((document) =>
        blocks.some((block) => block.documentPath === document.documentPath),
      )
      .map((document) => {
        const scoped = blocks.filter(
          (block) => block.documentPath === document.documentPath,
        );
        return {
          ...document,
          start: scoped[0]!.start,
          end: scoped.at(-1)!.end,
        };
      });
    return [
      {
        ...chapter,
        parserVersion,
        scope: 'section' as const,
        sectionId,
        chapterId: sectionId,
        parentChapterId: chapter.chapterId,
        parentChapterTitle: chapter.title,
        boundaryKind: titleBlock ? ('heading' as const) : ('document' as const),
        title:
          titleBlock?.text ??
          (articleMode && groups.length === 1
            ? chapter.title
            : `${chapter.title} · 第${ordinal + 1}节（文档边界）`),
        documents,
        blocks,
        anchors,
      },
    ];
  });
}

/** One archive extraction and navigation/spine enumeration, without model calls. */
export async function inspectIllustrationCatalog(options: {
  sourcePath: string;
  scope?: 'section';
  limits?: Partial<IllustrationChapterLimits>;
  signal?: AbortSignal;
}): Promise<IllustrationCatalog> {
  return (await inspectIllustrationSource({
    ...options,
    catalog: true,
  })) as IllustrationCatalog;
}

export async function inspectIllustrationChapter(options: {
  sourcePath: string;
  chapterIndex: number;
  sectionId?: string;
  limits?: Partial<IllustrationChapterLimits>;
  signal?: AbortSignal;
}): Promise<IllustrationChapterIndex> {
  return (await inspectIllustrationSource(options)) as IllustrationChapterIndex;
}
