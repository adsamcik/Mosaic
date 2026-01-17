import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import {
  wrapKey,
  unwrapKey,
  wrapSymmetricKey,
  unwrapSymmetricKey,
} from '../src/keybox';
import {
  CryptoError,
  CryptoErrorCode,
  NONCE_SIZE,
  TAG_SIZE,
  KEY_SIZE,
} from '../src/types';

// MIN_WRAPPED_LENGTH = NONCE_SIZE + TAG_SIZE + 1 = 24 + 16 + 1 = 41
const MIN_WRAPPED_LENGTH = NONCE_SIZE + TAG_SIZE + 1;

describe('keybox', () => {
  let wrapper: Uint8Array;
  let key: Uint8Array;

  beforeAll(async () => {
    await sodium.ready;
    wrapper = sodium.randombytes_buf(32);
    key = sodium.randombytes_buf(32);
  });

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

  describe('wrapKey validation', () => {
    it('rejects wrapper key shorter than 32 bytes', () => {
      const shortWrapper = new Uint8Array(16);
      expect(() => wrapKey(key, shortWrapper)).toThrow(CryptoError);
    });

    it('rejects wrapper key longer than 32 bytes', () => {
      const longWrapper = new Uint8Array(64);
      expect(() => wrapKey(key, longWrapper)).toThrow(CryptoError);
    });

    it('includes actual and expected length in error message', () => {
      const shortWrapper = new Uint8Array(16);
      expect(() => wrapKey(key, shortWrapper)).toThrow(
        /Wrapper key must be 32 bytes, got 16/,
      );
    });

    it('throws with INVALID_KEY_LENGTH error code', () => {
      const shortWrapper = new Uint8Array(16);
      try {
        wrapKey(key, shortWrapper);
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(CryptoError);
        expect((e as CryptoError).code).toBe(
          CryptoErrorCode.INVALID_KEY_LENGTH,
        );
      }
    });
  });

  describe('unwrapKey validation', () => {
    it('rejects wrapper key shorter than 32 bytes', () => {
      const wrapped = wrapKey(key, wrapper);
      const shortWrapper = new Uint8Array(16);
      expect(() => unwrapKey(wrapped, shortWrapper)).toThrow(CryptoError);
    });

    it('rejects wrapper key longer than 32 bytes', () => {
      const wrapped = wrapKey(key, wrapper);
      const longWrapper = new Uint8Array(64);
      expect(() => unwrapKey(wrapped, longWrapper)).toThrow(CryptoError);
    });

    it('includes actual and expected length in wrapper error message', () => {
      const wrapped = wrapKey(key, wrapper);
      const shortWrapper = new Uint8Array(16);
      expect(() => unwrapKey(wrapped, shortWrapper)).toThrow(
        /Wrapper key must be 32 bytes, got 16/,
      );
    });

    it('rejects wrapped data shorter than MIN_WRAPPED_LENGTH', () => {
      // MIN_WRAPPED_LENGTH - 1 = 40 bytes should fail
      const tooShort = new Uint8Array(MIN_WRAPPED_LENGTH - 1);
      expect(() => unwrapKey(tooShort, wrapper)).toThrow(CryptoError);
    });

    it('accepts wrapped data exactly MIN_WRAPPED_LENGTH bytes', () => {
      // Wrap a 1-byte key - result is nonce(24) + ciphertext(1+16) = 41 = MIN_WRAPPED_LENGTH
      const oneByteKey = new Uint8Array([0x42]);
      const wrapped = wrapKey(oneByteKey, wrapper);
      expect(wrapped.length).toBe(MIN_WRAPPED_LENGTH);
      const unwrapped = unwrapKey(wrapped, wrapper);
      expect(unwrapped).toEqual(oneByteKey);
    });

    it('rejects wrapped data at MIN_WRAPPED_LENGTH - 1 boundary', () => {
      // 40 bytes is just under the minimum, should fail
      const justUnder = new Uint8Array(40);
      expect(() => unwrapKey(justUnder, wrapper)).toThrow(CryptoError);
    });

    it('includes actual and minimum length in short data error message', () => {
      const tooShort = new Uint8Array(30);
      expect(() => unwrapKey(tooShort, wrapper)).toThrow(
        /Wrapped key too short: 30 bytes, minimum 41/,
      );
    });

    it('includes authentication failed message for tampered data', () => {
      const wrapped = wrapKey(key, wrapper);
      wrapped[30] ^= 0xff; // Corrupt a byte
      expect(() => unwrapKey(wrapped, wrapper)).toThrow(
        /Failed to unwrap key - authentication failed/,
      );
    });

    it('throws DECRYPTION_FAILED for short wrapped data', () => {
      const tooShort = new Uint8Array(30);
      try {
        unwrapKey(tooShort, wrapper);
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(CryptoError);
        expect((e as CryptoError).code).toBe(CryptoErrorCode.DECRYPTION_FAILED);
      }
    });
  });

  describe('symmetric key helpers', () => {
    it('round-trips wrapSymmetricKey/unwrapSymmetricKey', () => {
      const wrapped = wrapSymmetricKey(key, wrapper);
      const unwrapped = unwrapSymmetricKey(wrapped, wrapper);
      expect(unwrapped).toEqual(key);
    });

    describe('wrapSymmetricKey validation', () => {
      it('rejects key shorter than 32 bytes', () => {
        const shortKey = new Uint8Array(16);
        expect(() => wrapSymmetricKey(shortKey, wrapper)).toThrow(CryptoError);
      });

      it('rejects key longer than 32 bytes', () => {
        const longKey = new Uint8Array(64);
        expect(() => wrapSymmetricKey(longKey, wrapper)).toThrow(CryptoError);
      });

      it('includes actual and expected length in error message', () => {
        const shortKey = new Uint8Array(16);
        expect(() => wrapSymmetricKey(shortKey, wrapper)).toThrow(
          /Key must be 32 bytes, got 16/,
        );
      });

      it('throws with INVALID_KEY_LENGTH error code', () => {
        const shortKey = new Uint8Array(16);
        try {
          wrapSymmetricKey(shortKey, wrapper);
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(CryptoError);
          expect((e as CryptoError).code).toBe(
            CryptoErrorCode.INVALID_KEY_LENGTH,
          );
        }
      });

      it('accepts exactly 32-byte key (boundary)', () => {
        const exactKey = sodium.randombytes_buf(32);
        expect(() => wrapSymmetricKey(exactKey, wrapper)).not.toThrow();
      });
    });

    describe('unwrapSymmetricKey validation', () => {
      it('rejects wrapped key that unwraps to less than 32 bytes', () => {
        const shortKey = new Uint8Array(16);
        const wrapped = wrapKey(shortKey, wrapper);
        expect(() => unwrapSymmetricKey(wrapped, wrapper)).toThrow(CryptoError);
      });

      it('rejects wrapped key that unwraps to more than 32 bytes', () => {
        const longKey = new Uint8Array(64);
        const wrapped = wrapKey(longKey, wrapper);
        expect(() => unwrapSymmetricKey(wrapped, wrapper)).toThrow(CryptoError);
      });

      it('includes actual and expected length in error message', () => {
        const shortKey = new Uint8Array(16);
        const wrapped = wrapKey(shortKey, wrapper);
        expect(() => unwrapSymmetricKey(wrapped, wrapper)).toThrow(
          /Unwrapped key expected to be 32 bytes, got 16/,
        );
      });

      it('throws with INVALID_KEY_LENGTH error code', () => {
        const shortKey = new Uint8Array(16);
        const wrapped = wrapKey(shortKey, wrapper);
        try {
          unwrapSymmetricKey(wrapped, wrapper);
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(CryptoError);
          expect((e as CryptoError).code).toBe(
            CryptoErrorCode.INVALID_KEY_LENGTH,
          );
        }
      });

      it('accepts wrapped key that unwraps to exactly 32 bytes', () => {
        const exactKey = sodium.randombytes_buf(32);
        const wrapped = wrapKey(exactKey, wrapper);
        const unwrapped = unwrapSymmetricKey(wrapped, wrapper);
        expect(unwrapped.length).toBe(32);
        expect(unwrapped).toEqual(exactKey);
      });
    });
  });
});
