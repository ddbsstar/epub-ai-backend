import { z } from 'zod';
import type { ProcessingRun } from '../processing/processing.types.js';

const count = z.number().int().nonnegative().max(1000000000);
export const businessAiSchema = z.object({
  status: z.enum([
    'DISABLED',
    'PENDING',
    'RUNNING',
    'APPLIED',
    'FALLBACK',
    'SKIPPED',
  ]),
  model: z.string().max(100).nullable(),
  reasonCode: z
    .string()
    .regex(/^[A-Z0-9_]{1,80}$/)
    .nullable(),
  sampledBlocks: count,
  appliedBlocks: count,
  usage: z
    .object({ inputTokens: count, outputTokens: count, totalTokens: count })
    .nullable(),
  estimatedCostMicros: count.nullable(),
  currency: z.literal('CNY'),
});
export type BusinessAiView = z.infer<typeof businessAiSchema>;

export const disabledAi = (): BusinessAiView => ({
  status: 'DISABLED',
  model: null,
  reasonCode: null,
  sampledBlocks: 0,
  appliedBlocks: 0,
  usage: null,
  estimatedCostMicros: null,
  currency: 'CNY',
});

export function runAiView(run: ProcessingRun): BusinessAiView {
  const checkpoint = [...run.steps]
    .reverse()
    .find(
      (step) =>
        step.status === 'SUCCEEDED' &&
        step.result &&
        typeof step.result === 'object' &&
        !Array.isArray(step.result) &&
        'ai' in step.result,
    );
  if (
    checkpoint?.result &&
    typeof checkpoint.result === 'object' &&
    !Array.isArray(checkpoint.result)
  ) {
    const parsed = businessAiSchema.safeParse(checkpoint.result.ai);
    if (parsed.success) return parsed.data;
  }
  if (
    run.configuration &&
    typeof run.configuration === 'object' &&
    !Array.isArray(run.configuration) &&
    run.configuration.ai === true
  ) {
    if (run.status === 'CANCELLED' || run.status === 'FAILED')
      return {
        ...disabledAi(),
        status: 'SKIPPED',
        reasonCode:
          run.status === 'CANCELLED' ? 'AI_CANCELLED' : 'AI_INPUT_REJECTED',
      };
    return {
      ...disabledAi(),
      status:
        run.stage === 'analyze' && run.status === 'RUNNING'
          ? 'RUNNING'
          : 'PENDING',
    };
  }
  return disabledAi();
}

export function aiFallbackMessage(reasonCode: string | null): string {
  switch (reasonCode) {
    case 'AI_BUDGET_EXCEEDED':
    case 'AI_RUN_BUDGET_EXCEEDED':
    case 'AI_DAILY_BUDGET_EXCEEDED':
    case 'MODEL_RUN_BUDGET_EXCEEDED':
    case 'MODEL_DAILY_BUDGET_EXCEEDED':
      return 'AI 调用达到当前预算，本轮继续使用规则排版。';
    case 'AI_TIMEOUT':
    case 'AI_OUTCOME_UNKNOWN':
    case 'AI_UNKNOWN_OUTCOME':
    case 'MODEL_CALL_UNKNOWN':
      return 'AI 调用未取得可确认的结果，未自动重发，本轮继续使用规则排版。';
    case 'AI_INVALID_PLAN':
    case 'AI_INVALID_RESPONSE':
    case 'AI_TRUNCATED':
      return 'AI 方案未通过校验，本轮继续使用规则排版。';
    default:
      return '本轮未采用 AI 方案，继续使用规则排版；原因与调用记录见报告。';
  }
}
