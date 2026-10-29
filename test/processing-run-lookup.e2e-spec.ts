import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { LocalProcessingPersistence } from '../src/processing/local-processing.persistence.js';
import { PrismaProcessingPersistence } from '../src/processing/prisma-processing.persistence.js';
import { ProcessingRepository } from '../src/processing/processing.repository.js';
import type {
  ProcessingBook,
  ProcessingRun,
} from '../src/processing/processing.types.js';

describe('read-only canonical processing run lookup', () => {
  let directory: string;
  let persistence: LocalProcessingPersistence;
  let repository: ProcessingRepository;
  let book: ProcessingBook;
  let run: ProcessingRun;
  const operation = 'illustration-export';
  const key = 'illustration-export:9165016e-097b-4534-a8c1-934f8063b0ac';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'epub-run-lookup-'));
    persistence = new LocalProcessingPersistence(directory);
    repository = new ProcessingRepository(persistence);
    book = await repository.createBook({
      ownerId: 'owner-a',
      sourceKey: 'sources/test.epub',
      sourceHash: 'a'.repeat(64),
      byteSize: 2048,
      originalName: 'test.epub',
    });
    run = (
      await repository.createRun({
        ownerId: book.ownerId,
        bookId: book.id,
        operation,
        idempotencyKey: key,
        requestHash: 'b'.repeat(64),
        configuration: { planId: '9165016e-097b-4534-a8c1-934f8063b0ac' },
        stages: ['illustration-export'],
      })
    ).run;
  });

  afterEach(async () => {
    await repository.close();
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('recovers an accepted POST after response loss without changing or dispatching work', async () => {
    const statePath = join(directory, 'metadata', 'state.json');
    const before = await readFile(statePath);
    const reopened = new ProcessingRepository(
      new LocalProcessingPersistence(directory),
    );
    try {
      expect(await reopened.findRunByKey(book.ownerId, operation, key)).toEqual(
        run,
      );
      expect(await reopened.findRunByKey(book.ownerId, operation, key)).toEqual(
        run,
      );
      expect(await readFile(statePath)).toEqual(before);
      expect(
        (await reopened.getRun(book.ownerId, run.id)).steps[0],
      ).toMatchObject({
        status: 'PENDING',
        attempt: 0,
        leaseVersion: 0,
        workerId: null,
      });
    } finally {
      await reopened.close();
    }
  });

  it.each([
    ['other-owner', operation, key],
    ['owner-a', 'illustration-plan', key],
    ['owner-a', operation, `${key}-missing`],
  ])(
    'does not disclose a run under mismatched tuple %s/%s/%s',
    async (...tuple) => {
      expect(await repository.findRunByKey(...tuple)).toBeNull();
    },
  );

  it('does not trust a persistence record with different tuple fields', async () => {
    const lookup = vi.spyOn(persistence, 'findRunByKey');
    for (const changed of [
      { ownerId: 'another-owner' },
      { operation: 'beautify' },
      { idempotencyKey: 'another-request' },
    ]) {
      lookup.mockResolvedValueOnce({ ...run, ...changed });
      expect(
        await repository.findRunByKey(book.ownerId, operation, key),
      ).toBeNull();
    }
  });

  it.each([
    { deletedAt: '2026-10-22T00:00:00.000Z' },
    { ownerId: 'another-owner' },
  ])('checks the referenced book is still accessible: %j', async (changed) => {
    vi.spyOn(persistence, 'getBook').mockResolvedValue({ ...book, ...changed });
    await expect(
      repository.findRunByKey(book.ownerId, operation, key),
    ).rejects.toMatchObject({ code: 'BOOK_NOT_FOUND' });
  });

  it.each([
    ['', operation, key],
    ['owner-a', 'INVALID OPERATION', key],
    ['owner-a', operation, ''],
    ['owner-a', operation, 'key with spaces'],
  ])('rejects an invalid lookup tuple %s/%s/%s', async (...tuple) => {
    const lookup = vi.spyOn(persistence, 'findRunByKey');
    await expect(repository.findRunByKey(...tuple)).rejects.toMatchObject({
      code: 'INVALID_RUN_INPUT',
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('uses the existing exact MySQL unique key and performs no mutation', async () => {
    const findUnique = vi.fn().mockResolvedValue({ record: run });
    const adapter = new PrismaProcessingPersistence({
      processingRun: { findUnique },
    } as unknown as PrismaClient);
    const found = await adapter.findRunByKey(book.ownerId, operation, key);
    expect(found).toEqual(run);
    expect(found).not.toBe(run);
    expect(findUnique).toHaveBeenCalledExactlyOnceWith({
      where: {
        ownerId_operation_idempotencyKey: {
          ownerId: book.ownerId,
          operation,
          idempotencyKey: key,
        },
      },
    });
    findUnique.mockResolvedValueOnce(null);
    expect(await adapter.findRunByKey(book.ownerId, operation, key)).toBeNull();
  });
});
