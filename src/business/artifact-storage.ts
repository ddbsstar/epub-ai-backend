import { createReadStream } from 'node:fs';
import {
  mkdir,
  readFile,
  stat,
  rm,
  copyFile,
  writeFile,
  link,
  open,
} from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable } from '@nestjs/common';
import { AppConfig } from '../config/app-config.module.js';
import { businessError } from './business-errors.js';

export interface ArtifactStorage {
  path(key: string): string;
  storeStream(
    key: string,
    stream: Readable,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<{ sha256: string; byteSize: number }>;
  describe(key: string): Promise<{ sha256: string; byteSize: number }>;
}

@Injectable()
export class LocalArtifactStorage implements ArtifactStorage {
  constructor(@Inject(AppConfig) private readonly config: AppConfig) {}

  path(key: string): string {
    const root = this.config.get('PROCESSING_DATA_DIR');
    if (
      !root ||
      !isAbsolute(root) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,300}$/.test(key) ||
      key.split('/').some((part) => part === '..' || part === '.')
    )
      throw businessError('ARTIFACT_NOT_FOUND', 404);
    const target = resolve(root, key);
    const within = relative(resolve(root), target);
    if (!within || within.startsWith(`..${sep}`) || isAbsolute(within))
      throw businessError('ARTIFACT_NOT_FOUND', 404);
    return target;
  }

  async storeStream(
    key: string,
    stream: Readable,
    maxBytes: number,
    signal?: AbortSignal,
  ) {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    const hash = createHash('sha256');
    let byteSize = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        byteSize += chunk.length;
        if (byteSize > maxBytes) {
          callback(businessError('UPLOAD_TOO_LARGE', 413));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    const handle = await open(target, 'wx', 0o600);
    try {
      await pipeline(stream, meter, handle.createWriteStream(), { signal });
      return { sha256: hash.digest('hex'), byteSize };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(target, { force: true });
      throw error;
    }
  }

  async describe(key: string) {
    const hash = createHash('sha256');
    const file = this.path(key);
    const info = await stat(file);
    if (!info.isFile()) throw businessError('ARTIFACT_NOT_FOUND', 404);
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return { sha256: hash.digest('hex'), byteSize: info.size };
  }

  async storeCopy(key: string, source: string) {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target, 1);
    return this.describe(key);
  }

  async storeJson(key: string, value: unknown) {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
    try {
      await link(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    return this.describe(key);
  }

  async readJson(key: string): Promise<unknown> {
    return JSON.parse(await readFile(this.path(key), 'utf8'));
  }
}
