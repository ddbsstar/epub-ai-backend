import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

/** Local-disk coordination only. There is no business data in this database.
 * SQLite VFS locks are released by the OS when a process dies; no PID files or
 * stale-file unlink protocol can remove a newly acquired live lock.
 * DatabaseSync is synchronous, so busy waiting is explicitly disabled and all
 * retries yield to the event loop. No transaction mutates the SQLite database.
 * https://nodejs.org/download/release/v24.15.0/docs/api/sqlite.html
 * https://www.sqlite.org/lang_transaction.html
 */
export async function acquireSqliteFileLock(
  path: string,
  waitMs = 5000,
): Promise<() => Promise<void>> {
  const database = new DatabaseSync(path, {
    timeout: 0,
    allowExtension: false,
  });
  const start = Date.now();
  try {
    while (true) {
      try {
        database.exec('BEGIN IMMEDIATE');
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          database.close();
        };
      } catch (error) {
        const code = (error as { errcode?: number }).errcode;
        if ((code !== 5 && code !== 6) || Date.now() - start >= waitMs)
          throw error;
        await delay(15 + Math.floor(Math.random() * 20));
      }
    }
  } catch (error) {
    database.close();
    throw error;
  }
}
