import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppConfig } from '../config/app-config.module.js';
import { ApiException } from '../common/http/api-exception.js';
import type { DependencyStatus } from '../database/database.service.js';

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

@Injectable()
export class AiService {
  constructor(@Inject(AppConfig) private readonly config: AppConfig) {}

  getStatus(): DependencyStatus {
    return this.config.get('QWEN_ENABLED')
      ? 'configured_not_checked'
      : 'disabled';
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
