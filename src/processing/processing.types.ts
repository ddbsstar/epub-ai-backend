import type { ModelCallRecord, ModelDailyBudget } from './model-call.types.js';

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type RunStatus =
  'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export type StepStatus =
  'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

export interface ProcessingBook {
  id: string;
  ownerId: string;
  sourceKey: string;
  sourceHash: string;
  byteSize: number;
  originalName: string;
  createdAt: string;
  deletedAt: string | null;
}

export interface RunStep {
  id: string;
  stage: string;
  status: StepStatus;
  dispatchGeneration: number;
  attempt: number;
  leaseVersion: number;
  leaseUntil: string | null;
  workerId: string | null;
  completedAt: string | null;
  result: JsonValue | null;
}

export interface ProcessingRun {
  id: string;
  ownerId: string;
  bookId: string;
  operation: string;
  idempotencyKey: string;
  requestHash: string;
  configuration: JsonValue;
  status: RunStatus;
  stage: string;
  steps: RunStep[];
  completedUnits: number;
  totalUnits: number;
  cancelRequestedAt: string | null;
  errorCode: string | null;
  artifactId: string | null;
  artifactIds: string[];
  createdAt: string;
  updatedAt: string;
  modelCall?: ModelCallRecord | null;
}

export interface ProcessingArtifact {
  id: string;
  ownerId: string;
  bookId: string;
  runId: string;
  storageKey: string;
  sha256: string;
  byteSize: number;
  mediaType: string;
  kind: string;
  createdAt: string;
}

export interface StepPayload {
  payloadVersion: 1;
  runId: string;
  stepId: string;
  dispatchGeneration: number;
}

export interface StepLease {
  runId: string;
  stepId: string;
  leaseVersion: number;
  workerId: string;
}

export interface ClaimedStep {
  run: ProcessingRun;
  book: ProcessingBook;
  step: RunStep;
  lease: StepLease;
}

export interface CreateRunInput {
  ownerId: string;
  bookId: string;
  operation: string;
  idempotencyKey: string;
  requestHash: string;
  configuration: JsonValue;
  stages: string[];
}

export type NewArtifact = Omit<
  ProcessingArtifact,
  'id' | 'ownerId' | 'bookId' | 'runId' | 'createdAt'
>;

export class ProcessingError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus = 409,
  ) {
    super(code);
    this.name = 'ProcessingError';
  }
}

export interface RunMutation {
  run: ProcessingRun;
  artifacts?: ProcessingArtifact[];
  dailyBudgets?: ModelDailyBudget[];
}

/** Runs are bounded aggregates (at most 16 stages), never a paragraph store. */
export interface ProcessingPersistence {
  createBook(book: ProcessingBook): Promise<void>;
  getBook(id: string): Promise<ProcessingBook | null>;
  createRun(
    run: ProcessingRun,
  ): Promise<{ run: ProcessingRun; reused: boolean }>;
  getRun(id: string): Promise<ProcessingRun | null>;
  findRunByKey(
    ownerId: string,
    operation: string,
    idempotencyKey: string,
  ): Promise<ProcessingRun | null>;
  mutateRun<T>(
    id: string,
    change: (
      run: ProcessingRun,
      book: ProcessingBook,
      dailyBudgets: Record<string, ModelDailyBudget>,
    ) => { result: T; mutation?: RunMutation },
    options?: { budgetDay?: string },
  ): Promise<T | null>;
  listActive(limit: number): Promise<ProcessingRun[]>;
  getArtifact(id: string): Promise<ProcessingArtifact | null>;
  close(): Promise<void>;
}
