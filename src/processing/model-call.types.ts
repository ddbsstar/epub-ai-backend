import type { StepLease } from './processing.types.js';
import type { UpstreamDiagnostic } from '../ai/upstream-diagnostic.js';

/** CNY millionths; every persisted monetary amount is a safe integer. */
export interface ModelCallReservation {
  fingerprint: string;
  sourceHash: string;
  sampleHash: string;
  promptVersion: string;
  model: string;
  schemaVersion: string;
  inputTokenUpperBound: number;
  maxOutputTokens: number;
  reservedMicros: number;
  budgetMicros: number;
  dailyBudgetMicros: number;
  /** Absent in historical records means enforced. Always keep usage accounting. */
  budgetEnforced?: false;
  priceVersion: string;
}

export interface ModelCallUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
}

export interface ModelCallCompletion {
  resultKey: string;
  resultHash: string;
  resultByteSize: number;
  usage?: ModelCallUsage;
  estimatedCostMicros?: number;
  providerRequestId?: string;
  finishReason?: string;
}

export type ModelCallStatus =
  'RESERVED' | 'SENT' | 'SUCCEEDED' | 'FAILED_KNOWN' | 'UNKNOWN' | 'CANCELLED';

/** Metadata only. Prompt, book excerpts and raw upstream output never live here. */
export interface ModelCallRecord extends ModelCallReservation {
  id: string;
  status: ModelCallStatus;
  budgetDay: string;
  budgetDisposition: 'HELD' | 'SETTLED' | 'RELEASED';
  reservedAt: string;
  sentAt: string | null;
  completedAt: string | null;
  lease: StepLease;
  resultKey: string | null;
  resultHash: string | null;
  resultByteSize: number | null;
  usage: ModelCallUsage | null;
  estimatedCostMicros: number | null;
  providerRequestId: string | null;
  finishReason: string | null;
  reasonCode: string | null;
  upstreamDiagnostic?: UpstreamDiagnostic;
}

export interface ModelDailyBudget {
  day: string;
  reservedMicros: number;
  spentMicros: number;
}
