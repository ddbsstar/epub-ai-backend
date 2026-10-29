import { rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const WINDOWS_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320] as const;

export interface AtomicRenameOptions {
  /** Dependency injection for deterministic tests; production uses this process. */
  platform?: NodeJS.Platform;
  rename?: (sourcePath: string, destinationPath: string) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Atomically replace a destination using the SAME prepared temporary file.
 * Windows scanners/readers can briefly deny rename even while the writer owns
 * its application lock. Retry only EPERM/EBUSY for at most 630 ms of backoff.
 * This never deletes the destination, copies bytes, or repeats the caller's work.
 * Every permanent failure is rethrown unchanged, including the final attempt.
 */
export async function atomicRename(
  sourcePath: string,
  destinationPath: string,
  options: AtomicRenameOptions = {},
): Promise<void> {
  const operation = options.rename ?? rename;
  const sleep = options.sleep ?? delay;
  const platform = options.platform ?? process.platform;
  for (let attempt = 0; ; attempt++) {
    try {
      await operation(sourcePath, destinationPath);
      return;
    } catch (error) {
      const code =
        error !== null && typeof error === 'object' && 'code' in error
          ? error.code
          : undefined;
      if (
        platform !== 'win32' ||
        (code !== 'EPERM' && code !== 'EBUSY') ||
        attempt >= WINDOWS_RETRY_DELAYS_MS.length
      )
        throw error;
      await sleep(WINDOWS_RETRY_DELAYS_MS[attempt]);
    }
  }
}
