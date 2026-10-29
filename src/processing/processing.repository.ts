import { randomUUID } from 'node:crypto';
import {
  inlineReviewParentId,
  inlineVisualReviewOperation,
} from './inline-visual-review.js';
import {
  sanitizeUpstreamDiagnostic,
  type UpstreamDiagnostic,
} from '../ai/upstream-diagnostic.js';
import {
  cancelModelCall,
  changedModelBudgets,
  modelBudget,
  releaseModelReservation,
  sameModelLease,
  validateModelCompletion,
  validateModelReservation,
} from './model-call-ledger.js';
import type {
  ModelCallCompletion,
  ModelCallRecord,
  ModelCallReservation,
  ModelDailyBudget,
} from './model-call.types.js';
import {
  ProcessingError,
  type ClaimedStep,
  type CreateRunInput,
  type JsonValue,
  type NewArtifact,
  type ProcessingArtifact,
  type ProcessingBook,
  type ProcessingPersistence,
  type ProcessingRun,
  type StepLease,
  type StepPayload,
} from './processing.types.js';

const terminal = (run: ProcessingRun) =>
  ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.status);
const payloadFor = (run: ProcessingRun): StepPayload | null => {
  const step = run.steps.find((value) => value.status === 'PENDING');
  return !terminal(run) && step
    ? {
        payloadVersion: 1,
        runId: run.id,
        stepId: step.id,
        dispatchGeneration: step.dispatchGeneration,
      }
    : null;
};

export function validateStepPayload(input: unknown): StepPayload {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ProcessingError('INVALID_STEP_PAYLOAD', 400);
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(',') !==
      'dispatchGeneration,payloadVersion,runId,stepId' ||
    value.payloadVersion !== 1 ||
    typeof value.runId !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(value.runId) ||
    typeof value.stepId !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(value.stepId) ||
    !Number.isSafeInteger(value.dispatchGeneration) ||
    Number(value.dispatchGeneration) < 1
  )
    throw new ProcessingError('INVALID_STEP_PAYLOAD', 400);
  return value as unknown as StepPayload;
}

export class ProcessingRepository {
  constructor(
    readonly persistence: ProcessingPersistence,
    private readonly clock: () => number = Date.now,
  ) {}

  async createBook(
    input: Omit<ProcessingBook, 'id' | 'createdAt' | 'deletedAt'>,
  ): Promise<ProcessingBook> {
    if (
      !input.ownerId ||
      input.ownerId.length > 100 ||
      !/^[a-f0-9]{64}$/.test(input.sourceHash) ||
      !Number.isSafeInteger(input.byteSize) ||
      input.byteSize < 1 ||
      input.originalName.length > 255 ||
      !this.validKey(input.sourceKey)
    )
      throw new ProcessingError('INVALID_BOOK_METADATA', 400);
    const book: ProcessingBook = {
      ...input,
      id: randomUUID(),
      createdAt: this.now(),
      deletedAt: null,
    };
    await this.persistence.createBook(book);
    return book;
  }

  async getBook(ownerId: string, id: string): Promise<ProcessingBook> {
    const book = await this.persistence.getBook(id);
    if (!book || book.ownerId !== ownerId || book.deletedAt)
      throw new ProcessingError('BOOK_NOT_FOUND', 404);
    return book;
  }

  async createRun(
    input: CreateRunInput,
  ): Promise<{ run: ProcessingRun; reused: boolean }> {
    await this.getBook(input.ownerId, input.bookId);
    if (
      !input.stages.length ||
      input.stages.length > 16 ||
      new Set(input.stages).size !== input.stages.length ||
      input.stages.some((stage) => !/^[a-z][a-z-]{0,47}$/.test(stage))
    )
      throw new ProcessingError('INVALID_STAGES', 400);
    if (
      !/^[a-z0-9_-]{1,64}$/.test(input.operation) ||
      !/^[\x21-\x7e]{1,100}$/.test(input.idempotencyKey) ||
      !/^[a-f0-9]{64}$/.test(input.requestHash)
    )
      throw new ProcessingError('INVALID_RUN_INPUT', 400);
    if (Buffer.byteLength(JSON.stringify(input.configuration), 'utf8') > 16384)
      throw new ProcessingError('CONFIGURATION_TOO_LARGE', 400);
    const now = this.now();
    const run: ProcessingRun = {
      id: randomUUID(),
      ownerId: input.ownerId,
      bookId: input.bookId,
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      configuration: input.configuration,
      status: 'QUEUED',
      stage: input.stages[0],
      steps: input.stages.map((stage) => ({
        id: randomUUID(),
        stage,
        status: 'PENDING',
        dispatchGeneration: 1,
        attempt: 0,
        leaseVersion: 0,
        leaseUntil: null,
        workerId: null,
        completedAt: null,
        result: null,
      })),
      completedUnits: 0,
      totalUnits: input.stages.length,
      cancelRequestedAt: null,
      errorCode: null,
      artifactId: null,
      artifactIds: [],
      createdAt: now,
      updatedAt: now,
    };
    return this.persistence.createRun(run);
  }

  async getRun(ownerId: string, id: string): Promise<ProcessingRun> {
    const run = await this.persistence.getRun(id);
    if (!run || run.ownerId !== ownerId)
      throw new ProcessingError('RUN_NOT_FOUND', 404);
    return run;
  }

  /** Read-only recovery of a canonical request after its POST response is lost. */
  async findRunByKey(
    ownerId: string,
    operation: string,
    idempotencyKey: string,
  ): Promise<ProcessingRun | null> {
    if (
      !ownerId ||
      ownerId.length > 100 ||
      !/^[a-z0-9_-]{1,64}$/.test(operation) ||
      !/^[\x21-\x7e]{1,100}$/.test(idempotencyKey)
    )
      throw new ProcessingError('INVALID_RUN_INPUT', 400);
    const run = await this.persistence.findRunByKey(
      ownerId,
      operation,
      idempotencyKey,
    );
    if (
      !run ||
      run.ownerId !== ownerId ||
      run.operation !== operation ||
      run.idempotencyKey !== idempotencyKey
    )
      return null;
    await this.getBook(ownerId, run.bookId);
    return run;
  }

  async getArtifact(ownerId: string, id: string): Promise<ProcessingArtifact> {
    const artifact = await this.persistence.getArtifact(id);
    if (!artifact || artifact.ownerId !== ownerId)
      throw new ProcessingError('ARTIFACT_NOT_FOUND', 404);
    await this.getBook(ownerId, artifact.bookId);
    const run = await this.getRun(ownerId, artifact.runId);
    if (run.status !== 'SUCCEEDED' || !run.artifactIds.includes(artifact.id))
      throw new ProcessingError('ARTIFACT_NOT_FOUND', 404);
    return artifact;
  }

  async requestCancel(ownerId: string, id: string): Promise<ProcessingRun> {
    const result = await this.persistence.mutateRun(
      id,
      (run, _book, budgets) => {
        if (run.ownerId !== ownerId)
          throw new ProcessingError('RUN_NOT_FOUND', 404);
        if (terminal(run)) return { result: run };
        run.cancelRequestedAt ??= this.now();
        cancelModelCall(run, budgets, this.now());
        if (!run.steps.some((step) => step.status === 'RUNNING'))
          this.cancel(run, budgets);
        run.updatedAt = this.now();
        return {
          result: run,
          mutation: { run, dailyBudgets: changedModelBudgets(run, budgets) },
        };
      },
    );
    if (!result) throw new ProcessingError('RUN_NOT_FOUND', 404);
    return result;
  }

  async listDispatchable(limit = 100): Promise<StepPayload[]> {
    const runs = await this.persistence.listActive(limit);
    return runs
      .filter(
        (run) =>
          run.operation !== inlineVisualReviewOperation &&
          !run.steps.some((step) => step.status === 'RUNNING'),
      )
      .map(payloadFor)
      .filter((value): value is StepPayload => value !== null);
  }

  /** An old failed/completed Redis record must not permanently shadow a pending
   * DB step. Only its exact still-pending generation may advance. */
  async advanceDispatchGeneration(input: unknown): Promise<StepPayload | null> {
    const payload = validateStepPayload(input);
    return this.persistence.mutateRun(payload.runId, (run, book) => {
      const step = run.steps.find((value) => value.id === payload.stepId);
      if (
        terminal(run) ||
        run.cancelRequestedAt ||
        book.deletedAt ||
        !step ||
        step !== run.steps.find((value) => value.status !== 'SUCCEEDED') ||
        step.status !== 'PENDING' ||
        step.dispatchGeneration !== payload.dispatchGeneration
      )
        return { result: null };
      step.dispatchGeneration += 1;
      step.leaseVersion += 1;
      run.updatedAt = this.now();
      return {
        result: { ...payload, dispatchGeneration: step.dispatchGeneration },
        mutation: { run },
      };
    });
  }

  async claim(
    input: unknown,
    workerId: string,
    leaseMs = 30000,
  ): Promise<ClaimedStep | null> {
    const payload = validateStepPayload(input);
    return this.persistence.mutateRun(payload.runId, (run, book, budgets) => {
      if (terminal(run) || run.cancelRequestedAt || book.deletedAt) {
        if (!terminal(run)) {
          this.cancel(run, budgets);
          return {
            result: null,
            mutation: { run, dailyBudgets: changedModelBudgets(run, budgets) },
          };
        }
        return { result: null };
      }
      const step = run.steps.find((value) => value.id === payload.stepId);
      if (
        !step ||
        step !== run.steps.find((value) => value.status !== 'SUCCEEDED') ||
        step.status !== 'PENDING' ||
        step.dispatchGeneration !== payload.dispatchGeneration
      )
        return { result: null };
      step.status = 'RUNNING';
      step.attempt += 1;
      step.leaseVersion += 1;
      step.workerId = workerId;
      step.leaseUntil = new Date(this.clock() + leaseMs).toISOString();
      run.status = 'RUNNING';
      run.stage = step.stage;
      run.updatedAt = this.now();
      return {
        result: {
          run,
          book,
          step,
          lease: {
            runId: run.id,
            stepId: step.id,
            workerId,
            leaseVersion: step.leaseVersion,
          },
        },
        mutation: { run },
      };
    });
  }

  async heartbeat(lease: StepLease, leaseMs = 30000): Promise<boolean> {
    return (
      (await this.persistence.mutateRun(lease.runId, (run, book) => {
        const step = this.validLease(run, lease);
        if (!step || run.cancelRequestedAt || book.deletedAt)
          return { result: false };
        step.leaseUntil = new Date(this.clock() + leaseMs).toISOString();
        run.updatedAt = this.now();
        return { result: true, mutation: { run } };
      })) ?? false
    );
  }

  /** Persist an immutable sub-unit checkpoint without advancing the coarse stage. */
  async checkpointStep(
    lease: StepLease,
    result: JsonValue,
    completedUnits: number,
    totalUnits: number,
  ): Promise<boolean> {
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 16384)
      throw new ProcessingError('CHECKPOINT_TOO_LARGE', 400);
    if (
      !Number.isSafeInteger(completedUnits) ||
      !Number.isSafeInteger(totalUnits) ||
      completedUnits < 0 ||
      totalUnits < completedUnits
    )
      throw new ProcessingError('INVALID_PROGRESS', 400);
    return (
      (await this.persistence.mutateRun(lease.runId, (run, book) => {
        const step = this.validLease(run, lease);
        if (!step || run.cancelRequestedAt || book.deletedAt)
          return { result: false };
        step.result = result;
        // run.completedUnits is the stage cursor; chapter counts live in result's private reference.
        run.updatedAt = this.now();
        return { result: true, mutation: { run } };
      })) ?? false
    );
  }

  async completeStep(
    lease: StepLease,
    result: JsonValue,
    options: { artifacts?: NewArtifact[] } = {},
  ): Promise<boolean> {
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 16384)
      throw new ProcessingError('CHECKPOINT_TOO_LARGE', 400);
    if (
      options.artifacts?.some(
        (artifact) =>
          !this.validKey(artifact.storageKey) ||
          !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
          !Number.isSafeInteger(artifact.byteSize) ||
          artifact.byteSize < 0 ||
          !/^[a-z][a-z0-9-]{0,47}$/.test(artifact.kind) ||
          artifact.mediaType.length > 100,
      )
    )
      throw new ProcessingError('INVALID_ARTIFACT_METADATA', 400);
    return (
      (await this.persistence.mutateRun(lease.runId, (run, book, budgets) => {
        const step = this.validLease(run, lease);
        if (!step) return { result: false };
        if (run.cancelRequestedAt || book.deletedAt) {
          this.cancel(run, budgets);
          return {
            result: false,
            mutation: { run, dailyBudgets: changedModelBudgets(run, budgets) },
          };
        }
        const isLast = step === run.steps.at(-1);
        if (
          Boolean(options.artifacts?.length) !== isLast ||
          (options.artifacts?.length ?? 0) > 8
        )
          throw new ProcessingError('INVALID_PUBLICATION_STAGE', 400);
        const artifacts = options.artifacts?.map((artifact) => ({
          ...artifact,
          id: randomUUID(),
          runId: run.id,
          bookId: run.bookId,
          ownerId: run.ownerId,
          createdAt: this.now(),
        }));
        step.status = 'SUCCEEDED';
        step.result = result;
        step.completedAt = this.now();
        step.leaseUntil = null;
        step.workerId = null;
        run.completedUnits += 1;
        run.updatedAt = this.now();
        run.status = isLast ? 'SUCCEEDED' : 'QUEUED';
        run.stage = isLast ? step.stage : run.steps[run.completedUnits].stage;
        if (artifacts) {
          run.artifactIds = artifacts.map((artifact) => artifact.id);
          run.artifactId = artifacts[0]?.id ?? null;
        }
        return { result: true, mutation: { run, artifacts } };
      })) ?? false
    );
  }

  async failStep(lease: StepLease, code: string): Promise<boolean> {
    const safeCode = /^[A-Z0-9_]{1,64}$/.test(code)
      ? code
      : 'PROCESSING_FAILED';
    return (
      (await this.persistence.mutateRun(lease.runId, (run, book, budgets) => {
        const step = this.validLease(run, lease);
        if (!step) return { result: false };
        if (run.cancelRequestedAt || book.deletedAt) this.cancel(run, budgets);
        else {
          cancelModelCall(run, budgets, this.now());
          step.status = 'FAILED';
          step.leaseUntil = null;
          step.workerId = null;
          run.status = 'FAILED';
          run.errorCode = safeCode;
        }
        run.updatedAt = this.now();
        return {
          result: true,
          mutation: { run, dailyBudgets: changedModelBudgets(run, budgets) },
        };
      })) ?? false
    );
  }

  async recoverExpired(limit = 100): Promise<number> {
    let count = 0;
    for (const candidate of await this.persistence.listActive(limit)) {
      const parentId = inlineReviewParentId(candidate);
      const parent = parentId ? await this.persistence.getRun(parentId) : null;
      const parentStopped = Boolean(
        parentId && (!parent || terminal(parent) || parent.cancelRequestedAt),
      );
      const changed = await this.persistence.mutateRun(
        candidate.id,
        (run, book, budgets) => {
          const step = run.steps.find((value) => value.status === 'RUNNING');
          if (
            run.operation === inlineVisualReviewOperation &&
            (parentStopped ||
              book.deletedAt ||
              (!step && this.clock() - Date.parse(run.updatedAt) > 180_000))
          ) {
            this.cancel(run, budgets);
            run.updatedAt = this.now();
            return {
              result: true,
              mutation: {
                run,
                dailyBudgets: changedModelBudgets(run, budgets),
              },
            };
          }
          if (!step?.leaseUntil || Date.parse(step.leaseUntil) > this.clock())
            return { result: false };
          if (run.modelCall?.status === 'SENT') {
            run.modelCall.status = 'UNKNOWN';
            run.modelCall.reasonCode = 'MODEL_CALL_LEASE_EXPIRED';
            run.modelCall.completedAt = this.now();
          }
          if (
            run.operation === inlineVisualReviewOperation &&
            run.modelCall?.status === 'UNKNOWN'
          ) {
            step.status = 'FAILED';
            step.leaseUntil = null;
            step.workerId = null;
            step.leaseVersion += 1;
            run.status = 'FAILED';
            run.errorCode = 'VISUAL_REVIEW_UNKNOWN_OUTCOME';
            run.updatedAt = this.now();
            return { result: true, mutation: { run } };
          }
          if (run.cancelRequestedAt || book.deletedAt)
            this.cancel(run, budgets);
          else if (step.attempt >= 3) {
            cancelModelCall(run, budgets, this.now());
            step.status = 'FAILED';
            step.leaseUntil = null;
            step.workerId = null;
            run.status = 'FAILED';
            run.errorCode = 'RECOVERY_LIMIT_EXCEEDED';
          } else {
            step.status = 'PENDING';
            step.dispatchGeneration += 1;
            step.leaseVersion += 1;
            step.leaseUntil = null;
            step.workerId = null;
            run.status = 'QUEUED';
          }
          run.updatedAt = this.now();
          return {
            result: true,
            mutation: { run, dailyBudgets: changedModelBudgets(run, budgets) },
          };
        },
      );
      if (changed) count += 1;
    }
    return count;
  }

  /** At most one paid attempt per run. A reservation is persisted before send. */
  async reserveModelCall(
    lease: StepLease,
    input: ModelCallReservation,
  ): Promise<{ call: ModelCallRecord; reused: boolean }> {
    const reservation = validateModelReservation(input);
    const day = this.now().slice(0, 10);
    const result = await this.persistence.mutateRun(
      lease.runId,
      (run, book, budgets) => {
        if (
          !this.validLease(run, lease) ||
          run.cancelRequestedAt ||
          book.deletedAt
        )
          throw new ProcessingError('STALE_PROCESSING_LEASE');
        if (book.sourceHash !== reservation.sourceHash)
          throw new ProcessingError('MODEL_SOURCE_MISMATCH');
        if (run.modelCall) {
          const call = run.modelCall;
          if (
            JSON.stringify(validateModelReservation(call)) !==
            JSON.stringify(reservation)
          )
            throw new ProcessingError('MODEL_CALL_CONFLICT');
          if (call.status === 'RESERVED') call.lease = { ...lease };
          else if (
            call.status === 'SENT' &&
            !sameModelLease(call.lease, lease)
          ) {
            call.status = 'UNKNOWN';
            call.reasonCode = 'MODEL_CALL_LEASE_EXPIRED';
            call.completedAt = this.now();
          }
          run.updatedAt = this.now();
          return { result: { call, reused: true }, mutation: { run } };
        }
        const budget = modelBudget(budgets, day);
        if (
          reservation.budgetEnforced !== false &&
          budget.spentMicros +
            budget.reservedMicros +
            reservation.reservedMicros >
            reservation.dailyBudgetMicros
        )
          throw new ProcessingError('MODEL_DAILY_BUDGET_EXCEEDED', 429);
        budget.reservedMicros += reservation.reservedMicros;
        const call: ModelCallRecord = {
          ...reservation,
          id: randomUUID(),
          status: 'RESERVED',
          budgetDay: day,
          budgetDisposition: 'HELD',
          reservedAt: this.now(),
          sentAt: null,
          completedAt: null,
          lease: { ...lease },
          resultKey: null,
          resultHash: null,
          resultByteSize: null,
          usage: null,
          estimatedCostMicros: null,
          providerRequestId: null,
          finishReason: null,
          reasonCode: null,
        };
        run.modelCall = call;
        run.updatedAt = this.now();
        return {
          result: { call, reused: false },
          mutation: { run, dailyBudgets: [budget] },
        };
      },
      { budgetDay: day },
    );
    if (!result) throw new ProcessingError('RUN_NOT_FOUND', 404);
    return result;
  }

  /** Only the winner of this atomic transition is permitted to send HTTP. */
  async beginModelCall(lease: StepLease, callId: string): Promise<boolean> {
    const day = this.now().slice(0, 10);
    return (
      (await this.persistence.mutateRun(
        lease.runId,
        (run, book, budgets) => {
          const call = run.modelCall;
          if (
            !this.validLease(run, lease) ||
            run.cancelRequestedAt ||
            book.deletedAt ||
            !call ||
            call.id !== callId ||
            call.status !== 'RESERVED' ||
            !sameModelLease(call.lease, lease)
          )
            return { result: false };
          const journalAt = this.now();
          if (journalAt.slice(0, 10) !== day) {
            // A lock wait crossed midnight after the persistence layer selected
            // its daily rows. Never send against an unloaded day's aggregate.
            releaseModelReservation(call, budgets);
            call.status = 'FAILED_KNOWN';
            call.reasonCode = 'MODEL_BUDGET_DAY_CHANGED';
            call.completedAt = journalAt;
            run.updatedAt = journalAt;
            return {
              result: false,
              mutation: {
                run,
                dailyBudgets: changedModelBudgets(run, budgets),
              },
            };
          }
          const dailyBudgets: ModelDailyBudget[] = [];
          if (call.budgetDay !== day) {
            const prior = modelBudget(budgets, call.budgetDay);
            const today = modelBudget(budgets, day);
            if (
              call.budgetEnforced !== false &&
              today.spentMicros + today.reservedMicros + call.reservedMicros >
                call.dailyBudgetMicros
            ) {
              // No HTTP was sent. Atomically release the prior day's hold and
              // record the refusal; a failed admission can never become SENT.
              releaseModelReservation(call, budgets);
              call.status = 'FAILED_KNOWN';
              call.reasonCode = 'MODEL_DAILY_BUDGET_EXCEEDED';
              call.completedAt = journalAt;
              run.updatedAt = journalAt;
              return {
                result: false,
                mutation: { run, dailyBudgets: [prior, today] },
              };
            }
            releaseModelReservation(call, budgets);
            call.budgetDay = day;
            call.budgetDisposition = 'HELD';
            today.reservedMicros += call.reservedMicros;
            dailyBudgets.push(prior, today);
          }
          call.status = 'SENT';
          call.sentAt = journalAt;
          run.updatedAt = journalAt;
          return { result: true, mutation: { run, dailyBudgets } };
        },
        { budgetDay: day },
      )) ?? false
    );
  }

  async completeModelCall(
    lease: StepLease,
    callId: string,
    input: ModelCallCompletion,
  ): Promise<boolean> {
    return (
      (await this.persistence.mutateRun(lease.runId, (run, book, budgets) => {
        const call = run.modelCall;
        if (
          !this.validLease(run, lease) ||
          run.cancelRequestedAt ||
          book.deletedAt ||
          !call ||
          call.id !== callId ||
          call.status !== 'SENT' ||
          !sameModelLease(call.lease, lease)
        )
          return { result: false };
        const completion = validateModelCompletion(input, call);
        call.status = 'SUCCEEDED';
        call.completedAt = this.now();
        call.resultKey = completion.resultKey;
        call.resultHash = completion.resultHash;
        call.resultByteSize = completion.resultByteSize;
        call.usage = completion.usage ?? null;
        call.estimatedCostMicros = completion.estimatedCostMicros ?? null;
        call.providerRequestId = completion.providerRequestId ?? null;
        call.finishReason = completion.finishReason ?? null;
        if (completion.usage && completion.estimatedCostMicros !== undefined) {
          releaseModelReservation(call, budgets);
          modelBudget(budgets, call.budgetDay).spentMicros +=
            completion.estimatedCostMicros;
          call.budgetDisposition = 'SETTLED';
        }
        run.updatedAt = this.now();
        return {
          result: true,
          mutation: { run, dailyBudgets: changedModelBudgets(run, budgets) },
        };
      })) ?? false
    );
  }

  /** Only for an explicit provider rejection that guarantees no execution. */
  async failKnownModelCall(
    lease: StepLease,
    callId: string,
    code: string,
  ): Promise<boolean> {
    return (
      (await this.persistence.mutateRun(lease.runId, (run, book, budgets) => {
        const call = run.modelCall;
        if (
          !this.validLease(run, lease) ||
          run.cancelRequestedAt ||
          book.deletedAt ||
          !call ||
          call.id !== callId ||
          !['RESERVED', 'SENT'].includes(call.status) ||
          !sameModelLease(call.lease, lease)
        )
          return { result: false };
        releaseModelReservation(call, budgets);
        call.status = 'FAILED_KNOWN';
        call.reasonCode = this.safeModelCode(code);
        call.completedAt = this.now();
        run.updatedAt = this.now();
        return {
          result: true,
          mutation: { run, dailyBudgets: changedModelBudgets(run, budgets) },
        };
      })) ?? false
    );
  }

  async markUnknownModelCall(
    lease: StepLease,
    callId: string,
    code = 'MODEL_CALL_OUTCOME_UNKNOWN',
    diagnostic?: UpstreamDiagnostic,
  ): Promise<boolean> {
    return (
      (await this.persistence.mutateRun(lease.runId, (run, book) => {
        const call = run.modelCall;
        if (
          !this.validLease(run, lease) ||
          run.cancelRequestedAt ||
          book.deletedAt ||
          !call ||
          call.id !== callId ||
          call.status !== 'SENT' ||
          !sameModelLease(call.lease, lease)
        )
          return { result: false };
        call.status = 'UNKNOWN';
        call.reasonCode = this.safeModelCode(code);
        const safeDiagnostic = sanitizeUpstreamDiagnostic(diagnostic);
        if (safeDiagnostic) call.upstreamDiagnostic = safeDiagnostic;
        call.completedAt = this.now();
        run.updatedAt = this.now();
        return { result: true, mutation: { run } };
      })) ?? false
    );
  }

  async getModelCall(lease: StepLease): Promise<ModelCallRecord | null> {
    return this.persistence.mutateRun(lease.runId, (run, book) => {
      if (
        !this.validLease(run, lease) ||
        run.cancelRequestedAt ||
        book.deletedAt
      )
        throw new ProcessingError('STALE_PROCESSING_LEASE');
      return { result: run.modelCall ?? null };
    });
  }

  private safeModelCode(code: string): string {
    return /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'MODEL_CALL_FAILED';
  }

  close(): Promise<void> {
    return this.persistence.close();
  }
  private now(): string {
    return new Date(this.clock()).toISOString();
  }
  private validKey(value: string): boolean {
    return (
      value.length > 0 &&
      value.length <= 255 &&
      !value.startsWith('/') &&
      /^[a-zA-Z0-9._/-]+$/.test(value) &&
      value
        .split('/')
        .every((part) => part !== '.' && part !== '..' && part.length > 0)
    );
  }
  private validLease(run: ProcessingRun, lease: StepLease) {
    const step = run.steps.find((value) => value.id === lease.stepId);
    return !terminal(run) &&
      step?.status === 'RUNNING' &&
      step.workerId === lease.workerId &&
      step.leaseVersion === lease.leaseVersion &&
      step.leaseUntil &&
      Date.parse(step.leaseUntil) > this.clock()
      ? step
      : null;
  }
  private cancel(
    run: ProcessingRun,
    budgets: Record<string, ModelDailyBudget>,
  ): void {
    cancelModelCall(run, budgets, this.now());
    run.status = 'CANCELLED';
    run.updatedAt = this.now();
    for (const step of run.steps)
      if (step.status === 'RUNNING' || step.status === 'PENDING') {
        step.status = 'CANCELLED';
        step.workerId = null;
        step.leaseUntil = null;
        step.leaseVersion += 1;
      }
  }
}
