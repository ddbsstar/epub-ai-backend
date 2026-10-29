import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildStructureSnapshot,
  validateStructurePlan,
} from './epub-structure.js';
import {
  unusedFontPlaceholderRepairs,
  UNUSED_FONT_PLACEHOLDER_POLICY,
} from './unused-font-placeholder.js';
import {
  hashFile,
  resolveResource,
  unpackArchive,
  writeArchive,
  type ArchiveResource,
} from './epub-archive.js';
import {
  attributeEscape,
  onlyElement,
  parseXml,
  type XmlDocument,
} from './epub-xml.js';
import {
  DEFAULT_EPUB_LIMITS,
  EpubProcessingError,
  type EpubDocumentReport,
  type EpubLimits,
  type EpubProcessOptions,
  type EpubProcessResult,
  type EpubReport,
  type EpubWarning,
  type EpubInspectOptions,
  type EpubStructureRole,
  type EpubStructureSnapshot,
} from './epub.types.js';
import {
  prepareReaderCss,
  READER_FIRST_CSS,
  structureRoleCss,
} from '../layout/reader-first.js';
import {
  editorialTypography,
  emptyEditorialCounts,
  type EditorialSummary,
} from '../layout/editorial-typography.js';

export { DEFAULT_EPUB_LIMITS, EpubProcessingError } from './epub.types.js';
export type {
  EpubProcessOptions,
  EpubProcessResult,
  EpubReport,
  EpubLimits,
  EpubInspectOptions,
  EpubStructureBlock,
  EpubStructurePlan,
  EpubStructureRole,
  EpubStructureSnapshot,
} from './epub.types.js';

interface ManifestItem {
  id: string;
  path: string;
  mediaType: string;
  properties: string[];
}
interface Reference {
  from: string;
  path: string;
  fragment?: string;
}

const activeElements = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'applet',
]);
const complexElements = new Set([
  'table',
  'pre',
  'svg',
  'math',
  'ruby',
  'audio',
  'video',
  'canvas',
  'blockquote',
]);
const sha256 = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');
const uriPath = (path: string) =>
  path.split('/').map(encodeURIComponent).join('/');

function fail(code: string, message: string): never {
  throw new EpubProcessingError(code, message);
}

function resolveLimits(overrides?: Partial<EpubLimits>): EpubLimits {
  const limits = { ...DEFAULT_EPUB_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > DEFAULT_EPUB_LIMITS[key as keyof EpubLimits]
    ) {
      fail('INVALID_LIMITS', '处理限制配置无效');
    }
  }
  return limits;
}

async function xmlResource(
  resource: ArchiveResource,
  limits: EpubLimits,
): Promise<XmlDocument> {
  if (resource.size > limits.maxXmlBytes)
    fail('DOCUMENT_SIZE_LIMIT', '单个文档超出处理限制');
  return parseXml(await readFile(resource.filePath));
}

function decodeCss(bytes: Buffer): {
  source: string;
  commentsNormalized: boolean;
} {
  try {
    return {
      source: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      commentsNormalized: false,
    };
  } catch {
    // Some legacy EPUBs contain GBK comments in an otherwise ASCII stylesheet.
    // Only comments can be discarded; never guess the encoding of selectors or values.
    const withoutComments = bytes
      .toString('latin1')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    if (
      Array.from(withoutComments).some(
        (character) => character.charCodeAt(0) > 127,
      )
    )
      fail('UNSUPPORTED_ENCODING', '样式含不支持的非 UTF-8 编码');
    return { source: withoutComments, commentsNormalized: true };
  }
}

function getResource(
  resources: Map<string, ArchiveResource>,
  path: string,
): ArchiveResource {
  const resource = resources.get(path);
  if (!resource) fail('MISSING_RESOURCE', 'EPUB 引用了缺失的书内资源');
  return resource;
}

function isXhtml(item: ManifestItem): boolean {
  return (
    item.mediaType === 'application/xhtml+xml' || item.mediaType === 'text/html'
  );
}

function navigationTargets(document: XmlDocument): string[] {
  return document.elements
    .filter((element) => element.local === 'content' && element.attrs.src)
    .map((element) => element.attrs.src);
}

function epub2CoverPropertyEdits(
  document: XmlDocument,
): { start: number; end: number; value: string }[] {
  const packageElement = onlyElement(document, 'package');
  const manifest = onlyElement(document, 'manifest');
  const metadata = onlyElement(document, 'metadata');
  const attributes = (element: typeof packageElement) => [
    ...document.source
      .slice(element.start, element.openingEnd)
      .matchAll(/\s+([^\s=/>]+)\s*=\s*(?:"[^"]*"|'[^']*')/g),
  ];
  const opfNamespace = 'http://www.idpf.org/2007/opf';
  if (
    packageElement.attrs.version !== '2.0' ||
    !attributes(packageElement).some(
      (attribute) => attribute[1] === 'version',
    ) ||
    [packageElement, manifest, metadata].some(
      (element) => element.uri !== opfNamespace,
    )
  )
    return [];
  const coverMetadata = document.elements.filter(
    (element) =>
      element.parent === metadata &&
      element.uri === opfNamespace &&
      element.local === 'meta' &&
      element.attrs.name === 'cover',
  );
  const coverItems = document.elements.filter(
    (element) =>
      element.parent === manifest &&
      element.uri === opfNamespace &&
      element.local === 'item' &&
      (element.attrs.properties ?? '').split(/\s+/).includes('cover-image'),
  );
  if (coverMetadata.length !== 1 || coverItems.length !== 1) return [];
  const item = coverItems[0];
  if (
    coverMetadata[0].attrs.content !== item.attrs.id ||
    !['name', 'content'].every((name) =>
      attributes(coverMetadata[0]).some((attribute) => attribute[1] === name),
    ) ||
    !['id', 'media-type'].every((name) =>
      attributes(item).some((attribute) => attribute[1] === name),
    ) ||
    !['image/jpeg', 'image/png'].includes(item.attrs['media-type']) ||
    item.attrs.properties.trim() !== 'cover-image'
  )
    return [];
  // Match complete quoted attributes, so text inside a different value or a
  // namespaced attribute cannot be mistaken for the unqualified OPF attribute.
  const attribute = attributes(item).find((match) => match[1] === 'properties');
  if (!attribute || attribute.index === undefined) return [];
  return [
    {
      start: item.start + attribute.index,
      end: item.start + attribute.index + attribute[0].length,
      value: '',
    },
  ];
}

function repairNcx(document: XmlDocument, identifier: string): string {
  const edits: { start: number; end: number; value: string }[] = [];
  const targets = new Map<string, number>();
  const contentByParent = new Map(
    document.elements
      .filter((element) => element.local === 'content' && element.parent)
      .map((element) => [element.parent, element]),
  );
  for (const element of document.elements) {
    if (
      element.local === 'meta' &&
      element.attrs.name === 'dtb:uid' &&
      element.attrs.content !== identifier
    ) {
      const tag = document.source.slice(element.start, element.openingEnd);
      edits.push({
        start: element.start,
        end: element.openingEnd,
        value: tag.replace(
          /\bcontent\s*=\s*(?:"[^"]*"|'[^']*')/,
          `content="${attributeEscape(identifier)}"`,
        ),
      });
    }
    if (element.local === 'navPoint') {
      const content = contentByParent.get(element);
      if (!content?.attrs.src) continue;
      if (!targets.has(content.attrs.src))
        targets.set(content.attrs.src, targets.size + 1);
      const playOrder = String(targets.get(content.attrs.src));
      if (element.attrs.playOrder !== playOrder) {
        const tag = document.source.slice(element.start, element.openingEnd);
        const replacement = /\bplayOrder\s*=/.test(tag)
          ? tag.replace(
              /\bplayOrder\s*=\s*(?:"[^"]*"|'[^']*')/,
              `playOrder="${playOrder}"`,
            )
          : tag.replace(/>$/, ` playOrder="${playOrder}">`);
        edits.push({
          start: element.start,
          end: element.openingEnd,
          value: replacement,
        });
      }
    }
  }
  let source = document.source;
  for (const edit of edits.sort((left, right) => right.start - left.start))
    source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
  return source;
}

function rasterType(bytes: Buffer): 'image/jpeg' | 'image/png' | undefined {
  let width = 0;
  let height = 0;
  let type: 'image/jpeg' | 'image/png' | undefined;
  if (
    bytes.length >= 33 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString('ascii', 12, 16) === 'IHDR'
  ) {
    type = 'image/png';
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 <= bytes.length && bytes[offset] === 0xff) {
      const marker = bytes[offset + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        type = 'image/jpeg';
        height = bytes.readUInt16BE(offset + 5);
        width = bytes.readUInt16BE(offset + 7);
        break;
      }
      offset += 2 + length;
    }
  }
  return width > 0 &&
    height > 0 &&
    width <= 20_000 &&
    height <= 20_000 &&
    width * height <= 40_000_000
    ? type
    : undefined;
}

/** Bounded content samples for a constrained planner; never returns the whole book. */
export async function inspectEpubStructure(
  options: EpubInspectOptions,
): Promise<EpubStructureSnapshot> {
  const limits = resolveLimits(options.limits);
  const sourcePath = resolve(options.sourcePath);
  const scratch = await mkdtemp(join(tmpdir(), 'epub-structure-'));
  try {
    options.signal?.throwIfAborted();
    const stats = await stat(sourcePath);
    if (!stats.isFile() || stats.size > limits.maxSourceBytes)
      fail('SOURCE_SIZE_LIMIT', '上传文件超出 EPUB 处理限制');
    const sourceSha256 = await hashFile(sourcePath, options.signal);
    const resources = await unpackArchive(
      sourcePath,
      scratch,
      limits,
      options.signal,
    );
    if (
      (await readFile(getResource(resources, 'mimetype').filePath, 'utf8')) !==
      'application/epub+zip'
    )
      fail('INVALID_EPUB_STRUCTURE', '文件不是有效的 EPUB');
    const snapshot = await buildStructureSnapshot(
      resources,
      sourceSha256,
      limits,
      options.signal,
    );
    if ((await hashFile(sourcePath, options.signal)) !== sourceSha256)
      fail('SOURCE_CHANGED', '处理期间原书文件发生变化');
    return snapshot;
  } catch (error) {
    if (error instanceof EpubProcessingError) throw error;
    if (options.signal?.aborted)
      throw new EpubProcessingError('PROCESSING_CANCELLED', '书籍处理已取消');
    throw new EpubProcessingError(
      'PROCESSING_FAILED',
      'EPUB 结构分析失败，原书文件未修改',
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** File-to-file deterministic engine; no network, model call or app-global mutable state. */
export async function processEpub(
  options: EpubProcessOptions,
): Promise<EpubProcessResult> {
  const limits = resolveLimits(options.limits);
  if (
    options.typographyProfile !== undefined &&
    options.typographyProfile !== 'editorial-1'
  )
    fail('INVALID_TYPOGRAPHY_PROFILE', '排版方案版本不受支持');
  if (options.typographyProfile && options.structurePlan)
    fail('INVALID_STRUCTURE_PLAN', '新排版方案不接收旧AI角色计划');
  const typography: EditorialSummary | undefined = options.typographyProfile
    ? {
        profile: 'editorial-1',
        totalParagraphs: 0,
        styledParagraphs: 0,
        preservedParagraphs: 0,
        styledHeadings: 0,
        roleCounts: emptyEditorialCounts(),
      }
    : undefined;
  const sourcePath = resolve(options.sourcePath);
  const outputDirectory = resolve(options.outputDirectory);
  if (sourcePath === join(outputDirectory, 'output.epub'))
    fail('INVALID_DESTINATION', '输出目录不能覆盖原书');
  await mkdir(outputDirectory, { recursive: true });
  // Keep private temporary expansion independent of deeply nested run paths.
  const scratch = await mkdtemp(join(tmpdir(), 'epub-work-'));
  const published: string[] = [];
  const warnings: EpubWarning[] = [];
  const warn = (code: string, message: string, document?: string) =>
    warnings.push({ code, message, ...(document ? { document } : {}) });
  try {
    options.signal?.throwIfAborted();
    const sourceStats = await stat(sourcePath);
    if (!sourceStats.isFile() || sourceStats.size > limits.maxSourceBytes)
      fail('SOURCE_SIZE_LIMIT', '上传文件超出 EPUB 处理限制');
    const sourceSha256 = await hashFile(sourcePath, options.signal);
    const resources = await unpackArchive(
      sourcePath,
      scratch,
      limits,
      options.signal,
    );
    const structureSnapshot = await buildStructureSnapshot(
      resources,
      sourceSha256,
      limits,
      options.signal,
    );
    const structureRoles = options.structurePlan
      ? validateStructurePlan(structureSnapshot, options.structurePlan)
      : new Map<string, EpubStructureRole>();
    const roleCounts: Record<EpubStructureRole, number> = {
      body: 0,
      quote: 0,
      poem: 0,
      caption: 0,
      'section-title': 0,
    };
    let appliedBlocks = 0;
    const reservedNames = new Set(
      [...resources.keys()].map((name) => name.toLowerCase()),
    );
    const allocateResourceName = (preferred: string): string => {
      const parsed = posix.parse(preferred);
      let candidate = preferred;
      let suffix = 1;
      while (reservedNames.has(candidate.toLowerCase()))
        candidate = posix.join(
          parsed.dir,
          `${parsed.name}-${suffix++}${parsed.ext}`,
        );
      reservedNames.add(candidate.toLowerCase());
      return candidate;
    };
    const originals = new Map(
      [...resources].map(([name, resource]) => [name, resource.sha256]),
    );
    const originalExpanded = [...resources.values()].reduce(
      (sum, resource) => sum + resource.size,
      0,
    );
    if (
      (await readFile(getResource(resources, 'mimetype').filePath, 'utf8')) !==
      'application/epub+zip'
    )
      fail('INVALID_EPUB_STRUCTURE', '文件不是有效的 EPUB');
    if (
      [...resources.keys()].some((name) =>
        /^META-INF\/(?:encryption|signatures)\.xml$/i.test(name),
      )
    )
      fail('ENCRYPTED_EPUB', '首版不支持加密、混淆字体或签名 EPUB');
    const container = await xmlResource(
      getResource(resources, 'META-INF/container.xml'),
      limits,
    );
    const roots = container.elements.filter(
      (element) =>
        element.local === 'rootfile' &&
        element.attrs['media-type'] === 'application/oebps-package+xml',
    );
    if (roots.length !== 1 || !roots[0].attrs['full-path'])
      fail('INVALID_EPUB_STRUCTURE', '首版仅支持单一 EPUB 内容包');
    const packagePath = resolveResource(
      'container.xml',
      roots[0].attrs['full-path'],
    ).path;
    const packageResource = getResource(resources, packagePath);
    const packageDocument = await xmlResource(packageResource, limits);
    const packageElement = onlyElement(packageDocument, 'package');
    const manifestElement = onlyElement(packageDocument, 'manifest');
    const spineElement = onlyElement(packageDocument, 'spine');
    const metadata = onlyElement(packageDocument, 'metadata');
    if (!['2.0', '3.0'].includes(packageElement.attrs.version))
      fail('UNSUPPORTED_EPUB_VERSION', '仅支持 EPUB 2 或 EPUB 3');
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
      fail('FIXED_LAYOUT_EPUB', '首版仅支持可重排文字 EPUB');
    const identifier = packageDocument.elements
      .find(
        (element) =>
          element.local === 'identifier' &&
          element.attrs.id === packageElement.attrs['unique-identifier'],
      )
      ?.text.trim();
    if (!identifier) fail('INVALID_EPUB_STRUCTURE', 'EPUB 缺少唯一标识符');
    const title =
      packageDocument.elements
        .find(
          (element) => element.parent === metadata && element.local === 'title',
        )
        ?.text.trim()
        .slice(0, 200) || null;
    const items: ManifestItem[] = packageDocument.elements
      .filter(
        (element) =>
          element.parent === manifestElement && element.local === 'item',
      )
      .map((element) => {
        if (
          !element.attrs.id ||
          !element.attrs.href ||
          !element.attrs['media-type']
        )
          fail('INVALID_EPUB_STRUCTURE', 'EPUB 清单条目不完整');
        return {
          id: element.attrs.id,
          path: resolveResource(packagePath, element.attrs.href).path,
          mediaType: element.attrs['media-type'],
          properties: (element.attrs.properties ?? '')
            .split(/\s+/)
            .filter(Boolean),
        };
      });
    if (new Set(items.map((item) => item.path)).size !== items.length)
      fail('INVALID_EPUB_STRUCTURE', 'EPUB 资源清单存在重复目标');
    const byId = new Map(items.map((item) => [item.id, item]));
    const manifestPaths = new Set(items.map((item) => item.path));
    for (const item of items) {
      getResource(resources, item.path);
      if (
        /javascript|ecmascript/i.test(item.mediaType) ||
        item.properties.includes('scripted')
      )
        fail('ACTIVE_CONTENT', '首版不支持脚本或交互 EPUB');
    }
    const cssRepairs = await unusedFontPlaceholderRepairs(
      resources,
      items,
      limits,
      options.signal,
    );
    const spine = packageDocument.elements
      .filter(
        (element) =>
          element.parent === spineElement && element.local === 'itemref',
      )
      .map((element) => {
        const item = byId.get(element.attrs.idref);
        if (!item || !isXhtml(item))
          fail('UNSUPPORTED_SPINE', '阅读顺序中存在不支持的文档类型');
        return item;
      });
    if (
      spine.length === 0 ||
      new Set(spine.map((item) => item.path)).size !== spine.length
    )
      fail('INVALID_EPUB_STRUCTURE', '阅读顺序为空或含重复文档');
    const spinePaths = new Set(spine.map((item) => item.path));
    const idsByPath = new Map<string, Set<string>>();
    const references: Reference[] = [];
    for (const element of packageDocument.elements.filter(
      (element) => element.local === 'reference' && element.attrs.href,
    ))
      references.push({
        from: packagePath,
        ...resolveResource(packagePath, element.attrs.href),
      });
    if (spineElement.attrs.toc && !byId.has(spineElement.attrs.toc))
      fail('MISSING_RESOURCE', 'EPUB 缺少阅读顺序引用的目录');
    const newManifest: { path: string; id: string; mediaType: string }[] = [];
    const usedIds = new Set(packageDocument.ids);
    let generatedIndex = 0;
    const writeResource = async (
      name: string,
      content: string | Buffer,
    ): Promise<void> => {
      const bytes =
        typeof content === 'string' ? Buffer.from(content) : content;
      const filePath = join(scratch, `generated-${generatedIndex++}`);
      await writeFile(filePath, bytes, { flag: 'wx' });
      resources.set(name, {
        name,
        filePath,
        size: bytes.length,
        sha256: sha256(bytes),
      });
    };
    for (const [path, repair] of cssRepairs) {
      if (originals.get(path) !== repair.record.sourceSha256)
        fail('INTEGRITY_FAILURE', '字体占位修复与源样式不一致');
      await writeResource(path, repair.css);
      warn(
        'UNUSED_FONT_PLACEHOLDER_REMOVED',
        '移除未使用的缺失字体占位声明，原书文件未修改',
        path,
      );
    }
    const addResource = async (
      name: string,
      content: string,
      mediaType = 'text/css',
    ): Promise<void> => {
      if (
        [...resources.keys()].some(
          (existing) => existing.toLowerCase() === name.toLowerCase(),
        )
      )
        fail('GENERATED_RESOURCE_COLLISION', '书中已有同名排版资源');
      let id = `epub-ai-reader-${generatedIndex}`;
      while (usedIds.has(id)) id += '-next';
      usedIds.add(id);
      await writeResource(name, content);
      newManifest.push({ path: name, id, mediaType });
    };
    const readerCssPath = allocateResourceName(
      posix.join(posix.dirname(packagePath), 'epub-ai-reader-first.css'),
    );
    const cssByPath = new Map<string, { path: string; complex: boolean }>();
    for (const item of items.filter(
      (entry) => entry.mediaType === 'text/css',
    )) {
      const resource = getResource(resources, item.path);
      if (resource.size > limits.maxXmlBytes)
        fail('DOCUMENT_SIZE_LIMIT', '单个样式文件超出处理限制');
      const decoded = decodeCss(await readFile(resource.filePath));
      if (decoded.commentsNormalized)
        warn(
          'CSS_COMMENT_ENCODING_NORMALIZED',
          '旧样式注释编码不规范，排版副本仅移除注释，原样式资源保留',
          item.path,
        );
      const result = prepareReaderCss(decoded.source);
      for (const reference of result.references)
        references.push({
          from: item.path,
          ...resolveResource(item.path, reference),
        });
      cssByPath.set(item.path, {
        path: allocateResourceName(
          posix.join(
            posix.dirname(item.path),
            `epub-ai-${sha256(item.path).slice(0, 12)}.css`,
          ),
        ),
        complex: result.complex,
      });
    }
    const reports: EpubDocumentReport[] = [];
    const bodyHashes = new Map<string, string>();
    let coverPath = items.find((item) =>
      item.properties.includes('cover-image'),
    )?.path;
    if (!coverPath) {
      const coverId = packageDocument.elements.find(
        (element) => element.local === 'meta' && element.attrs.name === 'cover',
      )?.attrs.content;
      if (coverId) coverPath = byId.get(coverId)?.path;
    }
    const coverGuide = packageDocument.elements.find(
      (element) =>
        element.local === 'reference' && element.attrs.type === 'cover',
    )?.attrs.href;
    const coverDocumentPath = coverGuide
      ? resolveResource(packagePath, coverGuide).path
      : undefined;
    for (const item of items.filter(
      (entry) =>
        isXhtml(entry) ||
        entry.mediaType === 'application/x-dtbncx+xml' ||
        entry.mediaType === 'image/svg+xml',
    )) {
      options.signal?.throwIfAborted();
      const document = await xmlResource(
        getResource(resources, item.path),
        limits,
      );
      idsByPath.set(item.path, document.ids);
      for (const element of document.elements) {
        if (
          activeElements.has(element.local.toLowerCase()) ||
          Object.keys(element.attrs).some((name) => /^on[a-z]/i.test(name)) ||
          element.attrs['xml:base'] ||
          element.local === 'base'
        )
          fail('ACTIVE_CONTENT', '首版不支持脚本、事件或动态资源 EPUB');
        for (const [name, value] of Object.entries(element.attrs)) {
          if (!['href', 'src', 'poster', 'data'].includes(name) || !value)
            continue;
          if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) {
            if (
              element.local === 'a' &&
              name === 'href' &&
              /^(https?:|mailto:|tel:)/i.test(value)
            )
              continue;
            fail('REMOTE_RESOURCE', '首版仅支持资源完整保存在书内的 EPUB');
          }
          references.push({
            from: item.path,
            ...resolveResource(item.path, value),
          });
        }
        if (element.attrs.srcset)
          fail('UNSUPPORTED_RESOURCE', '首版不支持响应式图片资源列表');
        if (
          element.attrs.style &&
          /url\s*\(|expression\s*\(|@import|javascript\s*:/i.test(
            element.attrs.style,
          )
        )
          fail('ACTIVE_CONTENT', '首版不支持动态或外部内联样式资源');
        if (element.local === 'style') {
          const inlineCss = prepareReaderCss(element.text);
          for (const reference of inlineCss.references)
            references.push({
              from: item.path,
              ...resolveResource(item.path, reference),
            });
        }
      }
      if (item.mediaType === 'application/x-dtbncx+xml') {
        const repaired = repairNcx(document, identifier);
        if (repaired !== document.source) {
          if (
            JSON.stringify(navigationTargets(document)) !==
            JSON.stringify(navigationTargets(parseXml(Buffer.from(repaired))))
          )
            fail('INTEGRITY_FAILURE', '目录完整性校验失败');
          await writeResource(item.path, repaired);
          warn(
            'NCX_METADATA_REPAIRED',
            '修复目录唯一标识和顺序编号，目录目标与顺序保持不变',
            item.path,
          );
        }
        continue;
      }
      if (!isXhtml(item)) continue;
      const body = onlyElement(document, 'body');
      const head = onlyElement(document, 'head');
      if (body.uri !== 'http://www.w3.org/1999/xhtml' || head.uri !== body.uri)
        fail('INVALID_EPUB_STRUCTURE', 'EPUB 正文命名空间无效');
      const bodyBytes = document.source.slice(body.start, body.end);
      const bodyHash = sha256(bodyBytes);
      bodyHashes.set(item.path, bodyHash);
      if (!coverPath && item.path === coverDocumentPath)
        coverPath = document.elements.find(
          (element) => element.local === 'img' && element.attrs.src,
        )
          ? resolveResource(
              item.path,
              document.elements.find(
                (element) => element.local === 'img' && element.attrs.src,
              )!.attrs.src,
            ).path
          : undefined;
      const paragraphElements = document.elements.filter(
        (element) => element.local === 'p',
      );
      const headingElements = document.elements.filter((element) =>
        /^h[1-6]$/.test(element.local),
      );
      const reasons: string[] = [];
      if (
        item.properties.includes('nav') ||
        document.elements.some((element) => element.local === 'nav')
      )
        reasons.push('NAVIGATION_DOCUMENT');
      if (
        headingElements.length === 0 ||
        paragraphElements.filter((element) => !element.attrs.class).length === 0
      )
        reasons.push('NO_SEMANTIC_PROSE');
      if (
        document.elements.some(
          (element) => element.attrs.style || element.local === 'style',
        )
      )
        reasons.push('INLINE_STYLE');
      if (
        document.elements.some(
          (element) =>
            complexElements.has(element.local) ||
            ((element.local === 'div' ||
              element.local === 'body' ||
              /^h[12]$/.test(element.local)) &&
              (element.attrs.class || element.attrs.style)),
        )
      )
        reasons.push('COMPLEX_STRUCTURE');
      const links = document.elements.filter(
        (element) =>
          element.local === 'link' &&
          /(?:^|\s)stylesheet(?:\s|$)/i.test(element.attrs.rel ?? ''),
      );
      if (
        links.some(
          (element) =>
            !element.attrs.href ||
            !cssByPath.has(
              resolveResource(item.path, element.attrs.href).path,
            ) ||
            cssByPath.get(resolveResource(item.path, element.attrs.href).path)
              ?.complex,
        )
      )
        reasons.push('COMPLEX_CSS');
      let transformed = document.source;
      const assignments = structureSnapshot.blocks
        .filter(
          (block) =>
            block.documentPath === item.path && structureRoles.has(block.id),
        )
        .map((block) => ({
          childIndex: block.position.childIndex,
          role: structureRoles.get(block.id)!,
        }));
      const editorial =
        typography && spinePaths.has(item.path)
          ? editorialTypography(
              document,
              body,
              await Promise.all(
                links
                  .filter(
                    (link) =>
                      link.attrs.href &&
                      cssByPath.has(
                        resolveResource(item.path, link.attrs.href).path,
                      ),
                  )
                  .map(
                    async (link) =>
                      decodeCss(
                        await readFile(
                          getResource(
                            resources,
                            resolveResource(item.path, link.attrs.href).path,
                          ).filePath,
                        ),
                      ).source,
                  ),
              ),
            )
          : undefined;
      if (editorial) {
        if (
          links.some(
            (link) =>
              !link.attrs.href ||
              !cssByPath.has(resolveResource(item.path, link.attrs.href).path),
          )
        )
          editorial.reasons.push('EDITORIAL_STYLESHEET_UNSUPPORTED');
        if (
          item.properties.includes('nav') ||
          document.elements.some((entry) => entry.local === 'nav')
        )
          editorial.reasons.push('NAVIGATION_DOCUMENT');
        reasons.splice(0, reasons.length, ...editorial.reasons);
        typography!.totalParagraphs += paragraphElements.length;
      }
      const shouldStyle = editorial
        ? editorial.reasons.length === 0
        : spinePaths.has(item.path) &&
          (reasons.length === 0 ||
            (assignments.length > 0 &&
              reasons.every((reason) => reason === 'NO_SEMANTIC_PROSE')));
      let editorialCssPath: string | null = null;
      if (shouldStyle && editorial) {
        editorialCssPath = allocateResourceName(
          posix.join(
            posix.dirname(packagePath),
            `epub-ai-editorial-${sha256(item.path).slice(0, 12)}.css`,
          ),
        );
        await addResource(editorialCssPath, editorial.css);
        const edits = links.map((link) => ({
          start: link.start,
          end: link.end,
          value: '',
        }));
        edits.push({
          start: head.closingStart,
          end: head.closingStart,
          value: `<link xmlns="http://www.w3.org/1999/xhtml" rel="stylesheet" type="text/css" href="${attributeEscape(uriPath(posix.relative(posix.dirname(item.path), editorialCssPath)))}" />\n`,
        });
        for (const edit of edits.sort((a, b) => b.start - a.start))
          transformed =
            transformed.slice(0, edit.start) +
            edit.value +
            transformed.slice(edit.end);
        typography!.styledParagraphs += editorial.styledParagraphs;
        typography!.styledHeadings += editorial.styledHeadings;
        for (const role of Object.keys(
          editorial.roleCounts,
        ) as (keyof EditorialSummary['roleCounts'])[])
          typography!.roleCounts[role] += editorial.roleCounts[role];
      } else if (shouldStyle) {
        if (!resources.has(readerCssPath))
          await addResource(readerCssPath, READER_FIRST_CSS);
        const edits: { start: number; end: number; value: string }[] = [];
        for (const link of links) {
          const originalCssPath = resolveResource(
            item.path,
            link.attrs.href,
          ).path;
          const clonedCss = cssByPath.get(originalCssPath)!;
          if (!resources.has(clonedCss.path)) {
            const originalCss = decodeCss(
              await readFile(getResource(resources, originalCssPath).filePath),
            ).source;
            await addResource(
              clonedCss.path,
              prepareReaderCss(originalCss).css,
            );
          }
          const originalTag = document.source.slice(
            link.start,
            link.openingEnd,
          );
          const href = attributeEscape(
            uriPath(posix.relative(posix.dirname(item.path), clonedCss.path)),
          );
          edits.push({
            start: link.start,
            end: link.openingEnd,
            value: originalTag.replace(
              /(\s)href\s*=\s*(?:"[^"]*"|'[^']*')/,
              `$1href="${href}"`,
            ),
          });
        }
        const href = attributeEscape(
          uriPath(posix.relative(posix.dirname(item.path), readerCssPath)),
        );
        edits.push({
          start: head.closingStart,
          end: head.closingStart,
          value: `<link xmlns="http://www.w3.org/1999/xhtml" rel="stylesheet" type="text/css" href="${href}" />\n`,
        });
        if (assignments.length > 0) {
          const structureCssPath = allocateResourceName(
            posix.join(
              posix.dirname(packagePath),
              `epub-ai-structure-${sha256(item.path).slice(0, 12)}.css`,
            ),
          );
          await addResource(structureCssPath, structureRoleCss(assignments));
          const structureHref = attributeEscape(
            uriPath(posix.relative(posix.dirname(item.path), structureCssPath)),
          );
          edits[edits.length - 1].value +=
            `<link xmlns="http://www.w3.org/1999/xhtml" rel="stylesheet" type="text/css" href="${structureHref}" />\n`;
          appliedBlocks += assignments.length;
          for (const assignment of assignments) roleCounts[assignment.role]++;
        }
        for (const edit of edits.sort(
          (left, right) => right.start - left.start,
        ))
          transformed =
            transformed.slice(0, edit.start) +
            edit.value +
            transformed.slice(edit.end);
      }
      const fixedDoctype = transformed.replace(
        /<!DOCTYPE\s+html\s+PUBLIC\s+"-\/\/W3C\/\/DTD XHTML 1\.0 Strict\/\/EN"\s+"http:\/\/www\.w3\.org\/TR\/xhtml1\/DTD\/xhtml1-strict\.dtd"\s*>/i,
        '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">',
      );
      if (fixedDoctype !== transformed)
        warn(
          'DOCTYPE_REPAIRED',
          '更新 XHTML 声明，正文内容保持不变',
          item.path,
        );
      transformed = fixedDoctype;
      const reparsed = parseXml(Buffer.from(transformed));
      const newBody = onlyElement(reparsed, 'body');
      if (
        sha256(reparsed.source.slice(newBody.start, newBody.end)) !== bodyHash
      )
        fail('INTEGRITY_FAILURE', '正文原始内容校验失败');
      if (transformed !== document.source)
        await writeResource(item.path, transformed);
      if (spinePaths.has(item.path)) {
        reports.push({
          path: item.path,
          status: shouldStyle ? 'styled' : 'preserved',
          reasons,
          paragraphs: paragraphElements.length,
          headings: headingElements.length,
          bodySha256: bodyHash,
          ...(editorial
            ? {
                editorial: {
                  profile: 'editorial-1' as const,
                  cssPath: editorialCssPath,
                  assignments: shouldStyle ? editorial.assignments : [],
                },
              }
            : {}),
        });
        if (!shouldStyle)
          warn(
            'CHAPTER_PRESERVED',
            '保留本章原样式，避免修改复杂结构或缺少明确语义的内容',
            item.path,
          );
        if (
          shouldStyle &&
          paragraphElements.some((element) => element.attrs.class)
        )
          warn(
            'SPECIAL_PARAGRAPH_PRESERVED',
            '保留带专用样式的特殊段落',
            item.path,
          );
      }
    }
    for (const reference of references) {
      getResource(resources, reference.path);
      if (!manifestPaths.has(reference.path))
        fail('UNMANIFESTED_RESOURCE', 'EPUB 引用了未列入资源清单的内容');
      if (
        reference.fragment &&
        idsByPath.has(reference.path) &&
        !idsByPath.get(reference.path)!.has(reference.fragment)
      )
        fail('BROKEN_REFERENCE', 'EPUB 含无效的书内目录或链接目标');
    }
    const packageEdits = epub2CoverPropertyEdits(packageDocument);
    if (packageEdits.length > 0)
      warn(
        'OPF_EPUB2_COVER_PROPERTY_REPAIRED',
        '移除 EPUB 2 封面条目上冗余的 EPUB 3 属性，保留原有封面元数据',
        packagePath,
      );
    if (newManifest.length > 0) {
      const prefix = manifestElement.name.includes(':')
        ? `${manifestElement.name.split(':')[0]}:`
        : '';
      const added = newManifest
        .map(
          (item) =>
            `<${prefix}item id="${item.id}" href="${attributeEscape(uriPath(posix.relative(posix.dirname(packagePath), item.path)))}" media-type="${item.mediaType}" />`,
        )
        .join('\n');
      packageEdits.push({
        start: manifestElement.closingStart,
        end: manifestElement.closingStart,
        value: added + '\n',
      });
    }
    if (packageEdits.length > 0) {
      // All edits use original offsets; apply the manifest append and narrowly
      // scoped attribute removal from right to left without reserializing XML.
      let changedPackage = packageDocument.source;
      for (const edit of packageEdits.sort(
        (left, right) => right.start - left.start,
      ))
        changedPackage =
          changedPackage.slice(0, edit.start) +
          edit.value +
          changedPackage.slice(edit.end);
      const parsed = parseXml(Buffer.from(changedPackage));
      if (
        parsed.source.slice(
          onlyElement(parsed, 'spine').start,
          onlyElement(parsed, 'spine').end,
        ) !== packageDocument.source.slice(spineElement.start, spineElement.end)
      )
        fail('INTEGRITY_FAILURE', '阅读顺序校验失败');
      await writeResource(packagePath, changedPackage);
    }
    const allowedChanged = new Set([
      packagePath,
      ...bodyHashes.keys(),
      ...items
        .filter((item) => item.mediaType === 'application/x-dtbncx+xml')
        .map((item) => item.path),
    ]);
    for (const [name, hash] of originals)
      if (cssRepairs.has(name)) {
        if (
          hash !== cssRepairs.get(name)!.record.sourceSha256 ||
          resources.get(name)?.sha256 !==
            cssRepairs.get(name)!.record.outputSha256
        )
          fail('INTEGRITY_FAILURE', '字体占位修复超出已验证的源范围');
      } else if (
        !allowedChanged.has(name) &&
        resources.get(name)?.sha256 !== hash
      )
        fail('INTEGRITY_FAILURE', '原始资源校验失败');
    if (reports.length !== spine.length)
      fail('INVALID_EPUB_STRUCTURE', '正文文档检查不完整');
    const stagedOutput = join(scratch, 'output.epub');
    await writeArchive(resources, stagedOutput, options.signal);
    const writtenResources = await unpackArchive(
      stagedOutput,
      scratch,
      limits,
      options.signal,
      false,
    );
    if (
      writtenResources.size !== resources.size ||
      [...resources].some(
        ([name, resource]) =>
          writtenResources.get(name)?.sha256 !== resource.sha256 ||
          writtenResources.get(name)?.size !== resource.size,
      )
    )
      fail('INTEGRITY_FAILURE', '导出后的 EPUB 资源校验失败');
    if ((await hashFile(sourcePath, options.signal)) !== sourceSha256)
      fail('SOURCE_CHANGED', '处理期间原书文件发生变化');
    const outputSha256 = await hashFile(stagedOutput, options.signal);
    const styledDocuments = reports.filter(
      (report) => report.status === 'styled',
    ).length;
    const report: EpubReport = {
      schemaVersion: 1,
      pipelineVersion: 'reader-first-1',
      sourceSha256,
      outputSha256,
      summary: {
        title,
        chapters: spine.length,
        styledChapters: styledDocuments,
        preservedChapters: spine.length - styledDocuments,
        bodyBytesPreserved: true,
        entries: originals.size,
        expandedBytes: originalExpanded,
        spineDocuments: spine.length,
        styledDocuments,
        preservedDocuments: spine.length - styledDocuments,
        images: items.filter((item) => item.mediaType.startsWith('image/'))
          .length,
      },
      documents: reports,
      structure: {
        schemaVersion: 1,
        analyzerVersion: 'structure-samples-1',
        snapshotFingerprint: structureSnapshot.fingerprint,
        sampledBlocks: structureSnapshot.blocks.length,
        truncated: structureSnapshot.truncated,
        planned: options.structurePlan !== undefined,
        appliedBlocks,
        preservedBlocks: structureSnapshot.blocks.length - appliedBlocks,
        roleCounts,
      },
      warnings,
      ...(typography
        ? {
            typography: {
              ...typography,
              preservedParagraphs:
                typography.totalParagraphs - typography.styledParagraphs,
            },
          }
        : {}),
      ...(cssRepairs.size
        ? {
            sourceRepairs: {
              policyVersion: UNUSED_FONT_PLACEHOLDER_POLICY,
              stylesheets: [...cssRepairs.values()].map(
                (repair) => repair.record,
              ),
            },
          }
        : {}),
      integrity: {
        sourceUnchanged: true,
        bodyBytesPreserved: true,
        originalResourcesPreserved: cssRepairs.size === 0,
        spineOrderPreserved: true,
        navigationPreserved: true,
        internalReferencesChecked: true,
      },
      validation: {
        archive: 'passed',
        xml: 'passed',
        references: 'passed',
        epubcheck: 'not-run',
        device: 'not-tested',
      },
    };
    const outputPath = join(outputDirectory, 'output.epub');
    const reportPath = join(outputDirectory, 'report.json');
    await copyFile(stagedOutput, outputPath, constants.COPYFILE_EXCL);
    published.push(outputPath);
    let cover: EpubProcessResult['cover'];
    if (coverPath) {
      const coverResource = getResource(resources, coverPath);
      if (coverResource.size <= limits.maxXmlBytes) {
        const bytes = await readFile(coverResource.filePath);
        const mediaType = rasterType(bytes);
        if (mediaType) {
          const path = join(
            outputDirectory,
            mediaType === 'image/png' ? 'cover.png' : 'cover.jpg',
          );
          await copyFile(coverResource.filePath, path, constants.COPYFILE_EXCL);
          published.push(path);
          cover = { path, mediaType };
        } else
          warn(
            'COVER_UNAVAILABLE',
            '封面不是首版支持的安全 JPEG/PNG，未生成网页封面',
          );
      } else warn('COVER_UNAVAILABLE', '封面文件较大，未生成网页封面');
    }
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
    });
    published.push(reportPath);
    return { outputPath, reportPath, ...(cover ? { cover } : {}), report };
  } catch (error) {
    for (const file of published) await rm(file, { force: true });
    if (error instanceof EpubProcessingError) throw error;
    if (options.signal?.aborted)
      throw new EpubProcessingError('PROCESSING_CANCELLED', '书籍处理已取消');
    throw new EpubProcessingError(
      'PROCESSING_FAILED',
      'EPUB 处理失败，原书文件未修改',
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
