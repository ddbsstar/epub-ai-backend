import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { validateEnvironment } from '../src/config/environment.js';
import type { AppConfig } from '../src/config/app-config.module.js';
import { ImageGenerationService } from '../src/ai/image-generation.service.js';
import { ImageCallLedger } from '../src/ai/image-call-ledger.js';
import { ImageProviderError } from '../src/ai/image-provider.types.js';
import { ImageProviderService } from '../src/ai/image-provider.service.js';
import {
  ImageAssetError,
  ImageAssetService,
} from '../src/ai/image-asset.service.js';

describe('Internal image generation integration', () => {
  let directory: string;
  let ledger: ImageCallLedger;
  let config: AppConfig;
  let provider: ImageProviderService;
  let assetService: ImageAssetService;
  let service: ImageGenerationService;
  let bytes: Buffer;
  let generate = vi.fn<ImageProviderService['generate']>();
  let download = vi.fn<ImageAssetService['download']>();
  const request = {
    ownerId: 'local-owner',
    operationId: 'illustration-proof',
    callKey: 'one-image-v1',
    prompt:
      'A small tree in a wide quiet landscape, an original book illustration.',
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'epub-image-integration-'));
    const environment = validateEnvironment({
      NODE_ENV: 'test',
      IMAGE_GENERATION_ENABLED: true,
      IMAGE_API_KEY: 'test-placeholder',
      IMAGE_DATA_DIR: directory,
    });
    config = {
      get: (key: keyof typeof environment) => environment[key],
    } as AppConfig;
    ledger = new ImageCallLedger({ enabled: true, dataDir: directory });
    provider = new ImageProviderService(config);
    generate = vi.fn<ImageProviderService['generate']>().mockResolvedValue({
      imageUrl:
        'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/test.png',
      imageCount: 1,
      providerRequestId: 'test-request',
    });
    vi.spyOn(provider, 'generate').mockImplementation(generate);
    bytes = await sharp({
      create: { width: 1024, height: 1024, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer();
    download = vi.fn<ImageAssetService['download']>().mockResolvedValue({
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteSize: bytes.length,
      width: 1024,
      height: 1024,
      mediaType: 'image/png',
    });
    assetService = { download } as unknown as ImageAssetService;
    service = new ImageGenerationService(
      config,
      provider,
      assetService,
      ledger,
    );
  });

  afterEach(async () => {
    ledger.close();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('persists a private asset and reuses it after reopening without a second call', async () => {
    const first = await service.generateOne(request);
    expect(first).toMatchObject({
      reused: false,
      imageCount: 1,
      budgetStatus: 'SETTLED',
      estimatedCostMicros: 100000,
    });
    expect(await readFile(first.asset.path)).toEqual(bytes);
    ledger.close();
    ledger = new ImageCallLedger({ enabled: true, dataDir: directory });
    service = new ImageGenerationService(
      config,
      provider,
      assetService,
      ledger,
    );
    const second = await service.generateOne(request);
    expect(second).toMatchObject({
      reused: true,
      callId: first.callId,
      asset: first.asset,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(second)).not.toContain(request.prompt);
    expect(JSON.stringify(second)).not.toContain('test-placeholder');
  });

  it('holds unknown charges and never regenerates after a timeout', async () => {
    generate.mockRejectedValue(new ImageProviderError('IMAGE_TIMEOUT'));
    await expect(service.generateOne(request)).rejects.toMatchObject({
      code: 'IMAGE_TIMEOUT',
    });
    await expect(service.generateOne(request)).rejects.toMatchObject({
      code: 'IMAGE_CALL_OUTCOME_UNKNOWN',
    });
    await expect(
      service.generateOne({ ...request, callKey: 'new-key' }),
    ).rejects.toMatchObject({ code: 'IMAGE_OPERATION_BUDGET_EXCEEDED' });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('persists only vetted upstream diagnostics and never retries the rejected image', async () => {
    const diagnostic = {
      httpStatus: 429,
      providerErrorCode: 'Throttling.RateQuota',
      providerRequestId: 'test-rejected-image',
      message: 'private-rejection-marker',
    };
    generate.mockRejectedValue(
      new ImageProviderError('IMAGE_UPSTREAM_REJECTED', diagnostic),
    );
    const unknown = vi.spyOn(ledger, 'markUnknown');
    await expect(service.generateOne(request)).rejects.toMatchObject({
      code: 'IMAGE_UPSTREAM_REJECTED',
    });
    const persisted = ledger.get(unknown.mock.calls[0]![0]);
    expect(persisted).toMatchObject({
      status: 'UNKNOWN',
      budgetStatus: 'HELD',
      upstreamDiagnostic: {
        httpStatus: 429,
        providerErrorCode: 'Throttling.RateQuota',
        providerRequestId: 'test-rejected-image',
      },
    });
    expect(JSON.stringify(persisted)).not.toContain('private-rejection-marker');
    await expect(service.generateOne(request)).rejects.toMatchObject({
      code: 'IMAGE_CALL_OUTCOME_UNKNOWN',
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(download).not.toHaveBeenCalled();
  });

  it('rejects conflicting prompts without paying a second time', async () => {
    await service.generateOne(request);
    await expect(
      service.generateOne({ ...request, prompt: 'Different illustration' }),
    ).rejects.toMatchObject({ code: 'IMAGE_CALL_CONFLICT' });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('does not regenerate a damaged cached image', async () => {
    const first = await service.generateOne(request);
    await writeFile(first.asset.path, Buffer.alloc(first.asset.byteSize));
    await expect(service.generateOne(request)).rejects.toMatchObject({
      code: 'IMAGE_ASSET_UNAVAILABLE',
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('retries only the checkpointed download after a download rejection', async () => {
    download.mockRejectedValueOnce(new ImageAssetError('IMAGE_URL_REJECTED'));
    await expect(service.generateOne(request)).rejects.toHaveProperty('code');
    const recovered = await service.generateOne(request);
    expect(recovered).toMatchObject({ reused: true, budgetStatus: 'SETTLED' });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledTimes(2);
  });

  it('rejects tampered provider checkpoints without calling either network service', async () => {
    download.mockRejectedValueOnce(new ImageAssetError('IMAGE_URL_REJECTED'));
    await expect(service.generateOne(request)).rejects.toHaveProperty('code');
    const { readdir } = await import('node:fs/promises');
    const names = await readdir(join(directory, 'pending'));
    await writeFile(join(directory, 'pending', names[0]!), '{}');
    await expect(service.generateOne(request)).rejects.toMatchObject({
      code: 'IMAGE_PROVIDER_CHECKPOINT_INVALID',
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid input before opening the ledger or invoking the provider', async () => {
    await expect(
      service.generateOne({ ...request, prompt: 'a'.repeat(801) }),
    ).rejects.toMatchObject({ code: 'IMAGE_INPUT_LIMIT' });
    expect(generate).not.toHaveBeenCalled();
    await expect(service.generateOne(request)).resolves.toHaveProperty(
      'imageCount',
      1,
    );
  });
});
