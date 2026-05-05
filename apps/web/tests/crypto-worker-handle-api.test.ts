import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import initRustWasm from '../src/generated/mosaic-wasm/mosaic_wasm.js';
import { cryptoWorker } from '../src/workers/crypto.worker';
import { WorkerCryptoErrorCode, type AccountHandleId } from '../src/workers/types';

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(
  here,
  '../src/generated/mosaic-wasm/mosaic_wasm_bg.wasm',
);

const TEST_KDF = {
  memoryKib: 64 * 1024,
  iterations: 3,
  parallelism: 1,
} as const;

function fixedSalt(seed: number): Uint8Array {
  const out = new Uint8Array(16);
  for (let i = 0; i < out.length; i += 1) out[i] = (seed + i) & 0xff;
  return out;
}

function writeU32Le(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function v03Envelope(ciphertext = new Uint8Array([1, 2, 3])): Uint8Array {
  const out = new Uint8Array(64 + ciphertext.length);
  out.set(new TextEncoder().encode('SGzk'), 0);
  out[4] = 0x03;
  writeU32Le(out, 5, 7);
  writeU32Le(out, 9, 11);
  for (let i = 0; i < 24; i += 1) out[13 + i] = 0xa0 + i;
  out[37] = 3;
  out.set(ciphertext, 64);
  return out;
}

function v04Envelope(): Uint8Array {
  const out = new Uint8Array(64);
  out.set(new TextEncoder().encode('SGzk'), 0);
  out[4] = 0x04;
  out[5] = 2;
  for (let i = 0; i < 16; i += 1) out[6 + i] = 0xb0 + i;
  writeU32Le(out, 22, 5);
  writeU32Le(out, 26, 1234);
  return out;
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(bytes).digest());
}

describe('W-S1 crypto worker handle API', () => {
  beforeAll(async () => {
    const wasmBytes = new Uint8Array(readFileSync(wasmPath));
    await initRustWasm({ module_or_path: wasmBytes });
  });

  afterEach(async () => {
    await cryptoWorker.clear();
  });

  it('encryptShardWithEpochHandle and decryptShardWithEpochHandle round trip through an epoch handle', async () => {
    const account = await cryptoWorker.createNewAccount({
      password: 'w-s1-test-password',
      userSalt: fixedSalt(0x11),
      accountSalt: fixedSalt(0x22),
      kdf: TEST_KDF,
    });
    const epoch = await cryptoWorker.createEpochHandle(
      account.accountHandleId as AccountHandleId,
      7,
    );
    const plaintext = new Uint8Array([0, 1, 2, 3, 4, 250, 255]);

    const envelope = await cryptoWorker.encryptShardWithEpochHandle(
      epoch.epochHandleId,
      plaintext,
      3,
      11,
    );
    const decrypted = await cryptoWorker.decryptShardWithEpochHandle(
      epoch.epochHandleId,
      envelope,
    );

    expect(envelope[0]).toBe(0x53);
    expect(envelope[4]).toBe(0x03);
    expect(decrypted).toEqual(plaintext);
  });

  it('verifyShardIntegrity hashes only ciphertext bytes and compares in constant time', async () => {
    const ciphertext = new Uint8Array([9, 8, 7, 6, 5]);
    const envelope = v03Envelope(ciphertext);
    const expected = sha256(ciphertext);
    const wrong = new Uint8Array(expected);
    wrong[0] ^= 0xff;

    await expect(
      cryptoWorker.verifyShardIntegrity(envelope, expected),
    ).resolves.toBe(true);
    await expect(
      cryptoWorker.verifyShardIntegrity(envelope, wrong),
    ).resolves.toBe(false);
  });

  it('peekEnvelopeHeader parses v0x03 headers without decrypting', async () => {
    const parsed = await cryptoWorker.peekEnvelopeHeader(v03Envelope());

    expect(parsed.version).toBe(0x03);
    if (parsed.version !== 0x03) throw new Error('expected v0x03 header');
    expect(parsed.magic).toBe('SGzk');
    expect(parsed.epoch).toBe(7);
    expect(parsed.shard).toBe(11);
    expect(parsed.tier).toBe(3);
    expect(parsed.nonce).toEqual(
      new Uint8Array(Array.from({ length: 24 }, (_, i) => 0xa0 + i)),
    );
  });

  it('peekEnvelopeHeader parses v0x04 streaming headers without decrypting', async () => {
    const parsed = await cryptoWorker.peekEnvelopeHeader(v04Envelope());

    expect(parsed.version).toBe(0x04);
    if (parsed.version !== 0x04) throw new Error('expected v0x04 header');
    expect(parsed.magic).toBe('SGzk');
    expect(parsed.epoch).toBe(0);
    expect(parsed.shard).toBe(0);
    expect(parsed.tier).toBe(2);
    expect(parsed.streamSalt).toEqual(
      new Uint8Array(Array.from({ length: 16 }, (_, i) => 0xb0 + i)),
    );
    expect(parsed.frameCount).toBe(5);
    expect(parsed.finalFrameSize).toBe(1234);
  });

  it('rejects the conventional null WASM epoch handle sentinel', async () => {
    let err: { code?: number } | null = null;
    try {
      await cryptoWorker.encryptShardWithEpochHandle(
        0n,
        new Uint8Array([1]),
        1,
        0,
      );
    } catch (caught) {
      err = caught as { code?: number };
    }

    expect(err?.code).toBe(WorkerCryptoErrorCode.HandleNotFound);
  });
});
