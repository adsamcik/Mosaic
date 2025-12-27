import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { signManifest, verifyManifest, signShard, verifyShard, signWithContext, verifyWithContext } from '../src/signer';

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
  });

  describe('context signing', () => {
    it('works with custom context', () => {
      const data = new Uint8Array([1, 2, 3]);
      const ctx = 'MyApp_v1';
      const sig = signWithContext(data, ctx, keypair.privateKey);
      expect(verifyWithContext(data, sig, ctx, keypair.publicKey)).toBe(true);
      expect(verifyWithContext(data, sig, 'WrongContext', keypair.publicKey)).toBe(false);
    });

    it('rejects invalid key length for signWithContext', () => {
      const data = new Uint8Array([1, 2, 3]);
      expect(() => signWithContext(data, 'ctx', new Uint8Array(32))).toThrow();
    });

    it('returns false for invalid signature length in verifyWithContext', () => {
      const data = new Uint8Array([1, 2, 3]);
      const invalidSig = new Uint8Array(32); // Should be 64
      expect(verifyWithContext(data, invalidSig, 'ctx', keypair.publicKey)).toBe(false);
    });

    it('returns false for invalid public key length in verifyWithContext', () => {
      const data = new Uint8Array([1, 2, 3]);
      const sig = signWithContext(data, 'ctx', keypair.privateKey);
      expect(verifyWithContext(data, sig, 'ctx', new Uint8Array(16))).toBe(false);
    });

    it('returns false when verifyWithContext crypto throws', () => {
      const data = new Uint8Array([1, 2, 3]);
      // Create a signature that looks valid but is garbage
      const fakeSig = sodium.randombytes_buf(64);
      expect(verifyWithContext(data, fakeSig, 'ctx', keypair.publicKey)).toBe(false);
    });
  });

  describe('shard signing edge cases', () => {
    it('rejects invalid key length for signShard', () => {
      expect(() => signShard(header, ciphertext, new Uint8Array(32))).toThrow();
    });

    it('returns false for invalid signature length in verifyShard', () => {
      const invalidSig = new Uint8Array(32); // Should be 64
      expect(verifyShard(header, ciphertext, invalidSig, keypair.publicKey)).toBe(false);
    });

    it('returns false for invalid public key length in verifyShard', () => {
      const sig = signShard(header, ciphertext, keypair.privateKey);
      expect(verifyShard(header, ciphertext, sig, new Uint8Array(16))).toBe(false);
    });

    it('returns false when verifyShard crypto throws', () => {
      // Create a signature that looks valid length but is garbage
      const fakeSig = sodium.randombytes_buf(64);
      expect(verifyShard(header, ciphertext, fakeSig, keypair.publicKey)).toBe(false);
    });
  });

  describe('manifest edge cases', () => {
    it('returns false for invalid signature length in verifyManifest', () => {
      const invalidSig = new Uint8Array(32); // Should be 64
      expect(verifyManifest(manifest, invalidSig, keypair.publicKey)).toBe(false);
    });

    it('returns false when verifyManifest crypto throws', () => {
      const fakeSig = sodium.randombytes_buf(64);
      expect(verifyManifest(manifest, fakeSig, keypair.publicKey)).toBe(false);
    });
  });

  it('rejects invalid key lengths', () => {
    expect(() => signManifest(manifest, new Uint8Array(32))).toThrow();
    expect(verifyManifest(manifest, new Uint8Array(64), new Uint8Array(16))).toBe(false);
  });
});
