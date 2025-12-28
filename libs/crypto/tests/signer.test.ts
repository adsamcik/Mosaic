import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { signManifest, verifyManifest, signShard, verifyShard, signWithContext, verifyWithContext } from '../src/signer';
import { CryptoErrorCode } from '../src/types';

beforeAll(async () => {
  await sodium.ready;
});

describe('signer', () => {
  const keypair = sodium.crypto_sign_keypair();
  const manifest = new TextEncoder().encode('{"test": "manifest"}');
  const header = sodium.randombytes_buf(64);
  const ciphertext = sodium.randombytes_buf(100);

  describe('manifest signing', () => {
    it('produces valid signatures', () => {
      const sig = signManifest(manifest, keypair.privateKey);
      expect(verifyManifest(manifest, sig, keypair.publicKey)).toBe(true);
    });

    it('rejects tampered manifest', () => {
      const sig = signManifest(manifest, keypair.privateKey);
      const tampered = new Uint8Array(manifest);
      tampered[0] ^= 0xff;
      expect(verifyManifest(tampered, sig, keypair.publicKey)).toBe(false);
    });

    it('rejects wrong public key', () => {
      const sig = signManifest(manifest, keypair.privateKey);
      const other = sodium.crypto_sign_keypair();
      expect(verifyManifest(manifest, sig, other.publicKey)).toBe(false);
    });

    it('throws with correct error message and code for invalid key length (too short)', () => {
      const shortKey = new Uint8Array(32);
      expect(() => signManifest(manifest, shortKey)).toThrowError(
        /Signing secret key must be 64 bytes, got 32/
      );
      try {
        signManifest(manifest, shortKey);
      } catch (e: unknown) {
        expect((e as { code: string }).code).toBe(CryptoErrorCode.INVALID_KEY_LENGTH);
      }
    });

    it('throws with correct error message for invalid key length (too long)', () => {
      const longKey = new Uint8Array(128);
      expect(() => signManifest(manifest, longKey)).toThrowError(
        /Signing secret key must be 64 bytes, got 128/
      );
    });

    it('throws for empty key', () => {
      const emptyKey = new Uint8Array(0);
      expect(() => signManifest(manifest, emptyKey)).toThrowError(
        /Signing secret key must be 64 bytes, got 0/
      );
    });

    it('rejects signature that is too short', () => {
      const shortSig = new Uint8Array(32);
      expect(verifyManifest(manifest, shortSig, keypair.publicKey)).toBe(false);
    });

    it('rejects signature that is too long', () => {
      const longSig = new Uint8Array(128);
      expect(verifyManifest(manifest, longSig, keypair.publicKey)).toBe(false);
    });

    it('rejects empty signature', () => {
      const emptySig = new Uint8Array(0);
      expect(verifyManifest(manifest, emptySig, keypair.publicKey)).toBe(false);
    });

    it('rejects public key that is too short', () => {
      const sig = signManifest(manifest, keypair.privateKey);
      const shortPubKey = new Uint8Array(16);
      expect(verifyManifest(manifest, sig, shortPubKey)).toBe(false);
    });

    it('rejects public key that is too long', () => {
      const sig = signManifest(manifest, keypair.privateKey);
      const longPubKey = new Uint8Array(64);
      expect(verifyManifest(manifest, sig, longPubKey)).toBe(false);
    });

    it('rejects empty public key', () => {
      const sig = signManifest(manifest, keypair.privateKey);
      const emptyPubKey = new Uint8Array(0);
      expect(verifyManifest(manifest, sig, emptyPubKey)).toBe(false);
    });
  });

  describe('shard signing', () => {
    it('produces valid signatures', () => {
      const sig = signShard(header, ciphertext, keypair.privateKey);
      expect(verifyShard(header, ciphertext, sig, keypair.publicKey)).toBe(true);
    });

    it('rejects tampered header', () => {
      const sig = signShard(header, ciphertext, keypair.privateKey);
      const tampered = new Uint8Array(header);
      tampered[0] ^= 0xff;
      expect(verifyShard(tampered, ciphertext, sig, keypair.publicKey)).toBe(false);
    });

    it('throws with correct error message and code for invalid key length (too short)', () => {
      const shortKey = new Uint8Array(32);
      expect(() => signShard(header, ciphertext, shortKey)).toThrowError(
        /Signing secret key must be 64 bytes, got 32/
      );
      try {
        signShard(header, ciphertext, shortKey);
      } catch (e: unknown) {
        expect((e as { code: string }).code).toBe(CryptoErrorCode.INVALID_KEY_LENGTH);
      }
    });

    it('throws for key that is too long', () => {
      const longKey = new Uint8Array(128);
      expect(() => signShard(header, ciphertext, longKey)).toThrowError(
        /Signing secret key must be 64 bytes, got 128/
      );
    });

    it('throws for empty key', () => {
      const emptyKey = new Uint8Array(0);
      expect(() => signShard(header, ciphertext, emptyKey)).toThrowError(
        /Signing secret key must be 64 bytes, got 0/
      );
    });

    it('rejects signature that is too short', () => {
      const shortSig = new Uint8Array(32);
      expect(verifyShard(header, ciphertext, shortSig, keypair.publicKey)).toBe(false);
    });

    it('rejects signature that is too long', () => {
      const longSig = new Uint8Array(128);
      expect(verifyShard(header, ciphertext, longSig, keypair.publicKey)).toBe(false);
    });

    it('rejects empty signature', () => {
      const emptySig = new Uint8Array(0);
      expect(verifyShard(header, ciphertext, emptySig, keypair.publicKey)).toBe(false);
    });

    it('rejects public key that is too short', () => {
      const sig = signShard(header, ciphertext, keypair.privateKey);
      const shortPubKey = new Uint8Array(16);
      expect(verifyShard(header, ciphertext, sig, shortPubKey)).toBe(false);
    });

    it('rejects public key that is too long', () => {
      const sig = signShard(header, ciphertext, keypair.privateKey);
      const longPubKey = new Uint8Array(64);
      expect(verifyShard(header, ciphertext, sig, longPubKey)).toBe(false);
    });

    it('rejects empty public key', () => {
      const sig = signShard(header, ciphertext, keypair.privateKey);
      const emptyPubKey = new Uint8Array(0);
      expect(verifyShard(header, ciphertext, sig, emptyPubKey)).toBe(false);
    });
  });

  describe('context signing', () => {
    it('works with custom context', () => {
      const data = new Uint8Array([1, 2, 3]);
      const ctx = 'MyApp_v1';
      const sig = signWithContext(data, ctx, keypair.privateKey);
      expect(verifyWithContext(data, sig, ctx, keypair.publicKey)).toBe(true);
      expect(verifyWithContext(data, sig, 'WrongContext', keypair.publicKey)).toBe(false);
    });

    it('throws with correct error message and code for invalid key length (too short)', () => {
      const data = new Uint8Array([1, 2, 3]);
      const shortKey = new Uint8Array(32);
      expect(() => signWithContext(data, 'ctx', shortKey)).toThrowError(
        /Signing secret key must be 64 bytes, got 32/
      );
      try {
        signWithContext(data, 'ctx', shortKey);
      } catch (e: unknown) {
        expect((e as { code: string }).code).toBe(CryptoErrorCode.INVALID_KEY_LENGTH);
      }
    });

    it('throws for key that is too long', () => {
      const data = new Uint8Array([1, 2, 3]);
      const longKey = new Uint8Array(128);
      expect(() => signWithContext(data, 'ctx', longKey)).toThrowError(
        /Signing secret key must be 64 bytes, got 128/
      );
    });

    it('throws for empty key', () => {
      const data = new Uint8Array([1, 2, 3]);
      const emptyKey = new Uint8Array(0);
      expect(() => signWithContext(data, 'ctx', emptyKey)).toThrowError(
        /Signing secret key must be 64 bytes, got 0/
      );
    });

    it('rejects signature that is too short', () => {
      const data = new Uint8Array([1, 2, 3]);
      const shortSig = new Uint8Array(32);
      expect(verifyWithContext(data, shortSig, 'ctx', keypair.publicKey)).toBe(false);
    });

    it('rejects signature that is too long', () => {
      const data = new Uint8Array([1, 2, 3]);
      const longSig = new Uint8Array(128);
      expect(verifyWithContext(data, longSig, 'ctx', keypair.publicKey)).toBe(false);
    });

    it('rejects empty signature', () => {
      const data = new Uint8Array([1, 2, 3]);
      const emptySig = new Uint8Array(0);
      expect(verifyWithContext(data, emptySig, 'ctx', keypair.publicKey)).toBe(false);
    });

    it('rejects public key that is too short', () => {
      const data = new Uint8Array([1, 2, 3]);
      const sig = signWithContext(data, 'ctx', keypair.privateKey);
      expect(verifyWithContext(data, sig, 'ctx', new Uint8Array(16))).toBe(false);
    });

    it('rejects public key that is too long', () => {
      const data = new Uint8Array([1, 2, 3]);
      const sig = signWithContext(data, 'ctx', keypair.privateKey);
      expect(verifyWithContext(data, sig, 'ctx', new Uint8Array(64))).toBe(false);
    });

    it('rejects empty public key', () => {
      const data = new Uint8Array([1, 2, 3]);
      const sig = signWithContext(data, 'ctx', keypair.privateKey);
      expect(verifyWithContext(data, sig, 'ctx', new Uint8Array(0))).toBe(false);
    });

    it('returns false when verifyWithContext crypto throws', () => {
      const data = new Uint8Array([1, 2, 3]);
      // Create a signature that looks valid but is garbage
      const fakeSig = sodium.randombytes_buf(64);
      expect(verifyWithContext(data, fakeSig, 'ctx', keypair.publicKey)).toBe(false);
    });
  });

  describe('domain separation', () => {
    it('shard signature is NOT valid when verified with empty context via signWithContext', () => {
      // This test kills the L13 mutation: SHARD_SIGN_CONTEXT → empty string
      // If SHARD_SIGN_CONTEXT were empty, the shard signature would be verifiable with empty context
      const sig = signShard(header, ciphertext, keypair.privateKey);
      const shardData = new Uint8Array(header.length + ciphertext.length);
      shardData.set(header);
      shardData.set(ciphertext, header.length);

      // The shard uses 'Mosaic_Shard_v1' context - verify it does NOT work with empty context
      const validWithEmpty = verifyWithContext(shardData, sig, '', keypair.publicKey);
      expect(validWithEmpty).toBe(false);
    });

    it('shard signature is valid only with correct internal context', () => {
      // Verify shard signatures use the specific context 'Mosaic_Shard_v1'
      const sig = signShard(header, ciphertext, keypair.privateKey);
      const shardData = new Uint8Array(header.length + ciphertext.length);
      shardData.set(header);
      shardData.set(ciphertext, header.length);

      // Should work with exact context
      const validWithCorrectContext = verifyWithContext(shardData, sig, 'Mosaic_Shard_v1', keypair.publicKey);
      expect(validWithCorrectContext).toBe(true);

      // Should NOT work with wrong context
      const validWithWrongContext = verifyWithContext(shardData, sig, 'Wrong_Context', keypair.publicKey);
      expect(validWithWrongContext).toBe(false);
    });

    it('manifest signature is NOT valid when verified with empty context', () => {
      const sig = signManifest(manifest, keypair.privateKey);

      // Verify it does NOT work with empty context
      const validWithEmpty = verifyWithContext(manifest, sig, '', keypair.publicKey);
      expect(validWithEmpty).toBe(false);
    });

    it('manifest and shard signatures are not interchangeable', () => {
      // Sign data as manifest
      const manifestSig = signManifest(manifest, keypair.privateKey);

      // Should not verify as shard
      const validAsShard = verifyShard(manifest, new Uint8Array(0), manifestSig, keypair.publicKey);
      expect(validAsShard).toBe(false);
    });
  });

  describe('manifest edge cases (catch blocks)', () => {
    it('returns false for invalid signature length in verifyManifest', () => {
      const invalidSig = new Uint8Array(32); // Should be 64
      expect(verifyManifest(manifest, invalidSig, keypair.publicKey)).toBe(false);
    });

    it('returns false when verifyManifest crypto throws', () => {
      const fakeSig = sodium.randombytes_buf(64);
      expect(verifyManifest(manifest, fakeSig, keypair.publicKey)).toBe(false);
    });
  });

  describe('shard edge cases (catch blocks)', () => {
    it('returns false when verifyShard crypto throws', () => {
      // Create a signature that looks valid length but is garbage
      const fakeSig = sodium.randombytes_buf(64);
      expect(verifyShard(header, ciphertext, fakeSig, keypair.publicKey)).toBe(false);
    });
  });

  describe('mocked verification errors', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns false when verifyManifest internal crypto throws', () => {
      const sig = signManifest(manifest, keypair.privateKey);
      const originalFn = sodium.crypto_sign_verify_detached;
      sodium.crypto_sign_verify_detached = vi.fn(() => {
        throw new Error('Simulated verification failure');
      }) as typeof sodium.crypto_sign_verify_detached;
      
      try {
        expect(verifyManifest(manifest, sig, keypair.publicKey)).toBe(false);
      } finally {
        sodium.crypto_sign_verify_detached = originalFn;
      }
    });

    it('returns false when verifyShard internal crypto throws', () => {
      const sig = signShard(header, ciphertext, keypair.privateKey);
      const originalFn = sodium.crypto_sign_verify_detached;
      sodium.crypto_sign_verify_detached = vi.fn(() => {
        throw new Error('Simulated verification failure');
      }) as typeof sodium.crypto_sign_verify_detached;
      
      try {
        expect(verifyShard(header, ciphertext, sig, keypair.publicKey)).toBe(false);
      } finally {
        sodium.crypto_sign_verify_detached = originalFn;
      }
    });

    it('returns false when verifyWithContext internal crypto throws', () => {
      const data = new Uint8Array([1, 2, 3]);
      const sig = signWithContext(data, 'ctx', keypair.privateKey);
      const originalFn = sodium.crypto_sign_verify_detached;
      sodium.crypto_sign_verify_detached = vi.fn(() => {
        throw new Error('Simulated verification failure');
      }) as typeof sodium.crypto_sign_verify_detached;
      
      try {
        expect(verifyWithContext(data, sig, 'ctx', keypair.publicKey)).toBe(false);
      } finally {
        sodium.crypto_sign_verify_detached = originalFn;
      }
    });
  });

  describe('length validation guards (mutation testing)', () => {
    // These tests verify that length checks happen BEFORE libsodium is called.
    // This kills mutants that change `if (length !== X)` to `if (false)`.
    // We use a spy to confirm crypto is never invoked for invalid lengths.

    afterEach(() => {
      vi.restoreAllMocks();
    });

    describe('verifyManifest length guards', () => {
      it('rejects 63-byte signature without calling libsodium', () => {
        const spy = vi.spyOn(sodium, 'crypto_sign_verify_detached');
        const sig63 = new Uint8Array(63); // One byte short of SIGNATURE_LENGTH (64)
        
        const result = verifyManifest(manifest, sig63, keypair.publicKey);
        
        expect(result).toBe(false);
        expect(spy).not.toHaveBeenCalled();
      });

      it('rejects 65-byte signature without calling libsodium', () => {
        const spy = vi.spyOn(sodium, 'crypto_sign_verify_detached');
        const sig65 = new Uint8Array(65); // One byte over SIGNATURE_LENGTH (64)
        
        const result = verifyManifest(manifest, sig65, keypair.publicKey);
        
        expect(result).toBe(false);
        expect(spy).not.toHaveBeenCalled();
      });

      it('rejects 31-byte public key without calling libsodium', () => {
        const spy = vi.spyOn(sodium, 'crypto_sign_verify_detached');
        const sig = signManifest(manifest, keypair.privateKey);
        const pubKey31 = new Uint8Array(31); // One byte short of PUBLIC_KEY_LENGTH (32)
        
        const result = verifyManifest(manifest, sig, pubKey31);
        
        expect(result).toBe(false);
        expect(spy).not.toHaveBeenCalled();
      });

      it('rejects 33-byte public key without calling libsodium', () => {
        const spy = vi.spyOn(sodium, 'crypto_sign_verify_detached');
        const sig = signManifest(manifest, keypair.privateKey);
        const pubKey33 = new Uint8Array(33); // One byte over PUBLIC_KEY_LENGTH (32)
        
        const result = verifyManifest(manifest, sig, pubKey33);
        
        expect(result).toBe(false);
        expect(spy).not.toHaveBeenCalled();
      });
    });

    describe('verifyShard length guards', () => {
      it('rejects 63-byte signature without calling libsodium', () => {
        const spy = vi.spyOn(sodium, 'crypto_sign_verify_detached');
        const sig63 = new Uint8Array(63);
        
        const result = verifyShard(header, ciphertext, sig63, keypair.publicKey);
        
        expect(result).toBe(false);
        expect(spy).not.toHaveBeenCalled();
      });

      it('rejects 65-byte signature without calling libsodium', () => {
        const spy = vi.spyOn(sodium, 'crypto_sign_verify_detached');
        const sig65 = new Uint8Array(65);
        
        const result = verifyShard(header, ciphertext, sig65, keypair.publicKey);
        
        expect(result).toBe(false);
        expect(spy).not.toHaveBeenCalled();
      });

      it('rejects 31-byte public key without calling libsodium', () => {
        const spy = vi.spyOn(sodium, 'crypto_sign_verify_detached');
        const sig = signShard(header, ciphertext, keypair.privateKey);
        const pubKey31 = new Uint8Array(31);
        
        const result = verifyShard(header, ciphertext, sig, pubKey31);
        
        expect(result).toBe(false);
        expect(spy).not.toHaveBeenCalled();
      });

      it('rejects 33-byte public key without calling libsodium', () => {
        const spy = vi.spyOn(sodium, 'crypto_sign_verify_detached');
        const sig = signShard(header, ciphertext, keypair.privateKey);
        const pubKey33 = new Uint8Array(33);
        
        const result = verifyShard(header, ciphertext, sig, pubKey33);
        
        expect(result).toBe(false);
        expect(spy).not.toHaveBeenCalled();
      });
    });

    describe('verifyWithContext length guards', () => {
      const data = new Uint8Array([1, 2, 3]);
      const ctx = 'test_context';

      it('rejects 63-byte signature without calling libsodium', () => {
        const spy = vi.spyOn(sodium, 'crypto_sign_verify_detached');
        const sig63 = new Uint8Array(63);
        
        const result = verifyWithContext(data, sig63, ctx, keypair.publicKey);
        
        expect(result).toBe(false);
        expect(spy).not.toHaveBeenCalled();
      });

      it('rejects 65-byte signature without calling libsodium', () => {
        const spy = vi.spyOn(sodium, 'crypto_sign_verify_detached');
        const sig65 = new Uint8Array(65);
        
        const result = verifyWithContext(data, sig65, ctx, keypair.publicKey);
        
        expect(result).toBe(false);
        expect(spy).not.toHaveBeenCalled();
      });

      it('rejects 31-byte public key without calling libsodium', () => {
        const spy = vi.spyOn(sodium, 'crypto_sign_verify_detached');
        const sig = signWithContext(data, ctx, keypair.privateKey);
        const pubKey31 = new Uint8Array(31);
        
        const result = verifyWithContext(data, sig, ctx, pubKey31);
        
        expect(result).toBe(false);
        expect(spy).not.toHaveBeenCalled();
      });

      it('rejects 33-byte public key without calling libsodium', () => {
        const spy = vi.spyOn(sodium, 'crypto_sign_verify_detached');
        const sig = signWithContext(data, ctx, keypair.privateKey);
        const pubKey33 = new Uint8Array(33);
        
        const result = verifyWithContext(data, sig, ctx, pubKey33);
        
        expect(result).toBe(false);
        expect(spy).not.toHaveBeenCalled();
      });
    });
  });
});
