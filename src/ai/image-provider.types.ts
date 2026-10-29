export const IMAGE_PROMPT_MAX_CODEPOINTS = 800;
export const IMAGE_PROMPT_MAX_BYTES = 8192;
export const IMAGE_RESPONSE_MAX_BYTES = 96 * 1024;

export interface ImageGenerationInput {
  prompt: string;
  signal?: AbortSignal;
}

export interface ImageGenerationResult {
  imageUrl: string;
  providerRequestId?: string;
  imageCount: 1;
}

export type ImageProviderErrorCode =
  | 'IMAGE_DISABLED'
  | 'IMAGE_NOT_CONFIGURED'
  | 'IMAGE_INVALID_INPUT'
  | 'IMAGE_INPUT_LIMIT'
  | 'IMAGE_CANCELLED'
  | 'IMAGE_TIMEOUT'
  | 'IMAGE_RESPONSE_LIMIT'
  | 'IMAGE_INVALID_RESPONSE'
  | 'IMAGE_UPSTREAM_REJECTED'
  | 'IMAGE_UPSTREAM_ERROR';

/** Safe code only. After SENT, no failure code proves a request was unbilled. */
export class ImageProviderError extends Error {
  readonly diagnostic?: UpstreamDiagnostic;
  constructor(
    readonly code: ImageProviderErrorCode,
    diagnostic?: UpstreamDiagnostic,
  ) {
    super(code);
    this.name = 'ImageProviderError';
    const safe = sanitizeUpstreamDiagnostic(diagnostic);
    if (safe) this.diagnostic = Object.freeze(safe);
  }
}
import {
  sanitizeUpstreamDiagnostic,
  type UpstreamDiagnostic,
} from './upstream-diagnostic.js';
