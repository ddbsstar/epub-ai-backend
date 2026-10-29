import { EventEmitter } from 'node:events';
import type { LookupAddress } from 'node:dns';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { AppConfig } from '../src/config/app-config.module.js';
import type { Environment } from '../src/config/environment.js';
import {
  ImageAssetService,
  type ImageAssetTransport,
} from '../src/ai/image-asset.service.js';

const host = 'dashscope-result-bj.oss-cn-beijing.aliyuncs.com';
const remoteUrl = `https://${host}/generated/image.png?signature=private-marker`;
let png: Buffer;
let jpeg: Buffer;

beforeAll(async () => {
  png = await sharp({
    create: { width: 12, height: 8, channels: 3, background: '#aabbcc' },
  })
    .png()
    .toBuffer();
  jpeg = await sharp({
    create: { width: 12, height: 8, channels: 3, background: '#aabbcc' },
  })
    .withExif({ IFD0: { Artist: 'private-source-metadata' } })
    .jpeg()
    .toBuffer();
});

interface Fixture {
  bytes?: Buffer;
  mediaType?: string;
  status?: number;
  addresses?: LookupAddress[];
  config?: Record<string, unknown>;
  hang?: boolean;
  chunks?: Buffer[];
  headers?: Record<string, string>;
  requestError?: boolean;
}

function fixture(options: Fixture = {}) {
  const config = {
    IMAGE_DOWNLOAD_HOSTS: host,
    IMAGE_MAX_BYTES: 10 * 1024 * 1024,
    IMAGE_MAX_PIXELS: 16777216,
    IMAGE_TIMEOUT_MS: 120000,
    ...options.config,
  };
  let response: IncomingMessage | undefined;
  let requestOptions: RequestOptions | undefined;
  const lookupMock = vi
    .fn()
    .mockResolvedValue(
      options.addresses ?? [{ address: '8.8.8.8', family: 4 }],
    );
  const requestMock = vi.fn(
    (
      outgoingOptions: RequestOptions,
      callback: (value: IncomingMessage) => void,
    ) => {
      requestOptions = outgoingOptions;
      const outgoing = new EventEmitter();
      const destroy = vi.fn();
      Object.assign(outgoing, {
        destroy,
        end: () => {
          queueMicrotask(() => {
            if (options.requestError) {
              outgoing.emit('error', new Error('private-network-marker'));
              return;
            }
            if (options.hang) return;
            const stream = new PassThrough();
            response = stream as unknown as IncomingMessage;
            response.statusCode = options.status ?? 200;
            response.headers = {
              'content-type': options.mediaType ?? 'image/png',
              ...options.headers,
            };
            callback(response);
            if (stream.destroyed) return;
            for (const chunk of options.chunks ?? [options.bytes ?? png])
              stream.write(chunk);
            stream.end();
          });
        },
      });
      return outgoing as unknown as ClientRequest;
    },
  );
  const transport: ImageAssetTransport = {
    lookup: lookupMock,
    request: requestMock,
  };
  const service = new ImageAssetService(
    {
      get: (key: keyof Environment) => config[key as keyof typeof config],
    } as AppConfig,
    transport,
  );
  return {
    service,
    lookupMock,
    requestMock,
    get requestOptions() {
      return requestOptions;
    },
    get response() {
      return response;
    },
  };
}

describe('Private image download and decoding boundary (offline)', () => {
  it('pins the validated address, verifies TLS, and never forwards credentials', async () => {
    const current = fixture();
    const result = await current.service.download(remoteUrl);
    expect(result).toMatchObject({
      mediaType: 'image/png',
      width: 12,
      height: 8,
      byteSize: result.bytes.length,
      sha256: createHash('sha256').update(result.bytes).digest('hex'),
    });
    expect(result).not.toHaveProperty('url');
    expect(JSON.stringify({ ...result, bytes: undefined })).not.toContain(
      'signature',
    );
    expect(current.lookupMock).toHaveBeenCalledExactlyOnceWith(host);
    expect(current.requestOptions).toMatchObject({
      hostname: host,
      servername: host,
      port: 443,
      agent: false,
      rejectUnauthorized: true,
      family: 4,
      headers: { accept: 'image/png, image/jpeg' },
    });
    expect(current.requestOptions?.headers).not.toHaveProperty('authorization');
    const pinnedLookup = current.requestOptions!.lookup!;
    const one = vi.fn();
    pinnedLookup(host, { all: false }, one);
    expect(one).toHaveBeenCalledExactlyOnceWith(null, '8.8.8.8', 4);
    const all = vi.fn();
    pinnedLookup(host, { all: true }, all);
    expect(all).toHaveBeenCalledExactlyOnceWith(null, [
      { address: '8.8.8.8', family: 4 },
    ]);
    expect(current.lookupMock).toHaveBeenCalledTimes(1);
  });

  it('decodes JPEG pixels into PNG and removes source EXIF metadata', async () => {
    const result = await fixture({
      bytes: jpeg,
      mediaType: 'image/jpeg',
    }).service.download(remoteUrl);
    const metadata = await sharp(result.bytes).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.exif).toBeUndefined();
    expect(result.bytes.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
  });

  it.each([
    `http://${host}/image.png`,
    `https://${host}:444/image.png`,
    `https://user:secret@${host}/image.png`,
    `https://${host}.evil.example/image.png`,
    `https://evil.example/${host}/image.png`,
    `https://${host}./image.png`,
    `https://${host}/image.png#fragment`,
    'file:///private/image.png',
    'https://127.0.0.1/image.png',
    'invalid-private-url',
  ])('rejects unsafe URL before resolution: %s', async (url) => {
    const current = fixture();
    await expect(current.service.download(url)).rejects.toMatchObject({
      code: 'IMAGE_URL_REJECTED',
    });
    expect(current.lookupMock).not.toHaveBeenCalled();
    expect(current.requestMock).not.toHaveBeenCalled();
  });

  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.1.2',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.1.2',
    '192.168.1.2',
    '192.0.2.1',
    '198.18.1.2',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
  ])('rejects private and reserved IPv4 DNS results: %s', async (address) => {
    const current = fixture({ addresses: [{ address, family: 4 }] });
    await expect(current.service.download(remoteUrl)).rejects.toMatchObject({
      code: 'IMAGE_ADDRESS_REJECTED',
    });
    expect(current.requestMock).not.toHaveBeenCalled();
  });

  it.each([
    '::',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '2001::1',
    '2002:7f00:1::1',
    '3fff::1',
  ])('rejects private and reserved IPv6 DNS results: %s', async (address) => {
    const current = fixture({ addresses: [{ address, family: 6 }] });
    await expect(current.service.download(remoteUrl)).rejects.toMatchObject({
      code: 'IMAGE_ADDRESS_REJECTED',
    });
    expect(current.requestMock).not.toHaveBeenCalled();
  });

  it('accepts public IPv6 and rejects mixed public/private DNS answers', async () => {
    await expect(
      fixture({
        addresses: [{ address: '2606:4700:4700::1111', family: 6 }],
      }).service.download(remoteUrl),
    ).resolves.toMatchObject({ width: 12 });
    const current = fixture({
      addresses: [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    });
    await expect(current.service.download(remoteUrl)).rejects.toMatchObject({
      code: 'IMAGE_ADDRESS_REJECTED',
    });
    expect(current.requestMock).not.toHaveBeenCalled();
  });

  it('rejects empty or inconsistent resolver results', async () => {
    for (const addresses of [[], [{ address: '8.8.8.8', family: 6 }]]) {
      const current = fixture({ addresses });
      await expect(current.service.download(remoteUrl)).rejects.toMatchObject({
        code: 'IMAGE_ADDRESS_REJECTED',
      });
      expect(current.requestMock).not.toHaveBeenCalled();
    }
  });

  it('rejects redirects without requesting the Location target', async () => {
    const current = fixture({
      status: 302,
      headers: { location: 'http://127.0.0.1/private' },
    });
    await expect(current.service.download(remoteUrl)).rejects.toMatchObject({
      code: 'IMAGE_DOWNLOAD_REJECTED',
    });
    expect(current.requestMock).toHaveBeenCalledTimes(1);
    expect(current.response?.destroyed).toBe(true);
  });

  it('enforces declared and streamed byte limits', async () => {
    const declared = fixture({
      headers: { 'content-length': '1001' },
      config: { IMAGE_MAX_BYTES: 1000 },
    });
    await expect(declared.service.download(remoteUrl)).rejects.toMatchObject({
      code: 'IMAGE_BYTE_LIMIT',
    });
    const streamed = fixture({
      chunks: [Buffer.alloc(600), Buffer.alloc(600)],
      config: { IMAGE_MAX_BYTES: 1000 },
    });
    await expect(streamed.service.download(remoteUrl)).rejects.toMatchObject({
      code: 'IMAGE_BYTE_LIMIT',
    });
    expect(streamed.response?.destroyed).toBe(true);
  });

  it('rejects compressed HTTP bodies, unsupported MIME, and disguised non-images', async () => {
    await expect(
      fixture({ headers: { 'content-encoding': 'gzip' } }).service.download(
        remoteUrl,
      ),
    ).rejects.toMatchObject({ code: 'IMAGE_FORMAT_REJECTED' });
    await expect(
      fixture({ mediaType: 'image/svg+xml' }).service.download(remoteUrl),
    ).rejects.toMatchObject({ code: 'IMAGE_FORMAT_REJECTED' });
    await expect(
      fixture({
        bytes: Buffer.from('<svg>private-marker</svg>'),
      }).service.download(remoteUrl),
    ).rejects.toMatchObject({ code: 'IMAGE_DECODE_FAILED' });
    await expect(
      fixture({ bytes: jpeg, mediaType: 'image/png' }).service.download(
        remoteUrl,
      ),
    ).rejects.toMatchObject({ code: 'IMAGE_FORMAT_REJECTED' });
  });

  it('rejects truncated image data and decoded pixel limits', async () => {
    await expect(
      fixture({ bytes: png.subarray(0, png.length - 20) }).service.download(
        remoteUrl,
      ),
    ).rejects.toMatchObject({ code: 'IMAGE_DECODE_FAILED' });
    await expect(
      fixture({ config: { IMAGE_MAX_PIXELS: 20 } }).service.download(remoteUrl),
    ).rejects.toMatchObject({ code: 'IMAGE_DECODE_FAILED' });
  });

  it('limits the re-encoded PNG as well as the source JPEG', async () => {
    const noise = Buffer.alloc(64 * 64 * 3);
    for (let index = 0; index < noise.length; index++)
      noise[index] = (index * 173 + Math.floor(index / 11) * 31) % 256;
    const compressed = await sharp(noise, {
      raw: { width: 64, height: 64, channels: 3 },
    })
      .jpeg({ quality: 5 })
      .toBuffer();
    const normalized = await sharp(compressed)
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(normalized.length).toBeGreaterThan(compressed.length);
    await expect(
      fixture({
        bytes: compressed,
        mediaType: 'image/jpeg',
        config: { IMAGE_MAX_BYTES: compressed.length + 1 },
      }).service.download(remoteUrl),
    ).rejects.toMatchObject({ code: 'IMAGE_BYTE_LIMIT' });
  });

  it('handles cancellation before DNS and during a stalled request', async () => {
    const before = fixture();
    await expect(
      before.service.download(remoteUrl, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: 'IMAGE_CANCELLED' });
    expect(before.lookupMock).not.toHaveBeenCalled();
    const during = fixture({ hang: true });
    const controller = new AbortController();
    const result = during.service.download(remoteUrl, controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'IMAGE_CANCELLED' });
  });

  it('times out stalled DNS and normalizes private network error details', async () => {
    const timed = fixture({ config: { IMAGE_TIMEOUT_MS: 10 } });
    timed.lookupMock.mockImplementation(() => new Promise(() => undefined));
    await expect(timed.service.download(remoteUrl)).rejects.toMatchObject({
      code: 'IMAGE_TIMEOUT',
    });
    const failed = fixture({ requestError: true });
    try {
      await failed.service.download(remoteUrl);
      throw new Error('Expected failure');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'IMAGE_DOWNLOAD_FAILED',
        message: 'IMAGE_DOWNLOAD_FAILED',
      });
      expect(String(error)).not.toContain('private-');
      expect(String(error)).not.toContain(host);
    }
  });
});
