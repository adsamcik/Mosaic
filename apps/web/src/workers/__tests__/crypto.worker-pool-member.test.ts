import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LinkTierHandleId } from '../types';

const rustMocks = vi.hoisted(() => ({
  rustVerifyShardIntegrity: vi.fn<(shardBytes: Uint8Array, expectedHash: Uint8Array) => Promise<void>>(),
}));

const cryptoClientMocks = vi.hoisted(() => ({
  decryptShardWithLinkTierHandle: vi.fn<(handleId: LinkTierHandleId, envelopeBytes: Uint8Array) => Promise<Uint8Array>>(),
}));

vi.mock('comlink', () => ({ expose: vi.fn() }));
vi.mock('../rust-crypto-core', () => rustMocks);
vi.mock('../../lib/crypto-client', () => ({
  getCryptoClient: vi.fn(async () => cryptoClientMocks),
}));

import { DownloadError } from '../crypto-pool';
import { __cryptoPoolMemberTestUtils } from '../crypto.worker-pool-member';

beforeEach(() => {
  rustMocks.rustVerifyShardIntegrity.mockReset();
  cryptoClientMocks.decryptShardWithLinkTierHandle.mockReset();
});

describe('crypto worker pool member', () => {
  it('does not expose the legacy raw-key decrypt API', () => {
    expect('decryptShard' in __cryptoPoolMemberTestUtils.memberApi).toBe(false);
  });

  it('routes tier-key compatibility calls through link-tier handles', async () => {
    const handleId = 'lnkt_test_member_1' as LinkTierHandleId;
    const envelope = new Uint8Array([1, 2, 3]);
    const plaintext = new Uint8Array([9, 8, 7]);
    cryptoClientMocks.decryptShardWithLinkTierHandle.mockResolvedValueOnce(plaintext);

    await expect(
      __cryptoPoolMemberTestUtils.memberApi.decryptShardWithTierKey(envelope, handleId),
    ).resolves.toBe(plaintext);

    expect(cryptoClientMocks.decryptShardWithLinkTierHandle).toHaveBeenCalledWith(handleId, envelope);
  });

  it('preserves the original AEAD failure as the decrypt error cause', async () => {
    const handleId = 'lnkt_test_member_2' as LinkTierHandleId;
    const original = new Error('original AEAD failure');
    cryptoClientMocks.decryptShardWithLinkTierHandle.mockRejectedValueOnce(original);

    await expect(
      __cryptoPoolMemberTestUtils.memberApi.decryptShardWithTierKey(new Uint8Array([1]), handleId),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(DownloadError);
      expect(error).toMatchObject({ code: 'Decrypt' });
      expect((error as Error).cause).toBe(original);
      return true;
    });
  });
});
