import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
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
  });

  it('rejects invalid key lengths', () => {
    expect(() => signManifest(manifest, new Uint8Array(32))).toThrow();
    expect(verifyManifest(manifest, new Uint8Array(64), new Uint8Array(16))).toBe(false);
  });
});
