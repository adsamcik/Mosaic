/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import type { LinkDecryptionKey, DownloadErrorReason } from './types';

/** Download pipeline error code taxonomy mirrored from Rust. */
export type DownloadErrorCode = DownloadErrorReason;

/** Error thrown by Phase 2 download pipeline components. */
export class DownloadError extends Error {
  /** Stable download error code. */
  readonly code: DownloadErrorCode;

  /** Optional retry delay hint for transient failures. */
  readonly retryAfterMs?: number;

  constructor(code: DownloadErrorCode, message: string, opts?: { readonly retryAfterMs?: number; readonly cause?: unknown }) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'DownloadError';
    this.code = code;
    if (opts?.retryAfterMs !== undefined) {
      this.retryAfterMs = opts.retryAfterMs;
    }
  }
}

/** Pool API for Rust-WASM-backed shard crypto work. */
export interface CryptoPool {
  /** Number of worker slots in this pool. */
  readonly size: number;
  /** Verify a shard's SHA256 hash. Throws DownloadError(Integrity) on mismatch. */
  verifyShard(shardBytes: Uint8Array, expectedHash: Uint8Array): Promise<void>;
  /** Decrypt a shard with an authenticated viewer epoch seed. Throws DownloadError(Decrypt) on AEAD failure. */
  decryptShard(shardBytes: Uint8Array, epochSeed: Uint8Array): Promise<Uint8Array>;
  /** Decrypt a shard with a share-link tier key. Throws DownloadError(Decrypt) on AEAD failure. */
  decryptShardWithTierKey(shardBytes: Uint8Array, tierKey: LinkDecryptionKey): Promise<Uint8Array>;
  /** Pool stats for telemetry/UI. */
  getStats(): Promise<{ size: number; idle: number; busy: number; queued: number }>;
  /** Tear down all workers. Idempotent. */
  shutdown(): Promise<void>;
}

/** Crypto pool construction options. */
export interface CryptoPoolOptions {
  /** Pool size; defaults to autoSizePool() result. */
  readonly size?: number;
}

interface CryptoPoolMemberApi {
  verifyShard(shardBytes: Uint8Array, expectedHash: Uint8Array): Promise<void>;
  decryptShard(shardBytes: Uint8Array, epochSeed: Uint8Array): Promise<Uint8Array>;
  decryptShardWithTierKey(shardBytes: Uint8Array, tierKey: LinkDecryptionKey): Promise<Uint8Array>;
}

interface WorkerSlot {
  readonly index: number;
  worker: Worker;
  api: Comlink.Remote<CryptoPoolMemberApi>;
  busy: boolean;
}

type WorkerFactory = (url: URL, options: WorkerOptions) => Worker;

let workerFactory: WorkerFactory = (url, options) => new Worker(url, options);

/** Choose a conservative crypto-worker pool size for the current device/network. */
export function autoSizePool(): number {
  const nav = globalThis.navigator;
  const hardwareConcurrency = Math.max(1, nav.hardwareConcurrency || 1);
  if (hardwareConcurrency <= 2) {
    return 1;
  }

  const mobile = isMobileNavigator(nav);
  const desktopBase = Math.min(hardwareConcurrency - 1, 6);
  const mobileBase = Math.min(2, hardwareConcurrency - 1);
  let size = Math.max(1, mobile ? mobileBase : desktopBase);

  const connection = navigatorConnection(nav);
  const effectiveType = connection?.effectiveType ?? '';
  if (effectiveType === 'slow-2g' || effectiveType === '2g' || effectiveType === '3g') {
    size = Math.max(1, Math.floor(size / 2));
  }

  return size;
}

/** Create a lazily-spawned crypto worker pool. */
export async function getCryptoPool(opts?: CryptoPoolOptions): Promise<CryptoPool> {
  return new CryptoWorkerPool(opts?.size ?? autoSizePool());
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly permits: number) {}

  get queued(): number {
    return this.waiters.length;
  }

  async acquire(): Promise<() => void> {
    if (this.active >= this.permits) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }
}

class CryptoWorkerPool implements CryptoPool {
  readonly size: number;
  private readonly semaphore: Semaphore;
  private readonly slots: WorkerSlot[] = [];
  private nextSlotIndex = 0;
  private initialized = false;
  private shuttingDown = false;

  constructor(size: number) {
    this.size = Math.max(1, Math.floor(size));
    this.semaphore = new Semaphore(this.size);
  }

  async verifyShard(shardBytes: Uint8Array, expectedHash: Uint8Array): Promise<void> {
    await this.dispatch((api) => api.verifyShard(shardBytes, expectedHash));
  }

  decryptShard(shardBytes: Uint8Array, epochSeed: Uint8Array): Promise<Uint8Array> {
    return this.dispatch((api) => api.decryptShard(shardBytes, epochSeed));
  }

  decryptShardWithTierKey(shardBytes: Uint8Array, tierKey: LinkDecryptionKey): Promise<Uint8Array> {
    return this.dispatch((api) => api.decryptShardWithTierKey(shardBytes, tierKey));
  }

  async getStats(): Promise<{ size: number; idle: number; busy: number; queued: number }> {
    const busy = this.slots.filter((slot) => slot.busy).length;
    return { size: this.size, idle: this.size - busy, busy, queued: this.semaphore.queued };
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    for (const slot of this.slots) {
      slot.worker.terminate();
    }
    this.slots.length = 0;
    this.initialized = false;
  }

  private async dispatch<T>(op: (api: Comlink.Remote<CryptoPoolMemberApi>) => Promise<T>): Promise<T> {
    if (this.shuttingDown) {
      throw new DownloadError('IllegalState', 'Crypto pool is shut down');
    }
    this.ensureWorkers();
    const release = await this.semaphore.acquire();
    const slot = this.nextIdleSlot();
    slot.busy = true;
    try {
      return await op(slot.api);
    } catch (error) {
      if (isWorkerDiedError(error)) {
        this.respawnSlot(slot);
        throw new DownloadError('IllegalState', 'Crypto worker terminated unexpectedly', { cause: error });
      }
      throw error;
    } finally {
      slot.busy = false;
      release();
    }
  }

  private ensureWorkers(): void {
    if (this.initialized) {
      return;
    }
    for (let index = 0; index < this.size; index += 1) {
      this.slots.push(this.createSlot(index));
    }
    this.initialized = true;
  }

  private createSlot(index: number): WorkerSlot {
    const worker = workerFactory(new URL('./crypto.worker-pool-member.ts', import.meta.url), { type: 'module' });
    return { index, worker, api: Comlink.wrap<CryptoPoolMemberApi>(worker), busy: false };
  }

  private respawnSlot(slot: WorkerSlot): void {
    slot.worker.terminate();
    const replacement = this.createSlot(slot.index);
    slot.worker = replacement.worker;
    slot.api = replacement.api;
  }

  private nextIdleSlot(): WorkerSlot {
    for (let scanned = 0; scanned < this.slots.length; scanned += 1) {
      const index = (this.nextSlotIndex + scanned) % this.slots.length;
      const slot = this.slots[index];
      if (slot && !slot.busy) {
        this.nextSlotIndex = (index + 1) % this.slots.length;
        return slot;
      }
    }
    throw new DownloadError('IllegalState', 'Crypto pool semaphore admitted work with no idle worker');
  }
}

function navigatorConnection(nav: Navigator): { readonly effectiveType?: string } | undefined {
  return typeof nav === 'object' && nav !== null && 'connection' in nav
    ? nav.connection as { readonly effectiveType?: string }
    : undefined;
}

function navigatorUserAgentData(nav: Navigator): { readonly mobile?: boolean } | undefined {
  return typeof nav === 'object' && nav !== null && 'userAgentData' in nav
    ? nav.userAgentData as { readonly mobile?: boolean }
    : undefined;
}

function isMobileNavigator(nav: Navigator): boolean {
  const userAgentData = navigatorUserAgentData(nav);
  if (typeof userAgentData?.mobile === 'boolean') {
    return userAgentData.mobile;
  }
  return /Mobi/u.test(nav.userAgent || '');
}

function isWorkerDiedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const text = `${error.name} ${error.message}`.toLowerCase();
  return text.includes('terminated') || text.includes('disconnected') || text.includes('died') || text.includes('worker');
}

export const __cryptoPoolTestUtils = {
  setWorkerFactory(factory: WorkerFactory): void {
    workerFactory = factory;
  },
  resetWorkerFactory(): void {
    workerFactory = (url, options) => new Worker(url, options);
  },
};

