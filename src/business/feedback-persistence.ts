import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { z } from 'zod';
import { acquireSqliteFileLock } from '../processing/sqlite-file-lock.js';
import { atomicRename } from '../processing/atomic-rename.js';
import { businessError } from './business-errors.js';

export const FEEDBACK_RETENTION_HOURS = 24;
const RETENTION_MS = FEEDBACK_RETENTION_HOURS * 60 * 60 * 1000;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
export const feedbackInputSchema = z
  .object({
    category: z.enum(['typography', 'processing', 'download', 'other']),
    reader: z.enum([
      'kindle',
      'apple-books',
      'kobo',
      'calibre',
      'other',
      'not-tested',
    ]),
    deliveryRoute: z.enum([
      'send-to-kindle',
      'usb',
      'reader-import',
      'not-tested',
      'other',
    ]),
    rating: z.enum(['better', 'same', 'worse']).optional(),
    requestId: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,128}$/u)
      .optional(),
    description: z.string().trim().max(1000).optional(),
  })
  .strict();
export type FeedbackInput = z.infer<typeof feedbackInputSchema>;
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const recordSchema = z
  .object({
    receiptId: z.uuid(),
    ownerScope: z.string().regex(/^[a-f0-9]{64}$/u),
    keyHash: z.string().regex(/^[a-f0-9]{64}$/u),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    payload: feedbackInputSchema,
  })
  .strict();
const stateSchema = z
  .object({ version: z.literal(1), records: z.array(recordSchema).max(500) })
  .strict();
type FeedbackState = z.infer<typeof stateSchema>;
export type FeedbackReceipt = { receiptId: string; expiresAt: string };
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Bounded local-disk feedback only. Never reads book metadata or sends feedback elsewhere. */
export class LocalFeedbackPersistence {
  readonly directory: string;
  private readonly statePath: string;
  constructor(
    dataDirectory: string,
    private readonly clock: () => number = Date.now,
    private readonly limits = { owner: 5, global: 500 },
  ) {
    const root = resolve(dataDirectory);
    if (
      !isAbsolute(dataDirectory) ||
      [parse(root).root, homedir(), process.cwd()].some(
        (value) => value.toLowerCase() === root.toLowerCase(),
      )
    )
      throw businessError('FEEDBACK_UNAVAILABLE', 503);
    this.directory = join(root, 'feedback');
    this.statePath = join(this.directory, 'state.json');
    if (
      !Number.isSafeInteger(limits.owner) ||
      limits.owner < 1 ||
      limits.owner > 5 ||
      !Number.isSafeInteger(limits.global) ||
      limits.global < 1 ||
      limits.global > 500
    )
      throw businessError('FEEDBACK_UNAVAILABLE', 503);
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.transaction(true, (state) => ({
      value: undefined,
      changed: state.records.length === 0,
    }));
  }

  async submit(
    ownerId: string,
    key: string,
    input: unknown,
    ensureCapacity: () => Promise<void> = async () => undefined,
  ): Promise<FeedbackReceipt> {
    const parsed = feedbackInputSchema.safeParse(input);
    if (!parsed.success || Buffer.byteLength(JSON.stringify(input)) > 8192)
      throw businessError('INVALID_FEEDBACK');
    if (!/^[a-f0-9]{64}$/u.test(ownerId))
      throw businessError('FEEDBACK_UNAVAILABLE', 503);
    if (!z.uuid().safeParse(key).success)
      throw businessError('INVALID_IDEMPOTENCY_KEY');
    const payload = parsed.data;
    const ownerScope = hash('feedback-owner-v1:' + ownerId);
    const keyHash = hash(ownerScope + ':' + key);
    const payloadHash = hash(JSON.stringify(payload));
    return this.transaction(true, async (state) => {
      const old = state.records.find(
        (record) =>
          record.ownerScope === ownerScope && record.keyHash === keyHash,
      );
      if (old) {
        if (old.payloadHash !== payloadHash)
          throw businessError('IDEMPOTENCY_CONFLICT', 409);
        return {
          value: { receiptId: old.receiptId, expiresAt: old.expiresAt },
          changed: false,
        };
      }
      if (
        state.records.filter((record) => record.ownerScope === ownerScope)
          .length >= this.limits.owner
      )
        throw businessError('FEEDBACK_OWNER_LIMIT', 429);
      if (state.records.length >= this.limits.global)
        throw businessError('FEEDBACK_CAPACITY_EXCEEDED', 429);
      await ensureCapacity();
      const now = this.clock();
      const receipt = {
        receiptId: randomUUID(),
        expiresAt: new Date(now + RETENTION_MS).toISOString(),
      };
      state.records.push({
        ...receipt,
        ownerScope,
        keyHash,
        payloadHash,
        createdAt: new Date(now).toISOString(),
        payload,
      });
      return { value: receipt, changed: true };
    });
  }

  /** Operator-only local API; no controller exposes records or receipt lookup. */
  async readForOperator() {
    return this.transaction(false, (state) => ({
      value: structuredClone(state.records),
      changed: false,
    }));
  }
  async prune(): Promise<void> {
    await this.transaction(false, () => ({ value: undefined, changed: false }));
  }

  private async transaction<T>(
    create: boolean,
    operation: (
      state: FeedbackState,
    ) =>
      { value: T; changed: boolean } | Promise<{ value: T; changed: boolean }>,
  ): Promise<T> {
    if (create) await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.directory).catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
    if (!directory) return (await operation({ version: 1, records: [] })).value;
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw businessError('FEEDBACK_UNAVAILABLE', 503);
    const lockPath = join(this.directory, 'state.lock.sqlite');
    const lockStat = await lstat(lockPath).catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
    if (lockStat && (!lockStat.isFile() || lockStat.isSymbolicLink()))
      throw businessError('FEEDBACK_UNAVAILABLE', 503);
    const release = await acquireSqliteFileLock(lockPath);
    try {
      const entries = await readdir(this.directory, { withFileTypes: true });
      if (entries.length > 1000)
        throw businessError('FEEDBACK_UNAVAILABLE', 503);
      // Holding the same OS lock proves any leftover write temporary is from a
      // dead/failed writer. Remove only fixed-format temporaries, never a live lock.
      for (const entry of entries)
        if (
          /^\.state-[a-f0-9-]{36}\.tmp$/u.test(entry.name) &&
          !entry.isDirectory()
        )
          await rm(join(this.directory, entry.name), { force: true });
      const stat = await lstat(this.statePath).catch((error: unknown) => {
        if (missing(error)) return null;
        throw error;
      });
      if (
        stat &&
        (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES)
      )
        throw businessError('FEEDBACK_UNAVAILABLE', 503);
      const state: FeedbackState = stat
        ? stateSchema.parse(JSON.parse(await readFile(this.statePath, 'utf8')))
        : { version: 1, records: [] };
      const now = this.clock();
      const size = state.records.length;
      state.records = state.records.filter(
        (record) =>
          Date.parse(record.expiresAt) > now &&
          Date.parse(record.createdAt) + RETENTION_MS > now,
      );
      const pruned = state.records.length !== size;
      // Expiry cleanup is persisted even when a later admission is rejected.
      if (pruned) await this.write(state);
      const result = await operation(state);
      if (result.changed || (!stat && create)) await this.write(state);
      return result.value;
    } finally {
      await release();
    }
  }

  private async write(state: FeedbackState) {
    const data = JSON.stringify(state);
    if (Buffer.byteLength(data) > MAX_STATE_BYTES)
      throw businessError('FEEDBACK_CAPACITY_EXCEEDED', 429);
    const temporary = join(this.directory, `.state-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(data);
        await file.sync();
      } finally {
        await file.close();
      }
      await atomicRename(temporary, this.statePath);
      if (process.platform !== 'win32') {
        const directory = await open(this.directory, 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
