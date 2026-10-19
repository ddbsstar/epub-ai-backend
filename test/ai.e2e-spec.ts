import { AiService } from '../src/ai/ai.service.js';
import { AppConfig } from '../src/config/app-config.module.js';
import {
  validateEnvironment,
  type Environment,
} from '../src/config/environment.js';

function service(enabled: boolean) {
  const environment = validateEnvironment({
    NODE_ENV: 'test',
    QWEN_ENABLED: enabled,
    QWEN_API_KEY: 'test-placeholder',
    QWEN_BASE_URL: 'https://example.com/v1',
    QWEN_MODEL: 'test-model',
    QWEN_MAX_OUTPUT_TOKENS: 1024,
  });
  return new AiService({
    get: <K extends keyof Environment>(key: K) => environment[key],
  } as AppConfig);
}

afterEach(() => vi.unstubAllGlobals());

describe('Internal model boundary (no paid calls)', () => {
  it('rejects disabled models before making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      service(false).complete({
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).rejects.toMatchObject({ payload: { code: 'AI_NOT_CONFIGURED' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('limits output, disables redirects, and parses a model result', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'result' } }] }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await service(true).complete({
        messages: [{ role: 'user', content: 'hello' }],
        maxOutputTokens: 8192,
      }),
    ).toEqual({ content: 'result' });
    const options = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(options.body as string).max_tokens).toBe(1024);
    expect(options.redirect).toBe('error');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('normalizes upstream failures and rejects invalid inputs without retrying', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error('private-upstream-marker'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      service(true).complete({
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).rejects.toMatchObject({ payload: { code: 'AI_UPSTREAM_ERROR' } });
    await expect(
      service(true).complete({ messages: [] }),
    ).rejects.toMatchObject({ payload: { code: 'AI_INVALID_INPUT' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
