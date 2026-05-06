import { beforeEach, describe, expect, it, vi } from 'vitest';

const cryptoMocks = vi.hoisted(() => ({
  fullKey: new Uint8Array(32).fill(0xf3),
  previewKey: new Uint8Array(32).fill(0xf2),
  thumbKey: new Uint8Array(32).fill(0xf1),
  deriveTierKeys: vi.fn((epochSeed: Uint8Array) => {
    if (epochSeed.byteLength !== 32) throw new Error('bad seed');
    return {
      fullKey: cryptoMocks.fullKey,
      previewKey: cryptoMocks.previewKey,
      thumbKey: cryptoMocks.thumbKey,
    };
  }),
  memzero: vi.fn((bytes: Uint8Array) => bytes.fill(0)),
}));

const rustMocks = vi.hoisted(() => ({
  rustDecryptShardWithSeed: vi.fn<(shardBytes: Uint8Array, seed: Uint8Array) => Promise<Uint8Array>>(),
  rustVerifyShardIntegrity: vi.fn<(shardBytes: Uint8Array, expectedHash: Uint8Array) => Promise<void>>(),
}));

vi.mock('comlink', () => ({ expose: vi.fn() }));
vi.mock('@mosaic/crypto', () => cryptoMocks);
vi.mock('../rust-crypto-core', () => rustMocks);

import { DownloadError } from '../crypto-pool';
import { __cryptoPoolMemberTestUtils } from '../crypto.worker-pool-member';

beforeEach(() => {
  cryptoMocks.fullKey = new Uint8Array(32).fill(0xf3);
  cryptoMocks.previewKey = new Uint8Array(32).fill(0xf2);
  cryptoMocks.thumbKey = new Uint8Array(32).fill(0xf1);
  cryptoMocks.deriveTierKeys.mockClear();
  cryptoMocks.memzero.mockClear();
  rustMocks.rustDecryptShardWithSeed.mockReset();
  rustMocks.rustVerifyShardIntegrity.mockReset();
});

describe('crypto worker pool member', () => {
  it('preserves the original AEAD failure as the decrypt error cause', async () => {
    const original = new Error('original AEAD failure');
    rustMocks.rustDecryptShardWithSeed.mockRejectedValue(original);

    await expect(
      __cryptoPoolMemberTestUtils.memberApi.decryptShard(new Uint8Array([1]), new Uint8Array(32).fill(7), 3),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(DownloadError);
      expect(error).toMatchObject({ code: 'Decrypt' });
      expect((error as Error).cause).toBe(original);
      return true;
    });
  });

  it('never falls back to using the raw epoch seed as the AEAD key', async () => {
    const rawEpochSeed = new Uint8Array(32).fill(0xe0);
    const original = new Error('AEAD failed');
    rustMocks.rustDecryptShardWithSeed.mockRejectedValue(original);

    await expect(
      __cryptoPoolMemberTestUtils.memberApi.decryptShard(new Uint8Array([1]), rawEpochSeed, 3),
    ).rejects.toMatchObject({ code: 'Decrypt' });

    expect(rustMocks.rustDecryptShardWithSeed).toHaveBeenCalledTimes(1);
    expect(rustMocks.rustDecryptShardWithSeed).toHaveBeenCalledWith(expect.any(Uint8Array), cryptoMocks.fullKey);
    expect(rustMocks.rustDecryptShardWithSeed).not.toHaveBeenCalledWith(expect.any(Uint8Array), rawEpochSeed);
  });

  it.each([
    [1, 'thumb'],
    [2, 'preview'],
    [3, 'full'],
  ] as const)('selects the %s tier key for epoch-seed decrypts', async (tier, keyName) => {
    rustMocks.rustDecryptShardWithSeed.mockResolvedValue(new Uint8Array([9]));
    await expect(
      __cryptoPoolMemberTestUtils.memberApi.decryptShard(new Uint8Array([1]), new Uint8Array(32).fill(7), tier),
    ).resolves.toEqual(new Uint8Array([9]));

    const expectedKey = keyName === 'thumb'
      ? cryptoMocks.thumbKey
      : keyName === 'preview' ? cryptoMocks.previewKey : cryptoMocks.fullKey;
    expect(rustMocks.rustDecryptShardWithSeed).toHaveBeenCalledWith(expect.any(Uint8Array), expectedKey);
    expect(cryptoMocks.memzero).toHaveBeenCalledWith(cryptoMocks.fullKey);
    expect(cryptoMocks.memzero).toHaveBeenCalledWith(cryptoMocks.previewKey);
    expect(cryptoMocks.memzero).toHaveBeenCalledWith(cryptoMocks.thumbKey);
  });
});
