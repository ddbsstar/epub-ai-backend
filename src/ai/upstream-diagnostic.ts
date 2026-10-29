/** Private metadata only. Never retain upstream messages, bodies, URLs or causes. */
export interface UpstreamDiagnostic {
  httpStatus: number;
  providerErrorCode?: string;
  providerRequestId?: string;
}

const knownProviderCodes = new Set([
  'invalid_api_key',
  'authentication_error',
  'invalid_request_error',
  'invalid_parameter',
  'insufficient_quota',
  'rate_limit_exceeded',
  'permission_denied',
  'model_not_found',
  'context_length_exceeded',
  'content_filter',
  'server_error',
  'service_unavailable',
  'InvalidApiKey',
  'InvalidParameter',
  'InvalidParameterValue',
  'InvalidInput',
  'AccessDenied',
  'Forbidden',
  'ModelNotFound',
  'DataInspectionFailed',
  'InputDataInspectionFailed',
  'OutputDataInspectionFailed',
  'Throttling',
  'Throttling.RateQuota',
  'Throttling.AllocationQuota',
  'Arrearage',
  'InternalError',
  'ServiceUnavailable',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeRequestId(value: unknown): string | undefined {
  return typeof value === 'string' &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(value) &&
    !/^(?:sk[-_]|bearer)/i.test(value)
    ? value
    : undefined;
}

/** Explicit picks also defend ledger callers from storing arbitrary extra data. */
export function sanitizeUpstreamDiagnostic(
  value: unknown,
): UpstreamDiagnostic | undefined {
  const input = record(value);
  if (
    !input ||
    !Number.isInteger(input.httpStatus) ||
    (input.httpStatus as number) < 100 ||
    (input.httpStatus as number) > 599
  )
    return undefined;
  const code =
    typeof input.providerErrorCode === 'string' &&
    knownProviderCodes.has(input.providerErrorCode)
      ? input.providerErrorCode
      : undefined;
  const requestId = safeRequestId(input.providerRequestId);
  return {
    httpStatus: input.httpStatus as number,
    ...(code ? { providerErrorCode: code } : {}),
    ...(requestId ? { providerRequestId: requestId } : {}),
  };
}

/** At most 8 KiB / 500 ms of a rejected response; unknown fields are discarded. */
export async function rejectedResponseDiagnostic(
  response: Response,
  callerSignal: AbortSignal,
): Promise<UpstreamDiagnostic> {
  const headers = ['x-request-id', 'request-id', 'x-dashscope-request-id'];
  const headerRequestId = headers
    .map((name) => safeRequestId(response.headers.get(name)))
    .find(Boolean);
  const fallback = sanitizeUpstreamDiagnostic({
    httpStatus: response.status,
    providerRequestId: headerRequestId,
  })!;
  const limit = 8192;
  if (
    !response.body ||
    Number(response.headers.get('content-length') ?? 0) > limit
  ) {
    void response.body?.cancel().catch(() => undefined);
    return fallback;
  }
  const reader = response.body.getReader();
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(500)]);
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      void reader.cancel().catch(() => undefined);
      reject(new Error('UPSTREAM_DIAGNOSTIC_ABORTED'));
    };
  });
  signal.addEventListener('abort', abort!, { once: true });
  if (signal.aborted) abort!();
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => undefined);
        return fallback;
      }
      chunks.push(chunk.value);
    }
    const body = record(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      ) as unknown,
    );
    const error = record(body?.error);
    return sanitizeUpstreamDiagnostic({
      httpStatus: response.status,
      providerErrorCode: error?.code ?? body?.code,
      providerRequestId:
        headerRequestId ?? body?.request_id ?? error?.request_id,
    })!;
  } catch {
    return fallback;
  } finally {
    signal.removeEventListener('abort', abort!);
    reader.releaseLock();
  }
}
