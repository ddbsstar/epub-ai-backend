import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { AiService } from '../src/ai/ai.service.js';
import {
  AiGatewayError,
  type StructureMessage,
  type VisualReviewImage,
} from '../src/ai/ai-structure.types.js';
import type { AppConfig } from '../src/config/app-config.module.js';
import {
  validateEnvironment,
  type Environment,
} from '../src/config/environment.js';

const messages: StructureMessage[] = [
  {
    role: 'system',
    content: 'Evaluate the supplied illustration. Return JSON.',
  },
  { role: 'user', content: 'No people; a small stone bridge; monochrome ink.' },
];

function service(extra: Record<string, unknown> = {}) {
  const environment = validateEnvironment({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PROCESSING_ENABLED: true,
    PROCESSING_AI_ENABLED: true,
    PROCESSING_DATA_DIR: join(tmpdir(), 'epub-visual-gateway-offline-test'),
    EPUBCHECK_JAR_PATH: join(tmpdir(), 'offline-epubcheck.jar'),
    QWEN_ENABLED: true,
    QWEN_API_KEY: 'offline-placeholder',
    QWEN_BASE_URL: 'https://example.com/compatible-mode/v1/',
    QWEN_MODEL: 'inherited-vision-model',
    QWEN_MAX_OUTPUT_TOKENS: 4096,
    VISUAL_REVIEW_ENABLED: true,
    VISUAL_REVIEW_MAX_OUTPUT_TOKENS: 768,
    ...extra,
  });
  return new AiService({
    get: <K extends keyof Environment>(key: K) => environment[key],
  } as AppConfig);
}

function completion(extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      id: 'visual-completion-1',
      choices: [
        { finish_reason: 'stop', message: { content: '{"passed":true}' } },
      ],
      usage: {
        prompt_tokens: 900,
        completion_tokens: 100,
        total_tokens: 1000,
        image_tokens: 258,
      },
      ...extra,
    }),
    { status: 200 },
  );
}

interface VisualRequestBody {
  model: string;
  messages: [
    StructureMessage,
    {
      role: 'user';
      content: [
        { type: 'image_url'; image_url: { url: string } },
        { type: 'text'; text: string },
      ];
    },
  ];
  temperature: number;
  max_tokens: number;
  enable_thinking: boolean;
  response_format: { type: string };
  stream: boolean;
}

describe('bounded visual model gateway (offline, no paid calls)', () => {
  let image: VisualReviewImage;

  beforeAll(async () => {
    const bytes = await sharp({
      create: {
        width: 16,
        height: 12,
        channels: 3,
        background: { r: 245, g: 242, b: 235 },
      },
    })
      .jpeg({ quality: 85 })
      .toBuffer();
    image = {
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mediaType: 'image/jpeg',
      width: 16,
      height: 12,
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    { extra: {}, expected: 'inherited-vision-model' },
    {
      extra: { VISUAL_REVIEW_MODEL: 'explicit-vision-model' },
      expected: 'explicit-vision-model',
    },
  ])(
    'sends the actual JPEG and separate text with model $expected',
    async ({ extra, expected }) => {
      const fetchMock = vi.fn().mockResolvedValue(completion());
      vi.stubGlobal('fetch', fetchMock);

      const result = await service(extra).completeVisual(messages, image);
      expect(result).toEqual({
        content: '{"passed":true}',
        finishReason: 'stop',
        providerRequestId: 'visual-completion-1',
        usage: { inputTokens: 900, outputTokens: 100, totalTokens: 1000 },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(url).toBe(
        'https://example.com/compatible-mode/v1/chat/completions',
      );
      expect(options).toMatchObject({ method: 'POST', redirect: 'error' });
      expect(options.signal).toBeInstanceOf(AbortSignal);
      const body = JSON.parse(options.body as string) as VisualRequestBody;
      expect(body.model).toBe(expected);
      expect(body.messages[0]).toEqual(messages[0]);
      expect(body.messages[1].role).toBe('user');
      expect(body.messages[1].content).toHaveLength(2);
      const [imagePart, textPart] = body.messages[1].content;
      expect(imagePart.type).toBe('image_url');
      expect(imagePart.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
      expect(
        Buffer.from(imagePart.image_url.url.split(',')[1]!, 'base64'),
      ).toEqual(image.bytes);
      expect(textPart).toEqual({ type: 'text', text: messages[1]!.content });
      expect(body).toMatchObject({
        temperature: 0,
        max_tokens: 768,
        enable_thinking: false,
        response_format: { type: 'json_object' },
        stream: false,
      });
      // prompt_tokens already includes the provider's visual token accounting.
      expect(result.usage!.inputTokens).toBe(900);
      expect(result.usage!.totalTokens).toBe(1000);
    },
  );

  it('rejects the disabled visual gate without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      service({ VISUAL_REVIEW_ENABLED: false }).completeVisual(messages, image),
    ).rejects.toMatchObject({ code: 'VISUAL_REVIEW_DISABLED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'hash', patch: { sha256: '0'.repeat(64) } },
    { name: 'too wide', patch: { width: 513 } },
    { name: 'too high', patch: { height: 513 } },
    { name: 'zero dimension', patch: { width: 0 } },
    { name: 'fractional dimension', patch: { height: 12.5 } },
  ])('rejects an invalid image $name before fetch', async ({ patch }) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      service().completeVisual(messages, { ...image, ...patch }),
    ).rejects.toMatchObject({ code: 'VISUAL_REVIEW_IMAGE_INVALID' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects oversized image bytes and malformed JPEG markers before fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const bytes of [Buffer.alloc(262145), Buffer.from('not-a-jpeg')]) {
      await expect(
        service().completeVisual(messages, {
          ...image,
          bytes,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        }),
      ).rejects.toMatchObject({ code: 'VISUAL_REVIEW_IMAGE_INVALID' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'missing system', input: [messages[1]!] },
    { name: 'extra turn', input: [...messages, messages[1]!] },
    { name: 'reversed roles', input: [...messages].reverse() },
    {
      name: 'empty text',
      input: [messages[0]!, { role: 'user', content: ' ' }],
    },
    {
      name: 'text byte bound',
      input: [messages[0]!, { role: 'user', content: '文'.repeat(9000) }],
    },
  ])('rejects $name before fetch', async ({ input }) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      service().completeVisual(input as StructureMessage[], image),
    ).rejects.toMatchObject({ code: 'VISUAL_REVIEW_INPUT_LIMIT' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('enforces the independent text token reservation bound before fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      service({ VISUAL_REVIEW_INPUT_TOKEN_BUDGET: 8192 }).completeVisual(
        [messages[0]!, { role: 'user', content: 'a'.repeat(4200) }],
        image,
      ),
    ).rejects.toMatchObject({ code: 'VISUAL_REVIEW_INPUT_LIMIT' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retains only safe rejection diagnostics and never retries', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'model_not_found',
            message: 'private-upstream-marker and book text',
          },
          request_id: 'safe-request-42',
        }),
        { status: 404 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const error = await service()
      .completeVisual(messages, image)
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AiGatewayError);
    expect(error).toMatchObject({
      code: 'VISUAL_REVIEW_UPSTREAM_REJECTED',
      diagnostic: {
        httpStatus: 404,
        providerErrorCode: 'model_not_found',
        providerRequestId: 'safe-request-42',
      },
    });
    expect(JSON.stringify(error)).not.toContain('private-upstream-marker');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('normalizes network failures without exposing causes or retrying', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error('private-network-marker'));
    vi.stubGlobal('fetch', fetchMock);
    const error = await service()
      .completeVisual(messages, image)
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'VISUAL_REVIEW_UPSTREAM_ERROR' });
    expect(JSON.stringify(error)).not.toContain('private-network-marker');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('handles an already cancelled caller before fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      service().completeVisual(messages, image, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: 'VISUAL_REVIEW_CANCELLED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes cancellation during fetch without retrying', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.reject(new Error('private-cancel-marker'));
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      service().completeVisual(messages, image, controller.signal),
    ).rejects.toMatchObject({ code: 'VISUAL_REVIEW_CANCELLED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('normalizes an elapsed timeout during fetch without a real wait or retry', async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    const fetchMock = vi.fn().mockImplementation(() => {
      timeout.abort();
      return Promise.reject(new Error('private-timeout-marker'));
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      service().completeVisual(messages, image),
    ).rejects.toMatchObject({ code: 'VISUAL_REVIEW_TIMEOUT' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { finish: 'length', expected: 'VISUAL_REVIEW_TRUNCATED' },
    { finish: 'content_filter', expected: 'VISUAL_REVIEW_INVALID_RESPONSE' },
    { finish: 'tool_calls', expected: 'VISUAL_REVIEW_INVALID_RESPONSE' },
  ])('rejects finish reason $finish', async ({ finish, expected }) => {
    const fetchMock = vi.fn().mockResolvedValue(
      completion({
        choices: [{ finish_reason: finish, message: { content: '{}' } }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      service().completeVisual(messages, image),
    ).rejects.toMatchObject({
      code: expected,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { choices: [] },
    { choices: [{ finish_reason: 'stop', message: { content: null } }] },
    {
      choices: [
        { finish_reason: 'stop', message: { content: '{}' } },
        { finish_reason: 'stop', message: { content: '{}' } },
      ],
    },
  ])(
    'rejects malformed completion structure without retrying',
    async (patch) => {
      const fetchMock = vi.fn().mockResolvedValue(completion(patch));
      vi.stubGlobal('fetch', fetchMock);
      await expect(
        service().completeVisual(messages, image),
      ).rejects.toMatchObject({
        code: 'VISUAL_REVIEW_INVALID_RESPONSE',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    undefined,
    { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1258 },
    { prompt_tokens: 40000, completion_tokens: 100, total_tokens: 40100 },
    { prompt_tokens: 900, completion_tokens: 1000, total_tokens: 1900 },
    { prompt_tokens: 1.5, completion_tokens: 1, total_tokens: 2.5 },
  ])(
    'keeps missing or invalid usage unavailable rather than inventing it',
    async (usage) => {
      const fetchMock = vi.fn().mockResolvedValue(completion({ usage }));
      vi.stubGlobal('fetch', fetchMock);
      const result = await service().completeVisual(messages, image);
      expect(result.content).toBe('{"passed":true}');
      expect(result).not.toHaveProperty('usage');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('applies the bounded response reader before parsing output', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('not consumed', {
        status: 200,
        headers: { 'content-length': '1025' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      service({ AI_MAX_RESPONSE_BYTES: 1024 }).completeVisual(messages, image),
    ).rejects.toMatchObject({ code: 'AI_RESPONSE_LIMIT' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
