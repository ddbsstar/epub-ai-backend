import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AppConfig } from '../config/app-config.module.js';
import { ProcessingRepository } from '../processing/processing.repository.js';
import { LocalProcessingPersistence } from '../processing/local-processing.persistence.js';
import { LocalArtifactStorage } from './artifact-storage.js';
import { businessError } from './business-errors.js';

@Injectable()
export class BetaMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private sweeping?: Promise<void>;
  constructor(
    @Inject(AppConfig) private readonly config: AppConfig,
    @Inject(ProcessingRepository)
    private readonly repository: ProcessingRepository,
    @Inject(LocalArtifactStorage)
    private readonly storage: LocalArtifactStorage,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.get('PROCESSING_PUBLIC_BETA_ENABLED')) return;
    await this.sweep();
    this.timer = setInterval(() => {
      void this.sweep().catch(() => undefined);
    }, 30000);
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.sweeping;
  }

  sweep(): Promise<void> {
    if (this.sweeping) return this.sweeping;
    this.sweeping = this.performSweep().finally(() => {
      this.sweeping = undefined;
    });
    return this.sweeping;
  }

  async ensureCapacity(): Promise<void> {
    if (!this.config.get('PROCESSING_PUBLIC_BETA_ENABLED')) return;
    const quota =
      this.config.get('PROCESSING_BETA_STORAGE_MAX_MIB') * 1024 * 1024;
    // Headroom includes two in-flight uploads and the one bounded active worker.
    const headroom =
      (this.config.get('PROCESSING_UPLOAD_MAX_MIB') * 3 + 128) * 1024 * 1024;
    let size = 0,
      entries = 0;
    const walk = async (path: string): Promise<void> => {
      for (const item of await readdir(path, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        },
      )) {
        if (++entries > 30000 || item.isSymbolicLink())
          throw businessError('STORAGE_CAPACITY_EXCEEDED', 507);
        const target = join(path, item.name);
        if (item.isDirectory()) await walk(target);
        else {
          const stat = await lstat(target).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return null;
              throw error;
            },
          );
          if (stat) size += stat.size;
        }
        if (size + headroom > quota)
          throw businessError('STORAGE_CAPACITY_EXCEEDED', 507);
      }
    };
    await walk(this.config.get('PROCESSING_DATA_DIR'));
  }

  private async performSweep(): Promise<void> {
    if (!this.config.get('PROCESSING_PUBLIC_BETA_ENABLED')) return;
    const persistence = this.repository.persistence;
    if (!(persistence instanceof LocalProcessingPersistence))
      throw new Error('BETA_REQUIRES_LOCAL_STORAGE');
    const snapshot = await persistence.pruneExpired();
    for (const key of snapshot.sourceKeys)
      if (/^sources\/[a-f0-9-]{36}\.epub$/.test(key))
        await rm(this.storage.path(key), { force: true });
    for (const id of snapshot.runIds)
      if (/^[a-f0-9-]{36}$/.test(id))
        await rm(this.storage.path(`runs/${id}`), {
          recursive: true,
          force: true,
        });
    // A worker fenced by expiry can finish an in-flight write. Remove those
    // unregistered remnants on subsequent sweeps, also after process restart.
    for (const kind of ['sources', 'runs'] as const) {
      const directory = this.storage.path(kind);
      const live = new Set(
        kind === 'sources'
          ? snapshot.liveSourceKeys
          : snapshot.liveRunIds.map((id) => 'runs/' + id),
      );
      for (const item of await readdir(directory, {
        withFileTypes: true,
      }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      })) {
        if (
          !(
            kind === 'sources' ? /^[a-f0-9-]{36}\.epub$/ : /^[a-f0-9-]{36}$/
          ).test(item.name)
        )
          continue;
        const key = kind + '/' + item.name;
        if (live.has(key)) continue;
        const path = this.storage.path(key);
        const info = await lstat(path).catch(() => null);
        if (info && info.mtimeMs < Date.now() - 300000)
          await rm(path, {
            recursive: kind === 'runs' && !item.isSymbolicLink(),
            force: true,
          });
      }
    }
  }
}
