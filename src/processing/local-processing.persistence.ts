import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve, parse } from 'node:path';
import { homedir } from 'node:os';
import { acquireSqliteFileLock } from './sqlite-file-lock.js';
import { atomicRename } from './atomic-rename.js';
import {
  assertInlineReviewParent,
  inlineReviewParentId,
  inlineVisualReviewOperation,
} from './inline-visual-review.js';
import type { ModelDailyBudget } from './model-call.types.js';
import {
  ProcessingError,
  type ProcessingArtifact,
  type ProcessingBook,
  type ProcessingPersistence,
  type ProcessingRun,
  type RunMutation,
} from './processing.types.js';

interface LocalState {
  version: 1;
  books: Record<string, ProcessingBook>;
  runs: Record<string, ProcessingRun>;
  artifacts: Record<string, ProcessingArtifact>;
  modelDailyBudgets: Record<string, ModelDailyBudget>;
}
const emptyState = (): LocalState => ({
  version: 1,
  books: {},
  runs: {},
  artifacts: {},
  modelDailyBudgets: {},
});
const missing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === 'ENOENT';

interface LocalLimits {
  maxRuns: number;
  ownerActiveLimit: number;
  ownerBookLimit?: number;
  maxActiveRuns?: number;
  maxSourceBytes?: number;
  retentionMs?: number;
}

/** Development only: bounded single-machine store; no network filesystem support. */
export class LocalProcessingPersistence implements ProcessingPersistence {
  readonly directory: string;
  private readonly statePath: string;
  private ready?: Promise<void>;

  constructor(
    dataDirectory: string,
    private readonly limits: LocalLimits = {
      maxRuns: 1000,
      ownerActiveLimit: 1,
    },
  ) {
    const target = resolve(dataDirectory);
    if (
      !isAbsolute(dataDirectory) ||
      [parse(target).root, homedir(), process.cwd()].some(
        (value) => value.toLowerCase() === target.toLowerCase(),
      )
    )
      throw new ProcessingError('UNSAFE_PROCESSING_DIRECTORY', 500);
    this.directory = join(target, 'metadata');
    this.statePath = join(this.directory, 'state.json');
  }

  initialize(): Promise<void> {
    this.ready ??= this.prepare();
    return this.ready;
  }

  async createBook(book: ProcessingBook): Promise<void> {
    await this.change((state) => {
      if (Object.keys(state.books).length >= this.limits.maxRuns)
        throw new ProcessingError('PROCESSING_CAPACITY_EXCEEDED', 429);
      const books = Object.values(state.books);
      if (
        this.limits.ownerBookLimit &&
        books.filter(
          (value) => value.ownerId === book.ownerId && !value.deletedAt,
        ).length >= this.limits.ownerBookLimit
      )
        throw new ProcessingError('OWNER_BOOK_LIMIT', 429);
      if (
        this.limits.maxSourceBytes &&
        books.reduce((sum, value) => sum + value.byteSize, book.byteSize) >
          this.limits.maxSourceBytes
      )
        throw new ProcessingError('STORAGE_CAPACITY_EXCEEDED', 507);
      state.books[book.id] = book;
    });
  }

  async getBook(id: string): Promise<ProcessingBook | null> {
    const book = (await this.read()).books[id];
    return book && !this.expired(book) ? book : null;
  }
  async getRun(id: string): Promise<ProcessingRun | null> {
    return (await this.read()).runs[id] ?? null;
  }
  async findRunByKey(
    ownerId: string,
    operation: string,
    idempotencyKey: string,
  ): Promise<ProcessingRun | null> {
    return (
      Object.values((await this.read()).runs).find(
        (run) =>
          run.ownerId === ownerId &&
          run.operation === operation &&
          run.idempotencyKey === idempotencyKey,
      ) ?? null
    );
  }
  async getArtifact(id: string): Promise<ProcessingArtifact | null> {
    return (await this.read()).artifacts[id] ?? null;
  }

  async createRun(
    run: ProcessingRun,
  ): Promise<{ run: ProcessingRun; reused: boolean }> {
    return this.change((state) => {
      const previous = Object.values(state.runs).find(
        (value) =>
          value.ownerId === run.ownerId &&
          value.operation === run.operation &&
          value.idempotencyKey === run.idempotencyKey,
      );
      if (previous) {
        if (previous.requestHash !== run.requestHash)
          throw new ProcessingError('IDEMPOTENCY_CONFLICT');
        return { run: previous, reused: true };
      }
      const book = state.books[run.bookId];
      if (
        !book ||
        book.deletedAt ||
        this.expired(book) ||
        book.ownerId !== run.ownerId
      )
        throw new ProcessingError('BOOK_NOT_FOUND', 404);
      const runs = Object.values(state.runs);
      const parentId = inlineReviewParentId(run);
      if (parentId) assertInlineReviewParent(run, state.runs[parentId]);
      const ownerActive = runs.filter(
        (value) =>
          value.ownerId === run.ownerId &&
          (value.status === 'QUEUED' || value.status === 'RUNNING'),
      );
      if (
        runs.length >= this.limits.maxRuns ||
        (this.limits.maxActiveRuns &&
          runs.filter((value) => ['QUEUED', 'RUNNING'].includes(value.status))
            .length >= this.limits.maxActiveRuns) ||
        (parentId
          ? ownerActive.some(
              (value) => value.operation === inlineVisualReviewOperation,
            )
          : ownerActive.length >= this.limits.ownerActiveLimit)
      )
        throw new ProcessingError('PROCESSING_CAPACITY_EXCEEDED', 429);
      state.runs[run.id] = run;
      return { run, reused: false };
    });
  }

  async mutateRun<T>(
    id: string,
    change: (
      run: ProcessingRun,
      book: ProcessingBook,
      dailyBudgets: Record<string, ModelDailyBudget>,
    ) => { result: T; mutation?: RunMutation },
  ): Promise<T | null> {
    return this.change((state) => {
      const run = state.runs[id];
      if (!run) return null;
      const book = state.books[run.bookId];
      if (!book) throw new ProcessingError('PROCESSING_STATE_INVALID', 503);
      const outcome = change(
        structuredClone(run),
        structuredClone(book),
        structuredClone(state.modelDailyBudgets),
      );
      if (outcome.mutation) {
        state.runs[id] = outcome.mutation.run;
        for (const artifact of outcome.mutation.artifacts ?? [])
          state.artifacts[artifact.id] = artifact;
        for (const budget of outcome.mutation.dailyBudgets ?? [])
          state.modelDailyBudgets[budget.day] = budget;
      }
      return outcome.result;
    });
  }

  async listActive(limit: number): Promise<ProcessingRun[]> {
    return Object.values((await this.read()).runs)
      .filter((run) => run.status === 'QUEUED' || run.status === 'RUNNING')
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .slice(0, limit);
  }

  /** Exactly one local worker process may execute at a time. */
  async acquireWorkerLock(): Promise<() => Promise<void>> {
    await this.initialize();
    try {
      return await this.lock('worker', 0);
    } catch {
      throw new ProcessingError('LOCAL_WORKER_ALREADY_RUNNING', 503);
    }
  }

  async close(): Promise<void> {
    /* Per-operation descriptors are closed immediately. */
  }

  /** Public-beta-only expiry. Removing metadata atomically fences active leases
   * before any private file is unlinked. No model records are ever replayed. */
  async pruneExpired(now = Date.now()): Promise<{
    sourceKeys: string[];
    runIds: string[];
    liveSourceKeys: string[];
    liveRunIds: string[];
  }> {
    if (!this.limits.retentionMs)
      return { sourceKeys: [], runIds: [], liveSourceKeys: [], liveRunIds: [] };
    return this.change((state) => {
      const expired = new Set(
        Object.values(state.books)
          .filter((book) => this.expired(book, now))
          .map((book) => book.id),
      );
      const sourceKeys = Object.values(state.books)
        .filter((book) => expired.has(book.id))
        .map((book) => book.sourceKey);
      const runIds = Object.values(state.runs)
        .filter((run) => expired.has(run.bookId))
        .map((run) => run.id);
      for (const id of expired) delete state.books[id];
      for (const id of runIds) delete state.runs[id];
      for (const artifact of Object.values(state.artifacts))
        if (expired.has(artifact.bookId)) delete state.artifacts[artifact.id];
      return {
        sourceKeys,
        runIds,
        liveSourceKeys: Object.values(state.books).map(
          (book) => book.sourceKey,
        ),
        liveRunIds: Object.keys(state.runs),
      };
    });
  }

  private expired(book: ProcessingBook, now = Date.now()): boolean {
    return Boolean(
      this.limits.retentionMs &&
      Date.parse(book.createdAt) + this.limits.retentionMs <= now,
    );
  }

  private async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const marker = await open(
      join(this.directory, '.epub-ai-metadata-v1'),
      'a',
      0o600,
    );
    await marker.close();
    const release = await this.lock('state');
    try {
      try {
        await stat(this.statePath);
      } catch (error) {
        if (!missing(error)) throw error;
        await this.write(emptyState());
      }
      if (this.limits.retentionMs) {
        const betaMarker = join(this.directory, '.epub-public-beta-v1');
        try {
          await stat(betaMarker);
        } catch (error) {
          if (!missing(error)) throw error;
          const existing = await this.readUnsafe();
          if (
            Object.keys(existing.books).length ||
            Object.keys(existing.runs).length ||
            Object.keys(existing.artifacts).length ||
            Object.keys(existing.modelDailyBudgets).length
          )
            throw new ProcessingError(
              'PUBLIC_BETA_REQUIRES_EMPTY_DIRECTORY',
              503,
            );
          const beta = await open(betaMarker, 'wx', 0o600);
          await beta.close();
        }
      }
    } finally {
      await release();
    }
  }

  private async read(): Promise<LocalState> {
    await this.initialize();
    return this.readUnsafe();
  }

  private async readUnsafe(): Promise<LocalState> {
    try {
      const data = JSON.parse(
        await readFile(this.statePath, 'utf8'),
      ) as LocalState;
      if (data.version !== 1 || !data.books || !data.runs || !data.artifacts)
        throw new Error('Invalid state');
      data.modelDailyBudgets ??= {};
      return data;
    } catch {
      throw new ProcessingError('PROCESSING_STATE_UNAVAILABLE', 503);
    }
  }

  private async change<T>(change: (state: LocalState) => T): Promise<T> {
    await this.initialize();
    const release = await this.lock('state');
    try {
      const state = await this.readUnsafe();
      const result = change(state);
      await this.write(state);
      return structuredClone(result);
    } finally {
      await release();
    }
  }

  private async write(state: LocalState): Promise<void> {
    const temporary = join(this.directory, `.state-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(state));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await atomicRename(temporary, this.statePath);
      // Directory fsync is supported on POSIX; Windows rename remains atomic.
      if (process.platform !== 'win32') {
        const directory = await open(this.directory, 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } catch (error) {
      // Preserve the real write/rename failure if temporary cleanup also fails.
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    await rm(temporary, { force: true });
  }

  private async lock(
    name: string,
    timeoutMs = 5000,
  ): Promise<() => Promise<void>> {
    try {
      return await acquireSqliteFileLock(
        join(this.directory, `${name}-lock.sqlite`),
        timeoutMs,
      );
    } catch {
      throw new ProcessingError('PROCESSING_LOCK_UNAVAILABLE', 503);
    }
  }
}
