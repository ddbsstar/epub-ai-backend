import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform, Writable } from 'node:stream';
import { crc32 } from 'node:zlib';
import * as yauzl from 'yauzl';
import * as yazl from 'yazl';
import { EpubProcessingError, type EpubLimits } from './epub.types.js';

export interface ArchiveResource {
  name: string;
  filePath: string;
  size: number;
  sha256: string;
}

export async function hashFile(
  filePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath, { signal }))
    hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export function safeArchiveName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 1_024 &&
    !/[\\:]/.test(name) &&
    !Array.from(name).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    !name.startsWith('/') &&
    !name
      .split('/')
      .some(
        (segment) => segment === '..' || segment === '.' || segment === '',
      ) &&
    name.normalize('NFC') === name
  );
}

/** Resolve a package URI without ever making a network request or extracting to its name. */
export function resolveResource(
  from: string,
  reference: string,
): { path: string; fragment?: string } {
  if (/^[a-z][a-z\d+.-]*:/i.test(reference) || reference.startsWith('//')) {
    throw new EpubProcessingError(
      'REMOTE_RESOURCE',
      '首版仅支持资源完整保存在书内的 EPUB',
    );
  }
  const [withoutFragment, rawFragment] = reference.split('#', 2);
  if (withoutFragment.includes('?')) {
    throw new EpubProcessingError(
      'INVALID_REFERENCE',
      '书内资源引用含不支持的参数',
    );
  }
  let decoded: string;
  let fragment: string | undefined;
  try {
    decoded = decodeURIComponent(withoutFragment);
    fragment =
      rawFragment === undefined ? undefined : decodeURIComponent(rawFragment);
  } catch {
    throw new EpubProcessingError('INVALID_REFERENCE', '书内资源地址编码无效');
  }
  if (
    decoded.startsWith('/') ||
    decoded.includes('\\') ||
    decoded.includes('\0') ||
    decoded.includes(':')
  ) {
    throw new EpubProcessingError('UNSAFE_ARCHIVE_PATH', '书内资源路径不安全');
  }
  const resourcePath = decoded
    ? posix.normalize(posix.join(posix.dirname(from), decoded))
    : from;
  if (!safeArchiveName(resourcePath)) {
    throw new EpubProcessingError(
      'UNSAFE_ARCHIVE_PATH',
      '书内资源超出 EPUB 范围',
    );
  }
  return { path: resourcePath, fragment };
}

export async function unpackArchive(
  sourcePath: string,
  scratchDirectory: string,
  limits: EpubLimits,
  signal?: AbortSignal,
  materialize = true,
): Promise<Map<string, ArchiveResource>> {
  const sourceStats = await stat(sourcePath);
  if (!sourceStats.isFile() || sourceStats.size > limits.maxSourceBytes) {
    throw new EpubProcessingError(
      'SOURCE_SIZE_LIMIT',
      '上传文件超出 EPUB 处理限制',
    );
  }
  const archive = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(
      sourcePath,
      {
        lazyEntries: true,
        autoClose: false,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (error, zip) => {
        if (error || !zip)
          reject(
            new EpubProcessingError(
              'INVALID_ARCHIVE',
              '无法读取 EPUB 压缩文件',
            ),
          );
        else resolve(zip);
      },
    );
  });
  try {
    const entries = await new Promise<yauzl.Entry[]>((resolve, reject) => {
      const list: yauzl.Entry[] = [];
      const names = new Set<string>();
      let expanded = 0;
      archive.once('error', () =>
        reject(new EpubProcessingError('INVALID_ARCHIVE', 'EPUB 压缩结构无效')),
      );
      archive.on('entry', (entry: yauzl.Entry) => {
        try {
          signal?.throwIfAborted();
          const directory = entry.fileName.endsWith('/');
          if (directory && entry.uncompressedSize !== 0)
            throw new EpubProcessingError(
              'INVALID_ARCHIVE',
              'EPUB 目录条目不能包含文件内容',
            );
          const name = directory ? entry.fileName.slice(0, -1) : entry.fileName;
          const canonical = name.normalize('NFC').toLowerCase();
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (
            !safeArchiveName(name) ||
            names.has(canonical) ||
            mode === 0xa000 ||
            (mode && mode !== 0x8000 && mode !== 0x4000)
          ) {
            throw new EpubProcessingError(
              'UNSAFE_ARCHIVE_PATH',
              'EPUB 含重复、链接或不安全的资源路径',
            );
          }
          names.add(canonical);
          if (entry.generalPurposeBitFlag & 1)
            throw new EpubProcessingError(
              'ENCRYPTED_EPUB',
              '不支持加密或 DRM EPUB',
            );
          if (![0, 8].includes(entry.compressionMethod))
            throw new EpubProcessingError(
              'UNSUPPORTED_COMPRESSION',
              'EPUB 压缩算法不受支持',
            );
          expanded += entry.uncompressedSize;
          if (
            names.size > limits.maxEntries ||
            entry.uncompressedSize > limits.maxEntryBytes ||
            expanded > limits.maxExpandedBytes ||
            entry.uncompressedSize / Math.max(entry.compressedSize, 1) >
              limits.maxCompressionRatio
          ) {
            throw new EpubProcessingError(
              'ARCHIVE_LIMIT',
              'EPUB 展开内容超出处理限制',
            );
          }
          if (!directory) list.push(entry);
          archive.readEntry();
        } catch (error) {
          reject(error);
        }
      });
      archive.once('end', () => resolve(list));
      archive.readEntry();
    });
    if (entries.length === 0)
      throw new EpubProcessingError('INVALID_ARCHIVE', 'EPUB 没有有效内容');
    const resources = new Map<string, ArchiveResource>();
    let actualExpanded = 0;
    for (const [index, entry] of entries.entries()) {
      signal?.throwIfAborted();
      const filePath = join(scratchDirectory, `resource-${index}`);
      const input = await new Promise<NodeJS.ReadableStream>(
        (resolve, reject) => {
          archive.openReadStream(entry, (error, stream) =>
            error || !stream
              ? reject(
                  new EpubProcessingError(
                    'INVALID_ARCHIVE',
                    '无法展开 EPUB 资源',
                  ),
                )
              : resolve(stream),
          );
        },
      );
      let count = 0;
      let crc = 0;
      const hash = createHash('sha256');
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          count += chunk.length;
          actualExpanded += chunk.length;
          if (
            count > limits.maxEntryBytes ||
            actualExpanded > limits.maxExpandedBytes
          ) {
            callback(
              new EpubProcessingError(
                'ARCHIVE_LIMIT',
                'EPUB 展开内容超出处理限制',
              ),
            );
            return;
          }
          hash.update(chunk);
          crc = crc32(chunk, crc);
          callback(null, chunk);
        },
      });
      await pipeline(
        input,
        meter,
        materialize
          ? createWriteStream(filePath, { flags: 'wx' })
          : new Writable({
              write(_chunk, _encoding, callback) {
                callback();
              },
            }),
        { signal },
      );
      if (count !== entry.uncompressedSize || crc !== entry.crc32 >>> 0) {
        throw new EpubProcessingError('ARCHIVE_INTEGRITY', 'EPUB 资源校验失败');
      }
      resources.set(entry.fileName, {
        name: entry.fileName,
        filePath,
        size: count,
        sha256: hash.digest('hex'),
      });
    }
    return resources;
  } finally {
    archive.close();
  }
}

export async function writeArchive(
  resources: Map<string, ArchiveResource>,
  outputPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const zip = new yazl.ZipFile();
  const completion = pipeline(
    zip.outputStream,
    createWriteStream(outputPath, { flags: 'wx' }),
    { signal },
  );
  zip.on('error', (error: Error) =>
    (zip.outputStream as Readable).destroy(error),
  );
  const sorted = [...resources.values()].sort((left, right) =>
    left.name.localeCompare(right.name, 'en'),
  );
  const mimetype = resources.get('mimetype');
  if (!mimetype)
    throw new EpubProcessingError(
      'INVALID_EPUB_STRUCTURE',
      'EPUB 缺少 mimetype',
    );
  for (const resource of [
    mimetype,
    ...sorted.filter((entry) => entry.name !== 'mimetype'),
  ]) {
    zip.addFile(resource.filePath, resource.name, {
      compress: resource.name !== 'mimetype',
      mtime: new Date('1980-01-01T00:00:00Z'),
      forceDosTimestamp: true,
    });
  }
  zip.end();
  await completion;
}
