import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  ImageCallLedger,
  ImageCallLedgerError,
  type ImageCallReservation,
} from '../src/ai/image-call-ledger.js';

const reservation: ImageCallReservation = {
  ownerId: 'local-owner',
  operationId: 'operation-1',
  callKey: 'illustration-1',
  fingerprint: 'a'.repeat(64),
  model: 'z-image-turbo',
  priceVersion: 'configured-estimate-1',
  priceMicros: 100_000,
  operationBudgetMicros: 200_000,
  dailyBudgetMicros: 300_000,
};
const asset = {
  relativeKey: 'assets/test-image.png',
  sha256: 'b'.repeat(64),
  byteSize: 1024,
  width: 1024,
  height: 768,
};
const providerResult = {
  relativeKey: 'provider-results/success.json',
  sha256: 'c'.repeat(64),
};

describe('local image call ledger (no external service)', () => {
  let directory: string;
  let now: number;
  let ledger: ImageCallLedger;
  const others: ImageCallLedger[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'epub-image-ledger-'));
    now = Date.parse('2026-10-21T12:00:00Z');
    ledger = newLedger();
  });
  afterEach(async () => {
    ledger.close();
    for (const value of others.splice(0)) value.close();
    await rm(directory, { recursive: true, force: true });
  });

  function newLedger(dataDir = directory, budgetEnforced?: boolean) {
    return new ImageCallLedger({
      enabled: true,
      budgetEnforced,
      dataDir,
      now: () => now,
      reservationTtlMs: 1000,
      sentTtlMs: 2000,
    });
  }

  function complete(input = reservation) {
    const result = ledger.reserve(input);
    ledger.begin(result.call.id, result.claimToken!);
    return ledger.succeed(
      result.call.id,
      result.claimToken!,
      asset,
      'provider-request-1',
    );
  }

  it('does not create a directory or database while disabled or before first use', () => {
    const dataDir = join(directory, 'disabled-child');
    const disabled = new ImageCallLedger({ enabled: false, dataDir });
    expect(() => disabled.reserve(reservation)).toThrowError(
      'IMAGE_GENERATION_DISABLED',
    );
    disabled.close();
    expect(existsSync(dataDir)).toBe(false);
    expect(existsSync(join(directory, 'image-calls.sqlite3'))).toBe(false);
  });

  it('persists a success without storing prompt, credentials or source URL', async () => {
    const result = complete();
    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      budgetStatus: 'SETTLED',
      priceMicros: 100_000,
      asset,
      providerRequestId: 'provider-request-1',
    });
    expect(result).not.toHaveProperty('claimToken');
    ledger.close();
    ledger = newLedger();
    expect(ledger.get(result.id)).toEqual(result);
    const bytes = await readFile(join(directory, 'image-calls.sqlite3'));
    expect(bytes.includes(Buffer.from('provider-request-1'))).toBe(true);
    expect(bytes.includes(Buffer.from('prompt'))).toBe(false);
    expect(bytes.includes(Buffer.from('https://'))).toBe(false);
  });

  it('reuses an existing call without returning its dispatch claim', () => {
    const result = ledger.reserve(reservation);
    const duplicate = ledger.reserve(reservation);
    expect(duplicate).toEqual({ call: result.call, reused: true });
    expect(() =>
      ledger.reserve({ ...reservation, fingerprint: 'c'.repeat(64) }),
    ).toThrowError('IMAGE_CALL_CONFLICT');
    ledger.begin(result.call.id, result.claimToken!);
    expect(ledger.reserve(reservation)).toMatchObject({
      reused: true,
      call: { status: 'SENT' },
    });
    expect(() => ledger.begin(result.call.id, result.claimToken!)).toThrowError(
      'IMAGE_CALL_STALE_CLAIM',
    );
  });

  it('allows one active reservation across independent connections', () => {
    const second = newLedger();
    others.push(second);
    const result = ledger.reserve(reservation);
    expect(() =>
      second.reserve({ ...reservation, operationId: 'operation-2' }),
    ).toThrowError('IMAGE_GENERATION_BUSY');
    expect(second.reserve(reservation)).toMatchObject({
      reused: true,
      call: { id: result.call.id },
    });
    second.begin(result.call.id, result.claimToken!);
    expect(() => ledger.begin(result.call.id, result.claimToken!)).toThrowError(
      'IMAGE_CALL_STALE_CLAIM',
    );
  });

  it('holds UNKNOWN costs and prevents retry with the same key', () => {
    const result = ledger.reserve(reservation);
    ledger.begin(result.call.id, result.claimToken!);
    const unknown = ledger.markUnknown(
      result.call.id,
      result.claimToken!,
      'IMAGE_TIMEOUT',
    );
    expect(unknown).toMatchObject({
      status: 'UNKNOWN',
      budgetStatus: 'HELD',
      reasonCode: 'IMAGE_TIMEOUT',
    });
    expect(ledger.reserve(reservation)).toEqual({
      call: unknown,
      reused: true,
    });
    expect(() =>
      ledger.succeed(result.call.id, result.claimToken!, asset),
    ).toThrowError('IMAGE_CALL_STALE_CLAIM');
    complete({ ...reservation, callKey: 'illustration-2' });
    expect(() =>
      ledger.reserve({ ...reservation, callKey: 'illustration-3' }),
    ).toThrowError('IMAGE_OPERATION_BUDGET_EXCEEDED');
  });

  it('freezes an operation budget and counts settled cost', () => {
    complete();
    expect(() =>
      ledger.reserve({
        ...reservation,
        callKey: 'another',
        operationBudgetMicros: 300_000,
      }),
    ).toThrowError('IMAGE_OPERATION_BUDGET_CONFLICT');
    complete({ ...reservation, callKey: 'another' });
    expect(() =>
      ledger.reserve({ ...reservation, callKey: 'third' }),
    ).toThrowError('IMAGE_OPERATION_BUDGET_EXCEEDED');
  });

  it('uses a global daily budget across owners and operations', () => {
    complete();
    complete({
      ...reservation,
      ownerId: 'owner-2',
      operationId: 'operation-2',
    });
    complete({
      ...reservation,
      ownerId: 'owner-3',
      operationId: 'operation-3',
    });
    expect(() =>
      ledger.reserve({ ...reservation, ownerId: 'owner-4' }),
    ).toThrowError('IMAGE_DAILY_BUDGET_EXCEEDED');
    now += 24 * 60 * 60 * 1000;
    expect(
      ledger.reserve({ ...reservation, ownerId: 'owner-4' }).call.budgetDay,
    ).toBe('2026-10-22');
  });

  it('allows multiple images above tiny operation and daily caps only in unrestricted mode while retaining settled accounting', () => {
    const tiny = {
      ...reservation,
      operationBudgetMicros: 1,
      dailyBudgetMicros: 1,
    };
    expect(() => ledger.reserve(tiny)).toThrowError(
      'IMAGE_OPERATION_BUDGET_EXCEEDED',
    );
    ledger.close();
    ledger = newLedger(directory, false);
    const completed = [
      complete(tiny),
      complete({ ...tiny, callKey: 'second' }),
      complete({ ...tiny, callKey: 'third' }),
    ];
    expect(
      completed.every(
        (call) =>
          call.budgetStatus === 'SETTLED' && call.priceMicros === 100_000,
      ),
    ).toBe(true);
    const database = new DatabaseSync(join(directory, 'image-calls.sqlite3'), {
      readOnly: true,
    });
    try {
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count, SUM(price_micros) AS cost FROM image_calls WHERE status = 'SUCCEEDED' AND budget_day = '2026-10-21'",
          )
          .get(),
      ).toEqual({ count: 3, cost: 300_000 });
    } finally {
      database.close();
    }
    ledger.close();
    ledger = newLedger();
    expect(ledger.get(completed[0].id)).toMatchObject({
      status: 'SUCCEEDED',
      priceMicros: 100_000,
      budgetStatus: 'SETTLED',
    });
    expect(ledger.reserve(tiny)).toMatchObject({
      reused: true,
      call: { id: completed[0].id },
    });
    expect(() =>
      ledger.reserve({ ...tiny, callKey: 'new-enforced-call' }),
    ).toThrowError('IMAGE_OPERATION_BUDGET_EXCEEDED');
  });

  it('moves unrestricted calls to the actual UTC send day even when that day already exceeds its cap', () => {
    ledger.close();
    ledger = newLedger(directory, false);
    const tiny = {
      ...reservation,
      operationBudgetMicros: 1,
      dailyBudgetMicros: 1,
    };
    now = Date.parse('2026-10-22T00:00:00Z');
    complete({ ...tiny, operationId: 'already-settled-next-day' });
    now = Date.parse('2026-10-21T23:59:59.500Z');
    const pending = ledger.reserve(tiny);
    now += 600;
    expect(ledger.begin(pending.call.id, pending.claimToken!)).toMatchObject({
      status: 'SENT',
      budgetDay: '2026-10-22',
      priceMicros: 100_000,
    });
    expect(
      ledger.succeed(pending.call.id, pending.claimToken!, asset),
    ).toMatchObject({
      budgetDay: '2026-10-22',
      status: 'SUCCEEDED',
      budgetStatus: 'SETTLED',
    });
    const database = new DatabaseSync(join(directory, 'image-calls.sqlite3'), {
      readOnly: true,
    });
    try {
      expect(
        database
          .prepare(
            'SELECT budget_day AS day, COUNT(*) AS count, SUM(price_micros) AS cost FROM image_calls GROUP BY budget_day',
          )
          .all(),
      ).toEqual([{ day: '2026-10-22', count: 2, cost: 200_000 }]);
    } finally {
      database.close();
    }
  });

  it('retains single active dispatch and UNKNOWN no-resend guarantees in unrestricted mode', () => {
    ledger.close();
    ledger = newLedger(directory, false);
    const tiny = {
      ...reservation,
      operationBudgetMicros: 1,
      dailyBudgetMicros: 1,
    };
    const first = ledger.reserve(tiny);
    ledger.begin(first.call.id, first.claimToken!);
    expect(() =>
      ledger.reserve({ ...tiny, callKey: 'busy-call' }),
    ).toThrowError('IMAGE_GENERATION_BUSY');
    now += 2000;
    const duplicate = ledger.reserve(tiny);
    expect(duplicate).toMatchObject({
      reused: true,
      call: {
        id: first.call.id,
        status: 'UNKNOWN',
        budgetStatus: 'HELD',
        priceMicros: 100_000,
      },
    });
    expect(duplicate).not.toHaveProperty('claimToken');
    expect(() => ledger.begin(first.call.id, first.claimToken!)).toThrowError(
      'IMAGE_CALL_STALE_CLAIM',
    );
    expect(() =>
      ledger.succeed(first.call.id, first.claimToken!, asset),
    ).toThrowError('IMAGE_CALL_STALE_CLAIM');
    expect(() =>
      ledger.resumeDownload(first.call.id, tiny.fingerprint),
    ).toThrowError('IMAGE_DOWNLOAD_NOT_RECOVERABLE');
    expect(
      complete({ ...tiny, callKey: 'new-independent-call' }),
    ).toMatchObject({ status: 'SUCCEEDED', priceMicros: 100_000 });
    expect(ledger.get(first.call.id)?.status).toBe('UNKNOWN');
  });

  it('moves an unsent reservation to the new UTC day before sending', () => {
    now = Date.parse('2026-10-21T23:59:59.500Z');
    const result = ledger.reserve(reservation);
    now += 600;
    expect(ledger.begin(result.call.id, result.claimToken!)).toMatchObject({
      status: 'SENT',
      budgetDay: '2026-10-22',
    });
    ledger.markUnknown(result.call.id, result.claimToken!, 'IMAGE_TIMEOUT');
    complete({
      ...reservation,
      ownerId: 'new-owner',
      dailyBudgetMicros: 200_000,
    });
    expect(() =>
      ledger.reserve({
        ...reservation,
        ownerId: 'third-owner',
        dailyBudgetMicros: 200_000,
      }),
    ).toThrowError('IMAGE_DAILY_BUDGET_EXCEEDED');
  });

  it('rechecks daily admission when a reservation crosses midnight', () => {
    // Seed a persisted new-day settlement, then use a controlled older clock to
    // exercise admission against that existing day's balance.
    now = Date.parse('2026-10-22T00:00:00Z');
    complete({ ...reservation, operationId: 'settled-next-day' });
    now = Date.parse('2026-10-21T23:59:59.500Z');
    const result = ledger.reserve({
      ...reservation,
      dailyBudgetMicros: 50_000 + reservation.priceMicros,
    });
    now += 600;
    expect(() => ledger.begin(result.call.id, result.claimToken!)).toThrowError(
      'IMAGE_DAILY_BUDGET_EXCEEDED',
    );
    expect(ledger.get(result.call.id)).toMatchObject({
      status: 'RESERVED',
      budgetDay: '2026-10-21',
    });
  });

  it('expires RESERVED safely, releases budgets and fences the old claim', () => {
    const result = ledger.reserve({
      ...reservation,
      operationBudgetMicros: 100_000,
      dailyBudgetMicros: 100_000,
    });
    now += 1000;
    expect(() => ledger.begin(result.call.id, result.claimToken!)).toThrowError(
      'IMAGE_CALL_STALE_CLAIM',
    );
    expect(ledger.get(result.call.id)).toMatchObject({
      status: 'CANCELLED',
      budgetStatus: 'RELEASED',
    });
    expect(
      ledger.reserve({
        ...reservation,
        operationBudgetMicros: 100_000,
        dailyBudgetMicros: 100_000,
        callKey: 'replacement',
      }).reused,
    ).toBe(false);
  });

  it('expires SENT to UNKNOWN, retaining budgets even after rejected stale success', () => {
    const result = ledger.reserve({
      ...reservation,
      dailyBudgetMicros: 100_000,
    });
    ledger.begin(result.call.id, result.claimToken!);
    now += 2000;
    expect(() =>
      ledger.succeed(result.call.id, result.claimToken!, asset),
    ).toThrowError('IMAGE_CALL_STALE_CLAIM');
    expect(ledger.get(result.call.id)).toMatchObject({
      status: 'UNKNOWN',
      budgetStatus: 'HELD',
      reasonCode: 'IMAGE_SENT_EXPIRED',
    });
    expect(() =>
      ledger.reserve({
        ...reservation,
        operationId: 'new',
        dailyBudgetMicros: 100_000,
      }),
    ).toThrowError('IMAGE_DAILY_BUDGET_EXCEEDED');
  });

  it('rejects unvalidated assets and unsafe strings without persisting them', () => {
    const result = ledger.reserve(reservation);
    ledger.begin(result.call.id, result.claimToken!);
    for (const relativeKey of [
      '../secret.png',
      '/root/image.png',
      'assets//image.png',
      'assets/./image.png',
    ]) {
      expect(() =>
        ledger.succeed(result.call.id, result.claimToken!, {
          ...asset,
          relativeKey,
        }),
      ).toThrowError('IMAGE_LEDGER_INVALID_INPUT');
    }
    expect(() =>
      ledger.markUnknown(
        result.call.id,
        result.claimToken!,
        'https://private?secret',
      ),
    ).toThrowError('IMAGE_LEDGER_INVALID_INPUT');
    expect(() =>
      ledger.succeed(result.call.id, result.claimToken!, asset, 'secret token'),
    ).toThrowError('IMAGE_LEDGER_INVALID_INPUT');
    expect(ledger.get(result.call.id)?.status).toBe('SENT');
  });

  it('refuses relative storage, malformed inputs and use after destruction', () => {
    expect(
      () => new ImageCallLedger({ enabled: true, dataDir: 'relative' }),
    ).toThrowError('IMAGE_LEDGER_INVALID_CONFIG');
    expect(() =>
      ledger.reserve({ ...reservation, priceMicros: 0 }),
    ).toThrowError('IMAGE_LEDGER_INVALID_INPUT');
    expect(() =>
      ledger.reserve({ ...reservation, fingerprint: 'bad' }),
    ).toThrowError(ImageCallLedgerError);
    ledger.onModuleDestroy();
    expect(() => ledger.get('missing')).toThrowError('IMAGE_LEDGER_CLOSED');
  });

  it('resumes a persisted provider result without reserving again or moving its cost day', () => {
    const initial = ledger.reserve({
      ...reservation,
      operationBudgetMicros: 100_000,
    });
    ledger.begin(initial.call.id, initial.claimToken!);
    ledger.recordProviderResult(
      initial.call.id,
      initial.claimToken!,
      providerResult,
      'provider-result-1',
    );
    ledger.markUnknown(
      initial.call.id,
      initial.claimToken!,
      'IMAGE_DOWNLOAD_ERROR',
    );
    ledger.close();
    now += 24 * 60 * 60 * 1000;
    ledger = newLedger();
    expect(ledger.get(initial.call.id)?.providerResult).toEqual(providerResult);
    const resumed = ledger.resumeDownload(
      initial.call.id,
      reservation.fingerprint,
    );
    expect(resumed.claimToken).not.toBe(initial.claimToken);
    expect(resumed.call).toMatchObject({
      status: 'SENT',
      budgetStatus: 'HELD',
      budgetDay: '2026-10-21',
      priceMicros: 100_000,
      providerResult,
    });
    const result = ledger.succeed(initial.call.id, resumed.claimToken, asset);
    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      budgetStatus: 'SETTLED',
      providerRequestId: 'provider-result-1',
      budgetDay: '2026-10-21',
    });
    expect(result).not.toHaveProperty('providerResult');
    expect(() =>
      ledger.reserve({
        ...reservation,
        callKey: 'new-key',
        operationBudgetMicros: 100_000,
      }),
    ).toThrowError('IMAGE_OPERATION_BUDGET_EXCEEDED');
    // The resumed download consumes no generation allowance on the new day.
    expect(
      ledger.reserve({
        ...reservation,
        operationId: 'new-day',
        dailyBudgetMicros: 100_000,
      }).reused,
    ).toBe(false);
  });

  it('does not recover UNKNOWN calls without a persisted successful provider result', () => {
    const initial = ledger.reserve(reservation);
    expect(() =>
      ledger.resumeDownload(initial.call.id, reservation.fingerprint),
    ).toThrowError('IMAGE_DOWNLOAD_NOT_RECOVERABLE');
    ledger.begin(initial.call.id, initial.claimToken!);
    ledger.markUnknown(initial.call.id, initial.claimToken!, 'IMAGE_TIMEOUT');
    expect(() =>
      ledger.resumeDownload(initial.call.id, 'f'.repeat(64)),
    ).toThrowError('IMAGE_CALL_CONFLICT');
    expect(() =>
      ledger.resumeDownload(initial.call.id, reservation.fingerprint),
    ).toThrowError('IMAGE_DOWNLOAD_NOT_RECOVERABLE');
    expect(() =>
      ledger.recordProviderResult(
        initial.call.id,
        initial.claimToken!,
        providerResult,
      ),
    ).toThrowError('IMAGE_CALL_STALE_CLAIM');
  });

  it('fences the initial claim and competing download resumptions across connections', () => {
    const initial = ledger.reserve(reservation);
    ledger.begin(initial.call.id, initial.claimToken!);
    ledger.recordProviderResult(
      initial.call.id,
      initial.claimToken!,
      providerResult,
    );
    ledger.markUnknown(
      initial.call.id,
      initial.claimToken!,
      'IMAGE_DOWNLOAD_ERROR',
    );
    const second = newLedger();
    others.push(second);
    const resumed = second.resumeDownload(
      initial.call.id,
      reservation.fingerprint,
    );
    expect(() =>
      ledger.resumeDownload(initial.call.id, reservation.fingerprint),
    ).toThrowError('IMAGE_DOWNLOAD_NOT_RECOVERABLE');
    expect(() =>
      ledger.succeed(initial.call.id, initial.claimToken!, asset),
    ).toThrowError('IMAGE_CALL_STALE_CLAIM');
    expect(() =>
      ledger.recordProviderResult(
        initial.call.id,
        initial.claimToken!,
        providerResult,
      ),
    ).toThrowError('IMAGE_CALL_STALE_CLAIM');
    expect(() =>
      ledger.begin(initial.call.id, resumed.claimToken),
    ).toThrowError('IMAGE_CALL_STALE_CLAIM');
    second.succeed(initial.call.id, resumed.claimToken, asset);
  });

  it('waits for the single active slot and preserves provider references after download expiry', () => {
    const initial = ledger.reserve(reservation);
    ledger.begin(initial.call.id, initial.claimToken!);
    ledger.recordProviderResult(
      initial.call.id,
      initial.claimToken!,
      providerResult,
    );
    ledger.markUnknown(
      initial.call.id,
      initial.claimToken!,
      'IMAGE_DOWNLOAD_ERROR',
    );
    const other = ledger.reserve({
      ...reservation,
      operationId: 'other-active',
    });
    expect(() =>
      ledger.resumeDownload(initial.call.id, reservation.fingerprint),
    ).toThrowError('IMAGE_GENERATION_BUSY');
    now += 1000;
    const resumed = ledger.resumeDownload(
      initial.call.id,
      reservation.fingerprint,
    );
    expect(ledger.get(other.call.id)?.status).toBe('CANCELLED');
    now += 2000;
    expect(() =>
      ledger.succeed(initial.call.id, resumed.claimToken, asset),
    ).toThrowError('IMAGE_CALL_STALE_CLAIM');
    expect(ledger.get(initial.call.id)).toMatchObject({
      status: 'UNKNOWN',
      providerResult,
      budgetStatus: 'HELD',
    });
    const resumedAgain = ledger.resumeDownload(
      initial.call.id,
      reservation.fingerprint,
    );
    expect(resumedAgain.claimToken).not.toBe(resumed.claimToken);
  });

  it('only records safe immutable private references with an active SENT claim', () => {
    const initial = ledger.reserve(reservation);
    expect(() =>
      ledger.recordProviderResult(
        initial.call.id,
        initial.claimToken!,
        providerResult,
      ),
    ).toThrowError('IMAGE_CALL_STALE_CLAIM');
    ledger.begin(initial.call.id, initial.claimToken!);
    expect(() =>
      ledger.recordProviderResult(initial.call.id, initial.claimToken!, {
        ...providerResult,
        relativeKey: 'https://private.example/image',
      }),
    ).toThrowError('IMAGE_LEDGER_INVALID_INPUT');
    ledger.recordProviderResult(
      initial.call.id,
      initial.claimToken!,
      providerResult,
      'request-1',
    );
    ledger.recordProviderResult(
      initial.call.id,
      initial.claimToken!,
      providerResult,
      'request-1',
    );
    expect(() =>
      ledger.recordProviderResult(initial.call.id, initial.claimToken!, {
        ...providerResult,
        sha256: 'd'.repeat(64),
      }),
    ).toThrowError('IMAGE_PROVIDER_RESULT_CONFLICT');
    expect(() =>
      ledger.recordProviderResult(
        initial.call.id,
        initial.claimToken!,
        providerResult,
        'request-2',
      ),
    ).toThrowError('IMAGE_PROVIDER_RESULT_CONFLICT');
  });

  it('upgrades an existing ledger file without inventing recoverable provider results', () => {
    const initial = ledger.reserve(reservation);
    ledger.begin(initial.call.id, initial.claimToken!);
    ledger.markUnknown(initial.call.id, initial.claimToken!, 'IMAGE_TIMEOUT');
    ledger.close();
    const oldDatabase = new DatabaseSync(
      join(directory, 'image-calls.sqlite3'),
    );
    oldDatabase.exec(
      'ALTER TABLE image_calls DROP COLUMN provider_result_json',
    );
    oldDatabase.close();
    ledger = newLedger();
    expect(ledger.get(initial.call.id)).toMatchObject({
      status: 'UNKNOWN',
      priceMicros: 100_000,
    });
    expect(ledger.get(initial.call.id)).not.toHaveProperty('providerResult');
    expect(() =>
      ledger.resumeDownload(initial.call.id, reservation.fingerprint),
    ).toThrowError('IMAGE_DOWNLOAD_NOT_RECOVERABLE');
  });

  it('serializes competing admissions in distinct Node processes', async () => {
    ledger.get('missing');
    ledger.close();
    const moduleUrl = pathToFileURL(
      join(process.cwd(), 'src/ai/image-call-ledger.ts'),
    ).href;
    const run = (operationId: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const source = `import { registerHooks } from 'node:module';
        registerHooks({ resolve(specifier, context, nextResolve) {
          try { return nextResolve(specifier, context); }
          catch(error) {
            if (error.code !== 'ERR_MODULE_NOT_FOUND' ||
                !specifier.startsWith('.') || !specifier.endsWith('.js')) throw error;
            return nextResolve(specifier.slice(0, -3) + '.ts', context);
          }
        }});
        const { ImageCallLedger } = await import(${JSON.stringify(moduleUrl)});
        const ledger = new ImageCallLedger({enabled:true,dataDir:${JSON.stringify(directory)}});
        try { ledger.reserve(${JSON.stringify({ ...reservation, operationId })});
          process.stdout.write('RESERVED');
        } catch(error) { process.stdout.write(error.code ?? 'UNEXPECTED'); }
        finally { ledger.close(); }`;
        const child = spawn(
          process.execPath,
          [
            '--experimental-transform-types',
            '--input-type=module',
            '-e',
            source,
          ],
          { windowsHide: true },
        );
        let output = '';
        let errors = '';
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
          errors += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0
            ? resolve(output)
            : reject(new Error(`Child test failed: ${errors}`)),
        );
      });
    const outcomes = await Promise.all([
      run('competing-1'),
      run('competing-2'),
    ]);
    expect(outcomes.sort()).toEqual(['IMAGE_GENERATION_BUSY', 'RESERVED']);
  }, 15_000);
});
