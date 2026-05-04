/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import { deriveTierKeys, memzero } from '@mosaic/crypto';
import { DownloadError } from './crypto-pool';
import { rustDecryptShardWithSeed, rustVerifyShardIntegrity } from './rust-crypto-core';
import type { LinkDecryptionKey } from './types';

interface CryptoPoolMemberApi {
  verifyShard(shardBytes: Uint8Array, expectedHash: Uint8Array): Promise<void>;
  decryptShard(shardBytes: Uint8Array, epochSeed: Uint8Array): Promise<Uint8Array>;
  decryptShardWithTierKey(shardBytes: Uint8Array, tierKey: LinkDecryptionKey): Promise<Uint8Array>;
}

const memberApi: CryptoPoolMemberApi = {
  async verifyShard(shardBytes: Uint8Array, expectedHash: Uint8Array): Promise<void> {
    try {
      await rustVerifyShardIntegrity(shardBytes, expectedHash);
    } catch (error) {
      throw new DownloadError('Integrity', 'Shard SHA256 mismatch', { cause: error });
    }
  },

  async decryptShard(shardBytes: Uint8Array, epochSeed: Uint8Array): Promise<Uint8Array> {
    const { fullKey, previewKey, thumbKey } = deriveTierKeys(epochSeed);
    try {
      try {
        return await rustDecryptShardWithSeed(shardBytes, fullKey);
      } catch {
        return await rustDecryptShardWithSeed(shardBytes, epochSeed);
      }
    } catch (error) {
      throw new DownloadError('Decrypt', 'Shard AEAD decrypt failed', { cause: error });
    } finally {
      memzero(fullKey);
      memzero(previewKey);
      memzero(thumbKey);
    }
  },

  async decryptShardWithTierKey(shardBytes: Uint8Array, tierKey: LinkDecryptionKey): Promise<Uint8Array> {
    if (typeof tierKey === 'string') {
      throw new DownloadError('IllegalState', 'Link tier handles are not available inside pool-member workers');
    }
    try {
      return await rustDecryptShardWithSeed(shardBytes, tierKey);
    } catch (error) {
      throw new DownloadError('Decrypt', 'Shard AEAD decrypt failed', { cause: error });
    }
  },
};


Comlink.expose(memberApi);

