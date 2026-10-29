import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicRename } from '../src/processing/atomic-rename.js';

const directories: string[] = [];
const errorWithCode = (code: string) =>
  Object.assign(new Error(code), { code });

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('atomic metadata rename', () => {
  it.each(['EPERM', 'EBUSY'])(
    'retries a transient Windows %s using exactly the same prepared paths',
    async (code) => {
      const error = errorWithCode(code);
      const rename = vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue(undefined);
      const sleep = vi.fn().mockResolvedValue(undefined);
      await atomicRename('prepared.tmp', 'state.json', {
        platform: 'win32',
        rename,
        sleep,
      });
      expect(rename.mock.calls).toEqual([
        ['prepared.tmp', 'state.json'],
        ['prepared.tmp', 'state.json'],
      ]);
      expect(sleep.mock.calls).toEqual([[10]]);
    },
  );

  it.each(['linux', 'darwin'] as const)(
    'does not retry even EPERM on %s',
    async (platform) => {
      const error = errorWithCode('EPERM');
      const rename = vi.fn().mockRejectedValue(error);
      const sleep = vi.fn();
      await expect(
        atomicRename('prepared.tmp', 'state.json', { platform, rename, sleep }),
      ).rejects.toBe(error);
      expect(rename).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it.each(['ENOENT', 'EACCES', 'EXDEV', 'ENOSPC'])(
    'immediately preserves Windows %s without retrying',
    async (code) => {
      const error = errorWithCode(code);
      const rename = vi.fn().mockRejectedValue(error);
      const sleep = vi.fn();
      await expect(
        atomicRename('prepared.tmp', 'state.json', {
          platform: 'win32',
          rename,
          sleep,
        }),
      ).rejects.toBe(error);
      expect(rename).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it('caps retries below one second and returns the final native failure unchanged', async () => {
    const errors = Array.from({ length: 7 }, () => errorWithCode('EBUSY'));
    let attempt = 0;
    const rename = vi
      .fn()
      .mockImplementation(() => Promise.reject(errors[attempt++]));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      atomicRename('prepared.tmp', 'state.json', {
        platform: 'win32',
        rename,
        sleep,
      }),
    ).rejects.toBe(errors[6]);
    expect(rename).toHaveBeenCalledTimes(7);
    expect(sleep.mock.calls).toEqual([[10], [20], [40], [80], [160], [320]]);
    expect(
      sleep.mock.calls.reduce((sum, call) => sum + Number(call[0]), 0),
    ).toBe(630);
  });

  it('stops immediately if a retry encounters a permanent error', async () => {
    const finalError = errorWithCode('ENOENT');
    const rename = vi
      .fn()
      .mockRejectedValueOnce(errorWithCode('EPERM'))
      .mockRejectedValue(finalError);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      atomicRename('prepared.tmp', 'state.json', {
        platform: 'win32',
        rename,
        sleep,
      }),
    ).rejects.toBe(finalError);
    expect(rename).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('replaces a real destination atomically and consumes only the prepared temporary file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atomic-state-write-test-'));
    directories.push(directory);
    const sourcePath = join(directory, 'prepared.tmp');
    const destinationPath = join(directory, 'state.json');
    await writeFile(sourcePath, 'new-state');
    await writeFile(destinationPath, 'old-state');
    await atomicRename(sourcePath, destinationPath);
    expect(await readFile(destinationPath, 'utf8')).toBe('new-state');
    expect(await readdir(directory)).toEqual(['state.json']);
  });
});
