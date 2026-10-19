import { QueueService } from '../src/queue/queue.service.js';
import type { AppConfig } from '../src/config/app-config.module.js';
import type { RedisService } from '../src/queue/redis.service.js';
import type { PinoLogger } from 'nestjs-pino';

const bull = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('bullmq', () => ({
  Queue: class {
    constructor() {
      return bull.create();
    }
  },
}));

function fixture(enabled = true) {
  const listeners = new Map<string, () => void>();
  const queue = {
    waitUntilReady: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, handler: () => void) => {
      listeners.set(event, handler);
      return queue;
    }),
  };
  const client = { disconnect: vi.fn() };
  const redis = {
    getClient: vi.fn(() => client),
    getStatus: vi.fn(() => 'connected'),
  };
  const logger = { warn: vi.fn() };
  bull.create.mockReturnValue(queue);
  const service = new QueueService(
    {
      get: (key: string) => (key === 'QUEUE_ENABLED' ? enabled : 'test-prefix'),
    } as AppConfig,
    redis as unknown as RedisService,
    logger as unknown as PinoLogger,
  );
  return { service, queue, redis, client, logger, listeners };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe('BullMQ readiness and shutdown (no network)', () => {
  it('does not construct a queue or access Redis when disabled', async () => {
    const { service, redis } = fixture(false);
    await service.onModuleInit();
    expect(service.getStatus()).toBe('disabled');
    expect(() => service.getQueue()).toThrow('后台队列未启用');
    expect(bull.create).not.toHaveBeenCalled();
    expect(redis.getClient).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it('reports connected only after BullMQ initialization completes', async () => {
    const { service, queue } = fixture();
    let ready!: () => void;
    queue.waitUntilReady.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
    );
    const initializing = service.onModuleInit();
    expect(service.getStatus()).toBe('unavailable');
    ready();
    await initializing;
    expect(service.getStatus()).toBe('connected');
    expect(service.getQueue()).toBe(queue);
    await service.onModuleDestroy();
  });

  it('keeps a failed BullMQ handshake unavailable even when Redis is ready', async () => {
    const { service, queue, logger } = fixture();
    queue.waitUntilReady.mockRejectedValue(new Error('private-acl-marker'));
    await service.onModuleInit();
    expect(service.getStatus()).toBe('unavailable');
    expect(() => service.getQueue()).toThrow('后台队列暂时不可用');
    expect(logger.warn).toHaveBeenCalledWith({ event: 'queue_unavailable' });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
      'private-acl-marker',
    );
    await service.onModuleDestroy();
  });

  it('bounds a stuck initialization and ignores a late ready result', async () => {
    vi.useFakeTimers();
    const { service, queue } = fixture();
    let ready!: () => void;
    queue.waitUntilReady.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
    );
    const initializing = service.onModuleInit();
    await vi.advanceTimersByTimeAsync(3000);
    await initializing;
    expect(service.getStatus()).toBe('unavailable');
    ready();
    await Promise.resolve();
    expect(service.getStatus()).toBe('unavailable');
    await service.onModuleDestroy();
  });

  it('degrades on queue errors, disconnects, and an unavailable Redis transport', async () => {
    const { service, redis, listeners } = fixture();
    await service.onModuleInit();
    redis.getStatus.mockReturnValue('unavailable');
    expect(service.getStatus()).toBe('unavailable');
    redis.getStatus.mockReturnValue('connected');
    listeners.get('error')!();
    expect(service.getStatus()).toBe('unavailable');
    listeners.get('ioredis:close')!();
    expect(service.getStatus()).toBe('unavailable');
    await service.onModuleDestroy();
  });

  it('bounds a stuck close and disconnects the shared Redis client', async () => {
    vi.useFakeTimers();
    const { service, queue, client, logger } = fixture();
    await service.onModuleInit();
    queue.close.mockImplementation(() => new Promise<void>(() => {}));
    const closing = service.onModuleDestroy();
    expect(service.getStatus()).toBe('unavailable');
    await vi.advanceTimersByTimeAsync(2000);
    await closing;
    expect(client.disconnect).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith({
      event: 'queue_shutdown_forced',
    });
  });

  it('closes normally without forcing the shared Redis connection down', async () => {
    const { service, queue, client } = fixture();
    await service.onModuleInit();
    await service.onModuleDestroy();
    expect(queue.close).toHaveBeenCalledOnce();
    expect(client.disconnect).not.toHaveBeenCalled();
  });
});
