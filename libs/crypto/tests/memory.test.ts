import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { zeroEpochKey, zeroIdentityKeypair, zeroLinkKeys } from '../src/memory';
import type { EpochKey, IdentityKeypair, LinkKeys } from '../src/types';

beforeAll(async () => {
  await sodium.ready;
});

function isAllZeros(buf: Uint8Array): boolean {
  return buf.every((b) => b === 0);
}

function hasNonZero(buf: Uint8Array): boolean {
  return buf.some((b) => b !== 0);
}

describe('zeroEpochKey', () => {
  it('zeros all sensitive fields', () => {
    const signKeypair = sodium.crypto_sign_keypair();
    const epochKey: EpochKey = {
      epochId: 1,
      epochSeed: sodium.randombytes_buf(32),
      thumbKey: sodium.randombytes_buf(32),
      previewKey: sodium.randombytes_buf(32),
      fullKey: sodium.randombytes_buf(32),
      signKeypair: {
        publicKey: signKeypair.publicKey,
        secretKey: signKeypair.privateKey,
      },
    };

    // Precondition: all sensitive fields have non-zero data
    expect(hasNonZero(epochKey.epochSeed)).toBe(true);
    expect(hasNonZero(epochKey.thumbKey)).toBe(true);
    expect(hasNonZero(epochKey.previewKey)).toBe(true);
    expect(hasNonZero(epochKey.fullKey)).toBe(true);
    expect(hasNonZero(epochKey.signKeypair.secretKey)).toBe(true);

    zeroEpochKey(epochKey);

    expect(isAllZeros(epochKey.epochSeed)).toBe(true);
    expect(isAllZeros(epochKey.thumbKey)).toBe(true);
    expect(isAllZeros(epochKey.previewKey)).toBe(true);
    expect(isAllZeros(epochKey.fullKey)).toBe(true);
    expect(isAllZeros(epochKey.signKeypair.secretKey)).toBe(true);
  });

  it('does not zero the sign publicKey', () => {
    const signKeypair = sodium.crypto_sign_keypair();
    const pubKeyCopy = new Uint8Array(signKeypair.publicKey);
    const epochKey: EpochKey = {
      epochId: 1,
      epochSeed: sodium.randombytes_buf(32),
      thumbKey: sodium.randombytes_buf(32),
      previewKey: sodium.randombytes_buf(32),
      fullKey: sodium.randombytes_buf(32),
      signKeypair: {
        publicKey: signKeypair.publicKey,
        secretKey: signKeypair.privateKey,
      },
    };

    zeroEpochKey(epochKey);

    expect(epochKey.signKeypair.publicKey).toEqual(pubKeyCopy);
    expect(hasNonZero(epochKey.signKeypair.publicKey)).toBe(true);
  });

  it('preserves epochId', () => {
    const signKeypair = sodium.crypto_sign_keypair();
    const epochKey: EpochKey = {
      epochId: 42,
      epochSeed: sodium.randombytes_buf(32),
      thumbKey: sodium.randombytes_buf(32),
      previewKey: sodium.randombytes_buf(32),
      fullKey: sodium.randombytes_buf(32),
      signKeypair: {
        publicKey: signKeypair.publicKey,
        secretKey: signKeypair.privateKey,
      },
    };

    zeroEpochKey(epochKey);

    expect(epochKey.epochId).toBe(42);
  });
});

describe('zeroIdentityKeypair', () => {
  it('zeros both secret keys', () => {
    const edKp = sodium.crypto_sign_keypair();
    const x25519Pub = sodium.crypto_sign_ed25519_pk_to_curve25519(edKp.publicKey);
    const x25519Sec = sodium.crypto_sign_ed25519_sk_to_curve25519(edKp.privateKey);

    const keypair: IdentityKeypair = {
      ed25519: { publicKey: edKp.publicKey, secretKey: edKp.privateKey },
      x25519: { publicKey: x25519Pub, secretKey: x25519Sec },
    };

    expect(hasNonZero(keypair.ed25519.secretKey)).toBe(true);
    expect(hasNonZero(keypair.x25519.secretKey)).toBe(true);

    zeroIdentityKeypair(keypair);

    expect(isAllZeros(keypair.ed25519.secretKey)).toBe(true);
    expect(isAllZeros(keypair.x25519.secretKey)).toBe(true);
  });

  it('does not zero public keys', () => {
    const edKp = sodium.crypto_sign_keypair();
    const x25519Pub = sodium.crypto_sign_ed25519_pk_to_curve25519(edKp.publicKey);
    const x25519Sec = sodium.crypto_sign_ed25519_sk_to_curve25519(edKp.privateKey);

    const edPubCopy = new Uint8Array(edKp.publicKey);
    const x25519PubCopy = new Uint8Array(x25519Pub);

    const keypair: IdentityKeypair = {
      ed25519: { publicKey: edKp.publicKey, secretKey: edKp.privateKey },
      x25519: { publicKey: x25519Pub, secretKey: x25519Sec },
    };

    zeroIdentityKeypair(keypair);

    expect(keypair.ed25519.publicKey).toEqual(edPubCopy);
    expect(keypair.x25519.publicKey).toEqual(x25519PubCopy);
    expect(hasNonZero(keypair.ed25519.publicKey)).toBe(true);
    expect(hasNonZero(keypair.x25519.publicKey)).toBe(true);
  });
});

describe('zeroLinkKeys', () => {
  it('zeros linkId and wrappingKey', () => {
    const linkKeys: LinkKeys = {
      linkId: sodium.randombytes_buf(16),
      wrappingKey: sodium.randombytes_buf(32),
    };

    expect(hasNonZero(linkKeys.linkId)).toBe(true);
    expect(hasNonZero(linkKeys.wrappingKey)).toBe(true);

    zeroLinkKeys(linkKeys);

    expect(isAllZeros(linkKeys.linkId)).toBe(true);
    expect(isAllZeros(linkKeys.wrappingKey)).toBe(true);
  });
});
