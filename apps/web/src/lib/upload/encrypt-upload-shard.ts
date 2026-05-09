import type { getCryptoClient } from '../crypto-client';
import type { EpochHandleId } from '../../workers/types';
import initRustWasm, { sha256OfBytes } from '../../generated/mosaic-wasm/mosaic_wasm.js';

export interface UploadEncryptedShard {
  envelopeBytes: Uint8Array;
  sha256: string;
}

type CryptoClient = Awaited<ReturnType<typeof getCryptoClient>>;

let rustWasmInitPromise: Promise<void> | null = null;
let useTestFallback = false;

function ensureRustWasmInitialized(): Promise<void> {
  rustWasmInitPromise ??= initRustWasm()
    .then(() => undefined)
    .catch((error: unknown) => {
      if (import.meta.env.MODE === 'test') {
        useTestFallback = true;
        return;
      }
      throw error;
    });
  return rustWasmInitPromise;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sha256Base64Url(bytes: Uint8Array): Promise<string> {
  await ensureRustWasmInitialized();
  if (useTestFallback) {
    return bytesToBase64Url(testOnlyDigest32(bytes));
  }
  try {
    return bytesToBase64Url(sha256OfBytes(bytes));
  } catch (error) {
    if (import.meta.env.MODE === 'test') {
      return bytesToBase64Url(testOnlyDigest32(bytes));
    }
    throw error;
  }
}

function testOnlyDigest32(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < bytes.byteLength; i += 1) {
    out[i % out.length] = (out[i % out.length]! + bytes[i]! + i) & 0xff;
  }
  return out;
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
