import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  rejectedResponseDiagnostic,
  sanitizeUpstreamDiagnostic,
} from '../src/ai/upstream-diagnostic.js';
import { AiGatewayError } from '../src/ai/ai-structure.types.js';
import { ImageProviderError } from '../src/ai/image-provider.types.js';
import { ImageCallLedger } from '../src/ai/image-call-ledger.js';

describe('private upstream diagnostics (no external service)', () => {
  it('retains only vetted metadata, including from untyped ledger callers', () => {
    const input = {
      httpStatus: 429,
      providerErrorCode: 'rate_limit_exceeded',
      providerRequestId: 'req-test-123',
      message: 'private-book-and-key-marker',
      body: { secret: 'private-body-marker' },
      url: 'https://example.com/secret',
    };
    const expected = {
      httpStatus: 429,
      providerErrorCode: 'rate_limit_exceeded',
      providerRequestId: 'req-test-123',
    };
    expect(sanitizeUpstreamDiagnostic(input)).toEqual(expected);
    for (const error of [
      new AiGatewayError('AI_UPSTREAM_REJECTED', input),
      new ImageProviderError('IMAGE_UPSTREAM_REJECTED', input),
    ]) {
      expect(error.diagnostic).toEqual(expected);
      expect(JSON.stringify(error)).not.toContain('private-');
      expect(JSON.stringify(error)).not.toContain('https://');
    }
    expect(
      sanitizeUpstreamDiagnostic({
        httpStatus: 403,
        providerErrorCode: 'private-secret-message',
        providerRequestId: 'sk-private-credential',
      }),
    ).toEqual({ httpStatus: 403 });
    for (const httpStatus of [0, 600, '401', Number.NaN, 401.5])
      expect(sanitizeUpstreamDiagnostic({ httpStatus })).toBeUndefined();
  });

  it('extracts only fixed provider code/request fields and ignores messages', async () => {
    const response = new Response(
      JSON.stringify({
        error: {
          code: 'insufficient_quota',
          message: 'private-request-body-marker',
          request_id: 'body-request-1',
        },
        key: 'private-key-marker',
      }),
      { status: 429, headers: { 'x-request-id': 'header-request-1' } },
    );
    expect(
      await rejectedResponseDiagnostic(response, new AbortController().signal),
    ).toEqual({
      httpStatus: 429,
      providerErrorCode: 'insufficient_quota',
      providerRequestId: 'header-request-1',
    });
    const ali = new Response(
      JSON.stringify({
        code: 'InvalidApiKey',
        message: 'private-key-marker',
        request_id: 'body-request-2',
      }),
      { status: 401 },
    );
    expect(
      await rejectedResponseDiagnostic(ali, new AbortController().signal),
    ).toEqual({
      httpStatus: 401,
      providerErrorCode: 'InvalidApiKey',
      providerRequestId: 'body-request-2',
    });
  });

  it('keeps the HTTP status for malformed, oversized or aborted error bodies', async () => {
    const cancelled = vi.fn();
    const streaming = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(4096));
        },
        cancel: cancelled,
      }),
      { status: 502 },
    );
    expect(
      await rejectedResponseDiagnostic(streaming, new AbortController().signal),
    ).toEqual({ httpStatus: 502 });
    expect(cancelled).toHaveBeenCalledTimes(1);
    for (const response of [
      new Response('private-not-json', { status: 401 }),
      new Response('{}', {
        status: 503,
        headers: { 'content-length': '8193' },
      }),
      new Response(new ReadableStream(), { status: 500 }),
    ])
      expect(
        await rejectedResponseDiagnostic(response, AbortSignal.abort()),
      ).toEqual({ httpStatus: response.status });
  });

  it('bounds a stalled error body independently of the paid request timeout', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      status: 502,
    });
    expect(
      await rejectedResponseDiagnostic(response, new AbortController().signal),
    ).toEqual({ httpStatus: 502 });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('atomically upgrades the old private image ledger without changing old rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'upstream-image-upgrade-'));
    let ledger = new ImageCallLedger({ enabled: true, dataDir: directory });
    try {
      const reservation = {
        ownerId: 'test-owner',
        operationId: 'test-op',
        callKey: 'test-call',
        fingerprint: 'a'.repeat(64),
        model: 'z-image-turbo',
        priceVersion: 'test-1',
        priceMicros: 100000,
        operationBudgetMicros: 200000,
        dailyBudgetMicros: 300000,
      };
      const first = ledger.reserve(reservation);
      ledger.begin(first.call.id, first.claimToken!);
      const prior = ledger.markUnknown(
        first.call.id,
        first.claimToken!,
        'IMAGE_UPSTREAM_ERROR',
      );
      ledger.close();
      const oldDatabase = new DatabaseSync(
        join(directory, 'image-calls.sqlite3'),
      );
      oldDatabase.exec('ALTER TABLE image_calls DROP COLUMN diagnostic_json');
      oldDatabase.close();
      ledger = new ImageCallLedger({ enabled: true, dataDir: directory });
      expect(ledger.get(first.call.id)).toEqual(prior);
      const second = ledger.reserve({ ...reservation, callKey: 'next-call' });
      ledger.begin(second.call.id, second.claimToken!);
      const diagnostic = {
        httpStatus: 429,
        providerErrorCode: 'Throttling.RateQuota',
        providerRequestId: 'provider-req-2',
        message: 'private-message-must-not-persist',
      };
      const unknown = ledger.markUnknown(
        second.call.id,
        second.claimToken!,
        'IMAGE_UPSTREAM_REJECTED',
        diagnostic,
      );
      expect(unknown).toMatchObject({
        status: 'UNKNOWN',
        budgetStatus: 'HELD',
        upstreamDiagnostic: {
          httpStatus: 429,
          providerErrorCode: 'Throttling.RateQuota',
          providerRequestId: 'provider-req-2',
        },
      });
      expect(JSON.stringify(unknown)).not.toContain('private-message');
      expect(
        ledger.reserve({ ...reservation, callKey: 'next-call' }),
      ).toMatchObject({
        reused: true,
        call: unknown,
      });
      ledger.close();
      ledger = new ImageCallLedger({ enabled: true, dataDir: directory });
      expect(ledger.get(second.call.id)).toEqual(unknown);
      expect(ledger.get(first.call.id)).toEqual(prior);
    } finally {
      ledger.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
