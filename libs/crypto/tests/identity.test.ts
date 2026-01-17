import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import {
  deriveIdentityKeypair,
  ed25519PubToX25519,
  ed25519SecretToX25519,
  generateIdentitySeed,
  generateEd25519Keypair,
  isValidEd25519PublicKey,
} from '../src/identity';
import { CryptoError, CryptoErrorCode } from '../src/types';

beforeAll(async () => {
  await sodium.ready;
});

describe('identity', () => {
  it('derives consistent keypairs from same seed', () => {
    const seed = sodium.randombytes_buf(32);
    const kp1 = deriveIdentityKeypair(seed);
    const kp2 = deriveIdentityKeypair(seed);
    expect(kp1.ed25519.publicKey).toEqual(kp2.ed25519.publicKey);
    expect(kp1.x25519.publicKey).toEqual(kp2.x25519.publicKey);
  });

  it('produces valid Ed25519 signatures', () => {
    const seed = generateIdentitySeed();
    const kp = deriveIdentityKeypair(seed);
    const message = new Uint8Array([1, 2, 3, 4]);
    const sig = sodium.crypto_sign_detached(message, kp.ed25519.secretKey);
    expect(
      sodium.crypto_sign_verify_detached(sig, message, kp.ed25519.publicKey),
    ).toBe(true);
  });

  it('produces valid X25519 key exchange', () => {
    const seed1 = generateIdentitySeed();
    const seed2 = generateIdentitySeed();
    const kp1 = deriveIdentityKeypair(seed1);
    const kp2 = deriveIdentityKeypair(seed2);

    const shared1 = sodium.crypto_scalarmult(
      kp1.x25519.secretKey,
      kp2.x25519.publicKey,
    );
    const shared2 = sodium.crypto_scalarmult(
      kp2.x25519.secretKey,
      kp1.x25519.publicKey,
    );
    expect(shared1).toEqual(shared2);
  });

  it('converts Ed25519 pubkey to X25519', () => {
    const seed = generateIdentitySeed();
    const kp = deriveIdentityKeypair(seed);
    const converted = ed25519PubToX25519(kp.ed25519.publicKey);
    expect(converted).toEqual(kp.x25519.publicKey);
  });

  it('converts Ed25519 secret to X25519', () => {
    const seed = generateIdentitySeed();
    const kp = deriveIdentityKeypair(seed);
    const converted = ed25519SecretToX25519(kp.ed25519.secretKey);
    expect(converted).toEqual(kp.x25519.secretKey);
  });

  describe('deriveIdentityKeypair validation', () => {
    it('rejects seed that is too short (16 bytes)', () => {
      const shortSeed = new Uint8Array(16);
      expect(() => deriveIdentityKeypair(shortSeed)).toThrow(CryptoError);
    });

    it('rejects seed that is too long (48 bytes)', () => {
      const longSeed = new Uint8Array(48);
      expect(() => deriveIdentityKeypair(longSeed)).toThrow(CryptoError);
    });

    it('error message includes expected byte count (32)', () => {
      try {
        deriveIdentityKeypair(new Uint8Array(16));
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as CryptoError).message).toContain('32 bytes');
        expect((e as CryptoError).message).toContain('got 16');
        expect((e as CryptoError).code).toBe(
          CryptoErrorCode.INVALID_KEY_LENGTH,
        );
      }
    });

    it('error message includes actual byte count received', () => {
      try {
        deriveIdentityKeypair(new Uint8Array(48));
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as CryptoError).message).toContain('32 bytes');
        expect((e as CryptoError).message).toContain('got 48');
      }
    });
  });

  describe('ed25519PubToX25519 validation', () => {
    it('rejects public key that is too short (16 bytes)', () => {
      expect(() => ed25519PubToX25519(new Uint8Array(16))).toThrow(CryptoError);
    });

    it('rejects public key that is too long (48 bytes)', () => {
      expect(() => ed25519PubToX25519(new Uint8Array(48))).toThrow(CryptoError);
    });

    it('error message includes expected byte count (32)', () => {
      try {
        ed25519PubToX25519(new Uint8Array(16));
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as CryptoError).message).toContain('32 bytes');
        expect((e as CryptoError).message).toContain('got 16');
        expect((e as CryptoError).code).toBe(
          CryptoErrorCode.INVALID_KEY_LENGTH,
        );
      }
    });

    it('error message includes actual byte count for too-long key', () => {
      try {
        ed25519PubToX25519(new Uint8Array(64));
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as CryptoError).message).toContain('32 bytes');
        expect((e as CryptoError).message).toContain('got 64');
      }
    });
  });

  describe('ed25519SecretToX25519 validation', () => {
    it('rejects secret key that is too short (32 bytes)', () => {
      expect(() => ed25519SecretToX25519(new Uint8Array(32))).toThrow(
        CryptoError,
      );
    });

    it('rejects secret key that is too long (96 bytes)', () => {
      expect(() => ed25519SecretToX25519(new Uint8Array(96))).toThrow(
        CryptoError,
      );
    });

    it('error message includes expected byte count (64)', () => {
      try {
        ed25519SecretToX25519(new Uint8Array(32));
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as CryptoError).message).toContain('64 bytes');
        expect((e as CryptoError).message).toContain('got 32');
        expect((e as CryptoError).code).toBe(
          CryptoErrorCode.INVALID_KEY_LENGTH,
        );
      }
    });

    it('error message includes actual byte count for too-long key', () => {
      try {
        ed25519SecretToX25519(new Uint8Array(128));
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as CryptoError).message).toContain('64 bytes');
        expect((e as CryptoError).message).toContain('got 128');
      }
    });
  });

  describe('isValidEd25519PublicKey validation', () => {
    it('returns true for valid public key', () => {
      const seed = generateIdentitySeed();
      const kp = deriveIdentityKeypair(seed);
      expect(isValidEd25519PublicKey(kp.ed25519.publicKey)).toBe(true);
    });

    it('returns false for key that is too short', () => {
      expect(isValidEd25519PublicKey(new Uint8Array(16))).toBe(false);
    });

    it('returns false for key that is too long', () => {
      expect(isValidEd25519PublicKey(new Uint8Array(48))).toBe(false);
    });

    it('returns false for all-zeros key (not on curve)', () => {
      const invalidKey = new Uint8Array(32).fill(0);
      expect(isValidEd25519PublicKey(invalidKey)).toBe(false);
    });

    it('returns false for low-order point', () => {
      // Small order point - libsodium should reject this
      const lowOrderPoint = new Uint8Array(32);
      lowOrderPoint[0] = 1;
      expect(isValidEd25519PublicKey(lowOrderPoint)).toBe(false);
    });

    // ====================================================================
    // Mutation testing: L158 validation bypass mutants
    // These tests verify that when length check is mutated to `if (false)`,
    // the behavior changes detectably via spy.
    // ====================================================================
    it('does NOT call libsodium for wrong-length key (spy verification)', () => {
      // Kills mutant: if (publicKey.length !== 32) → if (false)
      // Kills mutant: BlockStatement removed (length check block removed)
      // If length check is bypassed, libsodium function would be called
      const originalFn = sodium.crypto_sign_ed25519_pk_to_curve25519;
      const spy = vi.fn(originalFn);
      (
        sodium as unknown as Record<string, unknown>
      ).crypto_sign_ed25519_pk_to_curve25519 = spy;

      try {
        // Too short key
        const result16 = isValidEd25519PublicKey(new Uint8Array(16));
        expect(result16).toBe(false);
        expect(spy).not.toHaveBeenCalled(); // Must NOT reach libsodium

        // Too long key
        const result48 = isValidEd25519PublicKey(new Uint8Array(48));
        expect(result48).toBe(false);
        expect(spy).not.toHaveBeenCalled(); // Must NOT reach libsodium

        // Empty key
        const result0 = isValidEd25519PublicKey(new Uint8Array(0));
        expect(result0).toBe(false);
        expect(spy).not.toHaveBeenCalled(); // Must NOT reach libsodium
      } finally {
        sodium.crypto_sign_ed25519_pk_to_curve25519 = originalFn;
      }
    });

    it('DOES call libsodium for correct-length key', () => {
      // Complementary test: correct length SHOULD call libsodium
      const originalFn = sodium.crypto_sign_ed25519_pk_to_curve25519;
      const spy = vi.fn(originalFn);
      (
        sodium as unknown as Record<string, unknown>
      ).crypto_sign_ed25519_pk_to_curve25519 = spy;

      try {
        const seed = generateIdentitySeed();
        const kp = deriveIdentityKeypair(seed);
        const result = isValidEd25519PublicKey(kp.ed25519.publicKey);
        expect(result).toBe(true);
        expect(spy).toHaveBeenCalled(); // Must call libsodium at least once
      } finally {
        sodium.crypto_sign_ed25519_pk_to_curve25519 = originalFn;
      }
    });
  });

  describe('generateEd25519Keypair', () => {
    it('generates valid keypairs', () => {
      const kp = generateEd25519Keypair();
      expect(kp.publicKey.length).toBe(32);
      expect(kp.secretKey.length).toBe(64);
    });

    it('generates unique keypairs each time', () => {
      const kp1 = generateEd25519Keypair();
      const kp2 = generateEd25519Keypair();
      expect(kp1.publicKey).not.toEqual(kp2.publicKey);
      expect(kp1.secretKey).not.toEqual(kp2.secretKey);
    });
  });

  describe('mocked conversion errors', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('throws KEY_CONVERSION_FAILED when deriveIdentityKeypair pk conversion fails', () => {
      const seed = generateIdentitySeed();
      const originalFn = sodium.crypto_sign_ed25519_pk_to_curve25519;
      sodium.crypto_sign_ed25519_pk_to_curve25519 = vi.fn(() => {
        throw new Error('Simulated conversion failure');
      }) as typeof sodium.crypto_sign_ed25519_pk_to_curve25519;

      try {
        expect(() => deriveIdentityKeypair(seed)).toThrow(CryptoError);
        try {
          deriveIdentityKeypair(seed);
        } catch (e) {
          expect((e as CryptoError).message).toContain(
            'Failed to convert Ed25519 to X25519',
          );
          expect((e as CryptoError).code).toBe(
            CryptoErrorCode.KEY_CONVERSION_FAILED,
          );
          expect((e as CryptoError).cause).toBeInstanceOf(Error);
        }
      } finally {
        sodium.crypto_sign_ed25519_pk_to_curve25519 = originalFn;
      }
    });

    it('throws KEY_CONVERSION_FAILED when deriveIdentityKeypair sk conversion fails', () => {
      const seed = generateIdentitySeed();
      const originalFn = sodium.crypto_sign_ed25519_sk_to_curve25519;
      sodium.crypto_sign_ed25519_sk_to_curve25519 = vi.fn(() => {
        throw new Error('Simulated sk conversion failure');
      }) as typeof sodium.crypto_sign_ed25519_sk_to_curve25519;

      try {
        expect(() => deriveIdentityKeypair(seed)).toThrow(CryptoError);
        try {
          deriveIdentityKeypair(seed);
        } catch (e) {
          expect((e as CryptoError).message).toContain(
            'Failed to convert Ed25519 to X25519',
          );
          expect((e as CryptoError).code).toBe(
            CryptoErrorCode.KEY_CONVERSION_FAILED,
          );
        }
      } finally {
        sodium.crypto_sign_ed25519_sk_to_curve25519 = originalFn;
      }
    });

    it('throws KEY_CONVERSION_FAILED when ed25519SecretToX25519 fails', () => {
      const seed = generateIdentitySeed();
      const kp = deriveIdentityKeypair(seed);
      const originalFn = sodium.crypto_sign_ed25519_sk_to_curve25519;
      sodium.crypto_sign_ed25519_sk_to_curve25519 = vi.fn(() => {
        throw new Error('Simulated conversion failure');
      }) as typeof sodium.crypto_sign_ed25519_sk_to_curve25519;

      try {
        expect(() => ed25519SecretToX25519(kp.ed25519.secretKey)).toThrow(
          CryptoError,
        );
        try {
          ed25519SecretToX25519(kp.ed25519.secretKey);
        } catch (e) {
          expect((e as CryptoError).message).toContain(
            'Failed to convert Ed25519 secret key to X25519',
          );
          expect((e as CryptoError).code).toBe(
            CryptoErrorCode.KEY_CONVERSION_FAILED,
          );
          expect((e as CryptoError).cause).toBeInstanceOf(Error);
        }
      } finally {
        sodium.crypto_sign_ed25519_sk_to_curve25519 = originalFn;
      }
    });

    it('throws KEY_CONVERSION_FAILED when ed25519PubToX25519 fails', () => {
      const seed = generateIdentitySeed();
      const kp = deriveIdentityKeypair(seed);
      const originalFn = sodium.crypto_sign_ed25519_pk_to_curve25519;
      sodium.crypto_sign_ed25519_pk_to_curve25519 = vi.fn(() => {
        throw new Error('Simulated conversion failure');
      }) as typeof sodium.crypto_sign_ed25519_pk_to_curve25519;

      try {
        expect(() => ed25519PubToX25519(kp.ed25519.publicKey)).toThrow(
          CryptoError,
        );
        try {
          ed25519PubToX25519(kp.ed25519.publicKey);
        } catch (e) {
          expect((e as CryptoError).message).toContain(
            'Failed to convert Ed25519 public key to X25519',
          );
          expect((e as CryptoError).code).toBe(
            CryptoErrorCode.KEY_CONVERSION_FAILED,
          );
          expect((e as CryptoError).cause).toBeInstanceOf(Error);
        }
      } finally {
        sodium.crypto_sign_ed25519_pk_to_curve25519 = originalFn;
      }
    });

    it('isValidEd25519PublicKey returns false when conversion throws', () => {
      const seed = generateIdentitySeed();
      const kp = deriveIdentityKeypair(seed);
      const originalFn = sodium.crypto_sign_ed25519_pk_to_curve25519;
      sodium.crypto_sign_ed25519_pk_to_curve25519 = vi.fn(() => {
        throw new Error('Simulated conversion failure');
      }) as typeof sodium.crypto_sign_ed25519_pk_to_curve25519;

      try {
        // Even with a valid public key, if conversion fails, should return false
        expect(isValidEd25519PublicKey(kp.ed25519.publicKey)).toBe(false);
      } finally {
        sodium.crypto_sign_ed25519_pk_to_curve25519 = originalFn;
      }
    });
  });
});
