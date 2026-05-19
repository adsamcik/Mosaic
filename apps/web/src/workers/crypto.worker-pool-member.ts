/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import '../lib/worker-error-transfer';
import { getCryptoClient } from '../lib/crypto-client';
import { DownloadError } from './crypto-pool';
import { rustVerifyShardIntegrity } from './rust-crypto-core';
import type { EpochHandleId, LinkDecryptionKey, LinkTierHandleId } from './types';

interface CryptoPoolMemberApi {
  verifyShard(shardBytes: Uint8Array, expectedHash: Uint8Array): Promise<void>;
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

  async decryptShardWithTierKey(shardBytes: Uint8Array, tierKey: LinkDecryptionKey): Promise<Uint8Array> {
    const crypto = await getCryptoClient();
    try {
      return await crypto.decryptShardWithLinkTierHandle(tierKey, shardBytes);
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

export const __cryptoPoolMemberTestUtils = { memberApi };

Comlink.expose(memberApi);
