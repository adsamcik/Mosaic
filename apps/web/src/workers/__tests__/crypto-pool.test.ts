import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const workerRecords: FakeWorker[] = [];

class FakeWorker implements Worker {
  onerror: ((this: AbstractWorker, event: ErrorEvent) => unknown) | null = null;
  onmessage: ((this: Worker, event: MessageEvent) => unknown) | null = null;
  onmessageerror: ((this: Worker, event: MessageEvent) => unknown) | null = null;
  terminated = false;

  constructor(readonly api: FakeApi) {
    workerRecords.push(this);
  }

  terminate(): void {
    this.terminated = true;
  }

  postMessage(_message: unknown, _options?: StructuredSerializeOptions | Transferable[]): void {}

  addEventListener(_type: string, _callback: EventListenerOrEventListenerObject | null, _options?: AddEventListenerOptions | boolean): void {}

  removeEventListener(_type: string, _callback: EventListenerOrEventListenerObject | null, _options?: EventListenerOptions | boolean): void {}

  dispatchEvent(_event: Event): boolean { return true; }
}

interface FakeApi {
  verifyShard(shardBytes: Uint8Array, expectedHash: Uint8Array): Promise<void>;
  decryptShard(shardBytes: Uint8Array, epochSeed: Uint8Array): Promise<Uint8Array>;
  decryptShardWithTierKey(shardBytes: Uint8Array, tierKey: Uint8Array): Promise<Uint8Array>;
}

const apis: FakeApi[] = [];

vi.mock('comlink', () => ({
  wrap: (worker: FakeWorker): FakeApi => worker.api,
}));

import { __cryptoPoolTestUtils, autoSizePool, DownloadError, getCryptoPool } from '../crypto-pool';

function nav(opts: { readonly hardwareConcurrency: number; readonly mobile?: boolean; readonly userAgent?: string; readonly effectiveType?: string }): Navigator {
  return {
    hardwareConcurrency: opts.hardwareConcurrency,
    userAgent: opts.userAgent ?? '',
    userAgentData: opts.mobile === undefined ? undefined : { mobile: opts.mobile },
    connection: opts.effectiveType === undefined ? undefined : { effectiveType: opts.effectiveType },
  } as unknown as Navigator;
}

function makeApi(index: number, counts: number[], rejectOnce = false): FakeApi {
  let shouldReject = rejectOnce;
  return {
    async verifyShard(): Promise<void> {
      counts[index] = (counts[index] ?? 0) + 1;
      if (shouldReject) {
        shouldReject = false;
        throw new Error('worker terminated');
      }
    },
    async decryptShard(shardBytes: Uint8Array): Promise<Uint8Array> {
      return shardBytes;
    },
    async decryptShardWithTierKey(shardBytes: Uint8Array): Promise<Uint8Array> {
      return shardBytes;
    },
  };
}

beforeEach(() => {
  workerRecords.length = 0;
  apis.length = 0;
});

afterEach(() => {
  __cryptoPoolTestUtils.resetWorkerFactory();
  vi.unstubAllGlobals();
});

describe('crypto pool', () => {
  it('sizes desktop, mobile, low-end, and throttled connections', () => {
    vi.stubGlobal('navigator', nav({ hardwareConcurrency: 8 }));
    expect(autoSizePool()).toBe(6);
    vi.stubGlobal('navigator', nav({ hardwareConcurrency: 4, mobile: true }));
    expect(autoSizePool()).toBe(2);
    vi.stubGlobal('navigator', nav({ hardwareConcurrency: 2 }));
    expect(autoSizePool()).toBe(1);
    vi.stubGlobal('navigator', nav({ hardwareConcurrency: 8, effectiveType: '2g' }));
    expect(autoSizePool()).toBe(3);
  });

  it('does not spawn workers until first crypto call', async () => {
    __cryptoPoolTestUtils.setWorkerFactory(() => new FakeWorker(makeApi(0, [])));
    const pool = await getCryptoPool({ size: 2 });
    expect(workerRecords).toHaveLength(0);
    await pool.verifyShard(new Uint8Array([1]), new Uint8Array([2]));
    expect(workerRecords).toHaveLength(2);
  });

  it('dispatches round-robin across all workers', async () => {
    const counts = [0, 0, 0, 0];
    __cryptoPoolTestUtils.setWorkerFactory(() => {
      const api = makeApi(apis.length, counts);
      apis.push(api);
      return new FakeWorker(api);
    });
    const pool = await getCryptoPool({ size: 4 });
    await Promise.all(Array.from({ length: 8 }, () => pool.verifyShard(new Uint8Array([1]), new Uint8Array([2]))));
    expect(counts).toEqual([2, 2, 2, 2]);
  });

  it('respawns a crashed worker and surfaces IllegalState for in-flight work', async () => {
    const counts = [0, 0];
    __cryptoPoolTestUtils.setWorkerFactory(() => {
      const index = apis.length;
      const api = makeApi(index, counts, index === 0);
      apis.push(api);
      return new FakeWorker(api);
    });
    const pool = await getCryptoPool({ size: 1 });
    await expect(pool.verifyShard(new Uint8Array([1]), new Uint8Array([2]))).rejects.toMatchObject({ code: 'IllegalState' });
    expect(workerRecords[0]?.terminated).toBe(true);
    await expect(pool.verifyShard(new Uint8Array([1]), new Uint8Array([2]))).resolves.toBeUndefined();
    expect(workerRecords).toHaveLength(2);
  });

  it('shutdown is idempotent', async () => {
    __cryptoPoolTestUtils.setWorkerFactory(() => new FakeWorker(makeApi(0, [])));
    const pool = await getCryptoPool({ size: 1 });
    await pool.verifyShard(new Uint8Array([1]), new Uint8Array([2]));
    await pool.shutdown();
    await pool.shutdown();
    expect(workerRecords[0]?.terminated).toBe(true);
    await expect(pool.verifyShard(new Uint8Array([1]), new Uint8Array([2]))).rejects.toBeInstanceOf(DownloadError);
  });
});


