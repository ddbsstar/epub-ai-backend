import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageProviderService } from '../src/ai/image-provider.service.js';
import {
  IMAGE_RESPONSE_MAX_BYTES,
  ImageProviderError,
} from '../src/ai/image-provider.types.js';
import type { AppConfig } from '../src/config/app-config.module.js';
import {
  validateEnvironment,
  type Environment,
} from '../src/config/environment.js';

function service(extra: Record<string, unknown> = {}) {
  const environment = validateEnvironment({
    NODE_ENV: 'test',
    IMAGE_GENERATION_ENABLED: true,
    IMAGE_API_KEY: 'test-placeholder',
    IMAGE_DATA_DIR: join(tmpdir(), 'image-provider-test-not-written'),
    ...extra,
  });
  return new ImageProviderService({
    get: <K extends keyof Environment>(key: K) => environment[key],
  } as AppConfig);
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    output: {
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: [
              { image: 'https://cdn.example.com/generated.png?signature=test' },
              { text: 'private-prompt-marker' },
            ],
          },
        },
      ],
    },
    usage: { image_count: 1, width: 1024, height: 1024 },
    request_id: 'test-request-id',
    ...overrides,
  };
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Z-Image provider boundary (mock requests, no paid calls)', () => {
  it('uses the documented synchronous text-only protocol and a single image', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(result()));
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await service().generate({ prompt: 'A small bird in a vast sky.' }),
    ).toEqual({
      imageUrl: 'https://cdn.example.com/generated.png?signature=test',
      providerRequestId: 'test-request-id',
      imageCount: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(
      'https://maas.qianwenaiapi.com/api/v1/services/aigc/multimodal-generation/generation',
    );
    expect(options.method).toBe('POST');
    expect(options.redirect).toBe('error');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer test-placeholder',
    });
    expect(JSON.parse(options.body as string)).toEqual({
      model: 'z-image-turbo',
      input: {
        messages: [
          { role: 'user', content: [{ text: 'A small bird in a vast sky.' }] },
        ],
      },
      parameters: { size: '1024*1024', prompt_extend: false },
    });
  });

  it('validates before network use and rejects truncation rather than silently shortening', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = service();
    expect(() => provider.validate({ prompt: '鸟'.repeat(800) })).not.toThrow();
    expect(() => provider.validate({ prompt: '🐦'.repeat(800) })).not.toThrow();
    for (const prompt of ['鸟'.repeat(801), '🐦'.repeat(801)]) {
      await expect(provider.generate({ prompt })).rejects.toMatchObject({
        code: 'IMAGE_INPUT_LIMIT',
      });
    }
    for (const prompt of ['', '   ', '\u0000secret', '\ud800']) {
      await expect(provider.generate({ prompt })).rejects.toMatchObject({
        code: 'IMAGE_INVALID_INPUT',
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects disabled generation and cancelled preflight without sending', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      service({ IMAGE_GENERATION_ENABLED: false }).generate({ prompt: 'bird' }),
    ).rejects.toMatchObject({ code: 'IMAGE_DISABLED' });
    await expect(
      service().generate({ prompt: 'bird', signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'IMAGE_CANCELLED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([400, 401, 429, 500])(
    'normalizes HTTP %i without exposing raw errors or retrying',
    async (status) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          new Response('private-upstream-message', { status }),
        );
      vi.stubGlobal('fetch', fetchMock);
      await expect(
        service().generate({ prompt: 'bird' }),
      ).rejects.toMatchObject({
        code: 'IMAGE_UPSTREAM_REJECTED',
        message: 'IMAGE_UPSTREAM_REJECTED',
        diagnostic: { httpStatus: status },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('retains vetted image rejection diagnostics without raw provider messages', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 'DataInspectionFailed',
          message: 'private-upstream-message',
          request_id: 'provider-error-image-1',
        }),
        { status: 400 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const error = await service()
      .generate({ prompt: 'bird' })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: 'IMAGE_UPSTREAM_REJECTED',
      diagnostic: {
        httpStatus: 400,
        providerErrorCode: 'DataInspectionFailed',
        providerRequestId: 'provider-error-image-1',
      },
    });
    expect(JSON.stringify(error)).not.toContain('private-upstream-message');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('normalizes transport failures without retaining private upstream causes', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error('private-upstream-marker'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(service().generate({ prompt: 'bird' })).rejects.toEqual(
      new ImageProviderError('IMAGE_UPSTREAM_ERROR'),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts timed-out requests without retrying', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 1);
      return controller.signal;
    });
    const fetchMock = vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal!.addEventListener(
            'abort',
            () => reject(new Error('abort')),
            {
              once: true,
            },
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(service().generate({ prompt: 'bird' })).rejects.toMatchObject({
      code: 'IMAGE_TIMEOUT',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('supports caller cancellation during response streaming', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    const pending = service().generate({
      prompt: 'bird',
      signal: controller.signal,
    });
    queueMicrotask(() => controller.abort());
    await expect(pending).rejects.toMatchObject({ code: 'IMAGE_CANCELLED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    result({ usage: { image_count: 2 } }),
    result({ usage: undefined }),
    result({ output: { choices: [] } }),
    result({
      output: {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: [
                { image: 'https://cdn.example.com/one.png' },
                { image: 'https://cdn.example.com/two.png' },
              ],
            },
          },
        ],
      },
    }),
  ])('rejects missing or inconsistent single-image outputs', async (value) => {
    const fetchMock = vi.fn().mockResolvedValue(json(value));
    vi.stubGlobal('fetch', fetchMock);
    await expect(service().generate({ prompt: 'bird' })).rejects.toMatchObject({
      code: 'IMAGE_INVALID_RESPONSE',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    'http://cdn.example.com/a.png',
    'https://user:secret@cdn.example.com/a.png',
    'file:///tmp/a.png',
  ])('rejects unsafe returned image URL syntax', async (image) => {
    const value = result();
    value.output.choices[0]!.message.content = [{ image }];
    const fetchMock = vi.fn().mockResolvedValue(json(value));
    vi.stubGlobal('fetch', fetchMock);
    await expect(service().generate({ prompt: 'bird' })).rejects.toMatchObject({
      code: 'IMAGE_INVALID_RESPONSE',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds declared and streamed response sizes', async () => {
    for (const response of [
      new Response('{}', {
        headers: { 'content-length': String(IMAGE_RESPONSE_MAX_BYTES + 1) },
      }),
      new Response('x'.repeat(IMAGE_RESPONSE_MAX_BYTES + 1)),
    ]) {
      const fetchMock = vi.fn().mockResolvedValue(response);
      vi.stubGlobal('fetch', fetchMock);
      await expect(
        service().generate({ prompt: 'bird' }),
      ).rejects.toMatchObject({
        code: 'IMAGE_RESPONSE_LIMIT',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it.each(['not-json', '{"private":"upstream-marker"}'])(
    'normalizes malformed or incompatible JSON without leaking the content',
    async (body) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(body));
      vi.stubGlobal('fetch', fetchMock);
      await expect(service().generate({ prompt: 'bird' })).rejects.toEqual(
        new ImageProviderError('IMAGE_INVALID_RESPONSE'),
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
});
