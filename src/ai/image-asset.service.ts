import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { request, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import sharp from 'sharp';
import { AppConfig } from '../config/app-config.module.js';

export class ImageAssetError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ImageAssetError';
  }
}

/** Internal transport injection for offline tests; never supplied by an API caller. */
export const IMAGE_ASSET_TRANSPORT = Symbol('IMAGE_ASSET_TRANSPORT');

export interface ImageAssetTransport {
  lookup(hostname: string): Promise<LookupAddress[]>;
  request(
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ): ClientRequest;
}

const defaultTransport: ImageAssetTransport = {
  lookup: (hostname) => lookup(hostname, { all: true, order: 'verbatim' }),
  request,
};

export interface DownloadedImageAsset {
  bytes: Buffer;
  sha256: string;
  byteSize: number;
  mediaType: 'image/png';
  width: number;
  height: number;
}

/** Conservatively admit public unicast only, including documentation/reserved ranges. */
function publicAddress(address: LookupAddress): boolean {
  const family = isIP(address.address);
  if (family !== address.family) return false;
  if (family === 4) {
    const [a = 0, b = 0, c = 0] = address.address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family !== 6 || address.address.includes('.')) return false;
  const halves = address.address.toLowerCase().split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const parts =
    halves.length === 2
      ? [
          ...left,
          ...Array<string>(8 - left.length - right.length).fill('0'),
          ...right,
        ]
      : left;
  const first = Number.parseInt(parts[0] ?? '0', 16);
  const second = Number.parseInt(parts[1] ?? '0', 16);
  return (
    first >= 0x2000 &&
    first <= 0x3fff &&
    !(first === 0x2001 && (second < 0x0200 || second === 0x0db8)) &&
    first !== 0x2002 &&
    !(first === 0x3fff && second < 0x1000)
  );
}

async function abortable<T>(
  work: Promise<T>,
  signal: AbortSignal,
  cancel?: () => void,
): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => undefined);
    cancel?.();
    throw new ImageAssetError('IMAGE_CANCELLED');
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      cancel?.();
      reject(new ImageAssetError('IMAGE_CANCELLED'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

@Injectable()
export class ImageAssetService {
  private readonly transport: ImageAssetTransport;

  constructor(
    @Inject(AppConfig) private readonly config: AppConfig,
    @Optional()
    @Inject(IMAGE_ASSET_TRANSPORT)
    transport?: ImageAssetTransport,
  ) {
    this.transport = transport ?? defaultTransport;
  }

  /** Signed URLs remain transient; neither this result nor any error retains one. */
  async download(
    remoteUrl: string,
    callerSignal?: AbortSignal,
  ): Promise<DownloadedImageAsset> {
    const timeout = AbortSignal.timeout(this.config.get('IMAGE_TIMEOUT_MS'));
    const signal = callerSignal
      ? AbortSignal.any([timeout, callerSignal])
      : timeout;
    try {
      signal.throwIfAborted();
      const url = this.validateUrl(remoteUrl);
      const addresses = await abortable(
        this.transport.lookup(url.hostname),
        signal,
      );
      if (!addresses.length || !addresses.every(publicAddress))
        throw new ImageAssetError('IMAGE_ADDRESS_REJECTED');
      const source = await this.readRemote(url, addresses[0]!, signal);
      return await this.normalize(source.bytes, source.mediaType, signal);
    } catch (error) {
      if (callerSignal?.aborted) throw new ImageAssetError('IMAGE_CANCELLED');
      if (timeout.aborted) throw new ImageAssetError('IMAGE_TIMEOUT');
      if (error instanceof ImageAssetError) throw error;
      throw new ImageAssetError('IMAGE_DOWNLOAD_FAILED');
    }
  }

  private validateUrl(value: string): URL {
    let url: URL;
    try {
      if (value.length > 16384) throw new Error();
      url = new URL(value);
    } catch {
      throw new ImageAssetError('IMAGE_URL_REJECTED');
    }
    const hosts = this.config
      .get('IMAGE_DOWNLOAD_HOSTS')
      .split(',')
      .map((host) => host.trim().toLowerCase());
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      (url.port && url.port !== '443') ||
      isIP(url.hostname) !== 0 ||
      !hosts.includes(url.hostname)
    )
      throw new ImageAssetError('IMAGE_URL_REJECTED');
    return url;
  }

  private readRemote(
    url: URL,
    pinned: LookupAddress,
    signal: AbortSignal,
  ): Promise<{ bytes: Buffer; mediaType: string }> {
    const limit = this.config.get('IMAGE_MAX_BYTES');
    return new Promise((resolve, reject) => {
      let done = false;
      let current: IncomingMessage | undefined;
      let outgoing: ClientRequest | undefined;
      const finish = (
        error?: ImageAssetError,
        result?: { bytes: Buffer; mediaType: string },
      ) => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', onAbort);
        if (error) {
          current?.destroy();
          outgoing?.destroy();
          reject(error);
        } else if (result) resolve(result);
      };
      const onAbort = () => finish(new ImageAssetError('IMAGE_CANCELLED'));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      try {
        outgoing = this.transport.request(
          {
            protocol: 'https:',
            hostname: url.hostname,
            servername: url.hostname,
            port: 443,
            path: `${url.pathname}${url.search}`,
            method: 'GET',
            agent: false,
            rejectUnauthorized: true,
            family: pinned.family,
            // The socket uses precisely the previously checked IP; no DNS second lookup.
            lookup: (_hostname, options, callback) => {
              if (options.all) callback(null, [pinned]);
              else callback(null, pinned.address, pinned.family);
            },
            headers: { accept: 'image/png, image/jpeg' },
          },
          (response) => {
            current = response;
            if (done) {
              response.destroy();
              return;
            }
            response.on('error', () =>
              finish(new ImageAssetError('IMAGE_DOWNLOAD_FAILED')),
            );
            response.on('aborted', () =>
              finish(new ImageAssetError('IMAGE_DOWNLOAD_FAILED')),
            );
            // node:https does not follow redirects. A redirect is an ordinary rejection.
            if (response.statusCode !== 200) {
              finish(new ImageAssetError('IMAGE_DOWNLOAD_REJECTED'));
              return;
            }
            const contentType = response.headers['content-type'];
            const mediaType =
              typeof contentType === 'string'
                ? contentType.split(';')[0]!.trim().toLowerCase()
                : '';
            const encoding = response.headers['content-encoding'];
            if (
              !['image/png', 'image/jpeg'].includes(mediaType) ||
              (encoding && encoding !== 'identity')
            ) {
              finish(new ImageAssetError('IMAGE_FORMAT_REJECTED'));
              return;
            }
            const declared = response.headers['content-length'];
            if (
              declared !== undefined &&
              (!/^\d+$/.test(declared) ||
                !Number.isSafeInteger(Number(declared)) ||
                Number(declared) > limit)
            ) {
              finish(new ImageAssetError('IMAGE_BYTE_LIMIT'));
              return;
            }
            let byteSize = 0;
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => {
              if (done) return;
              byteSize += chunk.byteLength;
              if (byteSize > limit) {
                finish(new ImageAssetError('IMAGE_BYTE_LIMIT'));
                return;
              }
              chunks.push(chunk);
            });
            response.once('end', () => {
              if (!byteSize)
                finish(new ImageAssetError('IMAGE_FORMAT_REJECTED'));
              else
                finish(undefined, { bytes: Buffer.concat(chunks), mediaType });
            });
          },
        );
        outgoing.on('error', () =>
          finish(new ImageAssetError('IMAGE_DOWNLOAD_FAILED')),
        );
        outgoing.end();
      } catch {
        finish(new ImageAssetError('IMAGE_DOWNLOAD_FAILED'));
      }
    });
  }

  private async normalize(
    source: Buffer,
    mediaType: string,
    signal: AbortSignal,
  ): Promise<DownloadedImageAsset> {
    const pixelLimit = this.config.get('IMAGE_MAX_PIXELS');
    const decoder = sharp(source, {
      limitInputPixels: pixelLimit,
      failOn: 'warning',
    });
    try {
      const metadata = await abortable(decoder.metadata(), signal, () =>
        decoder.destroy(),
      );
      if (
        !['png', 'jpeg'].includes(metadata.format ?? '') ||
        (metadata.format === 'png' ? 'image/png' : 'image/jpeg') !==
          mediaType ||
        (metadata.pages ?? 1) !== 1
      )
        throw new ImageAssetError('IMAGE_FORMAT_REJECTED');
      if (
        !metadata.width ||
        !metadata.height ||
        metadata.width * metadata.height > pixelLimit
      )
        throw new ImageAssetError('IMAGE_PIXEL_LIMIT');
      // Re-encoding strips source EXIF/XMP/comments and validates actual pixels.
      const result = await abortable(
        decoder
          .rotate()
          .png({ compressionLevel: 9 })
          .toBuffer({ resolveWithObject: true }),
        signal,
        () => decoder.destroy(),
      );
      if (result.data.byteLength > this.config.get('IMAGE_MAX_BYTES'))
        throw new ImageAssetError('IMAGE_BYTE_LIMIT');
      return {
        bytes: result.data,
        sha256: createHash('sha256').update(result.data).digest('hex'),
        byteSize: result.data.byteLength,
        mediaType: 'image/png',
        width: result.info.width,
        height: result.info.height,
      };
    } catch (error) {
      if (error instanceof ImageAssetError) throw error;
      // libvips error strings may contain source details; never attach them.
      throw new ImageAssetError('IMAGE_DECODE_FAILED');
    } finally {
      decoder.destroy();
    }
  }
}
