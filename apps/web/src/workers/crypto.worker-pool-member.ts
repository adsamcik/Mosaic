/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import { decryptShard as cryptoDecryptShard, deriveTierKeys, memzero } from '@mosaic/crypto';
import { DownloadError } from './crypto-pool';
import type { LinkDecryptionKey } from './types';

interface CryptoPoolMemberApi {
  verifyShard(shardBytes: Uint8Array, expectedHash: Uint8Array): Promise<void>;
  decryptShard(shardBytes: Uint8Array, epochSeed: Uint8Array): Promise<Uint8Array>;
  decryptShardWithTierKey(shardBytes: Uint8Array, tierKey: LinkDecryptionKey): Promise<Uint8Array>;
}

const memberApi: CryptoPoolMemberApi = {
  async verifyShard(shardBytes: Uint8Array, expectedHash: Uint8Array): Promise<void> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', copyToArrayBuffer(shardBytes)));
    if (!constantTimeEqual(digest, expectedHash)) {
      throw new DownloadError('Integrity', 'Shard SHA256 mismatch');
    }
  },

  async decryptShard(shardBytes: Uint8Array, epochSeed: Uint8Array): Promise<Uint8Array> {
    const { fullKey, previewKey, thumbKey } = deriveTierKeys(epochSeed);
    try {
      try {
        return await cryptoDecryptShard(shardBytes, fullKey);
      } catch {
        return await cryptoDecryptShard(shardBytes, epochSeed);
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
      return await cryptoDecryptShard(shardBytes, tierKey);
    } catch (error) {
      throw new DownloadError('Decrypt', 'Shard AEAD decrypt failed', { cause: error });
    }
  },
};

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}

Comlink.expose(memberApi);

