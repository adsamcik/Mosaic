import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import { deriveIdentityKeypair, ed25519PubToX25519, generateIdentitySeed, isValidEd25519PublicKey } from '../src/identity';

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
    expect(sodium.crypto_sign_verify_detached(sig, message, kp.ed25519.publicKey)).toBe(true);
  });

  it('produces valid X25519 key exchange', () => {
    const seed1 = generateIdentitySeed();
    const seed2 = generateIdentitySeed();
    const kp1 = deriveIdentityKeypair(seed1);
    const kp2 = deriveIdentityKeypair(seed2);
    
    const shared1 = sodium.crypto_scalarmult(kp1.x25519.secretKey, kp2.x25519.publicKey);
    const shared2 = sodium.crypto_scalarmult(kp2.x25519.secretKey, kp1.x25519.publicKey);
    expect(shared1).toEqual(shared2);
  });

  it('converts Ed25519 pubkey to X25519', () => {
    const seed = generateIdentitySeed();
    const kp = deriveIdentityKeypair(seed);
    const converted = ed25519PubToX25519(kp.ed25519.publicKey);
    expect(converted).toEqual(kp.x25519.publicKey);
  });

  it('rejects invalid seed lengths', () => {
    expect(() => deriveIdentityKeypair(new Uint8Array(16))).toThrow();
  });

  it('validates Ed25519 public keys', () => {
    const seed = generateIdentitySeed();
    const kp = deriveIdentityKeypair(seed);
    expect(isValidEd25519PublicKey(kp.ed25519.publicKey)).toBe(true);
    expect(isValidEd25519PublicKey(new Uint8Array(32))).toBe(false); // All zeros invalid
  });
});
