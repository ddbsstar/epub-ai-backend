import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AiService } from '../src/ai/ai.service.js';
import {
  AiStructureService,
  estimatedMicros,
} from '../src/ai/ai-structure.service.js';
import {
  parseStructurePlan,
  structureMessages,
} from '../src/ai/ai-structure-plan.js';
import type { AiPlanStore } from '../src/ai/ai-structure.types.js';
import type { AppConfig } from '../src/config/app-config.module.js';
import {
  validateEnvironment,
  type Environment,
} from '../src/config/environment.js';
import type {
  EpubStructurePlan,
  EpubStructureSnapshot,
} from '../src/documents/epub.types.js';
import { LocalProcessingPersistence } from '../src/processing/local-processing.persistence.js';
import { ProcessingRepository } from '../src/processing/processing.repository.js';
import type { StepLease } from '../src/processing/processing.types.js';

const snapshot: EpubStructureSnapshot = {
  schemaVersion: 1,
  analyzerVersion: 'structure-samples-1',
  sourceSha256: 'a'.repeat(64),
  fingerprint: 'b'.repeat(64),
  blocks: [
    {
      id: 'sample-1',
      documentPath: 'OPS/private-document.xhtml',
      position: { childIndex: 1, start: 1, end: 2 },
      contentSha256: 'c'.repeat(64),
      excerpt: 'private-book-text-marker',
      originalClass: 'quotation',
      allowedRoles: ['body', 'quote'],
    },
    {
      id: 'sample-2',
      documentPath: 'OPS/private-document.xhtml',
      position: { childIndex: 2, start: 3, end: 4 },
      contentSha256: 'd'.repeat(64),
      excerpt: 'Ordinary dialogue is body.',
      originalClass: '',
      allowedRoles: ['body'],
    },
  ],
  truncated: false,
};
const validRoles = {
  roles: [
    { id: 'sample-1', role: 'quote' },
    { id: 'sample-2', role: 'body' },
  ],
};

function upstream(
  roles: unknown = validRoles,
  options: { usage?: boolean; finish?: string; raw?: string } = {},
) {
  return new Response(
    JSON.stringify({
      id: 'completion-test',
      choices: [
        {
          finish_reason: options.finish ?? 'stop',
          message: { content: options.raw ?? JSON.stringify(roles) },
        },
      ],
      ...(options.usage === false
        ? {}
        : {
            usage: {
              prompt_tokens: 100,
              completion_tokens: 50,
              total_tokens: 150,
            },
          }),
    }),
    { status: 200 },
  );
}

describe('controlled structure analysis (no paid calls)', () => {
  let directory: string;
  let repository: ProcessingRepository;
  let lease: StepLease;
  let now: number;
  let stored: EpubStructurePlan | undefined;
  let planStore: AiPlanStore;

  function config(extra: Record<string, unknown> = {}): AppConfig {
    const environment = validateEnvironment({
      NODE_ENV: 'test',
      PROCESSING_ENABLED: true,
      PROCESSING_DATA_DIR: directory,
      EPUBCHECK_JAR_PATH: join(directory, 'epubcheck.jar'),
      PROCESSING_AI_ENABLED: true,
      QWEN_ENABLED: true,
      QWEN_API_KEY: 'private-placeholder-key',
      QWEN_BASE_URL: 'https://example.com/v1',
      QWEN_MODEL: 'qwen3.8-flash',
      ...extra,
    });
    return {
      get: <K extends keyof Environment>(key: K) => environment[key],
    } as AppConfig;
  }
  function service(extra: Record<string, unknown> = {}) {
    const settings = config(extra);
    return new AiStructureService(
      settings,
      repository,
      new AiService(settings),
    );
  }
  async function newLease(owner = 'owner-a'): Promise<StepLease> {
    const book = await repository.createBook({
      ownerId: owner,
      sourceKey: 'sources/example.epub',
      sourceHash: snapshot.sourceSha256,
      byteSize: 100,
      originalName: 'sample.epub',
    });
    const { run } = await repository.createRun({
      ownerId: owner,
      bookId: book.id,
      operation: 'beautify',
      idempotencyKey: 'request-1',
      requestHash: 'e'.repeat(64),
      configuration: {},
      stages: ['analyze', 'process', 'publish'],
    });
    const claim = await repository.claim(
      {
        payloadVersion: 1,
        runId: run.id,
        stepId: run.steps[0]!.id,
        dispatchGeneration: 1,
      },
      'worker-test',
      120000,
    );
    return claim!.lease;
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'epub-ai-boundary-'));
    now = Date.now();
    repository = new ProcessingRepository(
      new LocalProcessingPersistence(directory),
      () => now,
    );
    lease = await newLease();
    stored = undefined;
    planStore = {
      async write(plan) {
        stored = plan;
        const bytes = Buffer.from(JSON.stringify(plan));
        return {
          storageKey: 'private/plan.json',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          byteSize: bytes.length,
        };
      },
      async read() {
        return stored;
      },
    };
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await repository.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('persists SENT before fetch, applies a complete plan and reuses it without another call', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      expect((await repository.getModelCall(lease))!.status).toBe('SENT');
      return upstream();
    });
    vi.stubGlobal('fetch', fetchMock);
    const analysis = service();
    const result = await analysis.analyze(snapshot, { lease, planStore });
    expect(result).toMatchObject({
      status: 'APPLIED',
      reasonCode: 'AI_APPLIED',
      reservedMicros: 31744,
      estimatedCostMicros: 215,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      plan: {
        sourceSha256: snapshot.sourceSha256,
        snapshotFingerprint: snapshot.fingerprint,
        roles: validRoles.roles,
      },
    });
    expect(await repository.getModelCall(lease)).toMatchObject({
      status: 'SUCCEEDED',
      budgetDisposition: 'SETTLED',
      resultKey: 'private/plan.json',
    });
    const retry = await analysis.analyze(snapshot, { lease, planStore });
    expect(retry).toMatchObject({ status: 'APPLIED', reasonCode: 'AI_REUSED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const metadata = await readFile(
      join(directory, 'metadata', 'state.json'),
      'utf8',
    );
    expect(metadata).not.toContain('private-book-text-marker');
    expect(metadata).not.toContain('private-placeholder-key');
    expect(metadata).not.toContain('private-document.xhtml');
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(request.body as string);
    expect(body).toMatchObject({
      enable_thinking: false,
      response_format: { type: 'json_object' },
      max_tokens: 2048,
      stream: false,
    });
    expect(body.messages[1].content).not.toContain('private-document.xhtml');
    expect(request.redirect).toBe('error');
    expect(estimatedMicros(32768, 2048, 800000, 2700000)).toBe(31744);
  });

  it('keeps the reservation held when a valid response omits usage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(upstream(validRoles, { usage: false })),
    );
    expect(
      await service().analyze(snapshot, { lease, planStore }),
    ).toMatchObject({ status: 'APPLIED' });
    expect(await repository.getModelCall(lease)).toMatchObject({
      status: 'SUCCEEDED',
      budgetDisposition: 'HELD',
      usage: null,
      estimatedCostMicros: null,
    });
  });

  it.each([
    ['unknown fields', { ...validRoles, css: 'body{color:red}' }],
    [
      'unknown ids',
      { roles: [{ id: 'injected', role: 'quote' }, validRoles.roles[1]] },
    ],
    ['duplicate ids', { roles: [validRoles.roles[0], validRoles.roles[0]] }],
    ['missing ids', { roles: [validRoles.roles[0]] }],
    [
      'disallowed role',
      { roles: [validRoles.roles[0], { id: 'sample-2', role: 'quote' }] },
    ],
  ])(
    'rejects %s without billing retries or partial application',
    async (_label, invalid) => {
      const fetchMock = vi.fn().mockResolvedValue(upstream(invalid));
      vi.stubGlobal('fetch', fetchMock);
      const analysis = service();
      expect(
        await analysis.analyze(snapshot, { lease, planStore }),
      ).toMatchObject({
        status: 'FALLBACK',
        reasonCode: 'AI_INVALID_PLAN',
      });
      expect(stored).toBeUndefined();
      expect(await repository.getModelCall(lease)).toMatchObject({
        status: 'UNKNOWN',
        budgetDisposition: 'HELD',
        estimatedCostMicros: null,
      });
      expect(
        await analysis.analyze(snapshot, { lease, planStore }),
      ).toMatchObject({
        status: 'FALLBACK',
        reasonCode: 'AI_UNKNOWN_OUTCOME',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('marks network errors UNKNOWN and does not resend after lease recovery', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error('secret-upstream-marker'));
    vi.stubGlobal('fetch', fetchMock);
    const analysis = service();
    expect(
      await analysis.analyze(snapshot, { lease, planStore }),
    ).toMatchObject({ reasonCode: 'AI_UPSTREAM_ERROR' });
    now += 120001;
    await repository.recoverExpired();
    const payload = (await repository.listDispatchable())[0]!;
    const reclaimed = (await repository.claim(
      payload,
      'worker-recovered',
      120000,
    ))!;
    const recovered = await analysis.analyze(snapshot, {
      lease: reclaimed.lease,
      planStore,
    });
    expect(recovered).toMatchObject({ reasonCode: 'AI_UNKNOWN_OUTCOME' });
    expect(JSON.stringify(recovered)).not.toContain('secret-upstream-marker');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps truncation and HTTP errors conservative with one attempt', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(upstream(validRoles, { finish: 'length' })),
    );
    expect(
      await service().analyze(snapshot, { lease, planStore }),
    ).toMatchObject({ reasonCode: 'AI_TRUNCATED' });
    expect((await repository.getModelCall(lease))!.status).toBe('UNKNOWN');
    const otherLease = await newLease('owner-b');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'invalid_api_key', message: 'private-rejection' },
          request_id: 'provider-error-1',
        }),
        { status: 401 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await service().analyze(snapshot, {
      lease: otherLease,
      planStore,
    });
    expect(result).toMatchObject({ reasonCode: 'AI_UPSTREAM_REJECTED' });
    expect(JSON.stringify(result)).not.toContain('private-rejection');
    expect((await repository.getModelCall(otherLease))!.budgetDisposition).toBe(
      'HELD',
    );
    expect(await repository.getModelCall(otherLease)).toMatchObject({
      status: 'UNKNOWN',
      upstreamDiagnostic: {
        httpStatus: 401,
        providerErrorCode: 'invalid_api_key',
        providerRequestId: 'provider-error-1',
      },
    });
    const metadata = await readFile(
      join(directory, 'metadata', 'state.json'),
      'utf8',
    );
    expect(metadata).not.toContain('private-rejection');
    expect(
      await service().analyze(snapshot, { lease: otherLease, planStore }),
    ).toMatchObject({
      reasonCode: 'AI_UNKNOWN_OUTCOME',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops an oversized response while reading and holds the possible charge', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1200));
      },
      cancel,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream)));
    expect(
      await service({ AI_MAX_RESPONSE_BYTES: 1024 }).analyze(snapshot, {
        lease,
        planStore,
      }),
    ).toMatchObject({
      status: 'FALLBACK',
      reasonCode: 'AI_RESPONSE_LIMIT',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect((await repository.getModelCall(lease))!.status).toBe('UNKNOWN');
  });

  it('cancels a sent call without releasing or resending it', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(() => {
      controller.abort();
      throw new Error('private-abort-marker');
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await service().analyze(snapshot, {
        lease,
        planStore,
        signal: controller.signal,
      }),
    ).toMatchObject({ reasonCode: 'AI_CANCELLED' });
    expect((await repository.getModelCall(lease))!.status).toBe('UNKNOWN');
    await service().analyze(snapshot, { lease, planStore });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds the whole request timeout and keeps the possible charge', async () => {
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, request: RequestInit) =>
        new Promise<never>((_resolve, reject) => {
          request.signal!.addEventListener(
            'abort',
            () => reject(new Error('private-timeout')),
            { once: true },
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await service({ QWEN_TIMEOUT_MS: 1000 }).analyze(snapshot, {
        lease,
        planStore,
      }),
    ).toMatchObject({
      reasonCode: 'AI_TIMEOUT',
      status: 'FALLBACK',
    });
    expect(await repository.getModelCall(lease)).toMatchObject({
      status: 'UNKNOWN',
      budgetDisposition: 'HELD',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not publish an in-memory plan if private persistence fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(upstream());
    vi.stubGlobal('fetch', fetchMock);
    const unavailable: AiPlanStore = {
      async write() {
        throw new Error('private-storage-failure');
      },
      async read() {
        throw new Error('private-storage-failure');
      },
    };
    const analysis = service();
    expect(
      await analysis.analyze(snapshot, { lease, planStore: unavailable }),
    ).toMatchObject({
      status: 'FALLBACK',
      reasonCode: 'AI_RESULT_UNAVAILABLE',
    });
    expect(
      await analysis.analyze(snapshot, { lease, planStore: unavailable }),
    ).toMatchObject({ reasonCode: 'AI_UNKNOWN_OUTCOME' });
    expect((await repository.getModelCall(lease))!.budgetDisposition).toBe(
      'HELD',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses one request under concurrent same-run analysis', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => upstream());
    vi.stubGlobal('fetch', fetchMock);
    const analysis = service();
    const results = await Promise.all([
      analysis.analyze(snapshot, { lease, planStore }),
      analysis.analyze(snapshot, { lease, planStore }),
    ]);
    expect(results.some((value) => value.status === 'APPLIED')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails before sending when disabled, too large, or over the per-run budget', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await service({ PROCESSING_AI_ENABLED: false }).analyze(snapshot, {
        lease,
        planStore,
      }),
    ).toMatchObject({ status: 'SKIPPED', reasonCode: 'AI_DISABLED' });
    expect(
      await service({ AI_MAX_MESSAGE_BYTES: 1024 }).analyze(
        {
          ...snapshot,
          blocks: snapshot.blocks.map((block) => ({
            ...block,
            excerpt: 'a'.repeat(240),
          })),
        },
        { lease, planStore },
      ),
    ).toMatchObject({ reasonCode: 'AI_INPUT_LIMIT' });
    expect(
      await service({ AI_RUN_BUDGET_MICROS: 1 }).analyze(snapshot, {
        lease,
        planStore,
      }),
    ).toMatchObject({ reasonCode: 'AI_RUN_BUDGET_EXCEEDED' });
    expect(await repository.getModelCall(lease)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a depleted shared daily budget before another upstream call', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error('network outcome unknown'));
    vi.stubGlobal('fetch', fetchMock);
    const analysis = service({ AI_DAILY_BUDGET_MICROS: 50000 });
    await analysis.analyze(snapshot, { lease, planStore });
    const other = await newLease('owner-b');
    expect(
      await analysis.analyze(snapshot, { lease: other, planStore }),
    ).toMatchObject({ reasonCode: 'AI_DAILY_BUDGET_EXCEEDED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not re-bill if a cached plan is missing or the model configuration changed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(upstream());
    vi.stubGlobal('fetch', fetchMock);
    await service().analyze(snapshot, { lease, planStore });
    stored = undefined;
    expect(
      await service().analyze(snapshot, { lease, planStore }),
    ).toMatchObject({ reasonCode: 'AI_RESULT_UNAVAILABLE' });
    expect(
      await service({ QWEN_MODEL: 'qwen/other-model' }).analyze(snapshot, {
        lease,
        planStore,
      }),
    ).toMatchObject({ reasonCode: 'AI_CONFIGURATION_CHANGED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves the role schema and excludes source paths from prompts', () => {
    expect(
      parseStructurePlan({ ...validRoles, path: 'file:///private' }, snapshot),
    ).toBeNull();
    expect(
      parseStructurePlan(
        {
          roles: [
            { id: 'sample-1', role: 'quote', text: 'replacement' },
            validRoles.roles[1],
          ],
        },
        snapshot,
      ),
    ).toBeNull();
    expect(JSON.stringify(structureMessages(snapshot))).not.toContain(
      'private-document.xhtml',
    );
  });

  it('rejects invalid or oversized snapshots before reserving a paid call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const invalid = {
      ...snapshot,
      blocks: [null],
    } as unknown as EpubStructureSnapshot;
    expect(
      await service().analyze(invalid, { lease, planStore }),
    ).toMatchObject({ reasonCode: 'AI_INVALID_SNAPSHOT' });
    expect(
      await service().analyze(
        { ...snapshot, blocks: Array(33).fill(snapshot.blocks[0]) },
        { lease, planStore },
      ),
    ).toMatchObject({ reasonCode: 'AI_INVALID_SNAPSHOT' });
    expect(await repository.getModelCall(lease)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
