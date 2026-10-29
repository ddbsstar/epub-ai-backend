import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalProcessingPersistence } from '../src/processing/local-processing.persistence.js';
import { ProcessingRepository } from '../src/processing/processing.repository.js';
import { acquireSqliteFileLock } from '../src/processing/sqlite-file-lock.js';
import type {
  ModelCallReservation,
  ModelDailyBudget,
} from '../src/processing/model-call.types.js';
import type {
  ClaimedStep,
  ProcessingBook,
} from '../src/processing/processing.types.js';

describe('persisted paid-call ledger and UTC daily admission', () => {
  let directory: string;
  let repository: ProcessingRepository;
  let persistence: LocalProcessingPersistence;
  let now: number;
  let book: ProcessingBook;
  let sequence: number;
  const reservation: ModelCallReservation = {
    fingerprint: 'b'.repeat(64),
    sourceHash: 'a'.repeat(64),
    sampleHash: 'c'.repeat(64),
    promptVersion: 'structure-v1',
    model: 'qwen-test',
    schemaVersion: '1',
    inputTokenUpperBound: 2000,
    maxOutputTokens: 1000,
    reservedMicros: 100,
    budgetMicros: 100,
    dailyBudgetMicros: 150,
    priceVersion: 'test-price-v1',
  };
  const completion = {
    resultKey: 'runs/private/plan.json',
    resultHash: 'd'.repeat(64),
    resultByteSize: 50,
    usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
    estimatedCostMicros: 20,
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'epub-model-ledger-'));
    now = Date.parse('2026-10-21T12:00:00Z');
    sequence = 0;
    persistence = new LocalProcessingPersistence(directory, {
      maxRuns: 100,
      ownerActiveLimit: 10,
    });
    repository = new ProcessingRepository(persistence, () => now);
    book = await repository.createBook({
      ownerId: 'owner-a',
      sourceKey: 'sources/test.epub',
      sourceHash: 'a'.repeat(64),
      byteSize: 1000,
      originalName: 'test.epub',
    });
  });
  afterEach(async () => {
    await repository.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function claim(): Promise<ClaimedStep> {
    const { run } = await repository.createRun({
      ownerId: book.ownerId,
      bookId: book.id,
      operation: 'beautify',
      idempotencyKey: `run-${++sequence}`,
      requestHash: 'f'.repeat(64),
      configuration: {},
      stages: ['analyze', 'publish'],
    });
    return (await repository.claim(
      {
        payloadVersion: 1,
        runId: run.id,
        stepId: run.steps[0].id,
        dispatchGeneration: 1,
      },
      'worker-a',
      30000,
    ))!;
  }
  async function budgets(): Promise<Record<string, ModelDailyBudget>> {
    const data = JSON.parse(
      await readFile(join(directory, 'metadata', 'state.json'), 'utf8'),
    ) as { modelDailyBudgets: Record<string, ModelDailyBudget> };
    return data.modelDailyBudgets;
  }
  async function recover(claimed: ClaimedStep): Promise<ClaimedStep> {
    now += 30001;
    await repository.recoverExpired();
    const run = await repository.getRun(book.ownerId, claimed.run.id);
    return (await repository.claim(
      {
        payloadVersion: 1,
        runId: run.id,
        stepId: run.steps[0].id,
        dispatchGeneration: run.steps[0].dispatchGeneration,
      },
      'worker-b',
      30000,
    ))!;
  }

  async function inlineReview(parentRunId?: string) {
    const { run } = await repository.createRun({
      ownerId: book.ownerId,
      bookId: book.id,
      operation: 'illustration-visual-review',
      idempotencyKey: `review-${++sequence}`,
      requestHash: 'f'.repeat(64),
      configuration: {
        version: 'illustration-visual-review-1',
        inputHash: 'b'.repeat(64),
        ...(parentRunId ? { parentRunId } : {}),
      },
      stages: ['analyze'],
    });
    return run;
  }
  it('expires an inline SENT review to terminal UNKNOWN/HELD without dispatching or releasing it', async () => {
    const run = await inlineReview();
    expect(await repository.listDispatchable()).toHaveLength(0);
    const claimed = (await repository.claim(
      {
        payloadVersion: 1,
        runId: run.id,
        stepId: run.steps[0]!.id,
        dispatchGeneration: 1,
      },
      'inline',
      30000,
    ))!;
    const { call } = await repository.reserveModelCall(
      claimed.lease,
      reservation,
    );
    await repository.beginModelCall(claimed.lease, call.id);
    now += 30001;
    await repository.recoverExpired();
    const recovered = await repository.getRun(book.ownerId, run.id);
    expect(recovered).toMatchObject({
      status: 'FAILED',
      errorCode: 'VISUAL_REVIEW_UNKNOWN_OUTCOME',
      modelCall: { status: 'UNKNOWN', budgetDisposition: 'HELD' },
    });
    expect(await repository.listDispatchable()).toHaveLength(0);
    expect((await budgets())['2026-10-21']).toMatchObject({
      reservedMicros: 100,
      spentMicros: 0,
    });
  });
  it('cancels an orphan inline child when its parent is cancelled, including a pending-before-send crash', async () => {
    const { run: parent } = await repository.createRun({
      ownerId: book.ownerId,
      bookId: book.id,
      operation: 'illustration-conversion',
      idempotencyKey: 'parent',
      requestHash: 'e'.repeat(64),
      configuration: {
        pipelineVersion: 'subsection-inline-7',
        visualReviewPolicyVersion: 'visual-review-1',
      },
      stages: ['convert'],
    });
    await repository.claim(
      {
        payloadVersion: 1,
        runId: parent.id,
        stepId: parent.steps[0]!.id,
        dispatchGeneration: 1,
      },
      'worker',
      30000,
    );
    const child = await inlineReview(parent.id);
    await repository.requestCancel(book.ownerId, parent.id);
    await repository.recoverExpired();
    expect((await repository.getRun(book.ownerId, child.id)).status).toBe(
      'CANCELLED',
    );
    expect(await repository.listDispatchable()).toHaveLength(0);
  });

  it('deduplicates concurrent reservations and permits only one HTTP sender', async () => {
    const claimed = await claim();
    const other = new ProcessingRepository(
      new LocalProcessingPersistence(directory),
      () => now,
    );
    const values = await Promise.all([
      repository.reserveModelCall(claimed.lease, reservation),
      other.reserveModelCall(claimed.lease, reservation),
    ]);
    expect(values[0].call.id).toBe(values[1].call.id);
    expect(values.filter((value) => !value.reused)).toHaveLength(1);
    const starts = await Promise.all([
      repository.beginModelCall(claimed.lease, values[0].call.id),
      other.beginModelCall(claimed.lease, values[1].call.id),
    ]);
    expect(starts.filter(Boolean)).toHaveLength(1);
    expect((await budgets())['2026-10-21']).toEqual({
      day: '2026-10-21',
      reservedMicros: 100,
      spentMicros: 0,
    });
  });

  it('serializes the global daily budget across different runs', async () => {
    const first = await claim();
    const second = await claim();
    const outcomes = await Promise.allSettled([
      repository.reserveModelCall(first.lease, reservation),
      repository.reserveModelCall(second.lease, reservation),
    ]);
    expect(
      outcomes.filter((value) => value.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(outcomes.find((value) => value.status === 'rejected')).toMatchObject(
      { reason: { code: 'MODEL_DAILY_BUDGET_EXCEEDED' } },
    );
    expect((await budgets())['2026-10-21'].reservedMicros).toBe(100);
  });

  it('admits multiple unbudgeted runs above tiny monetary caps while retaining measured usage and settlement', async () => {
    const unlimited: ModelCallReservation = {
      ...reservation,
      budgetMicros: 1,
      dailyBudgetMicros: 1,
      budgetEnforced: false,
    };
    const defaultClaim = await claim();
    await expect(
      repository.reserveModelCall(defaultClaim.lease, {
        ...reservation,
        budgetMicros: 1,
        dailyBudgetMicros: 1,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_MODEL_RESERVATION' });
    for (let index = 0; index < 3; index++) {
      const claimed = await claim();
      const { call } = await repository.reserveModelCall(
        claimed.lease,
        unlimited,
      );
      expect(await repository.beginModelCall(claimed.lease, call.id)).toBe(
        true,
      );
      expect(
        await repository.completeModelCall(claimed.lease, call.id, completion),
      ).toBe(true);
      expect(await repository.getModelCall(claimed.lease)).toMatchObject({
        budgetEnforced: false,
        budgetMicros: 1,
        dailyBudgetMicros: 1,
        reservedMicros: 100,
        status: 'SUCCEEDED',
        budgetDisposition: 'SETTLED',
        estimatedCostMicros: 20,
        usage: completion.usage,
      });
    }
    expect((await budgets())['2026-10-21']).toEqual({
      day: '2026-10-21',
      reservedMicros: 0,
      spentMicros: 60,
    });
  });

  it('keeps UNKNOWN calls non-resendable and fences expired dispatches even without monetary admission', async () => {
    const unlimited: ModelCallReservation = {
      ...reservation,
      budgetMicros: 1,
      dailyBudgetMicros: 1,
      budgetEnforced: false,
    };
    const first = await claim();
    const { call } = await repository.reserveModelCall(first.lease, unlimited);
    expect(await repository.beginModelCall(first.lease, call.id)).toBe(true);
    const next = await recover(first);
    expect(await repository.beginModelCall(first.lease, call.id)).toBe(false);
    expect(
      await repository.completeModelCall(first.lease, call.id, completion),
    ).toBe(false);
    await expect(
      repository.reserveModelCall(first.lease, unlimited),
    ).rejects.toMatchObject({ code: 'STALE_PROCESSING_LEASE' });
    expect(
      await repository.reserveModelCall(next.lease, unlimited),
    ).toMatchObject({
      reused: true,
      call: {
        id: call.id,
        status: 'UNKNOWN',
        budgetDisposition: 'HELD',
        budgetEnforced: false,
      },
    });
    expect(await repository.beginModelCall(next.lease, call.id)).toBe(false);
    await expect(
      repository.reserveModelCall(next.lease, {
        ...unlimited,
        fingerprint: 'e'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'MODEL_CALL_CONFLICT' });
    const another = await claim();
    const newCall = (
      await repository.reserveModelCall(another.lease, unlimited)
    ).call;
    expect(await repository.beginModelCall(another.lease, newCall.id)).toBe(
      true,
    );
    expect(
      await repository.completeModelCall(another.lease, newCall.id, completion),
    ).toBe(true);
    expect((await budgets())['2026-10-21']).toEqual({
      day: '2026-10-21',
      reservedMicros: 100,
      spentMicros: 20,
    });
  });

  it('moves an unbudgeted unsent reservation across midnight while accounting for both calls on the actual send day', async () => {
    const unlimited: ModelCallReservation = {
      ...reservation,
      budgetMicros: 1,
      dailyBudgetMicros: 1,
      budgetEnforced: false,
    };
    now = Date.parse('2026-10-22T00:00:00Z');
    const settled = await claim();
    const first = (await repository.reserveModelCall(settled.lease, unlimited))
      .call;
    await repository.beginModelCall(settled.lease, first.id);
    await repository.completeModelCall(settled.lease, first.id, completion);
    now = Date.parse('2026-10-21T23:59:59Z');
    const pending = await claim();
    const second = (await repository.reserveModelCall(pending.lease, unlimited))
      .call;
    now += 2000;
    expect(await repository.beginModelCall(pending.lease, second.id)).toBe(
      true,
    );
    expect(
      await repository.completeModelCall(pending.lease, second.id, completion),
    ).toBe(true);
    expect(await repository.getModelCall(pending.lease)).toMatchObject({
      budgetDay: '2026-10-22',
      budgetDisposition: 'SETTLED',
      estimatedCostMicros: 20,
    });
    expect(await budgets()).toEqual({
      '2026-10-21': { day: '2026-10-21', reservedMicros: 0, spentMicros: 0 },
      '2026-10-22': { day: '2026-10-22', reservedMicros: 0, spentMicros: 40 },
    });
  });

  it('fences stale lease mutations and safely transfers an unsent reservation', async () => {
    const first = await claim();
    const call = (await repository.reserveModelCall(first.lease, reservation))
      .call;
    const next = await recover(first);
    expect(await repository.beginModelCall(first.lease, call.id)).toBe(false);
    expect(
      await repository.completeModelCall(first.lease, call.id, completion),
    ).toBe(false);
    await expect(
      repository.reserveModelCall(first.lease, reservation),
    ).rejects.toMatchObject({ code: 'STALE_PROCESSING_LEASE' });
    const reused = await repository.reserveModelCall(next.lease, reservation);
    expect(reused).toMatchObject({
      reused: true,
      call: { id: call.id, status: 'RESERVED' },
    });
    expect(await repository.beginModelCall(next.lease, call.id)).toBe(true);
  });

  it('converts expired SENT to UNKNOWN and never resends it after recovery or reopen', async () => {
    const first = await claim();
    const call = (await repository.reserveModelCall(first.lease, reservation))
      .call;
    await repository.beginModelCall(first.lease, call.id);
    const next = await recover(first);
    const reopened = new ProcessingRepository(
      new LocalProcessingPersistence(directory),
      () => now,
    );
    const reused = await reopened.reserveModelCall(next.lease, reservation);
    expect(reused.call).toMatchObject({
      id: call.id,
      status: 'UNKNOWN',
      budgetDisposition: 'HELD',
    });
    expect(await reopened.beginModelCall(next.lease, call.id)).toBe(false);
    expect(
      await reopened.failKnownModelCall(next.lease, call.id, 'REJECTED'),
    ).toBe(false);
    expect((await budgets())['2026-10-21'].reservedMicros).toBe(100);
  });

  it('forbids a second fingerprint in the same run, even after a known rejection', async () => {
    const claimed = await claim();
    const call = (await repository.reserveModelCall(claimed.lease, reservation))
      .call;
    await repository.beginModelCall(claimed.lease, call.id);
    expect(
      await repository.failKnownModelCall(
        claimed.lease,
        call.id,
        'PROVIDER_REJECTED',
      ),
    ).toBe(true);
    await expect(
      repository.reserveModelCall(claimed.lease, {
        ...reservation,
        fingerprint: 'e'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'MODEL_CALL_CONFLICT' });
    expect(await repository.beginModelCall(claimed.lease, call.id)).toBe(false);
    expect((await budgets())['2026-10-21'].reservedMicros).toBe(0);
  });

  it('releases an unsent cancellation and prevents sending after cancel', async () => {
    const claimed = await claim();
    const call = (await repository.reserveModelCall(claimed.lease, reservation))
      .call;
    await repository.requestCancel(book.ownerId, claimed.run.id);
    expect(await repository.beginModelCall(claimed.lease, call.id)).toBe(false);
    expect(
      (await repository.getRun(book.ownerId, claimed.run.id)).modelCall,
    ).toMatchObject({ status: 'CANCELLED', budgetDisposition: 'RELEASED' });
    const another = await claim();
    await expect(
      repository.reserveModelCall(another.lease, reservation),
    ).resolves.toMatchObject({ reused: false });
  });

  it('retains the budget on sent cancellation and rejects late settlement', async () => {
    const claimed = await claim();
    const call = (await repository.reserveModelCall(claimed.lease, reservation))
      .call;
    await repository.beginModelCall(claimed.lease, call.id);
    await repository.requestCancel(book.ownerId, claimed.run.id);
    expect(
      await repository.completeModelCall(claimed.lease, call.id, completion),
    ).toBe(false);
    expect(
      (await repository.getRun(book.ownerId, claimed.run.id)).modelCall,
    ).toMatchObject({ status: 'UNKNOWN', budgetDisposition: 'HELD' });
    const another = await claim();
    await expect(
      repository.reserveModelCall(another.lease, reservation),
    ).rejects.toMatchObject({ code: 'MODEL_DAILY_BUDGET_EXCEEDED' });
  });

  it('settles once against measured usage and releases only the unused reservation', async () => {
    const claimed = await claim();
    const call = (await repository.reserveModelCall(claimed.lease, reservation))
      .call;
    await repository.beginModelCall(claimed.lease, call.id);
    expect(
      await repository.completeModelCall(claimed.lease, call.id, completion),
    ).toBe(true);
    expect(
      await repository.completeModelCall(claimed.lease, call.id, completion),
    ).toBe(false);
    expect((await budgets())['2026-10-21']).toEqual({
      day: '2026-10-21',
      reservedMicros: 0,
      spentMicros: 20,
    });
    expect(await repository.getModelCall(claimed.lease)).toMatchObject({
      status: 'SUCCEEDED',
      resultByteSize: 50,
      budgetDisposition: 'SETTLED',
    });
    const another = await claim();
    await expect(
      repository.reserveModelCall(another.lease, reservation),
    ).resolves.toMatchObject({ reused: false });
  });

  it('keeps the reservation on successful output with missing usage', async () => {
    const claimed = await claim();
    const call = (await repository.reserveModelCall(claimed.lease, reservation))
      .call;
    await repository.beginModelCall(claimed.lease, call.id);
    expect(
      await repository.completeModelCall(claimed.lease, call.id, {
        resultKey: completion.resultKey,
        resultHash: completion.resultHash,
        resultByteSize: 50,
        estimatedCostMicros: 0,
      }),
    ).toBe(true);
    expect((await budgets())['2026-10-21']).toEqual({
      day: '2026-10-21',
      reservedMicros: 100,
      spentMicros: 0,
    });
    expect(await repository.getModelCall(claimed.lease)).toMatchObject({
      status: 'SUCCEEDED',
      budgetDisposition: 'HELD',
    });
  });

  it('charges the reservation UTC day even if completion crosses midnight', async () => {
    now = Date.parse('2026-10-21T23:59:59Z');
    const claimed = await claim();
    const call = (await repository.reserveModelCall(claimed.lease, reservation))
      .call;
    await repository.beginModelCall(claimed.lease, call.id);
    now += 2000;
    expect(
      await repository.completeModelCall(claimed.lease, call.id, completion),
    ).toBe(true);
    const another = await claim();
    await repository.reserveModelCall(another.lease, reservation);
    expect(await budgets()).toEqual({
      '2026-10-21': { day: '2026-10-21', reservedMicros: 0, spentMicros: 20 },
      '2026-10-22': { day: '2026-10-22', reservedMicros: 100, spentMicros: 0 },
    });
  });

  it('readmits an unsent reservation on the actual UTC send day', async () => {
    now = Date.parse('2026-10-21T23:59:59Z');
    const claimed = await claim();
    const call = (await repository.reserveModelCall(claimed.lease, reservation))
      .call;
    now += 2000;
    expect(await repository.beginModelCall(claimed.lease, call.id)).toBe(true);
    expect(
      await repository.completeModelCall(claimed.lease, call.id, completion),
    ).toBe(true);
    expect(await budgets()).toEqual({
      '2026-10-21': { day: '2026-10-21', reservedMicros: 0, spentMicros: 0 },
      '2026-10-22': { day: '2026-10-22', reservedMicros: 0, spentMicros: 20 },
    });
    expect(await repository.getModelCall(claimed.lease)).toMatchObject({
      budgetDay: '2026-10-22',
      status: 'SUCCEEDED',
    });
  });

  it('does not send when the next UTC day budget is already reserved', async () => {
    now = Date.parse('2026-10-21T23:59:59Z');
    const yesterday = await claim();
    const call = (
      await repository.reserveModelCall(yesterday.lease, reservation)
    ).call;
    now += 2000;
    const today = await claim();
    await repository.reserveModelCall(today.lease, reservation);
    expect(await repository.beginModelCall(yesterday.lease, call.id)).toBe(
      false,
    );
    expect(await repository.getModelCall(yesterday.lease)).toMatchObject({
      status: 'FAILED_KNOWN',
      reasonCode: 'MODEL_DAILY_BUDGET_EXCEEDED',
      budgetDisposition: 'RELEASED',
      sentAt: null,
    });
    expect(await budgets()).toEqual({
      '2026-10-21': { day: '2026-10-21', reservedMicros: 0, spentMicros: 0 },
      '2026-10-22': { day: '2026-10-22', reservedMicros: 100, spentMicros: 0 },
    });
  });

  it('serializes competing midnight transfers without over-admitting the send day', async () => {
    now = Date.parse('2026-10-21T23:59:59Z');
    const limit = { ...reservation, dailyBudgetMicros: 300 };
    const first = await claim();
    const second = await claim();
    const firstCall = (await repository.reserveModelCall(first.lease, limit))
      .call;
    const secondCall = (await repository.reserveModelCall(second.lease, limit))
      .call;
    now += 2000;
    const today = await claim();
    await repository.reserveModelCall(today.lease, {
      ...limit,
      reservedMicros: 200,
      budgetMicros: 200,
    });
    const result = await Promise.all([
      repository.beginModelCall(first.lease, firstCall.id),
      repository.beginModelCall(second.lease, secondCall.id),
    ]);
    expect(result.filter(Boolean)).toHaveLength(1);
    expect(await budgets()).toEqual({
      '2026-10-21': { day: '2026-10-21', reservedMicros: 0, spentMicros: 0 },
      '2026-10-22': { day: '2026-10-22', reservedMicros: 300, spentMicros: 0 },
    });
  });

  it('fails closed if a lock wait crosses midnight after selecting budget rows', async () => {
    now = Date.parse('2026-10-21T23:59:59Z');
    const claimed = await claim();
    const call = (await repository.reserveModelCall(claimed.lease, reservation))
      .call;
    const release = await acquireSqliteFileLock(
      join(directory, 'metadata', 'state-lock.sqlite'),
      0,
    );
    const beginning = repository.beginModelCall(claimed.lease, call.id);
    now += 2000;
    await release();
    expect(await beginning).toBe(false);
    expect(await repository.getModelCall(claimed.lease)).toMatchObject({
      status: 'FAILED_KNOWN',
      reasonCode: 'MODEL_BUDGET_DAY_CHANGED',
      sentAt: null,
      budgetDisposition: 'RELEASED',
    });
    expect(await budgets()).toEqual({
      '2026-10-21': { day: '2026-10-21', reservedMicros: 0, spentMicros: 0 },
    });
  });

  it('rejects mismatched source, unsafe cost and oversized result before settlement', async () => {
    const claimed = await claim();
    await expect(
      repository.reserveModelCall(claimed.lease, {
        ...reservation,
        sourceHash: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'MODEL_SOURCE_MISMATCH' });
    await expect(
      repository.reserveModelCall(claimed.lease, {
        ...reservation,
        reservedMicros: 101,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_MODEL_RESERVATION' });
    const call = (await repository.reserveModelCall(claimed.lease, reservation))
      .call;
    await repository.beginModelCall(claimed.lease, call.id);
    await expect(
      repository.completeModelCall(claimed.lease, call.id, {
        ...completion,
        estimatedCostMicros: 101,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_MODEL_COMPLETION' });
    await expect(
      repository.completeModelCall(claimed.lease, call.id, {
        ...completion,
        resultByteSize: 262145,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_MODEL_COMPLETION' });
    expect(
      await repository.markUnknownModelCall(
        claimed.lease,
        call.id,
        'MODEL_OUTPUT_INVALID',
      ),
    ).toBe(true);
    expect(await repository.beginModelCall(claimed.lease, call.id)).toBe(false);
  });

  it('persists only explicit safe fields, never accidental raw prompt/output fields', async () => {
    const claimed = await claim();
    const call = (
      await repository.reserveModelCall(
        claimed.lease,
        Object.assign({}, reservation, { prompt: 'PRIVATE_PROMPT' }),
      )
    ).call;
    await repository.beginModelCall(claimed.lease, call.id);
    await repository.completeModelCall(
      claimed.lease,
      call.id,
      Object.assign({}, completion, { rawResponse: 'PRIVATE_RESPONSE' }),
    );
    const raw = await readFile(
      join(directory, 'metadata', 'state.json'),
      'utf8',
    );
    expect(raw).not.toContain('PRIVATE_PROMPT');
    expect(raw).not.toContain('PRIVATE_RESPONSE');
  });
});
