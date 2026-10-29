import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  sanitizeUpstreamDiagnostic,
  type UpstreamDiagnostic,
} from './upstream-diagnostic.js';

const identifier = z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/);
const money = z.number().int().min(1).max(1_000_000_000);
const reserveSchema = z
  .object({
    ownerId: identifier,
    operationId: identifier,
    callKey: identifier,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    model: z.string().regex(/^[a-zA-Z0-9._/-]{1,100}$/),
    priceVersion: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/),
    priceMicros: money,
    operationBudgetMicros: money,
    dailyBudgetMicros: money,
  })
  .strict();
const assetSchema = z
  .object({
    relativeKey: z
      .string()
      .regex(/^[a-zA-Z0-9_./-]{1,240}$/)
      .refine(
        (value) =>
          !isAbsolute(value) &&
          value
            .split('/')
            .every((part) => part && part !== '.' && part !== '..'),
      ),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteSize: z
      .number()
      .int()
      .min(1)
      .max(20 * 1024 * 1024),
    width: z.number().int().min(1).max(16384),
    height: z.number().int().min(1).max(16384),
  })
  .strict();
const providerResultSchema = assetSchema.pick({
  relativeKey: true,
  sha256: true,
});
const safeCode = z.string().regex(/^[A-Z0-9_]{1,64}$/);
const requestId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const rowSchema = reserveSchema.extend({
  id: identifier,
  claimToken: z.string().nullable(),
  status: z.enum(['RESERVED', 'SENT', 'SUCCEEDED', 'UNKNOWN', 'CANCELLED']),
  budgetDay: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  expiresAt: z.number().nullable(),
  assetJson: z.string().nullable(),
  providerResultJson: z.string().nullable(),
  providerRequestId: z.string().nullable(),
  reasonCode: z.string().nullable(),
  diagnosticJson: z.string().nullable(),
});
type Row = z.infer<typeof rowSchema>;

export type ImageCallReservation = z.infer<typeof reserveSchema>;
export type ImageAsset = z.infer<typeof assetSchema>;
export type ImageProviderResult = z.infer<typeof providerResultSchema>;
export type ImageCallStatus = Row['status'];
export interface ImageCall {
  id: string;
  ownerId: string;
  operationId: string;
  callKey: string;
  fingerprint: string;
  model: string;
  priceVersion: string;
  /** Configured CNY micros per image; an estimate, not a provider invoice. */
  priceMicros: number;
  status: ImageCallStatus;
  budgetStatus: 'HELD' | 'SETTLED' | 'RELEASED';
  budgetDay: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  asset?: ImageAsset;
  providerResult?: ImageProviderResult;
  providerRequestId?: string;
  reasonCode?: string;
  upstreamDiagnostic?: UpstreamDiagnostic;
}
export interface ImageCallLedgerOptions {
  enabled: boolean;
  /** Monetary admission only. Existing paid attempts never become resendable. */
  budgetEnforced?: boolean;
  dataDir: string;
  reservationTtlMs?: number;
  sentTtlMs?: number;
  now?: () => number;
}
export class ImageCallLedgerError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ImageCallLedgerError';
  }
}

const columns = `id, owner_id AS ownerId, operation_id AS operationId,
  call_key AS callKey, fingerprint, model, price_version AS priceVersion,
  price_micros AS priceMicros, operation_budget_micros AS operationBudgetMicros,
  daily_budget_micros AS dailyBudgetMicros, claim_token AS claimToken, status,
  budget_day AS budgetDay, created_at AS createdAt, updated_at AS updatedAt,
  expires_at AS expiresAt, asset_json AS assetJson,
  provider_result_json AS providerResultJson,
  provider_request_id AS providerRequestId, reason_code AS reasonCode,
  diagnostic_json AS diagnosticJson`;

/** Private, local, single-image admission ledger. Never stores prompts or URLs. */
export class ImageCallLedger {
  private database?: DatabaseSync;
  private closed = false;
  private readonly now: () => number;
  private readonly reservationTtlMs: number;
  private readonly sentTtlMs: number;

  constructor(private readonly options: ImageCallLedgerOptions) {
    this.now = options.now ?? Date.now;
    this.reservationTtlMs = options.reservationTtlMs ?? 60_000;
    this.sentTtlMs = options.sentTtlMs ?? 300_000;
    if (
      options.enabled &&
      (!isAbsolute(options.dataDir) ||
        !Number.isSafeInteger(this.reservationTtlMs) ||
        this.reservationTtlMs < 1 ||
        !Number.isSafeInteger(this.sentTtlMs) ||
        this.sentTtlMs < 1)
    )
      throw new ImageCallLedgerError('IMAGE_LEDGER_INVALID_CONFIG');
  }

  reserve(input: ImageCallReservation): {
    call: ImageCall;
    reused: boolean;
    claimToken?: string;
  } {
    const parsed = reserveSchema.safeParse(input);
    if (!parsed.success)
      throw new ImageCallLedgerError('IMAGE_LEDGER_INVALID_INPUT');
    const value = parsed.data;
    return this.transaction((database, now) => {
      const existing = database
        .prepare(
          `SELECT ${columns} FROM image_calls
           WHERE owner_id = ? AND operation_id = ? AND call_key = ?`,
        )
        .get(value.ownerId, value.operationId, value.callKey);
      if (existing) {
        const row = rowSchema.parse(existing);
        if (row.fingerprint !== value.fingerprint)
          throw new ImageCallLedgerError('IMAGE_CALL_CONFLICT');
        return { call: this.publicCall(row), reused: true };
      }
      const frozenBudget = database
        .prepare(
          `SELECT budget_micros AS budget FROM image_operations
           WHERE owner_id = ? AND operation_id = ?`,
        )
        .get(value.ownerId, value.operationId);
      if (frozenBudget && frozenBudget.budget !== value.operationBudgetMicros)
        throw new ImageCallLedgerError('IMAGE_OPERATION_BUDGET_CONFLICT');
      const operationUsed = this.used(
        database,
        'owner_id = ? AND operation_id = ?',
        value.ownerId,
        value.operationId,
      );
      if (
        this.options.budgetEnforced !== false &&
        operationUsed + value.priceMicros > value.operationBudgetMicros
      )
        throw new ImageCallLedgerError('IMAGE_OPERATION_BUDGET_EXCEEDED');
      const day = new Date(now).toISOString().slice(0, 10);
      if (
        this.options.budgetEnforced !== false &&
        this.used(database, 'budget_day = ?', day) + value.priceMicros >
          value.dailyBudgetMicros
      )
        throw new ImageCallLedgerError('IMAGE_DAILY_BUDGET_EXCEEDED');
      if (
        database
          .prepare(
            "SELECT id FROM image_calls WHERE status IN ('RESERVED', 'SENT') LIMIT 1",
          )
          .get()
      )
        throw new ImageCallLedgerError('IMAGE_GENERATION_BUSY');
      database
        .prepare(
          `INSERT OR IGNORE INTO image_operations (owner_id, operation_id, budget_micros)
           VALUES (?, ?, ?)`,
        )
        .run(value.ownerId, value.operationId, value.operationBudgetMicros);
      const id = randomUUID();
      const claimToken = randomUUID();
      database
        .prepare(
          `INSERT INTO image_calls
          (id, owner_id, operation_id, call_key, fingerprint, model, price_version,
           price_micros, operation_budget_micros, daily_budget_micros, claim_token,
           status, budget_day, created_at, updated_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RESERVED', ?, ?, ?, ?)`,
        )
        .run(
          id,
          value.ownerId,
          value.operationId,
          value.callKey,
          value.fingerprint,
          value.model,
          value.priceVersion,
          value.priceMicros,
          value.operationBudgetMicros,
          value.dailyBudgetMicros,
          claimToken,
          day,
          now,
          now,
          now + this.reservationTtlMs,
        );
      return {
        call: this.publicCall(this.row(database, id)),
        reused: false,
        claimToken,
      };
    });
  }

  /** Persist before any paid HTTP request. Duplicate/stale claims never send. */
  begin(callId: string, claimToken: string): ImageCall {
    return this.transaction((database, now) => {
      const row = this.claim(database, callId, claimToken, 'RESERVED');
      const day = new Date(now).toISOString().slice(0, 10);
      if (
        this.options.budgetEnforced !== false &&
        day !== row.budgetDay &&
        this.used(database, 'budget_day = ?', day) + row.priceMicros >
          row.dailyBudgetMicros
      )
        throw new ImageCallLedgerError('IMAGE_DAILY_BUDGET_EXCEEDED');
      database
        .prepare(
          `UPDATE image_calls SET status = 'SENT', budget_day = ?, updated_at = ?,
           expires_at = ? WHERE id = ? AND claim_token = ? AND status = 'RESERVED'`,
        )
        .run(day, now, now + this.sentTtlMs, callId, claimToken);
      return this.publicCall(this.row(database, callId));
    });
  }

  /** Only a fenced provider response may establish this private result reference. */
  recordProviderResult(
    callId: string,
    claimToken: string,
    reference: ImageProviderResult,
    providerRequestId?: string,
  ): ImageCall {
    const parsed = providerResultSchema.safeParse(reference);
    if (
      !parsed.success ||
      (providerRequestId !== undefined &&
        !requestId.safeParse(providerRequestId).success)
    )
      throw new ImageCallLedgerError('IMAGE_LEDGER_INVALID_INPUT');
    return this.transaction((database, now) => {
      const row = this.claim(database, callId, claimToken, 'SENT');
      const serialized = JSON.stringify(parsed.data);
      if (
        (row.providerResultJson && row.providerResultJson !== serialized) ||
        (row.providerRequestId &&
          providerRequestId &&
          row.providerRequestId !== providerRequestId)
      )
        throw new ImageCallLedgerError('IMAGE_PROVIDER_RESULT_CONFLICT');
      database
        .prepare(
          `UPDATE image_calls SET provider_result_json = ?, updated_at = ?,
           provider_request_id = COALESCE(?, provider_request_id)
           WHERE id = ? AND claim_token = ? AND status = 'SENT'`,
        )
        .run(serialized, now, providerRequestId ?? null, callId, claimToken);
      return this.publicCall(this.row(database, callId));
    });
  }

  /** Resume retrieval of a persisted result; this never authorizes generation. */
  resumeDownload(
    callId: string,
    fingerprint: string,
  ): { call: ImageCall; claimToken: string } {
    return this.transaction((database, now) => {
      const row = this.row(database, callId);
      if (row.fingerprint !== fingerprint)
        throw new ImageCallLedgerError('IMAGE_CALL_CONFLICT');
      if (row.status !== 'UNKNOWN' || !row.providerResultJson)
        throw new ImageCallLedgerError('IMAGE_DOWNLOAD_NOT_RECOVERABLE');
      // Parsing rejects any corrupted local reference before issuing a new claim.
      providerResultSchema.parse(JSON.parse(row.providerResultJson) as unknown);
      if (
        database
          .prepare(
            "SELECT id FROM image_calls WHERE status IN ('RESERVED', 'SENT') LIMIT 1",
          )
          .get()
      )
        throw new ImageCallLedgerError('IMAGE_GENERATION_BUSY');
      const claimToken = randomUUID();
      database
        .prepare(
          `UPDATE image_calls SET status = 'SENT', claim_token = ?, updated_at = ?,
           expires_at = ?, reason_code = NULL WHERE id = ? AND status = 'UNKNOWN'`,
        )
        .run(claimToken, now, now + this.sentTtlMs, callId);
      return { call: this.publicCall(this.row(database, callId)), claimToken };
    });
  }

  succeed(
    callId: string,
    claimToken: string,
    asset: ImageAsset,
    providerRequestId?: string,
  ): ImageCall {
    const parsed = assetSchema.safeParse(asset);
    if (
      !parsed.success ||
      (providerRequestId !== undefined &&
        !requestId.safeParse(providerRequestId).success)
    )
      throw new ImageCallLedgerError('IMAGE_LEDGER_INVALID_INPUT');
    return this.transaction((database, now) => {
      this.claim(database, callId, claimToken, 'SENT');
      database
        .prepare(
          `UPDATE image_calls SET status = 'SUCCEEDED', updated_at = ?, expires_at = NULL,
           claim_token = NULL, asset_json = ?, provider_result_json = NULL,
           provider_request_id = COALESCE(?, provider_request_id)
           WHERE id = ? AND claim_token = ? AND status = 'SENT'`,
        )
        .run(
          now,
          JSON.stringify(parsed.data),
          providerRequestId ?? null,
          callId,
          claimToken,
        );
      return this.publicCall(this.row(database, callId));
    });
  }

  /** Outcome uncertain: retain the entire reservation, with no automatic resend. */
  markUnknown(
    callId: string,
    claimToken: string,
    reasonCode: string,
    diagnostic?: UpstreamDiagnostic,
  ): ImageCall {
    if (!safeCode.safeParse(reasonCode).success)
      throw new ImageCallLedgerError('IMAGE_LEDGER_INVALID_INPUT');
    const safeDiagnostic = sanitizeUpstreamDiagnostic(diagnostic);
    return this.transaction((database, now) => {
      this.claim(database, callId, claimToken, 'SENT');
      database
        .prepare(
          `UPDATE image_calls SET status = 'UNKNOWN', updated_at = ?, expires_at = NULL,
           claim_token = NULL, reason_code = ?, diagnostic_json = ?
           WHERE id = ? AND claim_token = ? AND status = 'SENT'`,
        )
        .run(
          now,
          reasonCode,
          safeDiagnostic ? JSON.stringify(safeDiagnostic) : null,
          callId,
          claimToken,
        );
      return this.publicCall(this.row(database, callId));
    });
  }

  get(callId: string): ImageCall | undefined {
    return this.transaction((database) => {
      const row = database
        .prepare(`SELECT ${columns} FROM image_calls WHERE id = ?`)
        .get(callId);
      return row ? this.publicCall(rowSchema.parse(row)) : undefined;
    });
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
    this.closed = true;
  }

  onModuleDestroy(): void {
    this.close();
  }

  private open(): DatabaseSync {
    if (!this.options.enabled)
      throw new ImageCallLedgerError('IMAGE_GENERATION_DISABLED');
    if (this.closed) throw new ImageCallLedgerError('IMAGE_LEDGER_CLOSED');
    if (!this.database) {
      mkdirSync(this.options.dataDir, { recursive: true, mode: 0o700 });
      const database = new DatabaseSync(
        join(this.options.dataDir, 'image-calls.sqlite3'),
      );
      try {
        database.exec(`
          PRAGMA busy_timeout = 5000;
          PRAGMA journal_mode = WAL;
          PRAGMA synchronous = FULL;
          CREATE TABLE IF NOT EXISTS image_operations (
            owner_id TEXT NOT NULL, operation_id TEXT NOT NULL,
            budget_micros INTEGER NOT NULL CHECK (budget_micros > 0),
            PRIMARY KEY (owner_id, operation_id)
          );
          CREATE TABLE IF NOT EXISTS image_calls (
            id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, operation_id TEXT NOT NULL,
            call_key TEXT NOT NULL, fingerprint TEXT NOT NULL, model TEXT NOT NULL,
            price_version TEXT NOT NULL, price_micros INTEGER NOT NULL CHECK (price_micros > 0),
            operation_budget_micros INTEGER NOT NULL, daily_budget_micros INTEGER NOT NULL,
            claim_token TEXT, status TEXT NOT NULL CHECK
              (status IN ('RESERVED', 'SENT', 'SUCCEEDED', 'UNKNOWN', 'CANCELLED')),
            budget_day TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            expires_at INTEGER, asset_json TEXT, provider_result_json TEXT,
            provider_request_id TEXT, reason_code TEXT, diagnostic_json TEXT,
            UNIQUE (owner_id, operation_id, call_key)
          );
          CREATE INDEX IF NOT EXISTS image_calls_day ON image_calls (budget_day);
        `);
        // This private local ledger predates persisted result references. Upgrade
        // an existing file atomically; concurrent openers recheck under the lock.
        database.exec('BEGIN IMMEDIATE');
        try {
          const fields = database
            .prepare('PRAGMA table_info(image_calls)')
            .all();
          if (!fields.some((field) => field.name === 'provider_result_json'))
            database.exec(
              'ALTER TABLE image_calls ADD COLUMN provider_result_json TEXT',
            );
          if (!fields.some((field) => field.name === 'diagnostic_json'))
            database.exec(
              'ALTER TABLE image_calls ADD COLUMN diagnostic_json TEXT',
            );
          database.exec('COMMIT');
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
        this.database = database;
      } catch (error) {
        database.close();
        throw error;
      }
    }
    return this.database;
  }

  private transaction<T>(body: (database: DatabaseSync, now: number) => T): T {
    let database: DatabaseSync | undefined;
    let started = false;
    try {
      database = this.open();
      database.exec('BEGIN IMMEDIATE');
      started = true;
      const now = this.now();
      if (!Number.isSafeInteger(now) || now < 0)
        throw new ImageCallLedgerError('IMAGE_LEDGER_INVALID_CLOCK');
      // Recovery is committed even when a subsequent stale claim is rejected.
      database
        .prepare(
          `UPDATE image_calls SET status = 'CANCELLED', claim_token = NULL,
        expires_at = NULL, updated_at = ?, reason_code = 'IMAGE_RESERVATION_EXPIRED'
        WHERE status = 'RESERVED' AND expires_at <= ?`,
        )
        .run(now, now);
      database
        .prepare(
          `UPDATE image_calls SET status = 'UNKNOWN', claim_token = NULL,
        expires_at = NULL, updated_at = ?, reason_code = 'IMAGE_SENT_EXPIRED'
        WHERE status = 'SENT' AND expires_at <= ?`,
        )
        .run(now, now);
      database.exec('COMMIT');
      started = false;
      database.exec('BEGIN IMMEDIATE');
      started = true;
      const result = body(database, now);
      database.exec('COMMIT');
      started = false;
      return result;
    } catch (error) {
      if (started) {
        try {
          database?.exec('ROLLBACK');
        } catch {
          /* Safe failure code below. */
        }
      }
      if (error instanceof ImageCallLedgerError) throw error;
      throw new ImageCallLedgerError('IMAGE_LEDGER_STORAGE_ERROR');
    }
  }

  private used(
    database: DatabaseSync,
    where: string,
    ...bindings: string[]
  ): number {
    const value = database
      .prepare(
        `SELECT COALESCE(SUM(price_micros), 0) AS used
      FROM image_calls WHERE status != 'CANCELLED' AND ${where}`,
      )
      .get(...bindings);
    return Number(value?.used ?? 0);
  }

  private row(database: DatabaseSync, id: string): Row {
    const value = database
      .prepare(`SELECT ${columns} FROM image_calls WHERE id = ?`)
      .get(id);
    if (!value) throw new ImageCallLedgerError('IMAGE_CALL_NOT_FOUND');
    return rowSchema.parse(value);
  }

  private claim(
    database: DatabaseSync,
    id: string,
    token: string,
    status: ImageCallStatus,
  ): Row {
    const row = this.row(database, id);
    if (row.claimToken !== token || row.status !== status)
      throw new ImageCallLedgerError('IMAGE_CALL_STALE_CLAIM');
    return row;
  }

  private publicCall(row: Row): ImageCall {
    const diagnostic = row.diagnosticJson
      ? sanitizeUpstreamDiagnostic(JSON.parse(row.diagnosticJson) as unknown)
      : undefined;
    return {
      id: row.id,
      ownerId: row.ownerId,
      operationId: row.operationId,
      callKey: row.callKey,
      fingerprint: row.fingerprint,
      model: row.model,
      priceVersion: row.priceVersion,
      priceMicros: row.priceMicros,
      status: row.status,
      budgetStatus:
        row.status === 'SUCCEEDED'
          ? 'SETTLED'
          : row.status === 'CANCELLED'
            ? 'RELEASED'
            : 'HELD',
      budgetDay: row.budgetDay,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.expiresAt === null ? {} : { expiresAt: row.expiresAt }),
      ...(row.assetJson
        ? { asset: assetSchema.parse(JSON.parse(row.assetJson) as unknown) }
        : {}),
      ...(row.providerResultJson
        ? {
            providerResult: providerResultSchema.parse(
              JSON.parse(row.providerResultJson) as unknown,
            ),
          }
        : {}),
      ...(row.providerRequestId
        ? { providerRequestId: row.providerRequestId }
        : {}),
      ...(row.reasonCode ? { reasonCode: row.reasonCode } : {}),
      ...(diagnostic ? { upstreamDiagnostic: diagnostic } : {}),
    };
  }
}
