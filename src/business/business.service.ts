import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rm, statfs } from 'node:fs/promises';
import { basename } from 'node:path';
import Busboy from 'busboy';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppConfig } from '../config/app-config.module.js';
import { ApiException } from '../common/http/api-exception.js';
import { ProcessingRepository } from '../processing/processing.repository.js';
import type { ProcessingRun } from '../processing/processing.types.js';
import { LocalArtifactStorage } from './artifact-storage.js';
import {
  businessError,
  exposeProcessingErrors,
  safeProcessingMessage,
} from './business-errors.js';
import type { BusinessRequest } from './business-access.js';
import { runAiView } from './business-ai-view.js';
import { typographySummarySchema } from './business-typography.js';
import { BetaMaintenanceService } from './beta-maintenance.service.js';

const exportInput = z
  .object({
    theme: z.enum(['reader-first', 'reader-editorial']),
    ai: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.theme !== 'reader-editorial' || value.ai !== true);
const idSchema = z.uuid();
const visibleSummary = z.object({
  chapters: z.number().int().nonnegative(),
  styledChapters: z.number().int().nonnegative(),
  preservedChapters: z.number().int().nonnegative(),
  bodyBytesPreserved: z.boolean(),
  formatErrors: z.number().int().nonnegative(),
  formatWarnings: z.number().int().nonnegative(),
  typography: typographySummarySchema.optional(),
});

@Injectable()
export class BusinessService {
  private uploads = 0;

  constructor(
    @Inject(AppConfig) private readonly config: AppConfig,
    @Inject(ProcessingRepository)
    private readonly repository: ProcessingRepository,
    @Inject(LocalArtifactStorage)
    private readonly storage: LocalArtifactStorage,
    @Inject(BetaMaintenanceService)
    private readonly beta: BetaMaintenanceService,
  ) {}

  async upload(request: BusinessRequest) {
    if (this.uploads >= 2) throw businessError('OWNER_ACTIVE_LIMIT', 429);
    this.uploads += 1;
    const id = randomUUID();
    const key = `sources/${id}.epub`;
    const maxBytes = this.config.get('PROCESSING_UPLOAD_MAX_MIB') * 1024 * 1024;
    const controller = new AbortController();
    let fileTask: Promise<{ sha256: string; byteSize: number }> | undefined;
    const aborted = () => controller.abort();
    request.once('aborted', aborted);
    const deadline = setTimeout(aborted, 120000);
    deadline.unref();
    try {
      await this.beta.ensureCapacity();
      await mkdir(this.config.get('PROCESSING_DATA_DIR'), { recursive: true });
      const disk = await statfs(this.config.get('PROCESSING_DATA_DIR'));
      if (disk.bavail * disk.bsize < maxBytes * 3)
        throw businessError('STORAGE_CAPACITY_EXCEEDED', 507);
      let originalName = '';
      let invalid: Error | undefined;
      let parser: ReturnType<typeof Busboy>;
      try {
        parser = Busboy({
          headers: request.headers,
          limits: { fileSize: maxBytes, files: 1, fields: 0, parts: 2 },
          defParamCharset: 'utf8',
        });
      } catch {
        throw businessError('INVALID_UPLOAD');
      }
      await new Promise<void>((resolve, reject) => {
        parser.on('file', (field, stream, info) => {
          originalName = basename((info.filename ?? '').replaceAll('\\', '/'))
            .normalize('NFC')
            .split('')
            .filter(
              (character) =>
                character.charCodeAt(0) >= 32 &&
                character.charCodeAt(0) !== 127,
            )
            .join('')
            .slice(0, 180);
          if (
            field !== 'file' ||
            !originalName.toLowerCase().endsWith('.epub')
          ) {
            invalid = businessError('INVALID_UPLOAD');
            stream.resume();
            return;
          }
          stream.once('limit', () => {
            invalid = businessError('UPLOAD_TOO_LARGE', 413);
          });
          fileTask = this.storage.storeStream(
            key,
            stream,
            maxBytes,
            controller.signal,
          );
          fileTask.catch((error: unknown) => {
            invalid =
              error instanceof ApiException
                ? error
                : businessError('UPLOAD_STORAGE_ERROR', 503);
            request.unpipe(parser);
            parser.destroy();
            request.resume();
            reject(invalid);
          });
        });
        parser.once('partsLimit', () => {
          invalid = businessError('INVALID_UPLOAD');
        });
        parser.once('filesLimit', () => {
          invalid = businessError('INVALID_UPLOAD');
        });
        parser.once('fieldsLimit', () => {
          invalid = businessError('INVALID_UPLOAD');
        });
        parser.once('error', () => reject(businessError('INVALID_UPLOAD')));
        parser.once('close', resolve);
        controller.signal.addEventListener(
          'abort',
          () => {
            parser.destroy();
            reject(businessError('INVALID_UPLOAD'));
          },
          { once: true },
        );
        request.pipe(parser);
      });
      const stored = fileTask ? await fileTask : undefined;
      if (invalid) throw invalid;
      if (!stored || !stored.byteSize) throw businessError('INVALID_UPLOAD');
      const file = await open(this.storage.path(key), 'r');
      try {
        const magic = Buffer.alloc(4);
        await file.read(magic, 0, 4, 0);
        if (!magic.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])))
          throw businessError('INVALID_EPUB');
      } finally {
        await file.close();
      }
      const book = await exposeProcessingErrors(() =>
        this.repository.createBook({
          ownerId: request.processingOwnerId,
          sourceKey: key,
          sourceHash: stored.sha256,
          byteSize: stored.byteSize,
          originalName,
        }),
      );
      return {
        id,
        bookId: book.id,
        originalName,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
      };
    } catch (error) {
      controller.abort();
      await fileTask?.catch(() => undefined);
      await rm(this.storage.path(key), { force: true });
      if (error instanceof Error && error.name === 'AbortError')
        throw businessError('INVALID_UPLOAD');
      throw error;
    } finally {
      clearTimeout(deadline);
      request.removeListener('aborted', aborted);
      this.uploads -= 1;
    }
  }

  capabilities() {
    return {
      typographyOnly: this.config.get('PROCESSING_PUBLIC_BETA_ENABLED'),
      uploadMaxMiB: this.config.get('PROCESSING_UPLOAD_MAX_MIB'),
      retentionHours: this.config.get('PROCESSING_PUBLIC_BETA_ENABLED')
        ? this.config.get('PROCESSING_BETA_RETENTION_HOURS')
        : null,
    };
  }

  async createExport(
    ownerId: string,
    bookId: string,
    input: unknown,
    idempotency: unknown,
  ) {
    this.assertId(bookId);
    const parsed = exportInput.safeParse(input);
    if (!parsed.success) throw businessError('INVALID_UPLOAD');
    if (
      this.config.get('PROCESSING_PUBLIC_BETA_ENABLED') &&
      (parsed.data.theme !== 'reader-editorial' || parsed.data.ai === true)
    )
      throw businessError('PROCESSING_DISABLED', 403);
    if (
      typeof idempotency !== 'string' ||
      !/^[a-zA-Z0-9_-]{8,100}$/.test(idempotency)
    )
      throw businessError('INVALID_IDEMPOTENCY_KEY');
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          bookId,
          theme: parsed.data.theme,
          ai: parsed.data.ai ?? 'default',
          pipelineVersion:
            parsed.data.theme === 'reader-editorial'
              ? 'reader-editorial-v1'
              : 'reader-first-v2',
          ...(parsed.data.theme === 'reader-editorial'
            ? { typographyProfile: 'editorial-1' }
            : {}),
        }),
      )
      .digest('hex');
    const useAi =
      parsed.data.theme !== 'reader-editorial' &&
      (parsed.data.ai ?? true) &&
      this.config.get('PROCESSING_AI_ENABLED');
    if (
      this.config.get('PROCESSING_PUBLIC_BETA_ENABLED') &&
      !(await this.repository.findRunByKey(ownerId, 'beautify', idempotency))
    )
      await this.beta.ensureCapacity();
    const created = await exposeProcessingErrors(() =>
      this.repository.createRun({
        ownerId,
        bookId,
        operation: 'beautify',
        idempotencyKey: idempotency,
        requestHash,
        configuration: {
          theme: parsed.data.theme,
          pipelineVersion:
            parsed.data.theme === 'reader-editorial'
              ? 'reader-editorial-v1'
              : 'reader-first-v2',
          ...(parsed.data.theme === 'reader-editorial'
            ? { typographyProfile: 'editorial-1' }
            : {}),
          ai: useAi,
        },
        stages: useAi
          ? ['analyze', 'process', 'validate', 'publish']
          : ['process', 'validate', 'publish'],
      }),
    );
    return this.runView(ownerId, created.run);
  }

  async getRun(ownerId: string, id: string) {
    this.assertId(id);
    return this.runView(
      ownerId,
      await exposeProcessingErrors(() => this.repository.getRun(ownerId, id)),
    );
  }

  async cancel(ownerId: string, id: string) {
    this.assertId(id);
    return this.runView(
      ownerId,
      await exposeProcessingErrors(() =>
        this.repository.requestCancel(ownerId, id),
      ),
    );
  }

  async getDownload(ownerId: string, id: string) {
    this.assertId(id);
    const artifact = await exposeProcessingErrors(() =>
      this.repository.getArtifact(ownerId, id),
    );
    const file = this.storage.path(artifact.storageKey);
    const described = await this.storage
      .describe(artifact.storageKey)
      .catch(() => {
        throw businessError('ARTIFACT_NOT_FOUND', 404);
      });
    if (
      described.sha256 !== artifact.sha256 ||
      described.byteSize !== artifact.byteSize
    )
      throw businessError('ARTIFACT_NOT_FOUND', 404);
    return { artifact, stream: createReadStream(file) };
  }

  private assertId(id: string) {
    if (!idSchema.safeParse(id).success)
      throw businessError('RUN_NOT_FOUND', 404);
  }

  private async runView(ownerId: string, run: ProcessingRun) {
    const book = await exposeProcessingErrors(() =>
      this.repository.getBook(ownerId, run.bookId),
    );
    const artifactUrls: {
      epub: string | null;
      report: string | null;
      cover: string | null;
    } = { epub: null, report: null, cover: null };
    if (run.status === 'SUCCEEDED')
      for (const id of run.artifactIds) {
        const artifact = await exposeProcessingErrors(() =>
          this.repository.getArtifact(ownerId, id),
        );
        const kind = artifact.kind === 'export' ? 'epub' : artifact.kind;
        if (kind === 'epub' || kind === 'report' || kind === 'cover')
          artifactUrls[kind] = `/api/v1/artifacts/${id}/download`;
      }
    const result = run.steps.find(
      (step) => step.stage === 'validate' && step.status === 'SUCCEEDED',
    )?.result;
    const parsed = z
      .object({
        title: z.string().nullable(),
        summary: visibleSummary,
        warnings: z.array(z.string()).max(100),
      })
      .safeParse(result);
    return {
      id: run.id,
      bookId: run.bookId,
      status: run.status,
      stage: run.stage,
      completedUnits: run.completedUnits,
      totalUnits: run.totalUnits,
      originalName: book.originalName,
      title: parsed.success ? parsed.data.title : null,
      artifacts: artifactUrls,
      summary: parsed.success ? parsed.data.summary : null,
      warnings: parsed.success ? parsed.data.warnings : [],
      ai: runAiView(run),
      error: run.errorCode
        ? { code: run.errorCode, message: safeProcessingMessage(run.errorCode) }
        : null,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  }
}
