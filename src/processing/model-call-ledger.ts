import {
  ProcessingError,
  type ProcessingRun,
  type StepLease,
} from './processing.types.js';
import type {
  ModelCallCompletion,
  ModelCallRecord,
  ModelCallReservation,
  ModelDailyBudget,
} from './model-call.types.js';

const hash = (value: unknown) =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown, max = 1_000_000_000_000): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
const label = (value: unknown, max = 100) =>
  typeof value === 'string' &&
  value.length <= max &&
  /^[a-zA-Z0-9._:/-]+$/.test(value);

export function validateModelReservation(
  input: ModelCallReservation,
): ModelCallReservation {
  if (
    !hash(input.fingerprint) ||
    !hash(input.sourceHash) ||
    !hash(input.sampleHash) ||
    !label(input.promptVersion) ||
    !label(input.model) ||
    !label(input.schemaVersion) ||
    !label(input.priceVersion) ||
    !integer(input.inputTokenUpperBound, 10_000_000) ||
    input.inputTokenUpperBound < 1 ||
    !integer(input.maxOutputTokens, 1_000_000) ||
    input.maxOutputTokens < 1 ||
    !integer(input.reservedMicros) ||
    input.reservedMicros < 1 ||
    !integer(input.budgetMicros) ||
    !integer(input.dailyBudgetMicros) ||
    (input.budgetEnforced !== undefined && input.budgetEnforced !== false) ||
    (input.budgetEnforced !== false &&
      (input.reservedMicros > input.budgetMicros ||
        input.reservedMicros > input.dailyBudgetMicros))
  )
    throw new ProcessingError('INVALID_MODEL_RESERVATION', 400);
  // Explicit pick: callers cannot accidentally persist prompts or arbitrary output.
  return {
    fingerprint: input.fingerprint,
    sourceHash: input.sourceHash,
    sampleHash: input.sampleHash,
    promptVersion: input.promptVersion,
    model: input.model,
    schemaVersion: input.schemaVersion,
    inputTokenUpperBound: input.inputTokenUpperBound,
    maxOutputTokens: input.maxOutputTokens,
    reservedMicros: input.reservedMicros,
    budgetMicros: input.budgetMicros,
    dailyBudgetMicros: input.dailyBudgetMicros,
    ...(input.budgetEnforced === false
      ? { budgetEnforced: false as const }
      : {}),
    priceVersion: input.priceVersion,
  };
}

export function validateModelCompletion(
  input: ModelCallCompletion,
  call: ModelCallRecord,
): ModelCallCompletion {
  const parts = input.resultKey.split('/');
  if (
    !input.resultKey ||
    input.resultKey.length > 255 ||
    !/^[a-zA-Z0-9._/-]+$/.test(input.resultKey) ||
    parts.some((part) => !part || part === '.' || part === '..') ||
    !hash(input.resultHash) ||
    !integer(input.resultByteSize, 262144) ||
    input.resultByteSize < 1 ||
    (input.estimatedCostMicros !== undefined &&
      (!integer(input.estimatedCostMicros) ||
        input.estimatedCostMicros > call.reservedMicros)) ||
    (input.providerRequestId !== undefined &&
      !label(input.providerRequestId, 128)) ||
    (input.finishReason !== undefined && !label(input.finishReason, 48))
  )
    throw new ProcessingError('INVALID_MODEL_COMPLETION', 400);
  const usage = input.usage;
  if (
    usage &&
    (!integer(usage.inputTokens, call.inputTokenUpperBound) ||
      !integer(usage.outputTokens, call.maxOutputTokens) ||
      !integer(usage.totalTokens, 11_000_000) ||
      usage.totalTokens !== usage.inputTokens + usage.outputTokens ||
      (usage.cachedInputTokens !== undefined &&
        !integer(usage.cachedInputTokens, usage.inputTokens)))
  )
    throw new ProcessingError('INVALID_MODEL_USAGE', 400);
  return {
    resultKey: input.resultKey,
    resultHash: input.resultHash,
    resultByteSize: input.resultByteSize,
    ...(usage
      ? {
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
            ...(usage.cachedInputTokens === undefined
              ? {}
              : { cachedInputTokens: usage.cachedInputTokens }),
          },
        }
      : {}),
    ...(input.estimatedCostMicros === undefined
      ? {}
      : { estimatedCostMicros: input.estimatedCostMicros }),
    ...(input.providerRequestId === undefined
      ? {}
      : { providerRequestId: input.providerRequestId }),
    ...(input.finishReason === undefined
      ? {}
      : { finishReason: input.finishReason }),
  };
}

export function modelBudget(
  budgets: Record<string, ModelDailyBudget>,
  day: string,
): ModelDailyBudget {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
    throw new ProcessingError('MODEL_BUDGET_STATE_INVALID', 503);
  const budget = budgets[day] ?? { day, reservedMicros: 0, spentMicros: 0 };
  if (
    budget.day !== day ||
    !integer(budget.reservedMicros) ||
    !integer(budget.spentMicros)
  )
    throw new ProcessingError('MODEL_BUDGET_STATE_INVALID', 503);
  budgets[day] = budget;
  return budget;
}

export function releaseModelReservation(
  call: ModelCallRecord,
  budgets: Record<string, ModelDailyBudget>,
): void {
  if (call.budgetDisposition !== 'HELD') return;
  const budget = modelBudget(budgets, call.budgetDay);
  if (budget.reservedMicros < call.reservedMicros)
    throw new ProcessingError('MODEL_BUDGET_STATE_INVALID', 503);
  budget.reservedMicros -= call.reservedMicros;
  call.budgetDisposition = 'RELEASED';
}

export function cancelModelCall(
  run: ProcessingRun,
  budgets: Record<string, ModelDailyBudget>,
  now: string,
): void {
  const call = run.modelCall;
  if (call?.status === 'RESERVED') {
    releaseModelReservation(call, budgets);
    call.status = 'CANCELLED';
    call.reasonCode = 'RUN_CANCELLED';
    call.completedAt = now;
  } else if (call?.status === 'SENT') {
    call.status = 'UNKNOWN';
    call.reasonCode = 'MODEL_CALL_CANCELLED_AFTER_SEND';
    call.completedAt = now;
  }
}

export function sameModelLease(left: StepLease, right: StepLease): boolean {
  return (
    left.runId === right.runId &&
    left.stepId === right.stepId &&
    left.leaseVersion === right.leaseVersion &&
    left.workerId === right.workerId
  );
}

export const changedModelBudgets = (
  run: ProcessingRun,
  budgets: Record<string, ModelDailyBudget>,
): ModelDailyBudget[] =>
  run.modelCall ? [modelBudget(budgets, run.modelCall.budgetDay)] : [];
