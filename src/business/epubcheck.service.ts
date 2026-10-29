import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppConfig } from '../config/app-config.module.js';
import { ProcessingError } from '../processing/processing.types.js';

const checkResult = z.object({
  checker: z.object({
    checkerVersion: z.string(),
    nFatal: z.number().int().nonnegative(),
    nError: z.number().int().nonnegative(),
    nWarning: z.number().int().nonnegative(),
  }),
  messages: z
    .array(
      z.object({
        ID: z.string(),
        severity: z.string(),
        message: z.string(),
        locations: z
          .array(z.object({ path: z.string().optional() }))
          .optional(),
      }),
    )
    .max(10000),
});

export interface FormatCheck {
  checkerVersion: string;
  errors: number;
  warnings: number;
  fatal: number;
  errorSignatures: string[];
}

@Injectable()
export class EpubCheckService {
  constructor(@Inject(AppConfig) private readonly config: AppConfig) {}

  async check(
    sourcePath: string,
    reportPath: string,
    signal: AbortSignal,
  ): Promise<FormatCheck> {
    signal.throwIfAborted();
    let timedOut = false;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        this.config.get('EPUBCHECK_JAVA_PATH'),
        [
          '-Xmx256m',
          '-jar',
          this.config.get('EPUBCHECK_JAR_PATH'),
          sourcePath,
          '--json',
          reportPath,
        ],
        { shell: false, windowsHide: true, stdio: 'ignore' },
      );
      const stop = () => child.kill('SIGKILL');
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, this.config.get('EPUBCHECK_TIMEOUT_MS'));
      timer.unref();
      signal.addEventListener('abort', stop, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
      };
      child.once('error', () => {
        cleanup();
        reject(new ProcessingError('EPUBCHECK_UNAVAILABLE', 503));
      });
      child.once('close', (code) => {
        cleanup();
        if (signal.aborted) {
          reject(new ProcessingError('PROCESSING_CANCELLED'));
          return;
        }
        if (timedOut) {
          reject(new ProcessingError('EPUBCHECK_TIMEOUT', 504));
          return;
        }
        // EPUBCheck nonzero also represents validation failures. Parse its report.
        if (code === null) {
          reject(new ProcessingError('EPUBCHECK_UNAVAILABLE', 503));
          return;
        }
        resolve();
      });
    });
    try {
      if ((await stat(reportPath)).size > 8 * 1024 * 1024)
        throw new Error('report size');
      const data = checkResult.parse(
        JSON.parse(await readFile(reportPath, 'utf8')),
      );
      return {
        checkerVersion: data.checker.checkerVersion,
        errors: data.checker.nError,
        warnings: data.checker.nWarning,
        fatal: data.checker.nFatal,
        errorSignatures: data.messages
          .filter(
            (value) => value.severity === 'ERROR' || value.severity === 'FATAL',
          )
          .map((value) =>
            JSON.stringify([
              value.ID,
              value.message,
              value.locations?.map((location) => location.path ?? '').sort() ??
                [],
            ]),
          )
          .sort(),
      };
    } catch {
      throw new ProcessingError('EPUBCHECK_UNAVAILABLE', 503);
    }
  }
}

export function assertNoNewFormatErrors(
  before: FormatCheck,
  after: FormatCheck,
): void {
  if (before.fatal || after.fatal || after.errors > before.errors)
    throw new ProcessingError('VALIDATION_FAILED');
  const remaining = [...before.errorSignatures];
  for (const signature of after.errorSignatures) {
    const index = remaining.indexOf(signature);
    if (index < 0) throw new ProcessingError('VALIDATION_FAILED');
    remaining.splice(index, 1);
  }
}
