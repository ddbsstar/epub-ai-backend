import { ProcessingError, type ProcessingRun } from './processing.types.js';

export const inlineVisualReviewOperation = 'illustration-visual-review';

/** Only a running V7/V8 conversion can reserve one inline review above its owner slot. */
export function inlineReviewParentId(run: ProcessingRun): string | null {
  if (run.operation !== inlineVisualReviewOperation) return null;
  const configuration = run.configuration;
  if (
    !configuration ||
    typeof configuration !== 'object' ||
    Array.isArray(configuration) ||
    configuration.version !== 'illustration-visual-review-1' ||
    typeof configuration.inputHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(configuration.inputHash) ||
    (configuration.planningPolicy !== undefined &&
      configuration.planningPolicy !== 'content-people-1') ||
    run.steps.length !== 1 ||
    run.steps[0]?.stage !== 'analyze'
  )
    throw new ProcessingError('INVALID_INLINE_REVIEW', 400);
  if (configuration.parentRunId === undefined) return null;
  if (
    typeof configuration.parentRunId !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(configuration.parentRunId)
  )
    throw new ProcessingError('INVALID_INLINE_REVIEW', 400);
  return configuration.parentRunId;
}

export function assertInlineReviewParent(
  run: ProcessingRun,
  parent: ProcessingRun | null | undefined,
): void {
  const childPolicy =
    run.configuration &&
    typeof run.configuration === 'object' &&
    !Array.isArray(run.configuration)
      ? run.configuration.planningPolicy
      : undefined;
  if (
    !parent ||
    parent.operation !== 'illustration-conversion' ||
    parent.ownerId !== run.ownerId ||
    parent.bookId !== run.bookId ||
    parent.status !== 'RUNNING' ||
    parent.stage !== 'convert' ||
    parent.cancelRequestedAt ||
    !parent.steps.some(
      (step) =>
        step.stage === 'convert' &&
        step.status === 'RUNNING' &&
        step.leaseUntil &&
        Date.parse(step.leaseUntil) > Date.parse(run.createdAt),
    ) ||
    !parent.configuration ||
    typeof parent.configuration !== 'object' ||
    Array.isArray(parent.configuration) ||
    !['subsection-inline-7', 'subsection-inline-8'].includes(
      parent.configuration.pipelineVersion as string,
    ) ||
    parent.configuration.visualReviewPolicyVersion !== 'visual-review-1' ||
    (parent.configuration.pipelineVersion === 'subsection-inline-8'
      ? parent.configuration.planningPolicy !== 'content-people-1' ||
        childPolicy !== 'content-people-1'
      : parent.configuration.planningPolicy !== undefined ||
        childPolicy !== undefined)
  )
    throw new ProcessingError('INVALID_INLINE_REVIEW', 409);
}
