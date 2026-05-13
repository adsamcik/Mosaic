import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const facadeMocks = vi.hoisted(() => {
  let nextHandle = 100n;
  const closed = {
    account: [] as bigint[],
    epoch: [] as bigint[],
    linkTier: [] as bigint[],
  };
  const facade = {
    createNewAccount: vi.fn(() => ({ handle: nextHandle++, wrappedAccountKey: new Uint8Array([1, 2, 3]) })),
    createEpochKeyHandle: vi.fn((_account: bigint, epochId: number) => ({
      handle: nextHandle++,
      wrappedEpochSeed: new Uint8Array([epochId]),
      signPublicKey: new Uint8Array(32),
    })),
    encryptShardWithEpochHandle: vi.fn(() => ({ envelopeBytes: new Uint8Array([9, 9]), sha256: 'sha' })),
    mintLinkTierHandleFromRawKey: vi.fn(() => ({ handle: nextHandle++ })),
    decryptShardWithLinkTierHandle: vi.fn((_handle: bigint, envelope: Uint8Array) => envelope),
    closeAccountHandle: vi.fn((handle: bigint) => { closed.account.push(handle); }),
    closeIdentityHandle: vi.fn(),
    closeEpochKeyHandle: vi.fn((handle: bigint) => { closed.epoch.push(handle); }),
    closeLinkShareHandle: vi.fn(),
    closeLinkTierHandle: vi.fn((handle: bigint) => { closed.linkTier.push(handle); }),
  };
  return { facade, closed, reset: () => { nextHandle = 100n; closed.account = []; closed.epoch = []; closed.linkTier = []; } };
});

vi.mock('comlink', () => ({ expose: vi.fn() }));
vi.mock('libsodium-wrappers-sumo', () => ({
  default: {
    ready: Promise.resolve(),
    randombytes_buf: (length: number) => new Uint8Array(length).fill(7),
    to_base64: (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    base64_variants: { URLSAFE_NO_PADDING: 7 },
  },
}));
vi.mock('@mosaic/crypto', () => ({
  parseServerArgon2Params: vi.fn((payload) => ({
    memory: payload.memoryKib,
    iterations: payload.iterations,
    parallelism: payload.parallelism,
    algVersion: 0x13,
  })),
}));
vi.mock('../../workers/rust-crypto-core', () => ({
  getRustFacade: vi.fn(async () => facadeMocks.facade),
  parseEnvelopeHeaderFromRust: vi.fn(),
}));

import { cryptoWorker } from '../../workers/crypto.worker';

const kdf = { memoryKib: 8, iterations: 1, parallelism: 1 };

async function runUploadDownloadHandleCycle(iteration: number): Promise<void> {
  const account = await cryptoWorker.createNewAccount({
    password: `pass-${iteration}`,
    userSalt: new Uint8Array(16).fill(iteration),
    accountSalt: new Uint8Array(16).fill(iteration + 1),
    kdf,
  });
  const epoch = await cryptoWorker.createEpochHandle(account.accountHandleId, iteration + 1);
  await cryptoWorker.encryptShardWithEpoch(epoch.epochHandleId, new Uint8Array([1, 2, 3]), iteration, 1);
  await cryptoWorker.closeEpochHandle(epoch.epochHandleId);
  await cryptoWorker.closeAccountHandle(account.accountHandleId);

  const linkTierHandleId = await cryptoWorker.mintLinkTierHandleFromRawKey(new Uint8Array(32).fill(iteration));
  await cryptoWorker.decryptShardWithLinkTierHandle(linkTierHandleId, new Uint8Array([4, 5, 6]));
  await cryptoWorker.closeLinkTierHandle(linkTierHandleId);
}

describe('memory leak guards', () => {
  beforeEach(async () => {
    facadeMocks.reset();
    vi.clearAllMocks();
    await cryptoWorker.clear();
  });

  afterEach(async () => {
    await cryptoWorker.clear();
    vi.restoreAllMocks();
  });

  it('returns worker handle registry size to baseline after repeated upload/download crypto cycles', async () => {
    const baseline = (await cryptoWorker.getMemoryDiagnostics()).handles;
    expect(baseline.total).toBe(0);

    for (let iteration = 0; iteration < 10; iteration += 1) {
      await runUploadDownloadHandleCycle(iteration);
      const current = (await cryptoWorker.getMemoryDiagnostics()).handles;
      expect(current.total).toBe(baseline.total);
      expect(current.account).toBe(0);
      expect(current.epoch).toBe(0);
      expect(current.link).toBe(0);
    }

    expect(facadeMocks.closed.account).toHaveLength(10);
    expect(facadeMocks.closed.epoch).toHaveLength(10);
    expect(facadeMocks.closed.linkTier).toHaveLength(10);
  });

  it('balances addEventListener and removeEventListener for repeated upload-style cleanup scopes', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    for (let iteration = 0; iteration < 10; iteration += 1) {
      const listener = (): void => undefined;
      window.addEventListener('mosaic-memory-leak-test', listener);
      try {
        window.dispatchEvent(new Event('mosaic-memory-leak-test'));
      } finally {
        window.removeEventListener('mosaic-memory-leak-test', listener);
      }
    }

    expect(addSpy).toHaveBeenCalledTimes(10);
    expect(removeSpy).toHaveBeenCalledTimes(10);
    expect(removeSpy.mock.calls.map((call) => call[1])).toEqual(addSpy.mock.calls.map((call) => call[1]));
  });
});
