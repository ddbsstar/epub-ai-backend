import type { PrismaClient, Prisma } from '../generated/prisma/client.js';
import type { ModelDailyBudget } from './model-call.types.js';
import {
  assertInlineReviewParent,
  inlineReviewParentId,
  inlineVisualReviewOperation,
} from './inline-visual-review.js';
import {
  ProcessingError,
  type ProcessingArtifact,
  type ProcessingBook,
  type ProcessingPersistence,
  type ProcessingRun,
  type RunMutation,
} from './processing.types.js';

const json = (value: object) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const record = <T>(value: unknown): T => structuredClone(value) as T;

/** Requires reviewed migrations applied explicitly by the operator. */
export class PrismaProcessingPersistence implements ProcessingPersistence {
  constructor(
    private readonly client: PrismaClient,
    private readonly limits = { maxRuns: 1000, ownerActiveLimit: 1 },
  ) {}

  async createBook(book: ProcessingBook): Promise<void> {
    await this.transaction(async (transaction) => {
      await this.admission(transaction);
      if ((await transaction.processingBook.count()) >= this.limits.maxRuns)
        throw new ProcessingError('PROCESSING_CAPACITY_EXCEEDED', 429);
      await transaction.processingBook.create({
        data: {
          id: book.id,
          ownerId: book.ownerId,
          record: json(book),
          createdAt: new Date(book.createdAt),
        },
      });
    });
  }
  async getBook(id: string): Promise<ProcessingBook | null> {
    const row = await this.client.processingBook.findUnique({ where: { id } });
    return row
      ? {
          ...record<ProcessingBook>(row.record),
          deletedAt: row.deletedAt?.toISOString() ?? null,
        }
      : null;
  }
  async getRun(id: string): Promise<ProcessingRun | null> {
    const row = await this.client.processingRun.findUnique({ where: { id } });
    return row ? record<ProcessingRun>(row.record) : null;
  }
  async findRunByKey(
    ownerId: string,
    operation: string,
    idempotencyKey: string,
  ): Promise<ProcessingRun | null> {
    const row = await this.client.processingRun.findUnique({
      where: {
        ownerId_operation_idempotencyKey: {
          ownerId,
          operation,
          idempotencyKey,
        },
      },
    });
    return row ? record<ProcessingRun>(row.record) : null;
  }
  async getArtifact(id: string): Promise<ProcessingArtifact | null> {
    const row = await this.client.processingArtifact.findUnique({
      where: { id },
    });
    return row ? record<ProcessingArtifact>(row.record) : null;
  }
  async createRun(
    run: ProcessingRun,
  ): Promise<{ run: ProcessingRun; reused: boolean }> {
    return this.transaction(async (transaction) => {
      await this.admission(transaction);
      const existing = await transaction.processingRun.findUnique({
        where: {
          ownerId_operation_idempotencyKey: {
            ownerId: run.ownerId,
            operation: run.operation,
            idempotencyKey: run.idempotencyKey,
          },
        },
      });
      if (existing) {
        const prior = record<ProcessingRun>(existing.record);
        if (prior.requestHash !== run.requestHash)
          throw new ProcessingError('IDEMPOTENCY_CONFLICT');
        return { run: prior, reused: true };
      }
      await transaction.$queryRaw`SELECT id FROM processing_books WHERE id = ${run.bookId} FOR UPDATE`;
      const book = await transaction.processingBook.findUnique({
        where: { id: run.bookId },
      });
      if (!book || book.ownerId !== run.ownerId || book.deletedAt)
        throw new ProcessingError('BOOK_NOT_FOUND', 404);
      const total = await transaction.processingRun.count();
      const parentId = inlineReviewParentId(run);
      if (parentId) {
        const parent = await transaction.processingRun.findUnique({
          where: { id: parentId },
        });
        assertInlineReviewParent(
          run,
          parent ? record<ProcessingRun>(parent.record) : null,
        );
      }
      const active = await transaction.processingRun.count({
        where: {
          ownerId: run.ownerId,
          status: { in: ['QUEUED', 'RUNNING'] },
          ...(parentId ? { operation: inlineVisualReviewOperation } : {}),
        },
      });
      if (
        total >= this.limits.maxRuns ||
        active >= (parentId ? 1 : this.limits.ownerActiveLimit)
      )
        throw new ProcessingError('PROCESSING_CAPACITY_EXCEEDED', 429);
      await transaction.processingRun.create({
        data: {
          id: run.id,
          ownerId: run.ownerId,
          bookId: run.bookId,
          operation: run.operation,
          idempotencyKey: run.idempotencyKey,
          status: run.status,
          record: json(run),
          createdAt: new Date(run.createdAt),
          updatedAt: new Date(run.updatedAt),
        },
      });
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
    options: { budgetDay?: string } = {},
  ): Promise<T | null> {
    return this.transaction(async (transaction) => {
      // Shared ordering: global admission -> run -> book -> daily aggregate.
      // Reservation and settlement must serialize with other runs' budgets.
      await this.admission(transaction);
      await transaction.$queryRaw`SELECT id FROM processing_runs WHERE id = ${id} FOR UPDATE`;
      const row = await transaction.processingRun.findUnique({ where: { id } });
      if (!row) return null;
      // Publication and future deletion must take this same book lock.
      await transaction.$queryRaw`SELECT id FROM processing_books WHERE id = ${row.bookId} FOR UPDATE`;
      const bookRow = await transaction.processingBook.findUnique({
        where: { id: row.bookId },
      });
      if (!bookRow) throw new ProcessingError('PROCESSING_STATE_INVALID', 503);
      const book = record<ProcessingBook>(bookRow.record);
      book.deletedAt = bookRow.deletedAt?.toISOString() ?? null;
      const runRecord = record<ProcessingRun>(row.record);
      const days = [
        ...new Set([options.budgetDay, runRecord.modelCall?.budgetDay]),
      ].filter((day): day is string => Boolean(day));
      const dailyBudgets: Record<string, ModelDailyBudget> = {};
      for (const day of days) {
        const budgetRow =
          await transaction.processingModelDailyBudget.findUnique({
            where: { day },
          });
        if (budgetRow)
          dailyBudgets[day] = record<ModelDailyBudget>(budgetRow.record);
      }
      const outcome = change(runRecord, book, dailyBudgets);
      if (outcome.mutation) {
        const run = outcome.mutation.run;
        await transaction.processingRun.update({
          where: { id },
          data: {
            status: run.status,
            record: json(run),
            updatedAt: new Date(run.updatedAt),
          },
        });
        for (const artifact of outcome.mutation.artifacts ?? [])
          await transaction.processingArtifact.create({
            data: {
              id: artifact.id,
              ownerId: artifact.ownerId,
              runId: artifact.runId,
              bookId: artifact.bookId,
              record: json(artifact),
              createdAt: new Date(artifact.createdAt),
            },
          });
        for (const budget of outcome.mutation.dailyBudgets ?? [])
          await transaction.processingModelDailyBudget.upsert({
            where: { day: budget.day },
            create: { day: budget.day, record: json(budget) },
            update: { record: json(budget) },
          });
      }
      return outcome.result;
    });
  }
  async listActive(limit: number): Promise<ProcessingRun[]> {
    return (
      await this.client.processingRun.findMany({
        where: { status: { in: ['QUEUED', 'RUNNING'] } },
        orderBy: { updatedAt: 'asc' },
        take: limit,
      })
    ).map((row) => record<ProcessingRun>(row.record));
  }
  async close(): Promise<void> {
    /* DatabaseService owns this shared client. */
  }
  private transaction<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    // A book lock may be acquired after a run read. READ COMMITTED ensures the
    // subsequent availability check sees the state protected by that lock,
    // rather than an earlier repeatable-read snapshot.
    return this.client.$transaction(operation, {
      isolationLevel: 'ReadCommitted',
    });
  }
  private async admission(
    transaction: Prisma.TransactionClient,
  ): Promise<void> {
    const rows = await transaction.$queryRaw<
      { id: string }[]
    >`SELECT id FROM processing_admission_locks WHERE id = 'global' FOR UPDATE`;
    if (rows.length !== 1)
      throw new ProcessingError('PROCESSING_SCHEMA_NOT_READY', 503);
  }
}
