import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { sealAndSignBundle, verifyAndOpenBundle, createEpochKeyBundle } from '../src/sharing';
import { deriveIdentityKeypair, generateIdentitySeed } from '../src/identity';
import { generateEpochKey } from '../src/epochs';

beforeAll(async () => {
  await sodium.ready;
});

describe('sharing', () => {
  const ownerSeed = generateIdentitySeed();
  const recipientSeed = generateIdentitySeed();
  const ownerIdentity = deriveIdentityKeypair(ownerSeed);
  const recipientIdentity = deriveIdentityKeypair(recipientSeed);
  const epoch = generateEpochKey(1);
  const albumId = 'album-123';

  const bundle = createEpochKeyBundle(
    albumId,
    epoch.epochId,
    epoch.readKey,
    epoch.signKeypair,
    recipientIdentity.ed25519.publicKey
  );

  it('round-trips seal/open', () => {
    const sealed = sealAndSignBundle(bundle, recipientIdentity.ed25519.publicKey, ownerIdentity);
    const opened = verifyAndOpenBundle(
      sealed.sealed,
      sealed.signature,
      ownerIdentity.ed25519.publicKey,
      recipientIdentity,
      { albumId, minEpochId: 0 }
    );
    
    expect(opened.albumId).toBe(albumId);
    expect(opened.epochId).toBe(epoch.epochId);
    expect(opened.readKey).toEqual(epoch.readKey);
  });

  it('rejects invalid signature', () => {
    const sealed = sealAndSignBundle(bundle, recipientIdentity.ed25519.publicKey, ownerIdentity);
    sealed.signature[0] ^= 0xff;
    
    expect(() => verifyAndOpenBundle(
      sealed.sealed,
      sealed.signature,
      ownerIdentity.ed25519.publicKey,
      recipientIdentity,
      { albumId, minEpochId: 0 }
    )).toThrow('signature');
  });

  it('rejects wrong recipient', () => {
    const wrongRecipient = deriveIdentityKeypair(generateIdentitySeed());
    const sealed = sealAndSignBundle(bundle, recipientIdentity.ed25519.publicKey, ownerIdentity);
    
    expect(() => verifyAndOpenBundle(
      sealed.sealed,
      sealed.signature,
      ownerIdentity.ed25519.publicKey,
      wrongRecipient,
      { albumId, minEpochId: 0 }
    )).toThrow();
  });

  it('rejects albumId mismatch', () => {
    const sealed = sealAndSignBundle(bundle, recipientIdentity.ed25519.publicKey, ownerIdentity);
    
    expect(() => verifyAndOpenBundle(
      sealed.sealed,
      sealed.signature,
      ownerIdentity.ed25519.publicKey,
      recipientIdentity,
      { albumId: 'wrong-album', minEpochId: 0 }
    )).toThrow('albumId');
  });

  it('rejects old epochId', () => {
    const sealed = sealAndSignBundle(bundle, recipientIdentity.ed25519.publicKey, ownerIdentity);
    
    expect(() => verifyAndOpenBundle(
      sealed.sealed,
      sealed.signature,
      ownerIdentity.ed25519.publicKey,
      recipientIdentity,
      { albumId, minEpochId: 5 }
    )).toThrow('epochId');
  });
});
