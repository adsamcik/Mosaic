/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import { deriveTierKeys, memzero } from '@mosaic/crypto';
import { getCryptoClient } from '../lib/crypto-client';
import { DownloadError } from './crypto-pool';
import { rustDecryptShardWithSeed, rustVerifyShardIntegrity } from './rust-crypto-core';
import type { EpochHandleId, LinkDecryptionKey, LinkTierHandleId } from './types';

interface CryptoPoolMemberApi {
  verifyShard(shardBytes: Uint8Array, expectedHash: Uint8Array): Promise<void>;
  decryptShard(shardBytes: Uint8Array, rawKeyBytes: Uint8Array, tier: number): Promise<Uint8Array>;
  decryptShardWithTierKey(shardBytes: Uint8Array, tierKey: LinkDecryptionKey): Promise<Uint8Array>;
  decryptShardWithEpochHandle(epochHandleId: EpochHandleId, envelopeBytes: Uint8Array): Promise<Uint8Array>;
  decryptShardWithLinkTierHandle(linkTierHandleId: LinkTierHandleId, envelopeBytes: Uint8Array): Promise<Uint8Array>;
}

const memberApi: CryptoPoolMemberApi = {
  async verifyShard(shardBytes: Uint8Array, expectedHash: Uint8Array): Promise<void> {
    try {
      await rustVerifyShardIntegrity(shardBytes, expectedHash);
    } catch (error) {
      throw new DownloadError('Integrity', 'Shard SHA256 mismatch', { cause: error });
    }
  },

  async decryptShard(shardBytes: Uint8Array, rawKeyBytes: Uint8Array, tier: number): Promise<Uint8Array> {
    const { fullKey, previewKey, thumbKey } = deriveTierKeys(rawKeyBytes);
    try {
      const tierKey = selectTierKey(tier, { fullKey, previewKey, thumbKey });
      return await rustDecryptShardWithSeed(shardBytes, tierKey);
    } catch (error) {
      if (error instanceof DownloadError) {
        throw error;
      }
      throw new DownloadError('Decrypt', 'Shard AEAD decrypt failed', { cause: error });
    } finally {
      memzero(fullKey);
      memzero(previewKey);
      memzero(thumbKey);
    }
  },

  async decryptShardWithTierKey(shardBytes: Uint8Array, tierKey: LinkDecryptionKey): Promise<Uint8Array> {
    if (typeof tierKey === 'string') {
      const crypto = await getCryptoClient();
      try {
        return await crypto.decryptShardWithLinkTierHandle(tierKey, shardBytes);
      } catch (error) {
        throw new DownloadError('Decrypt', 'Shard AEAD decrypt failed', { cause: error });
      }
    }
    try {
      return await rustDecryptShardWithSeed(shardBytes, tierKey);
    } catch (error) {
      throw new DownloadError('Decrypt', 'Shard AEAD decrypt failed', { cause: error });
    }
  },

  async decryptShardWithEpochHandle(epochHandleId: EpochHandleId, envelopeBytes: Uint8Array): Promise<Uint8Array> {
    const crypto = await getCryptoClient();
    try {
      return await crypto.decryptShardWithEpochHandle(epochHandleId, envelopeBytes);
    } catch (error) {
      throw new DownloadError('Decrypt', 'Shard AEAD decrypt failed', { cause: error });
    }
  },

  async decryptShardWithLinkTierHandle(linkTierHandleId: LinkTierHandleId, envelopeBytes: Uint8Array): Promise<Uint8Array> {
    const crypto = await getCryptoClient();
    try {
      return await crypto.decryptShardWithLinkTierHandle(linkTierHandleId, envelopeBytes);
    } catch (error) {
      throw new DownloadError('Decrypt', 'Shard AEAD decrypt failed', { cause: error });
    }
  },
};

function selectTierKey(
  tier: number,
  keys: { readonly fullKey: Uint8Array; readonly previewKey: Uint8Array; readonly thumbKey: Uint8Array },
): Uint8Array {
  switch (tier) {
    case 1:
      return keys.thumbKey;
    case 2:
      return keys.previewKey;
    case 3:
      return keys.fullKey;
    default:
      throw new DownloadError('IllegalState', 'Unsupported shard tier for epoch-seed decrypt');
  }
}

export const __cryptoPoolMemberTestUtils = { memberApi };

Comlink.expose(memberApi);
