import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AppConfig } from '../config/app-config.module.js';
import type { EpubStructureSnapshot } from '../documents/epub.types.js';
import type {
  ModelCallRecord,
  ModelCallReservation,
  ModelCallUsage,
} from '../processing/model-call.types.js';
import { ProcessingRepository } from '../processing/processing.repository.js';
import { ProcessingError } from '../processing/processing.types.js';
import {
  parseStructurePlan,
  STRUCTURE_PLAN_SCHEMA_VERSION,
  STRUCTURE_PROMPT_VERSION,
  structureMessages,
  validStructureSnapshot,
} from './ai-structure-plan.js';
import {
  AiGatewayError,
  type AiStructureContext,
  type AiStructureResult,
} from './ai-structure.types.js';
import { AiService } from './ai.service.js';

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

/** Snapshot estimate only. Cached-input discounts are deliberately not assumed. */
export function estimatedMicros(
  inputTokens: number,
  outputTokens: number,
  inputPrice: number,
  outputPrice: number,
): number {
  return Number(
    (BigInt(inputTokens) * BigInt(inputPrice) +
      BigInt(outputTokens) * BigInt(outputPrice) +
      999999n) /
      1000000n,
  );
}

function callSummary(call: ModelCallRecord): Partial<AiStructureResult> {
  return {
    callId: call.id,
    model: call.model,
    reservedMicros: call.reservedMicros,
    ...(call.usage ? { usage: call.usage } : {}),
    ...(call.estimatedCostMicros !== null
      ? { estimatedCostMicros: call.estimatedCostMicros }
      : {}),
  };
}

@Injectable()
export class AiStructureService {
  constructor(
    @Inject(AppConfig) private readonly config: AppConfig,
    @Inject(ProcessingRepository)
    private readonly repository: ProcessingRepository,
    @Inject(AiService) private readonly gateway: AiService,
  ) {}

  async analyze(
    snapshot: EpubStructureSnapshot,
    context: AiStructureContext,
  ): Promise<AiStructureResult> {
    const fallback = (reasonCode: string): AiStructureResult => ({
      status: 'FALLBACK',
      reasonCode,
    });
    if (
      !this.config.get('PROCESSING_AI_ENABLED') ||
      !this.config.get('QWEN_ENABLED')
    )
      return { status: 'SKIPPED', reasonCode: 'AI_DISABLED' };
    if (context.signal?.aborted) return fallback('AI_CANCELLED');
    if (!validStructureSnapshot(snapshot))
      return fallback('AI_INVALID_SNAPSHOT');
    if (!snapshot.blocks.length)
      return { status: 'SKIPPED', reasonCode: 'AI_EMPTY_SNAPSHOT' };

    const messages = structureMessages(snapshot);
    const bytes = Buffer.byteLength(JSON.stringify(messages), 'utf8');
    // A conservative byte bound plus overhead, not a tokenizer or exact usage.
    if (
      bytes > this.config.get('AI_MAX_MESSAGE_BYTES') ||
      bytes + 4096 > this.config.get('AI_INPUT_TOKEN_BUDGET')
    )
      return fallback('AI_INPUT_LIMIT');
    const inputPrice = this.config.get('AI_INPUT_PRICE_MICROS_PER_MILLION');
    const outputPrice = this.config.get('AI_OUTPUT_PRICE_MICROS_PER_MILLION');
    const reservation: ModelCallReservation = {
      fingerprint: digest({
        source: snapshot.sourceSha256,
        snapshot: snapshot.fingerprint,
        samples: digest(messages),
        prompt: STRUCTURE_PROMPT_VERSION,
        schema: STRUCTURE_PLAN_SCHEMA_VERSION,
        endpoint: this.config.get('QWEN_BASE_URL'),
        model: this.config.get('QWEN_MODEL'),
        inputLimit: this.config.get('AI_INPUT_TOKEN_BUDGET'),
        outputLimit: this.config.get('QWEN_MAX_OUTPUT_TOKENS'),
        priceVersion: this.config.get('AI_PRICE_VERSION'),
        inputPrice,
        outputPrice,
      }),
      sourceHash: snapshot.sourceSha256,
      sampleHash: snapshot.fingerprint,
      promptVersion: STRUCTURE_PROMPT_VERSION,
      model: this.config.get('QWEN_MODEL'),
      schemaVersion: STRUCTURE_PLAN_SCHEMA_VERSION,
      inputTokenUpperBound: this.config.get('AI_INPUT_TOKEN_BUDGET'),
      maxOutputTokens: this.config.get('QWEN_MAX_OUTPUT_TOKENS'),
      reservedMicros: estimatedMicros(
        this.config.get('AI_INPUT_TOKEN_BUDGET'),
        this.config.get('QWEN_MAX_OUTPUT_TOKENS'),
        inputPrice,
        outputPrice,
      ),
      budgetMicros: this.config.get('AI_RUN_BUDGET_MICROS'),
      dailyBudgetMicros: this.config.get('AI_DAILY_BUDGET_MICROS'),
      ...(this.config.get('BUDGET_LIMITS_ENABLED') === false
        ? { budgetEnforced: false as const }
        : {}),
      priceVersion: this.config.get('AI_PRICE_VERSION'),
    };
    if (
      reservation.budgetEnforced !== false &&
      reservation.reservedMicros > reservation.budgetMicros
    )
      return fallback('AI_RUN_BUDGET_EXCEEDED');

    let call: ModelCallRecord;
    try {
      ({ call } = await this.repository.reserveModelCall(
        context.lease,
        reservation,
      ));
    } catch (error) {
      const codes: Record<string, string> = {
        MODEL_DAILY_BUDGET_EXCEEDED: 'AI_DAILY_BUDGET_EXCEEDED',
        MODEL_CALL_CONFLICT: 'AI_CONFIGURATION_CHANGED',
        STALE_PROCESSING_LEASE: 'AI_STALE_LEASE',
      };
      return fallback(
        error instanceof ProcessingError
          ? (codes[error.code] ?? 'AI_LEDGER_UNAVAILABLE')
          : 'AI_LEDGER_UNAVAILABLE',
      );
    }
    const result = (reasonCode: string): AiStructureResult => ({
      ...fallback(reasonCode),
      ...callSummary(call),
    });
    if (call.status === 'SUCCEEDED') {
      try {
        if (!call.resultKey || !call.resultHash || !call.resultByteSize)
          return result('AI_RESULT_UNAVAILABLE');
        const stored = await context.planStore.read({
          storageKey: call.resultKey,
          sha256: call.resultHash,
          byteSize: call.resultByteSize,
        });
        const plan = parseStructurePlan(stored, snapshot, true);
        return plan
          ? {
              status: 'APPLIED',
              reasonCode: 'AI_REUSED',
              ...callSummary(call),
              plan,
            }
          : result('AI_RESULT_UNAVAILABLE');
      } catch {
        return result('AI_RESULT_UNAVAILABLE');
      }
    }
    if (call.status === 'SENT' || call.status === 'UNKNOWN')
      return result('AI_UNKNOWN_OUTCOME');
    if (call.status !== 'RESERVED') return result('AI_PREVIOUS_CALL_FAILED');
    if (context.signal?.aborted) {
      await this.repository
        .failKnownModelCall(context.lease, call.id, 'AI_CANCELLED_BEFORE_SEND')
        .catch(() => false);
      return result('AI_CANCELLED');
    }
    try {
      // Only the winner of this persistent transition may make an HTTP request.
      if (!(await this.repository.beginModelCall(context.lease, call.id))) {
        const latest = await this.repository.getModelCall(context.lease);
        if (latest) call = latest;
        return result(
          latest?.reasonCode === 'MODEL_DAILY_BUDGET_EXCEEDED'
            ? 'AI_DAILY_BUDGET_EXCEEDED'
            : 'AI_CALL_NOT_STARTED',
        );
      }
    } catch {
      return result('AI_LEDGER_UNAVAILABLE');
    }

    try {
      const completion = await this.gateway.completeStructure(
        messages,
        context.signal,
      );
      let raw: unknown;
      try {
        raw = JSON.parse(completion.content) as unknown;
      } catch {
        throw new AiGatewayError('AI_INVALID_PLAN');
      }
      const plan = parseStructurePlan(raw, snapshot);
      if (!plan) throw new AiGatewayError('AI_INVALID_PLAN');
      if (context.signal?.aborted) throw new AiGatewayError('AI_CANCELLED');
      const stored = await context.planStore.write(plan);
      if (context.signal?.aborted) throw new AiGatewayError('AI_CANCELLED');
      const usage: ModelCallUsage | undefined = completion.usage;
      const cost = usage
        ? estimatedMicros(
            usage.inputTokens,
            usage.outputTokens,
            inputPrice,
            outputPrice,
          )
        : undefined;
      const committed = await this.repository.completeModelCall(
        context.lease,
        call.id,
        {
          resultKey: stored.storageKey,
          resultHash: stored.sha256,
          resultByteSize: stored.byteSize,
          finishReason: completion.finishReason,
          ...(completion.providerRequestId
            ? { providerRequestId: completion.providerRequestId }
            : {}),
          ...(usage ? { usage, estimatedCostMicros: cost } : {}),
        },
      );
      if (!committed) throw new AiGatewayError('AI_STALE_LEASE');
      return {
        status: 'APPLIED',
        reasonCode: 'AI_APPLIED',
        ...callSummary(call),
        plan,
        ...(usage ? { usage, estimatedCostMicros: cost } : {}),
      };
    } catch (error) {
      const reason =
        error instanceof AiGatewayError ? error.code : 'AI_RESULT_UNAVAILABLE';
      // Once SENT, even rejected/invalid output may have incurred provider cost.
      // Unknown is never cleared by retries, timeout cleanup or a zero estimate.
      await this.repository
        .markUnknownModelCall(
          context.lease,
          call.id,
          reason,
          error instanceof AiGatewayError ? error.diagnostic : undefined,
        )
        .catch(() => false);
      return result(reason);
    }
  }
}
