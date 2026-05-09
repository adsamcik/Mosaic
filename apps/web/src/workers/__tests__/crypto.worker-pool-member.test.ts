import { beforeEach, describe, expect, it, vi } from 'vitest';

const rustMocks = vi.hoisted(() => ({
  rustDecryptShardWithSeed: vi.fn<(shardBytes: Uint8Array, seed: Uint8Array) => Promise<Uint8Array>>(),
  rustVerifyShardIntegrity: vi.fn<(shardBytes: Uint8Array, expectedHash: Uint8Array) => Promise<void>>(),
}));

vi.mock('comlink', () => ({ expose: vi.fn() }));
vi.mock('../rust-crypto-core', () => rustMocks);

import { DownloadError } from '../crypto-pool';
import { __cryptoPoolMemberTestUtils } from '../crypto.worker-pool-member';

beforeEach(() => {
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

  it('routes legacy raw tier-key bytes directly through Rust decrypt', async () => {
    const rawTierKey = new Uint8Array(32).fill(0xe0);
    const original = new Error('AEAD failed');
    rustMocks.rustDecryptShardWithSeed.mockRejectedValue(original);

    await expect(
      __cryptoPoolMemberTestUtils.memberApi.decryptShard(new Uint8Array([1]), rawTierKey, 3),
    ).rejects.toMatchObject({ code: 'Decrypt' });

    expect(rustMocks.rustDecryptShardWithSeed).toHaveBeenCalledTimes(1);
    expect(rustMocks.rustDecryptShardWithSeed).toHaveBeenCalledWith(expect.any(Uint8Array), rawTierKey);
  });

  it.each([1, 2, 3] as const)('does not perform TypeScript tier derivation for tier %s', async (tier) => {
    const rawTierKey = new Uint8Array(32).fill(tier);
    rustMocks.rustDecryptShardWithSeed.mockResolvedValue(new Uint8Array([9]));
    await expect(
      __cryptoPoolMemberTestUtils.memberApi.decryptShard(new Uint8Array([1]), rawTierKey, tier),
    ).resolves.toEqual(new Uint8Array([9]));

    expect(rustMocks.rustDecryptShardWithSeed).toHaveBeenCalledWith(expect.any(Uint8Array), rawTierKey);
  });
});
