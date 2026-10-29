import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppConfig } from '../config/app-config.module.js';
import { rejectedResponseDiagnostic } from './upstream-diagnostic.js';
import {
  IMAGE_PROMPT_MAX_BYTES,
  IMAGE_PROMPT_MAX_CODEPOINTS,
  IMAGE_RESPONSE_MAX_BYTES,
  ImageProviderError,
  type ImageGenerationInput,
  type ImageGenerationResult,
} from './image-provider.types.js';

const providerOrigin = 'https://maas.qianwenaiapi.com';
const generationPath = '/api/v1/services/aigc/multimodal-generation/generation';
const responseSchema = z.object({
  request_id: z.unknown().optional(),
  output: z.object({
    choices: z
      .array(
        z.object({
          finish_reason: z.literal('stop'),
          message: z.object({
            role: z.literal('assistant'),
            content: z
              .array(
                z.union([
                  z.object({ image: z.string().min(1).max(8192) }).strict(),
                  z.object({ text: z.string() }).strict(),
                ]),
              )
              .min(1)
              .max(4),
          }),
        }),
      )
      .length(1),
  }),
  usage: z.object({ image_count: z.literal(1) }),
});

function safeImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

async function boundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > IMAGE_RESPONSE_MAX_BYTES || !response.body) {
    void response.body?.cancel().catch(() => undefined);
    throw new ImageProviderError('IMAGE_RESPONSE_LIMIT');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(new ImageProviderError('IMAGE_CANCELLED'));
  });
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
    rejectAbort?.();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > IMAGE_RESPONSE_MAX_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new ImageProviderError('IMAGE_RESPONSE_LIMIT');
      }
      chunks.push(chunk.value);
    }
    signal.throwIfAborted();
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      ) as unknown;
    } catch {
      throw new ImageProviderError('IMAGE_INVALID_RESPONSE');
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

@Injectable()
export class ImageProviderService {
  constructor(@Inject(AppConfig) private readonly config: AppConfig) {}

  /** Pure preflight: call before reserving money or persisting SENT. */
  validate(input: ImageGenerationInput): void {
    if (!this.config.get('IMAGE_GENERATION_ENABLED'))
      throw new ImageProviderError('IMAGE_DISABLED');
    const base = this.config.get('IMAGE_API_BASE_URL');
    if (
      !this.config.get('IMAGE_API_KEY') ||
      typeof base !== 'string' ||
      base.replace(/\/+$/, '') !== `${providerOrigin}/api/v1` ||
      this.config.get('IMAGE_MODEL') !== 'z-image-turbo' ||
      this.config.get('IMAGE_SIZE') !== '1024*1024'
    )
      throw new ImageProviderError('IMAGE_NOT_CONFIGURED');
    if (
      !input ||
      typeof input.prompt !== 'string' ||
      !input.prompt.trim() ||
      (input.signal !== undefined && !(input.signal instanceof AbortSignal))
    )
      throw new ImageProviderError('IMAGE_INVALID_INPUT');
    // This provider silently truncates beyond 800 characters: reject instead.
    if (Buffer.byteLength(input.prompt, 'utf8') > IMAGE_PROMPT_MAX_BYTES)
      throw new ImageProviderError('IMAGE_INPUT_LIMIT');
    let codepoints = 0;
    for (const character of input.prompt) {
      if (++codepoints > IMAGE_PROMPT_MAX_CODEPOINTS)
        throw new ImageProviderError('IMAGE_INPUT_LIMIT');
      const codepoint = character.codePointAt(0)!;
      if (
        codepoint <= 8 ||
        codepoint === 11 ||
        codepoint === 12 ||
        (codepoint >= 14 && codepoint <= 31) ||
        (codepoint >= 0xd800 && codepoint <= 0xdfff)
      )
        throw new ImageProviderError('IMAGE_INVALID_INPUT');
    }
    if (input.signal?.aborted) throw new ImageProviderError('IMAGE_CANCELLED');
  }

  /** One synchronous text-only request; no automatic retry or URL download. */
  async generate(input: ImageGenerationInput): Promise<ImageGenerationResult> {
    this.validate(input);
    const timeout = AbortSignal.timeout(this.config.get('IMAGE_TIMEOUT_MS'));
    const signal = input.signal
      ? AbortSignal.any([timeout, input.signal])
      : timeout;
    try {
      signal.throwIfAborted();
      const response = await fetch(`${providerOrigin}${generationPath}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.get('IMAGE_API_KEY')}`,
        },
        signal,
        redirect: 'error',
        body: JSON.stringify({
          model: 'z-image-turbo',
          input: {
            messages: [{ role: 'user', content: [{ text: input.prompt }] }],
          },
          parameters: { size: '1024*1024', prompt_extend: false },
        }),
      });
      if (!response.ok) {
        throw new ImageProviderError(
          'IMAGE_UPSTREAM_REJECTED',
          await rejectedResponseDiagnostic(response, signal),
        );
      }
      const parsed = responseSchema.safeParse(
        await boundedJson(response, signal),
      );
      if (!parsed.success)
        throw new ImageProviderError('IMAGE_INVALID_RESPONSE');
      const images = parsed.data.output.choices[0]!.message.content.filter(
        (item): item is { image: string } => 'image' in item,
      );
      if (images.length !== 1 || !safeImageUrl(images[0]!.image))
        throw new ImageProviderError('IMAGE_INVALID_RESPONSE');
      const requestId = parsed.data.request_id;
      return {
        imageUrl: images[0]!.image,
        imageCount: 1,
        ...(typeof requestId === 'string' &&
        /^[a-zA-Z0-9_-]{1,128}$/.test(requestId)
          ? { providerRequestId: requestId }
          : {}),
      };
    } catch (error) {
      if (error instanceof ImageProviderError && error.diagnostic) throw error;
      if (input.signal?.aborted)
        throw new ImageProviderError('IMAGE_CANCELLED');
      if (timeout.aborted) throw new ImageProviderError('IMAGE_TIMEOUT');
      if (error instanceof ImageProviderError) throw error;
      // Do not expose response messages, request URLs, prompts, or raw causes.
      throw new ImageProviderError('IMAGE_UPSTREAM_ERROR');
    }
  }
}
