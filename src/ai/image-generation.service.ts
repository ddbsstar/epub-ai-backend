import { createHash } from 'node:crypto';
import { mkdir, readFile, lstat, writeFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppConfig } from '../config/app-config.module.js';
import { ImageProviderService } from './image-provider.service.js';
import {
  ImageProviderError,
  type ImageGenerationResult,
} from './image-provider.types.js';
import { ImageAssetError, ImageAssetService } from './image-asset.service.js';
import {
  ImageCallLedger,
  ImageCallLedgerError,
  type ImageCall,
} from './image-call-ledger.js';

const requestSchema = z
  .object({
    ownerId: z.string().regex(/^[a-zA-Z0-9._:-]{1,100}$/),
    operationId: z.string().regex(/^[a-zA-Z0-9._:-]{1,100}$/),
    callKey: z.string().regex(/^[a-zA-Z0-9._:-]{1,100}$/),
    prompt: z.string(),
  })
  .strict();

export type GenerateImageRequest = z.infer<typeof requestSchema>;

const providerCheckpoint = z
  .object({
    schemaVersion: z.literal(1),
    callId: z.string().uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    imageUrl: z.string().min(1).max(8192),
    providerRequestId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,128}$/)
      .optional(),
  })
  .strict();

export class ImageGenerationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ImageGenerationError';
  }
}

/** Internal service only. No arbitrary-prompt HTTP controller is registered. */
@Injectable()
export class ImageGenerationService {
  constructor(
    @Inject(AppConfig) private readonly config: AppConfig,
    @Inject(ImageProviderService)
    private readonly provider: ImageProviderService,
    @Inject(ImageAssetService) private readonly assets: ImageAssetService,
    @Inject(ImageCallLedger) private readonly ledger: ImageCallLedger,
  ) {}

  async generateOne(input: GenerateImageRequest, signal?: AbortSignal) {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) throw new ImageGenerationError('IMAGE_INVALID_INPUT');
    const request = parsed.data;
    this.provider.validate({ prompt: request.prompt, signal });
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          schemaVersion: 'text-image-request-1',
          provider: this.config.get('IMAGE_API_BASE_URL'),
          model: this.config.get('IMAGE_MODEL'),
          size: this.config.get('IMAGE_SIZE'),
          prompt: request.prompt,
          promptExtend: false,
          priceMicros: this.config.get('IMAGE_PRICE_MICROS'),
          priceVersion: this.config.get('IMAGE_PRICE_VERSION'),
        }),
      )
      .digest('hex');
    const reservation = this.ledger.reserve({
      ownerId: request.ownerId,
      operationId: request.operationId,
      callKey: request.callKey,
      fingerprint,
      model: this.config.get('IMAGE_MODEL'),
      priceVersion: this.config.get('IMAGE_PRICE_VERSION'),
      priceMicros: this.config.get('IMAGE_PRICE_MICROS'),
      operationBudgetMicros: this.config.get('IMAGE_OPERATION_BUDGET_MICROS'),
      dailyBudgetMicros: this.config.get('IMAGE_DAILY_BUDGET_MICROS'),
    });
    if (reservation.reused) {
      if (reservation.call.status === 'SUCCEEDED')
        return this.receipt(reservation.call, true);
      if (
        reservation.call.status === 'UNKNOWN' &&
        reservation.call.providerResult
      ) {
        const result = await this.readProviderCheckpoint(reservation.call);
        const resumed = this.ledger.resumeDownload(
          reservation.call.id,
          fingerprint,
        );
        try {
          return await this.finishAsset(
            resumed.call,
            resumed.claimToken,
            result,
            true,
            signal,
          );
        } catch (error) {
          return this.fail(resumed.call.id, resumed.claimToken, error, signal);
        }
      }
      throw new ImageGenerationError(
        reservation.call.status === 'UNKNOWN'
          ? 'IMAGE_CALL_OUTCOME_UNKNOWN'
          : reservation.call.status === 'CANCELLED'
            ? 'IMAGE_CALL_CANCELLED'
            : 'IMAGE_CALL_IN_PROGRESS',
      );
    }
    const token = reservation.claimToken;
    if (!token) throw new ImageGenerationError('IMAGE_CALL_STALE');
    this.ledger.begin(reservation.call.id, token);
    try {
      const result = await this.provider.generate({
        prompt: request.prompt,
        signal,
      });
      const pendingKey = `pending/${reservation.call.id}.json`;
      const pendingPath = this.privatePath(pendingKey);
      const bytes = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          callId: reservation.call.id,
          fingerprint,
          imageUrl: result.imageUrl,
          ...(result.providerRequestId
            ? { providerRequestId: result.providerRequestId }
            : {}),
        }),
      );
      await mkdir(dirname(pendingPath), { recursive: true, mode: 0o700 });
      await writeFile(pendingPath, bytes, { flag: 'wx', mode: 0o600 });
      const checkpointed = this.ledger.recordProviderResult(
        reservation.call.id,
        token,
        {
          relativeKey: pendingKey,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
        result.providerRequestId,
      );
      return await this.finishAsset(checkpointed, token, result, false, signal);
    } catch (error) {
      return this.fail(reservation.call.id, token, error, signal);
    }
  }

  private fail(
    id: string,
    token: string,
    error: unknown,
    signal?: AbortSignal,
  ): never {
    const code =
      error instanceof ImageProviderError ||
      error instanceof ImageAssetError ||
      error instanceof ImageCallLedgerError ||
      error instanceof ImageGenerationError
        ? error.code
        : signal?.aborted
          ? 'IMAGE_CANCELLED'
          : 'IMAGE_GENERATION_FAILED';
    // Any post-SENT error may already have incurred a charge, even cancellation.
    try {
      this.ledger.markUnknown(
        id,
        token,
        code,
        error instanceof ImageProviderError ? error.diagnostic : undefined,
      );
    } catch {
      // Fenced expiry/recovery owns the row; never overwrite a newer claim.
    }
    throw new ImageGenerationError(code);
  }

  private privatePath(key: string): string {
    const root = this.config.get('IMAGE_DATA_DIR');
    if (
      !root ||
      !isAbsolute(root) ||
      !/^(?:assets\/[a-zA-Z0-9-]+\.png|pending\/[a-zA-Z0-9-]+\.json)$/.test(key)
    )
      throw new ImageGenerationError('IMAGE_ASSET_UNAVAILABLE');
    const target = resolve(root, key);
    const within = relative(resolve(root), target);
    if (!within || within.startsWith(`..${sep}`) || isAbsolute(within))
      throw new ImageGenerationError('IMAGE_ASSET_UNAVAILABLE');
    return target;
  }

  private async readProviderCheckpoint(
    call: ImageCall,
  ): Promise<ImageGenerationResult> {
    try {
      const reference = call.providerResult;
      if (!reference || reference.relativeKey !== `pending/${call.id}.json`)
        throw new Error();
      const path = this.privatePath(reference.relativeKey);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16384)
        throw new Error();
      const bytes = await readFile(path);
      if (createHash('sha256').update(bytes).digest('hex') !== reference.sha256)
        throw new Error();
      const value = providerCheckpoint.parse(
        JSON.parse(bytes.toString('utf8')),
      );
      if (value.callId !== call.id || value.fingerprint !== call.fingerprint)
        throw new Error();
      return {
        imageUrl: value.imageUrl,
        imageCount: 1,
        ...(value.providerRequestId
          ? { providerRequestId: value.providerRequestId }
          : {}),
      };
    } catch {
      throw new ImageGenerationError('IMAGE_PROVIDER_CHECKPOINT_INVALID');
    }
  }

  private async finishAsset(
    call: ImageCall,
    token: string,
    result: ImageGenerationResult,
    reused: boolean,
    signal?: AbortSignal,
  ) {
    const asset = await this.assets.download(result.imageUrl, signal);
    signal?.throwIfAborted();
    if (asset.width !== 1024 || asset.height !== 1024)
      throw new ImageGenerationError('IMAGE_DIMENSIONS_MISMATCH');
    const relativeKey = `assets/${call.id}.png`;
    const target = this.privatePath(relativeKey);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    try {
      await writeFile(target, asset.bytes, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A crash after file creation may leave the exact immutable asset behind.
      await this.verifyFile(target, asset.byteSize, asset.sha256);
    }
    signal?.throwIfAborted();
    const completed = this.ledger.succeed(
      call.id,
      token,
      {
        relativeKey,
        sha256: asset.sha256,
        byteSize: asset.byteSize,
        width: asset.width,
        height: asset.height,
      },
      result.providerRequestId,
    );
    if (call.providerResult)
      await rm(this.privatePath(call.providerResult.relativeKey), {
        force: true,
      }).catch(() => undefined);
    return this.receipt(completed, reused);
  }

  private async verifyFile(path: string, size: number, expectedHash: string) {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== size ||
      size > this.config.get('IMAGE_MAX_BYTES')
    )
      throw new ImageGenerationError('IMAGE_ASSET_UNAVAILABLE');
    const hash = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
    if (hash !== expectedHash)
      throw new ImageGenerationError('IMAGE_ASSET_UNAVAILABLE');
  }

  private async receipt(call: ImageCall, reused: boolean) {
    const asset = call.asset;
    if (!asset || call.status !== 'SUCCEEDED')
      throw new ImageGenerationError('IMAGE_ASSET_UNAVAILABLE');
    if (asset.relativeKey !== `assets/${call.id}.png`)
      throw new ImageGenerationError('IMAGE_ASSET_UNAVAILABLE');
    const path = this.privatePath(asset.relativeKey);
    try {
      await this.verifyFile(path, asset.byteSize, asset.sha256);
    } catch {
      throw new ImageGenerationError('IMAGE_ASSET_UNAVAILABLE');
    }
    return {
      callId: call.id,
      reused,
      model: call.model,
      generationMode: 'text-to-image' as const,
      imageCount: 1 as const,
      estimatedCostMicros: call.priceMicros,
      currency: 'CNY' as const,
      budgetStatus: call.budgetStatus,
      priceVersion: call.priceVersion,
      ...(call.providerRequestId
        ? { providerRequestId: call.providerRequestId }
        : {}),
      asset: {
        path,
        sha256: asset.sha256,
        byteSize: asset.byteSize,
        width: asset.width,
        height: asset.height,
        mediaType: 'image/png' as const,
      },
    };
  }
}
