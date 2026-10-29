import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessingRepository } from '../src/processing/processing.repository.js';
import { LocalProcessingPersistence } from '../src/processing/local-processing.persistence.js';

it('fences sub-unit checkpoint writes and keeps the coarse-stage cursor valid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'epub-progress-'));
  let now = Date.now();
  const repo = new ProcessingRepository(
    new LocalProcessingPersistence(root),
    () => now,
  );
  try {
    const book = await repo.createBook({
      ownerId: 'owner',
      sourceKey: 'source.epub',
      sourceHash: 'a'.repeat(64),
      byteSize: 1,
      originalName: 'test.epub',
    });
    const { run } = await repo.createRun({
      ownerId: 'owner',
      bookId: book.id,
      operation: 'illustration-conversion',
      idempotencyKey: 'checkpoint',
      requestHash: 'b'.repeat(64),
      configuration: {},
      stages: ['convert', 'assemble'],
    });
    const payload = {
      payloadVersion: 1,
      runId: run.id,
      stepId: run.steps[0]!.id,
      dispatchGeneration: 1,
    };
    const first = (await repo.claim(payload, 'worker-a', 5000))!;
    expect(
      await repo.checkpointStep(first.lease, { progress: 'old' }, 1, 20),
    ).toBe(true);
    expect((await repo.getRun('owner', run.id)).completedUnits).toBe(0);
    now += 6000;
    await repo.recoverExpired();
    const recovered = (await repo.listDispatchable())[0]!;
    const second = (await repo.claim(recovered, 'worker-b', 5000))!;
    expect(
      await repo.checkpointStep(first.lease, { progress: 'stale' }, 2, 20),
    ).toBe(false);
    expect(
      await repo.checkpointStep(second.lease, { progress: 'new' }, 2, 20),
    ).toBe(true);
    expect(await repo.completeStep(second.lease, { progress: 'final' })).toBe(
      true,
    );
    const progressed = await repo.getRun('owner', run.id);
    expect(progressed.stage).toBe('assemble');
    expect(progressed.completedUnits).toBe(1);
    expect(progressed.steps[0]!.result).toEqual({ progress: 'final' });
    const last = (await repo.listDispatchable())[0]!;
    const claim = (await repo.claim(last, 'worker-b', 5000))!;
    await repo.requestCancel('owner', run.id);
    expect(
      await repo.checkpointStep(
        claim.lease,
        { progress: 'after-cancel' },
        20,
        20,
      ),
    ).toBe(false);
  } finally {
    await repo.close();
    await rm(root, { recursive: true, force: true });
  }
});
