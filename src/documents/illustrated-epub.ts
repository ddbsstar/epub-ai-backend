import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { prepareReaderCss } from '../layout/reader-first.js';
import {
  hashFile,
  resolveResource,
  safeArchiveName,
  unpackArchive,
  writeArchive,
  type ArchiveResource,
} from './epub-archive.js';
import { processEpub } from './epub-engine.js';
import {
  unusedFontPlaceholderRepairs,
  UNUSED_FONT_PLACEHOLDER_POLICY,
} from './unused-font-placeholder.js';
import {
  attributeEscape,
  onlyElement,
  parseXml,
  type XmlDocument,
} from './epub-xml.js';
import {
  DEFAULT_EPUB_LIMITS,
  EpubProcessingError,
  type EpubLimits,
  type EpubSourceRepairs,
} from './epub.types.js';

/** These fields originate in the local chapter index, never from model markup. */
export interface IllustrationAnchor {
  documentPath: string;
  sourceStart: number;
  sourceEnd: number;
  contentSha256: string;
}

/** Registered reflowable layouts; models cannot supply CSS or coordinates. */
export interface IllustrationLayout {
  size: 'compact' | 'medium' | 'wide';
  alignment: 'center';
}

export interface InsertEpubIllustrationOptions {
  sourcePath: string;
  sourceSha256: string;
  anchor: IllustrationAnchor;
  image: { path: string; sha256: string };
  alt: string;
  layout?: IllustrationLayout;
  outputDirectory: string;
  limits?: Partial<EpubLimits>;
  signal?: AbortSignal;
}

export type IllustrationInsertion = Pick<
  InsertEpubIllustrationOptions,
  'anchor' | 'image' | 'alt' | 'layout'
>;

export interface InsertEpubIllustrationsOptions {
  sourcePath: string;
  sourceSha256: string;
  insertions: IllustrationInsertion[];
  outputDirectory: string;
  limits?: Partial<EpubLimits>;
  signal?: AbortSignal;
}

export interface IllustratedEpubReport {
  schemaVersion: 1;
  pipelineVersion: 'chapter-illustration-trial-1';
  sourceSha256: string;
  outputSha256: string;
  illustration: {
    documentPath: string;
    anchorContentSha256: string;
    imagePath: string;
    imageSha256: string;
    width: number;
    height: number;
    layout?: IllustrationLayout;
  };
  integrity: {
    sourceUnchanged: true;
    bodyBytesPreserved: false;
    originalBodySourceFragmentsPreserved: true;
    exactAllowlistedInsertion: true;
    originalImagesPreserved: true;
    originalIdsPreserved: true;
    spineOrderPreserved: true;
    navigationTargetsPreserved: true;
    internalReferencesChecked: true;
    writtenArchiveHashesVerified: true;
  };
  phases: {
    baseline: {
      originalBodyBytesPreserved: true;
      allowedChanges: string[];
      warningCodes: string[];
      sourceRepairs?: EpubSourceRepairs;
      originalResourcesPreserved?: boolean;
    };
    insertion: {
      changedResources: string[];
      addedResources: string[];
      insertedBodyElements: 1;
    };
  };
  validation: {
    epubcheck: 'not-run';
    device: 'not-tested';
    aesthetic: 'not-approved';
  };
}

export interface IllustratedEpubBatchReport extends Omit<
  IllustratedEpubReport,
  'pipelineVersion' | 'illustration' | 'phases'
> {
  pipelineVersion: 'chapter-illustration-batch-1';
  illustrations: (IllustratedEpubReport['illustration'] & {
    sourceStart: number;
    sourceEnd: number;
  })[];
  phases: {
    baseline: IllustratedEpubReport['phases']['baseline'];
    insertion: {
      changedResources: string[];
      addedResources: string[];
      insertedBodyElements: number;
    };
  };
}

const hash = (value: Buffer | string) =>
  createHash('sha256').update(value).digest('hex');
const xhtmlNamespace = 'http://www.w3.org/1999/xhtml';
const inlineElements = new Set([
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
const css = `/* epub-ai chapter illustration: fixed selectors, no paragraph positions */
div.epub-ai-chapter-illustration { display: block; margin: 1.5em 0; padding: 0; text-indent: 0; text-align: center; page-break-inside: avoid; break-inside: avoid; }
div.epub-ai-chapter-illustration > img { display: block; width: 100%; max-width: 100%; height: auto; margin: 0 auto; padding: 0; border: 0; }
`;
const layoutCss = `/* Registered centered inline illustrations for reflowable readers. */
div.epub-ai-chapter-illustration.epub-ai-illustration-compact > img { width: 45%; max-width: 100%; height: auto; }
div.epub-ai-chapter-illustration.epub-ai-illustration-medium > img { width: 70%; max-width: 100%; height: auto; }
div.epub-ai-chapter-illustration.epub-ai-illustration-wide > img { width: 100%; max-width: 100%; height: auto; }
`;

function fail(code: string, message: string): never {
  throw new EpubProcessingError(code, message);
}

function resourceAt(resources: Map<string, ArchiveResource>, path: string) {
  const value = resources.get(path);
  if (!value) fail('MISSING_RESOURCE', 'EPUB 引用了缺失的书内资源');
  return value;
}

async function xmlAt(
  resources: Map<string, ArchiveResource>,
  path: string,
  limits: EpubLimits,
): Promise<XmlDocument> {
  const resource = resourceAt(resources, path);
  if (resource.size > limits.maxXmlBytes)
    fail('DOCUMENT_SIZE_LIMIT', '单个文档超出处理限制');
  return parseXml(await readFile(resource.filePath));
}

function packagePathOf(container: XmlDocument) {
  const roots = container.elements.filter(
    (element) =>
      element.local === 'rootfile' &&
      element.attrs['media-type'] === 'application/oebps-package+xml',
  );
  if (roots.length !== 1 || !roots[0].attrs['full-path'])
    fail('INVALID_EPUB_STRUCTURE', '首版仅支持单一 EPUB 内容包');
  return resolveResource('container.xml', roots[0].attrs['full-path']).path;
}

function manifestItems(document: XmlDocument, packagePath: string) {
  const manifest = onlyElement(document, 'manifest');
  return document.elements
    .filter(
      (element) => element.parent === manifest && element.local === 'item',
    )
    .map((element) => ({
      id: element.attrs.id,
      path: resolveResource(packagePath, element.attrs.href).path,
      mediaType: element.attrs['media-type'],
      properties: (element.attrs.properties ?? '').split(/\s+/),
    }));
}

function sameIds(left: Set<string>, right: Set<string>) {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

/** Rebuild references and IDs from changed XML, rather than reusing a pre-insert index. */
async function validateReferences(
  resources: Map<string, ArchiveResource>,
  packagePath: string,
  limits: EpubLimits,
) {
  const packageDocument = await xmlAt(resources, packagePath, limits);
  const items = manifestItems(packageDocument, packagePath);
  if (new Set(items.map((item) => item.path)).size !== items.length)
    fail('INVALID_EPUB_STRUCTURE', 'EPUB 资源清单存在重复目标');
  const paths = new Set(items.map((item) => item.path));
  const ids = new Map<string, Set<string>>();
  const references: { path: string; fragment?: string }[] = [];
  for (const item of items) {
    resourceAt(resources, item.path);
    if (
      [
        'application/xhtml+xml',
        'text/html',
        'image/svg+xml',
        'application/x-dtbncx+xml',
      ].includes(item.mediaType)
    ) {
      const document = await xmlAt(resources, item.path, limits);
      ids.set(item.path, document.ids);
      for (const element of document.elements) {
        for (const [name, value] of Object.entries(element.attrs)) {
          if (!['href', 'src', 'poster', 'data'].includes(name) || !value)
            continue;
          if (
            element.local === 'a' &&
            name === 'href' &&
            /^(https?:|mailto:|tel:)/i.test(value)
          )
            continue;
          references.push(resolveResource(item.path, value));
        }
        if (element.local === 'style') {
          for (const reference of prepareReaderCss(element.text).references)
            references.push(resolveResource(item.path, reference));
        }
      }
    } else if (item.mediaType === 'text/css') {
      const resource = resourceAt(resources, item.path);
      if (resource.size > limits.maxXmlBytes)
        fail('DOCUMENT_SIZE_LIMIT', '单个样式文件超出处理限制');
      for (const reference of prepareReaderCss(
        (await readFile(resource.filePath)).toString('utf8'),
      ).references)
        references.push(resolveResource(item.path, reference));
    }
  }
  for (const element of packageDocument.elements.filter(
    (element) => element.local === 'reference' && element.attrs.href,
  ))
    references.push(resolveResource(packagePath, element.attrs.href));
  for (const reference of references) {
    if (!paths.has(reference.path))
      fail('UNMANIFESTED_RESOURCE', 'EPUB 引用了未列入资源清单的内容');
    resourceAt(resources, reference.path);
    if (
      reference.fragment &&
      ids.has(reference.path) &&
      !ids.get(reference.path)!.has(reference.fragment)
    )
      fail('BROKEN_REFERENCE', 'EPUB 含无效的书内目录或链接目标');
  }
}

/** Assemble all images once from the immutable source, never from a previous export. */
async function assembleIllustrations(
  options: InsertEpubIllustrationsOptions,
  legacy: boolean,
) {
  const limits = { ...DEFAULT_EPUB_LIMITS, ...options.limits };
  for (const [key, value] of Object.entries(limits)) {
    if (
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > DEFAULT_EPUB_LIMITS[key as keyof EpubLimits]
    )
      fail('INVALID_LIMITS', '处理限制配置无效');
  }
  const sourcePath = resolve(options.sourcePath);
  const outputDirectory = resolve(options.outputDirectory);
  const outputPath = join(outputDirectory, 'illustrated.epub');
  const reportPath = join(outputDirectory, 'illustration-report.json');
  if (sourcePath === outputPath)
    fail('INVALID_DESTINATION', '输出目录不能覆盖原书');
  if (
    !/^[a-f\d]{64}$/.test(options.sourceSha256) ||
    !Array.isArray(options.insertions) ||
    options.insertions.length < 1 ||
    options.insertions.length > 501
  )
    fail('INVALID_ILLUSTRATION_ANCHOR', '插画位置与原书不匹配');
  const anchorsByDocument = new Map<string, IllustrationAnchor[]>();
  for (const insertion of options.insertions) {
    const { anchor, image, alt } = insertion;
    if (insertion.layout !== undefined) {
      const layout: unknown = insertion.layout;
      if (
        !layout ||
        typeof layout !== 'object' ||
        Array.isArray(layout) ||
        Object.keys(layout).length !== 2 ||
        !Object.hasOwn(layout, 'size') ||
        !Object.hasOwn(layout, 'alignment') ||
        !['compact', 'medium', 'wide'].includes(insertion.layout.size) ||
        insertion.layout.alignment !== 'center'
      )
        fail('INVALID_ILLUSTRATION_LAYOUT', '插画版式必须使用已注册的居中尺寸');
    }
    if (
      !/^[a-f\d]{64}$/.test(image.sha256) ||
      !/^[a-f\d]{64}$/.test(anchor.contentSha256) ||
      !safeArchiveName(anchor.documentPath) ||
      !Number.isSafeInteger(anchor.sourceStart) ||
      !Number.isSafeInteger(anchor.sourceEnd) ||
      anchor.sourceStart < 0 ||
      anchor.sourceEnd <= anchor.sourceStart
    )
      fail('INVALID_ILLUSTRATION_ANCHOR', '插画位置与原书不匹配');
    if (
      typeof alt !== 'string' ||
      !alt.trim() ||
      Array.from(alt).length > 500 ||
      Array.from(alt).some((point) => {
        const value = point.codePointAt(0)!;
        return (
          (value < 32 && ![9, 10, 13].includes(value)) ||
          value === 127 ||
          value === 0xfffe ||
          value === 0xffff ||
          (value >= 0xd800 && value <= 0xdfff)
        );
      })
    )
      fail('INVALID_ILLUSTRATION_ALT', '插画说明无效');
    const anchors = anchorsByDocument.get(anchor.documentPath) ?? [];
    if (
      anchors.some(
        (existing) =>
          anchor.sourceStart < existing.sourceEnd &&
          anchor.sourceEnd > existing.sourceStart,
      )
    )
      fail('DUPLICATE_ILLUSTRATION_ANCHOR', '插画位置重复或互相冲突');
    anchors.push(anchor);
    anchorsByDocument.set(anchor.documentPath, anchors);
  }
  await mkdir(outputDirectory, { recursive: true });
  // Nested run/child paths can exceed Windows mkdtemp's path limit. Scratch
  // resources are private and independent of the immutable publication path.
  const scratch = await mkdtemp(join(tmpdir(), 'epub-illustration-work-'));
  const published: string[] = [];
  try {
    options.signal?.throwIfAborted();
    const sourceStats = await lstat(sourcePath);
    if (!sourceStats.isFile() || sourceStats.size > limits.maxSourceBytes)
      fail('SOURCE_SIZE_LIMIT', '上传文件超出 EPUB 处理限制');
    if ((await hashFile(sourcePath, options.signal)) !== options.sourceSha256)
      fail('SOURCE_CHANGED', '原书已变化，未插入插画');
    // Decode and privately stage one image at a time; do not retain N image buffers.
    const stagedImages: {
      path: string;
      size: number;
      width: number;
      height: number;
    }[] = [];
    let stagedImageBytes = 0;
    for (const [index, insertion] of options.insertions.entries()) {
      options.signal?.throwIfAborted();
      const imageStats = await lstat(insertion.image.path);
      if (
        !imageStats.isFile() ||
        imageStats.size <= 0 ||
        imageStats.size > 16 * 1024 * 1024
      )
        fail('IMAGE_ASSET_REJECTED', '插画文件超出安全限制');
      stagedImageBytes += imageStats.size;
      if (stagedImageBytes > limits.maxExpandedBytes)
        fail('ARCHIVE_LIMIT', '插画合计大小超出 EPUB 展开内容限制');
      const image = await readFile(insertion.image.path);
      if (hash(image) !== insertion.image.sha256)
        fail('IMAGE_ASSET_CHANGED', '插画文件已变化');
      const decoder = sharp(image, {
        failOn: 'warning',
        limitInputPixels: 16_000_000,
      });
      let width = 0;
      let height = 0;
      try {
        const metadata = await decoder.metadata();
        if (
          metadata.format !== 'png' ||
          (metadata.pages ?? 1) !== 1 ||
          !metadata.width ||
          !metadata.height
        )
          fail('IMAGE_ASSET_REJECTED', '插画必须是已验证的单帧 PNG');
        width = metadata.width;
        height = metadata.height;
        await decoder.raw().toBuffer();
      } catch (error) {
        if (error instanceof EpubProcessingError) throw error;
        fail('IMAGE_ASSET_REJECTED', '插画文件无法通过像素完整性校验');
      } finally {
        decoder.destroy();
      }
      const path = join(scratch, `checked-image-${index}`);
      await writeFile(path, image, { flag: 'wx' });
      stagedImages.push({ path, size: image.length, width, height });
    }
    const originalDirectory = join(scratch, 'original');
    await mkdir(originalDirectory);
    const originals = await unpackArchive(
      sourcePath,
      originalDirectory,
      limits,
      options.signal,
    );
    const originalPackagePath = packagePathOf(
      await xmlAt(originals, 'META-INF/container.xml', limits),
    );
    const originalItems = manifestItems(
      await xmlAt(originals, originalPackagePath, limits),
      originalPackagePath,
    );
    const stylePaths = new Set(
      originalItems
        .filter((item) => item.mediaType === 'text/css')
        .map((item) => item.path),
    );
    const positionalCss =
      /epub-ai validated structure roles|:(?:nth-|first-child|last-child|only-child|first-of-type|last-of-type|only-of-type)/i;
    for (const resource of originals.values()) {
      if (/epub-ai-structure-/i.test(resource.name))
        fail(
          'POSITIONAL_ROLE_CSS',
          '含按段落序号定位的 AI 样式，请从原书重新配图',
        );
      if (/\.css$/i.test(resource.name) || stylePaths.has(resource.name)) {
        if (resource.size > limits.maxXmlBytes)
          fail('DOCUMENT_SIZE_LIMIT', '单个样式文件超出处理限制');
        if (
          positionalCss.test(
            (await readFile(resource.filePath)).toString('utf8'),
          )
        )
          fail('POSITIONAL_ROLE_CSS', '按子元素位置定位的样式需要先重新映射');
      }
    }
    const originalDocuments = new Map<string, XmlDocument>();
    for (const [documentPath, anchors] of anchorsByDocument) {
      const document = await xmlAt(originals, documentPath, limits);
      originalDocuments.set(documentPath, document);
      if (
        document.elements.some(
          (element) =>
            element.local === 'style' && positionalCss.test(element.text),
        )
      )
        fail('POSITIONAL_ROLE_CSS', '按子元素位置定位的样式需要先重新映射');
      const body = onlyElement(document, 'body');
      for (const anchor of anchors) {
        const paragraph = document.elements.find(
          (element) =>
            element.start === anchor.sourceStart &&
            element.end === anchor.sourceEnd &&
            element.local === 'p' &&
            element.uri === xhtmlNamespace &&
            element.parent === body,
        );
        if (
          !paragraph ||
          body.uri !== xhtmlNamespace ||
          hash(document.source.slice(paragraph.start, paragraph.end)) !==
            anchor.contentSha256 ||
          document.elements.some(
            (element) =>
              element.start > paragraph.start &&
              element.start < paragraph.end &&
              (!inlineElements.has(element.local) ||
                element.uri !== xhtmlNamespace),
          )
        )
          fail(
            'INVALID_ILLUSTRATION_ANCHOR',
            '插画位置必须是原书中可安全定位的完整段落',
          );
      }
    }
    // Exactly one deterministic baseline from the original source for the whole batch.
    const baseline = await processEpub({
      sourcePath,
      outputDirectory: join(scratch, 'baseline'),
      limits,
      signal: options.signal,
    });
    if (baseline.report.sourceSha256 !== options.sourceSha256)
      fail('SOURCE_CHANGED', '原书已变化，未插入插画');
    const baselineDirectory = join(scratch, 'baseline-resources');
    await mkdir(baselineDirectory);
    const resources = await unpackArchive(
      baseline.outputPath,
      baselineDirectory,
      limits,
      options.signal,
    );
    const expectedCssRepairs = await unusedFontPlaceholderRepairs(
      originals,
      originalItems,
      limits,
      options.signal,
    );
    const expectedRepairReport = expectedCssRepairs.size
      ? {
          policyVersion: UNUSED_FONT_PLACEHOLDER_POLICY,
          stylesheets: [...expectedCssRepairs.values()].map(
            (repair) => repair.record,
          ),
        }
      : undefined;
    if (
      JSON.stringify(baseline.report.sourceRepairs) !==
        JSON.stringify(expectedRepairReport) ||
      baseline.report.integrity.originalResourcesPreserved !==
        (expectedCssRepairs.size === 0)
    )
      fail('INTEGRITY_FAILURE', '基线字体修复记录与原书不一致');
    for (const path of stylePaths) {
      const expected =
        expectedCssRepairs.get(path)?.record.outputSha256 ??
        originals.get(path)?.sha256;
      if (!expected || resources.get(path)?.sha256 !== expected)
        fail('INTEGRITY_FAILURE', '基线样式变化超出源字体修复白名单');
    }
    const baselineHashes = new Map(
      [...resources].map(([name, resource]) => [name, resource.sha256]),
    );
    const packagePath = packagePathOf(
      await xmlAt(resources, 'META-INF/container.xml', limits),
    );
    const packageDocument = await xmlAt(resources, packagePath, limits);
    const items = manifestItems(packageDocument, packagePath);
    const spine = onlyElement(packageDocument, 'spine');
    const cssPath = posix.join(
      posix.dirname(packagePath),
      'epub-ai-illustrations.css',
    );
    const imagePaths = options.insertions.map((insertion, index) =>
      posix.join(
        posix.dirname(packagePath),
        'epub-ai-illustrations',
        `${index + 1}-${insertion.image.sha256.slice(0, 16)}-${insertion.anchor.contentSha256.slice(0, 16)}.png`,
      ),
    );
    for (const name of [...imagePaths, cssPath]) {
      if (
        [...resources.keys()].some(
          (existing) => existing.toLowerCase() === name.toLowerCase(),
        )
      )
        fail('GENERATED_RESOURCE_COLLISION', '书中已有同名插画资源');
    }
    const uri = (from: string, to: string) =>
      posix
        .relative(posix.dirname(from), to)
        .split('/')
        .map(encodeURIComponent)
        .join('/');
    const changedDocuments = new Map<string, string>();
    const illustrations: IllustratedEpubBatchReport['illustrations'] =
      options.insertions.map((insertion, index) => ({
        documentPath: insertion.anchor.documentPath,
        sourceStart: insertion.anchor.sourceStart,
        sourceEnd: insertion.anchor.sourceEnd,
        anchorContentSha256: insertion.anchor.contentSha256,
        imagePath: imagePaths[index],
        imageSha256: insertion.image.sha256,
        width: stagedImages[index].width,
        height: stagedImages[index].height,
        ...(insertion.layout && { layout: { ...insertion.layout } }),
      }));
    for (const [documentPath] of anchorsByDocument) {
      const target = items.find((item) => item.path === documentPath);
      if (
        !target ||
        !['application/xhtml+xml', 'text/html'].includes(target.mediaType) ||
        target.properties.includes('nav') ||
        !packageDocument.elements.some(
          (element) =>
            element.parent === spine &&
            element.local === 'itemref' &&
            element.attrs.idref === target.id,
        )
      )
        fail('INVALID_ILLUSTRATION_ANCHOR', '插画位置不属于可处理的阅读正文');
      const originalDocument = originalDocuments.get(documentPath)!;
      const originalBody = onlyElement(originalDocument, 'body');
      const originalBodySource = originalDocument.source.slice(
        originalBody.start,
        originalBody.end,
      );
      const document = await xmlAt(resources, documentPath, limits);
      const body = onlyElement(document, 'body');
      const head = onlyElement(document, 'head');
      if (
        document.source.slice(body.start, body.end) !== originalBodySource ||
        head.end > body.start
      )
        fail('INTEGRITY_FAILURE', '插图前原始正文校验失败');
      const prefix = body.name.includes(':')
        ? `${body.name.split(':')[0]}:`
        : '';
      const headPrefix = head.name.includes(':')
        ? `${head.name.split(':')[0]}:`
        : '';
      const edits = options.insertions
        .map((insertion, index) => ({ insertion, index }))
        .filter(
          ({ insertion }) => insertion.anchor.documentPath === documentPath,
        )
        .sort(
          (left, right) =>
            right.insertion.anchor.sourceEnd - left.insertion.anchor.sourceEnd,
        );
      let changedDocument = document.source;
      let expectedBody = originalBodySource;
      for (const { insertion, index } of edits) {
        const className = insertion.layout
          ? `epub-ai-chapter-illustration epub-ai-illustration-${insertion.layout.size}`
          : 'epub-ai-chapter-illustration';
        const markup = `\n<${prefix}div class="${className}"><${prefix}img src="${attributeEscape(uri(documentPath, imagePaths[index]))}" alt="${attributeEscape(insertion.alt)}" /></${prefix}div>\n`;
        const relativeOffset = insertion.anchor.sourceEnd - originalBody.start;
        const offset = body.start + relativeOffset;
        changedDocument =
          changedDocument.slice(0, offset) +
          markup +
          changedDocument.slice(offset);
        expectedBody =
          expectedBody.slice(0, relativeOffset) +
          markup +
          expectedBody.slice(relativeOffset);
      }
      const link = `\n<${headPrefix}link rel="stylesheet" type="text/css" href="${attributeEscape(uri(documentPath, cssPath))}" />\n`;
      changedDocument =
        changedDocument.slice(0, head.closingStart) +
        link +
        changedDocument.slice(head.closingStart);
      const reparsed = parseXml(Buffer.from(changedDocument));
      const newBody = onlyElement(reparsed, 'body');
      if (
        reparsed.source.slice(newBody.start, newBody.end) !== expectedBody ||
        !sameIds(document.ids, reparsed.ids)
      )
        fail('INTEGRITY_FAILURE', '插图白名单或原始标识符校验失败');
      changedDocuments.set(documentPath, changedDocument);
    }
    const manifest = onlyElement(packageDocument, 'manifest');
    const manifestPrefix = manifest.name.includes(':')
      ? `${manifest.name.split(':')[0]}:`
      : '';
    const usedIds = new Set(packageDocument.ids);
    const idFor = (base: string) => {
      let id = base;
      while (usedIds.has(id)) id += '-next';
      usedIds.add(id);
      return id;
    };
    const added =
      '\n' +
      imagePaths
        .map(
          (path, index) =>
            `<${manifestPrefix}item id="${idFor(`epub-ai-chapter-art-${index + 1}`)}" href="${attributeEscape(uri(packagePath, path))}" media-type="image/png" />`,
        )
        .join('\n') +
      `\n<${manifestPrefix}item id="${idFor('epub-ai-chapter-art-css')}" href="${attributeEscape(uri(packagePath, cssPath))}" media-type="text/css" />\n`;
    const changedPackage =
      packageDocument.source.slice(0, manifest.closingStart) +
      added +
      packageDocument.source.slice(manifest.closingStart);
    const parsedPackage = parseXml(Buffer.from(changedPackage));
    const newSpine = onlyElement(parsedPackage, 'spine');
    if (
      parsedPackage.source.slice(newSpine.start, newSpine.end) !==
      packageDocument.source.slice(spine.start, spine.end)
    )
      fail('INTEGRITY_FAILURE', '阅读顺序校验失败');
    let generated = 0;
    const put = async (name: string, content: string) => {
      const bytes = Buffer.from(content);
      const path = join(scratch, `inserted-${generated++}`);
      await writeFile(path, bytes, { flag: 'wx' });
      resources.set(name, {
        name,
        filePath: path,
        size: bytes.length,
        sha256: hash(bytes),
      });
    };
    for (const [name, content] of changedDocuments) await put(name, content);
    await put(packagePath, changedPackage);
    await put(
      cssPath,
      css +
        (options.insertions.some((insertion) => insertion.layout)
          ? layoutCss
          : ''),
    );
    for (const [index, staged] of stagedImages.entries()) {
      const name = imagePaths[index];
      resources.set(name, {
        name,
        filePath: staged.path,
        size: staged.size,
        sha256: options.insertions[index].image.sha256,
      });
    }
    const changedResources = [...changedDocuments.keys(), packagePath];
    const addedResources = [...imagePaths, cssPath];
    if (resources.size !== baselineHashes.size + addedResources.length)
      fail('INTEGRITY_FAILURE', '插图资源白名单校验失败');
    for (const [name, expected] of baselineHashes) {
      if (
        !changedResources.includes(name) &&
        resources.get(name)?.sha256 !== expected
      )
        fail('INTEGRITY_FAILURE', '非插图资源发生变化');
    }
    for (const item of items.filter((entry) =>
      ['application/xhtml+xml', 'text/html'].includes(entry.mediaType),
    )) {
      const before = await xmlAt(originals, item.path, limits);
      const after = await xmlAt(resources, item.path, limits);
      if (!sameIds(before.ids, after.ids))
        fail('INTEGRITY_FAILURE', '原书标识符发生变化');
      if (!changedDocuments.has(item.path)) {
        const beforeBody = onlyElement(before, 'body');
        const afterBody = onlyElement(after, 'body');
        if (
          before.source.slice(beforeBody.start, beforeBody.end) !==
          after.source.slice(afterBody.start, afterBody.end)
        )
          fail('INTEGRITY_FAILURE', '其他正文发生变化');
      }
    }
    for (const item of items.filter((entry) =>
      entry.mediaType.startsWith('image/'),
    )) {
      if (originals.get(item.path)?.sha256 !== resources.get(item.path)?.sha256)
        fail('INTEGRITY_FAILURE', '原始图片发生变化');
    }
    await validateReferences(resources, packagePath, limits);
    if (
      resources.size > limits.maxEntries ||
      [...resources.values()].some(
        (resource) => resource.size > limits.maxEntryBytes,
      ) ||
      [...resources.values()].reduce(
        (total, resource) => total + resource.size,
        0,
      ) > limits.maxExpandedBytes
    )
      fail('ARCHIVE_LIMIT', '插画版 EPUB 超出书籍资源限制');
    const stagedOutput = join(scratch, 'illustrated.epub');
    await writeArchive(resources, stagedOutput, options.signal);
    const written = await unpackArchive(
      stagedOutput,
      scratch,
      limits,
      options.signal,
      false,
    );
    if (
      written.size !== resources.size ||
      [...resources].some(
        ([name, resource]) =>
          written.get(name)?.sha256 !== resource.sha256 ||
          written.get(name)?.size !== resource.size,
      )
    )
      fail('INTEGRITY_FAILURE', '导出资源哈希校验失败');
    if ((await hashFile(sourcePath, options.signal)) !== options.sourceSha256)
      fail('SOURCE_CHANGED', '处理期间原书发生变化');
    const report: IllustratedEpubBatchReport = {
      schemaVersion: 1,
      pipelineVersion: 'chapter-illustration-batch-1',
      sourceSha256: options.sourceSha256,
      outputSha256: await hashFile(stagedOutput, options.signal),
      illustrations,
      integrity: {
        sourceUnchanged: true,
        bodyBytesPreserved: false,
        originalBodySourceFragmentsPreserved: true,
        exactAllowlistedInsertion: true,
        originalImagesPreserved: true,
        originalIdsPreserved: true,
        spineOrderPreserved: true,
        navigationTargetsPreserved: true,
        internalReferencesChecked: true,
        writtenArchiveHashesVerified: true,
      },
      phases: {
        baseline: {
          originalBodyBytesPreserved: true,
          allowedChanges: [
            'reader-first-head-links-and-new-css',
            'xhtml-doctype-repair',
            'ncx-uid-and-playorder-repair-with-same-targets',
            'opf-new-css-manifest-items',
            'opf-epub2-redundant-cover-property-with-matching-cover-meta',
            ...(expectedCssRepairs.size
              ? ['unused-missing-font-placeholder-with-proven-unused-consumers']
              : []),
          ],
          warningCodes: [
            ...new Set(baseline.report.warnings.map((warning) => warning.code)),
          ],
          ...(expectedRepairReport
            ? {
                sourceRepairs: expectedRepairReport,
                originalResourcesPreserved: false,
              }
            : {}),
        },
        insertion: {
          changedResources,
          addedResources,
          insertedBodyElements: options.insertions.length,
        },
      },
      validation: {
        epubcheck: 'not-run',
        device: 'not-tested',
        aesthetic: 'not-approved',
      },
    };
    await copyFile(stagedOutput, outputPath, constants.COPYFILE_EXCL);
    published.push(outputPath);
    await writeFile(
      reportPath,
      JSON.stringify(legacy ? toLegacyReport(report) : report, null, 2) + '\n',
      { flag: 'wx' },
    );
    published.push(reportPath);
    return { outputPath, reportPath, report };
  } catch (error) {
    for (const path of published) await rm(path, { force: true });
    if (error instanceof EpubProcessingError) throw error;
    if (options.signal?.aborted) fail('PROCESSING_CANCELLED', '书籍处理已取消');
    fail('ILLUSTRATION_INSERT_FAILED', '插画导出失败，原书未修改');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function toLegacyReport(
  batch: IllustratedEpubBatchReport,
): IllustratedEpubReport {
  const first = batch.illustrations[0];
  return {
    schemaVersion: 1,
    pipelineVersion: 'chapter-illustration-trial-1',
    sourceSha256: batch.sourceSha256,
    outputSha256: batch.outputSha256,
    illustration: {
      documentPath: first.documentPath,
      anchorContentSha256: first.anchorContentSha256,
      imagePath: first.imagePath,
      imageSha256: first.imageSha256,
      width: first.width,
      height: first.height,
      ...(first.layout && { layout: { ...first.layout } }),
    },
    integrity: batch.integrity,
    phases: {
      baseline: batch.phases.baseline,
      insertion: { ...batch.phases.insertion, insertedBodyElements: 1 },
    },
    validation: batch.validation,
  };
}

export async function insertEpubIllustrations(
  options: InsertEpubIllustrationsOptions,
) {
  return assembleIllustrations(options, false);
}

/** Backward-compatible single-image API and report contract. */
export async function insertEpubIllustration(
  options: InsertEpubIllustrationOptions,
) {
  const { anchor, image, alt, layout, ...shared } = options;
  const result = await assembleIllustrations(
    {
      ...shared,
      insertions: [
        { anchor, image, alt, ...(layout === undefined ? {} : { layout }) },
      ],
    },
    true,
  );
  return { ...result, report: toLegacyReport(result.report) };
}
