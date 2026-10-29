import type { EpubStructurePlan } from '../documents/epub.types.js';
import type { ModelCallUsage } from '../processing/model-call.types.js';
import type { StepLease } from '../processing/processing.types.js';
import {
  sanitizeUpstreamDiagnostic,
  type UpstreamDiagnostic,
} from './upstream-diagnostic.js';

export interface AiPlanReference {
  storageKey: string;
  sha256: string;
  byteSize: number;
}

/** Private immutable objects only; the gateway never receives filesystem paths. */
export interface AiPlanStore {
  write(plan: EpubStructurePlan): Promise<AiPlanReference>;
  read(reference: AiPlanReference): Promise<unknown>;
}

export interface AiStructureContext {
  lease: StepLease;
  signal?: AbortSignal;
  planStore: AiPlanStore;
}

export interface AiStructureResult {
  status: 'APPLIED' | 'FALLBACK' | 'SKIPPED';
  reasonCode: string;
  plan?: EpubStructurePlan;
  callId?: string;
  usage?: ModelCallUsage;
  reservedMicros?: number;
  estimatedCostMicros?: number;
  model?: string;
}

export interface StructureMessage {
  role: 'system' | 'user';
  content: string;
}

export interface StructureCompletion {
  content: string;
  finishReason: 'stop';
  usage?: ModelCallUsage;
  providerRequestId?: string;
}

/** Locally normalized, hash-verified JPEG only; no arbitrary upstream URLs. */
export interface VisualReviewImage {
  bytes: Uint8Array;
  sha256: string;
  mediaType: 'image/jpeg';
  width: number;
  height: number;
}

/** Safe event codes only: never attach upstream text, request bodies or causes. */
export class AiGatewayError extends Error {
  readonly diagnostic?: UpstreamDiagnostic;
  constructor(
    readonly code: string,
    diagnostic?: UpstreamDiagnostic,
  ) {
    super(code);
    this.name = 'AiGatewayError';
    const safe = sanitizeUpstreamDiagnostic(diagnostic);
    if (safe) this.diagnostic = Object.freeze(safe);
  }
}
