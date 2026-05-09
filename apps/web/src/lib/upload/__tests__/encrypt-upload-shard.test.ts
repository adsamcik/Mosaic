import { describe, expect, it, vi } from 'vitest';

const wasmMocks = vi.hoisted(() => ({
  initRustWasm: vi.fn().mockResolvedValue(undefined),
  sha256OfBytes: vi.fn(() => Uint8Array.from({ length: 32 }, (_, index) => index)),
}));

vi.mock('../../../generated/mosaic-wasm/mosaic_wasm.js', () => ({
  default: wasmMocks.initRustWasm,
  sha256OfBytes: wasmMocks.sha256OfBytes,
}));

import { encryptUploadShardWithEpochHandle } from '../encrypt-upload-shard';
import type { getCryptoClient } from '../../crypto-client';
import type { EpochHandleId } from '../../../workers/types';

type CryptoClient = Awaited<ReturnType<typeof getCryptoClient>>;

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

describe('encryptUploadShardWithEpochHandle', () => {
  it('uses Rust SHA-256 bytes for the upload envelope content hash', async () => {
    const envelopeBytes = new Uint8Array([1, 2, 3, 4]);
    const crypto = {
      encryptShardWithEpochHandle: vi.fn().mockResolvedValue(envelopeBytes),
    } as unknown as CryptoClient;

    const result = await encryptUploadShardWithEpochHandle(
      crypto,
      'epoch-42' as EpochHandleId,
      new Uint8Array([9, 8, 7]),
      2,
      3,
    );

    expect(result.envelopeBytes).toBe(envelopeBytes);
    expect(result.sha256).toBe(base64Url(wasmMocks.sha256OfBytes.mock.results[0]!.value));
    expect(wasmMocks.initRustWasm).toHaveBeenCalledTimes(1);
    expect(wasmMocks.sha256OfBytes).toHaveBeenCalledWith(envelopeBytes);
    expect(crypto.encryptShardWithEpochHandle).toHaveBeenCalledWith(
      'epoch-42',
      new Uint8Array([9, 8, 7]),
      2,
      3,
    );
  });
});
