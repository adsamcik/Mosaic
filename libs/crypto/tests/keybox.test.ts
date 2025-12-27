import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { wrapKey, unwrapKey, wrapSymmetricKey, unwrapSymmetricKey } from '../src/keybox';
import { CryptoErrorCode } from '../src/types';

beforeAll(async () => {
  await sodium.ready;
});

describe('keybox', () => {
  const wrapper = sodium.randombytes_buf(32);
  const key = sodium.randombytes_buf(32);

  it('round-trips wrap/unwrap', () => {
    const wrapped = wrapKey(key, wrapper);
    const unwrapped = unwrapKey(wrapped, wrapper);
    expect(unwrapped).toEqual(key);
  });

  it('produces different ciphertext each time (random nonce)', () => {
    const wrapped1 = wrapKey(key, wrapper);
    const wrapped2 = wrapKey(key, wrapper);
    expect(wrapped1).not.toEqual(wrapped2);
  });

  it('fails unwrap with wrong wrapper key', () => {
    const wrapped = wrapKey(key, wrapper);
    const wrongWrapper = sodium.randombytes_buf(32);
    expect(() => unwrapKey(wrapped, wrongWrapper)).toThrow();
  });

  it('fails unwrap with corrupted ciphertext', () => {
    const wrapped = wrapKey(key, wrapper);
    wrapped[30] ^= 0xff; // Corrupt a byte
    expect(() => unwrapKey(wrapped, wrapper)).toThrow();
  });

  it('rejects wrapper keys not 32 bytes', () => {
    expect(() => wrapKey(key, new Uint8Array(16))).toThrow();
    expect(() => unwrapKey(new Uint8Array(50), new Uint8Array(16))).toThrow();
  });

  it('rejects wrapped data too short', () => {
    expect(() => unwrapKey(new Uint8Array(30), wrapper)).toThrow();
  });

  describe('symmetric key helpers', () => {
    it('validates key length on wrap', () => {
      expect(() => wrapSymmetricKey(new Uint8Array(16), wrapper)).toThrow();
    });

    it('validates unwrapped key length', () => {
      const wrapped = wrapKey(new Uint8Array(16), wrapper); // 16 byte key
      expect(() => unwrapSymmetricKey(wrapped, wrapper)).toThrow();
    });
  });
});
