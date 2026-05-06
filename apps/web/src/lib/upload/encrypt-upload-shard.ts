import type { getCryptoClient } from '../crypto-client';
import type { EpochHandleId } from '../../workers/types';

export interface UploadEncryptedShard {
  envelopeBytes: Uint8Array;
  sha256: string;
}

type CryptoClient = Awaited<ReturnType<typeof getCryptoClient>>;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function sha256Base64Url(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('WebCrypto SHA-256 is unavailable');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function encryptUploadShardWithEpochHandle(
  crypto: CryptoClient,
  epochHandleId: EpochHandleId,
  plaintext: Uint8Array,
  tier: 1 | 2 | 3,
  shardIndex: number,
): Promise<UploadEncryptedShard> {
  const envelopeBytes = await crypto.encryptShardWithEpochHandle(
    epochHandleId,
    plaintext,
    tier,
    shardIndex,
  );
  return {
    envelopeBytes,
    sha256: await sha256Base64Url(envelopeBytes),
  };
}
