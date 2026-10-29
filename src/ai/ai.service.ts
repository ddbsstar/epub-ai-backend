import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppConfig } from '../config/app-config.module.js';
import { ApiException } from '../common/http/api-exception.js';
import type { DependencyStatus } from '../database/database.service.js';
import type { ModelCallUsage } from '../processing/model-call.types.js';
import { rejectedResponseDiagnostic } from './upstream-diagnostic.js';
import {
  AiGatewayError,
  type StructureCompletion,
  type StructureMessage,
  type VisualReviewImage,
} from './ai-structure.types.js';

const completionInput = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(['system', 'user', 'assistant']),
            content: z.string().min(1).max(32000),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().min(1).max(8192).optional(),
  })
  .strict();

export type CompletionInput = z.infer<typeof completionInput>;

const completionResponse = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().max(1000000) }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().nonnegative(),
      completion_tokens: z.number().nonnegative(),
      total_tokens: z.number().nonnegative(),
    })
    .optional(),
});

const structureResponse = z.object({
  id: z.string().max(128).optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string(),
        message: z.object({ content: z.string() }),
      }),
    )
    .length(1),
  usage: z.unknown().optional(),
});

const usageSchema = z.object({
  prompt_tokens: z.number().int().min(1).max(1_000_000),
  completion_tokens: z.number().int().min(1).max(1_000_000),
  total_tokens: z.number().int().min(2).max(2_000_000),
});

/** Missing/invalid usage cannot safely reduce a reservation. */
function parseUsage(
  value: unknown,
  inputLimit: number,
  outputLimit: number,
): ModelCallUsage | undefined {
  const usage = usageSchema.safeParse(value);
  if (
    !usage.success ||
    usage.data.prompt_tokens > inputLimit ||
    usage.data.completion_tokens > outputLimit ||
    usage.data.total_tokens !==
      usage.data.prompt_tokens + usage.data.completion_tokens
  )
    return undefined;
  return {
    inputTokens: usage.data.prompt_tokens,
    outputTokens: usage.data.completion_tokens,
    totalTokens: usage.data.total_tokens,
  };
}

async function boundedJson(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<unknown> {
  const cancel = () => {
    void response.body?.cancel().catch(() => undefined);
  };
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > limit || !response.body) {
    cancel();
    throw new AiGatewayError('AI_RESPONSE_LIMIT');
  }
  const reader = response.body.getReader();
  let rejectAbort: ((error: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
    rejectAbort?.(new AiGatewayError('AI_ABORTED'));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const value = await Promise.race([reader.read(), aborted]);
      if (value.done) break;
      size += value.value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => undefined);
        throw new AiGatewayError('AI_RESPONSE_LIMIT');
      }
      chunks.push(value.value);
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    ) as unknown;
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

@Injectable()
export class AiService {
  constructor(@Inject(AppConfig) private readonly config: AppConfig) {}

  getStatus(): DependencyStatus {
    return this.config.get('QWEN_ENABLED')
      ? 'configured_not_checked'
      : 'disabled';
  }

  /** Internal visual review only; caller must persist SENT before invoking. */
  async completeVisual(
    messages: StructureMessage[],
    image: VisualReviewImage,
    callerSignal?: AbortSignal,
  ): Promise<StructureCompletion> {
    if (
      !this.config.get('VISUAL_REVIEW_ENABLED') ||
      !this.config.get('QWEN_ENABLED')
    )
      throw new AiGatewayError('VISUAL_REVIEW_DISABLED');
    const textBytes = Buffer.byteLength(JSON.stringify(messages), 'utf8');
    const bytes = Buffer.from(image.bytes);
    if (
      messages.length !== 2 ||
      messages[0]?.role !== 'system' ||
      messages[1]?.role !== 'user' ||
      messages.some(
        (message) =>
          typeof message.content !== 'string' || !message.content.trim(),
      ) ||
      textBytes > 24576 ||
      textBytes + 4096 > this.config.get('VISUAL_REVIEW_INPUT_TOKEN_BUDGET')
    )
      throw new AiGatewayError('VISUAL_REVIEW_INPUT_LIMIT');
    if (
      image.mediaType !== 'image/jpeg' ||
      bytes.length < 4 ||
      bytes.length > 262144 ||
      bytes[0] !== 255 ||
      bytes[1] !== 216 ||
      bytes.at(-2) !== 255 ||
      bytes.at(-1) !== 217 ||
      !Number.isInteger(image.width) ||
      !Number.isInteger(image.height) ||
      image.width < 1 ||
      image.height < 1 ||
      image.width > 512 ||
      image.height > 512 ||
      createHash('sha256').update(bytes).digest('hex') !== image.sha256
    )
      throw new AiGatewayError('VISUAL_REVIEW_IMAGE_INVALID');
    const timeout = AbortSignal.timeout(this.config.get('QWEN_TIMEOUT_MS'));
    const signal = callerSignal
      ? AbortSignal.any([timeout, callerSignal])
      : timeout;
    try {
      signal.throwIfAborted();
      const response = await fetch(
        `${this.config.get('QWEN_BASE_URL').replace(/\/+$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.config.get('QWEN_API_KEY')}`,
          },
          signal,
          redirect: 'error',
          body: JSON.stringify({
            model:
              this.config.get('VISUAL_REVIEW_MODEL') ||
              this.config.get('QWEN_MODEL'),
            messages: [
              messages[0],
              {
                role: 'user',
                content: [
                  {
                    type: 'image_url',
                    image_url: {
                      url: `data:image/jpeg;base64,${bytes.toString('base64')}`,
                    },
                  },
                  { type: 'text', text: messages[1]!.content },
                ],
              },
            ],
            temperature: 0,
            max_tokens: this.config.get('VISUAL_REVIEW_MAX_OUTPUT_TOKENS'),
            enable_thinking: false,
            response_format: { type: 'json_object' },
            stream: false,
          }),
        },
      );
      if (!response.ok)
        throw new AiGatewayError(
          'VISUAL_REVIEW_UPSTREAM_REJECTED',
          await rejectedResponseDiagnostic(response, signal),
        );
      const parsed = structureResponse.safeParse(
        await boundedJson(
          response,
          this.config.get('AI_MAX_RESPONSE_BYTES'),
          signal,
        ),
      );
      if (!parsed.success)
        throw new AiGatewayError('VISUAL_REVIEW_INVALID_RESPONSE');
      const choice = parsed.data.choices[0]!;
      if (choice.finish_reason === 'length')
        throw new AiGatewayError('VISUAL_REVIEW_TRUNCATED');
      if (choice.finish_reason !== 'stop')
        throw new AiGatewayError('VISUAL_REVIEW_INVALID_RESPONSE');
      const usage = parseUsage(
        parsed.data.usage,
        this.config.get('VISUAL_REVIEW_INPUT_TOKEN_BUDGET'),
        this.config.get('VISUAL_REVIEW_MAX_OUTPUT_TOKENS'),
      );
      const id = parsed.data.id;
      return {
        content: choice.message.content,
        finishReason: 'stop',
        ...(usage ? { usage } : {}),
        ...(id && /^[a-zA-Z0-9_-]{1,128}$/.test(id)
          ? { providerRequestId: id }
          : {}),
      };
    } catch (error) {
      if (error instanceof AiGatewayError && error.diagnostic) throw error;
      if (callerSignal?.aborted)
        throw new AiGatewayError('VISUAL_REVIEW_CANCELLED');
      if (timeout.aborted) throw new AiGatewayError('VISUAL_REVIEW_TIMEOUT');
      if (error instanceof AiGatewayError) throw error;
      throw new AiGatewayError('VISUAL_REVIEW_UPSTREAM_ERROR');
    }
  }

  /** Called only after the processing ledger has persisted SENT. No retries. */
  async completeStructure(
    messages: StructureMessage[],
    callerSignal?: AbortSignal,
  ): Promise<StructureCompletion> {
    if (!this.config.get('QWEN_ENABLED'))
      throw new AiGatewayError('AI_DISABLED');
    const messageBytes = Buffer.byteLength(JSON.stringify(messages), 'utf8');
    if (
      messageBytes > this.config.get('AI_MAX_MESSAGE_BYTES') ||
      messageBytes + 4096 > this.config.get('AI_INPUT_TOKEN_BUDGET')
    )
      throw new AiGatewayError('AI_INPUT_LIMIT');
    const timeout = AbortSignal.timeout(this.config.get('QWEN_TIMEOUT_MS'));
    const signal = callerSignal
      ? AbortSignal.any([timeout, callerSignal])
      : timeout;
    try {
      signal.throwIfAborted();
      const response = await fetch(
        `${this.config.get('QWEN_BASE_URL').replace(/\/+$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.config.get('QWEN_API_KEY')}`,
          },
          signal,
          redirect: 'error',
          body: JSON.stringify({
            model: this.config.get('QWEN_MODEL'),
            messages,
            temperature: 0.1,
            max_tokens: this.config.get('QWEN_MAX_OUTPUT_TOKENS'),
            enable_thinking: false,
            response_format: { type: 'json_object' },
            stream: false,
          }),
        },
      );
      if (!response.ok) {
        throw new AiGatewayError(
          'AI_UPSTREAM_REJECTED',
          await rejectedResponseDiagnostic(response, signal),
        );
      }
      const parsed = structureResponse.safeParse(
        await boundedJson(
          response,
          this.config.get('AI_MAX_RESPONSE_BYTES'),
          signal,
        ),
      );
      if (!parsed.success) throw new AiGatewayError('AI_INVALID_RESPONSE');
      const choice = parsed.data.choices[0]!;
      if (choice.finish_reason === 'length')
        throw new AiGatewayError('AI_TRUNCATED');
      if (choice.finish_reason !== 'stop')
        throw new AiGatewayError('AI_INVALID_RESPONSE');
      const usage = parseUsage(
        parsed.data.usage,
        this.config.get('AI_INPUT_TOKEN_BUDGET'),
        this.config.get('QWEN_MAX_OUTPUT_TOKENS'),
      );
      const id = parsed.data.id;
      return {
        content: choice.message.content,
        finishReason: 'stop',
        ...(usage ? { usage } : {}),
        ...(id && /^[a-zA-Z0-9_-]{1,128}$/.test(id)
          ? { providerRequestId: id }
          : {}),
      };
    } catch (error) {
      // An HTTP rejection already has a definitive status, even if its bounded
      // diagnostic body was interrupted. Billing remains UNKNOWN upstream.
      if (error instanceof AiGatewayError && error.diagnostic) throw error;
      if (callerSignal?.aborted) throw new AiGatewayError('AI_CANCELLED');
      if (timeout.aborted) throw new AiGatewayError('AI_TIMEOUT');
      if (error instanceof AiGatewayError) throw error;
      throw new AiGatewayError('AI_UPSTREAM_ERROR');
    }
  }

  /** Internal entry point only. No public model-proxy controller is registered. */
  async complete(input: CompletionInput) {
    if (!this.config.get('QWEN_ENABLED')) {
      throw new ApiException(
        { code: 'AI_NOT_CONFIGURED', message: 'AI 服务尚未启用' },
        503,
      );
    }
    const parsed = completionInput.safeParse(input);
    if (!parsed.success || JSON.stringify(parsed.data).length > 256000) {
      throw new ApiException({
        code: 'AI_INVALID_INPUT',
        message: 'AI 请求参数不正确',
      });
    }
    const signal = AbortSignal.timeout(this.config.get('QWEN_TIMEOUT_MS'));
    try {
      const response = await fetch(
        `${this.config.get('QWEN_BASE_URL').replace(/\/+$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.config.get('QWEN_API_KEY')}`,
          },
          signal,
          redirect: 'error',
          body: JSON.stringify({
            model: this.config.get('QWEN_MODEL'),
            messages: parsed.data.messages,
            temperature: parsed.data.temperature ?? 0.4,
            max_tokens: Math.min(
              parsed.data.maxOutputTokens ??
                this.config.get('QWEN_MAX_OUTPUT_TOKENS'),
              this.config.get('QWEN_MAX_OUTPUT_TOKENS'),
            ),
            stream: false,
          }),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Upstream rejected request');
      }
      const result = completionResponse.safeParse(await response.json());
      if (!result.success) throw new Error('Invalid upstream response');
      return {
        content: result.data.choices[0]!.message.content,
        ...(result.data.usage ? { usage: result.data.usage } : {}),
      };
    } catch {
      throw new ApiException(
        {
          code: signal.aborted ? 'AI_TIMEOUT' : 'AI_UPSTREAM_ERROR',
          message: signal.aborted
            ? 'AI 请求超时，请稍后重试'
            : 'AI 服务暂时不可用',
        },
        signal.aborted ? 504 : 502,
      );
    }
  }
}
