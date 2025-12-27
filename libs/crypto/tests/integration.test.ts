/**
 * Crypto Integration Tests
 *
 * These tests verify complete cryptographic workflows end-to-end,
 * simulating real-world usage patterns:
 * - User registration and key derivation
 * - Album creation with epoch keys
 * - Photo upload with shard encryption
 * - Album sharing between users
 * - Photo sync and decryption
 * - Epoch key rotation
 */

import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import {
  // Key derivation
  deriveKeys,
  unwrapAccountKey,
  generateSalts,
  getArgon2Params,
  // Identity
  deriveIdentityKeypair,
  // Epoch keys
  generateEpochKey,
  // Envelope encryption
  encryptShard,
  decryptShard,
  verifyShard,
  // Signing
  signManifest,
  verifyManifest,
  // Sharing
  sealAndSignBundle,
  verifyAndOpenBundle,
  createEpochKeyBundle,
  // Utils
  memzero,
  sha256,
  toBase64,
  fromBase64,
  type DerivedKeys,
  type IdentityKeypair,
  type EpochKey,
  ShardTier,
} from '../src';

beforeAll(async () => {
  await sodium.ready;
});

describe('integration: user registration flow', () => {
  it('derives and unwraps consistent account key', async () => {
    const password = 'correct-horse-battery-staple';
    const { userSalt, accountSalt } = generateSalts();
    const params = getArgon2Params();

    // First derivation - generates random L2 account key
    const keys1 = await deriveKeys(password, userSalt, accountSalt, params);
    const accountKeyWrapped = keys1.accountKeyWrapped;

    // Store the account key for comparison
    const originalAccountKey = new Uint8Array(keys1.accountKey);

    // Second login - unwrap the stored account key
    const unwrappedKey = await unwrapAccountKey(
      password,
      userSalt,
      accountSalt,
      accountKeyWrapped,
      params
    );

    // Unwrapped key should match original
    expect(unwrappedKey).toEqual(originalAccountKey);

    // Clean up
    memzero(keys1.masterKey);
    memzero(keys1.rootKey);
    memzero(keys1.accountKey);
    memzero(unwrappedKey);
  });

  it('derives different keys with different passwords', async () => {
    const { userSalt, accountSalt } = generateSalts();
    const params = getArgon2Params();

    const keys1 = await deriveKeys('password1', userSalt, accountSalt, params);
    const keys2 = await deriveKeys('password2', userSalt, accountSalt, params);

    expect(keys1.accountKey).not.toEqual(keys2.accountKey);

    memzero(keys1.masterKey);
    memzero(keys1.rootKey);
    memzero(keys1.accountKey);
    memzero(keys2.masterKey);
    memzero(keys2.rootKey);
    memzero(keys2.accountKey);
  });

  it('derives identity keypair from account key', async () => {
    const password = 'test-password';
    const { userSalt, accountSalt } = generateSalts();
    const params = getArgon2Params();

    const keys = await deriveKeys(password, userSalt, accountSalt, params);
    const identity = deriveIdentityKeypair(keys.accountKey);

    // Identity should have both Ed25519 and X25519 keypairs
    expect(identity.ed25519.publicKey).toHaveLength(32);
    expect(identity.ed25519.secretKey).toHaveLength(64);
    expect(identity.x25519.publicKey).toHaveLength(32);
    expect(identity.x25519.secretKey).toHaveLength(32);

    // Should derive same identity from same account key
    const identity2 = deriveIdentityKeypair(keys.accountKey);
    expect(identity2.ed25519.publicKey).toEqual(identity.ed25519.publicKey);

    memzero(keys.masterKey);
    memzero(keys.rootKey);
    memzero(keys.accountKey);
    memzero(identity.ed25519.secretKey);
    memzero(identity.x25519.secretKey);
    memzero(identity2.ed25519.secretKey);
    memzero(identity2.x25519.secretKey);
  });
});

describe('integration: album creation and photo upload', () => {
  let ownerIdentity: IdentityKeypair;
  let epochKey: EpochKey;
  const albumId = 'album-' + Date.now();

  beforeAll(async () => {
    // Simulate owner registration
    const { userSalt, accountSalt } = generateSalts();
    const params = getArgon2Params();
    const keys = await deriveKeys('owner-password', userSalt, accountSalt, params);
    ownerIdentity = deriveIdentityKeypair(keys.accountKey);
    memzero(keys.masterKey);
    memzero(keys.rootKey);
    memzero(keys.accountKey);

    // Create epoch key for new album
    epochKey = generateEpochKey(1);
  });

  it('encrypts and decrypts photo shards', async () => {
    // Simulate a 1MB photo chunk
    const photoData = sodium.randombytes_buf(1024 * 1024);

    // Encrypt shard using fullKey (for original resolution)
    const encrypted = await encryptShard(
      photoData,
      epochKey.fullKey,
      epochKey.epochId,
      0, // shard index
      ShardTier.ORIGINAL
    );

    // Verify SHA256 hash
    const isValid = await verifyShard(encrypted.ciphertext, encrypted.sha256);
    expect(isValid).toBe(true);

    // Decrypt shard
    const decrypted = await decryptShard(encrypted.ciphertext, epochKey.fullKey);
    expect(decrypted).toEqual(photoData);
  });

  it('encrypts multiple shards for a large photo', async () => {
    // Use smaller chunks for faster testing
    const CHUNK_SIZE = 64 * 1024; // 64KB per chunk
    const totalSize = 180 * 1024; // 180KB photo = 3 shards
    const shardCount = Math.ceil(totalSize / CHUNK_SIZE);

    const shards: Array<{ ciphertext: Uint8Array; sha256: string }> = [];

    for (let i = 0; i < shardCount; i++) {
      const chunkSize = Math.min(CHUNK_SIZE, totalSize - i * CHUNK_SIZE);
      const chunk = sodium.randombytes_buf(chunkSize);

      const encrypted = await encryptShard(
        chunk,
        epochKey.fullKey,
        epochKey.epochId,
        i,
        ShardTier.ORIGINAL
      );

      shards.push(encrypted);
    }

    expect(shards).toHaveLength(3);

    // All shards should have unique hashes
    const hashes = new Set(shards.map((s) => s.sha256));
    expect(hashes.size).toBe(3);
  });

  it('signs and verifies manifest', async () => {
    // Create manifest metadata
    const manifestData = new TextEncoder().encode(
      JSON.stringify({
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        width: 4000,
        height: 3000,
        shardIds: ['shard-1', 'shard-2', 'shard-3'],
      })
    );

    // Sign manifest with epoch sign key
    const signature = signManifest(manifestData, epochKey.signKeypair.secretKey);

    // Verify signature
    const isValid = verifyManifest(
      manifestData,
      signature,
      epochKey.signKeypair.publicKey
    );
    expect(isValid).toBe(true);

    // Tampered manifest should fail verification
    const tamperedManifest = new Uint8Array(manifestData);
    tamperedManifest[0] ^= 0xff;
    const isInvalid = verifyManifest(
      tamperedManifest,
      signature,
      epochKey.signKeypair.publicKey
    );
    expect(isInvalid).toBe(false);
  });
});

describe('integration: album sharing between users', () => {
  let ownerIdentity: IdentityKeypair;
  let recipientIdentity: IdentityKeypair;
  let epochKey: EpochKey;
  const albumId = 'shared-album-' + Date.now();

  beforeAll(async () => {
    const params = getArgon2Params();

    // Owner setup
    const ownerSalts = generateSalts();
    const ownerKeys = await deriveKeys(
      'owner-password',
      ownerSalts.userSalt,
      ownerSalts.accountSalt,
      params
    );
    ownerIdentity = deriveIdentityKeypair(ownerKeys.accountKey);
    memzero(ownerKeys.masterKey);
    memzero(ownerKeys.rootKey);
    memzero(ownerKeys.accountKey);

    // Recipient setup
    const recipientSalts = generateSalts();
    const recipientKeys = await deriveKeys(
      'recipient-password',
      recipientSalts.userSalt,
      recipientSalts.accountSalt,
      params
    );
    recipientIdentity = deriveIdentityKeypair(recipientKeys.accountKey);
    memzero(recipientKeys.masterKey);
    memzero(recipientKeys.rootKey);
    memzero(recipientKeys.accountKey);

    // Create epoch key
    epochKey = generateEpochKey(1);
  });

  it('owner can share epoch key with recipient', () => {
    // Owner creates epoch key bundle for recipient (using epochSeed for sharing)
    const bundle = createEpochKeyBundle(
      albumId,
      epochKey.epochId,
      epochKey.epochSeed,
      epochKey.signKeypair,
      recipientIdentity.ed25519.publicKey
    );

    // Owner seals and signs the bundle
    const sealed = sealAndSignBundle(
      bundle,
      recipientIdentity.ed25519.publicKey,
      ownerIdentity
    );

    // Recipient opens the bundle
    const opened = verifyAndOpenBundle(
      sealed.sealed,
      sealed.signature,
      ownerIdentity.ed25519.publicKey,
      recipientIdentity,
      { albumId, minEpochId: 0 }
    );

    // Recipient should have the epoch seed
    expect(opened.albumId).toBe(albumId);
    expect(opened.epochId).toBe(epochKey.epochId);
    expect(opened.epochSeed).toEqual(epochKey.epochSeed);
    expect(opened.signKeypair.publicKey).toEqual(epochKey.signKeypair.publicKey);
  });

  it('recipient can decrypt photos shared by owner', async () => {
    // Owner encrypts a photo using fullKey
    const photoData = new TextEncoder().encode('This is a secret photo!');
    const encrypted = await encryptShard(
      photoData,
      epochKey.fullKey,
      epochKey.epochId,
      0,
      ShardTier.ORIGINAL
    );

    // Simulate sharing: recipient receives epoch key bundle
    const bundle = createEpochKeyBundle(
      albumId,
      epochKey.epochId,
      epochKey.epochSeed,
      epochKey.signKeypair,
      recipientIdentity.ed25519.publicKey
    );
    const sealed = sealAndSignBundle(
      bundle,
      recipientIdentity.ed25519.publicKey,
      ownerIdentity
    );
    const opened = verifyAndOpenBundle(
      sealed.sealed,
      sealed.signature,
      ownerIdentity.ed25519.publicKey,
      recipientIdentity,
      { albumId, minEpochId: 0 }
    );

    // Recipient derives tier keys from epochSeed and decrypts
    const { deriveTierKeys } = await import('../src/epochs');
    const tierKeys = deriveTierKeys(opened.epochSeed);
    const decrypted = await decryptShard(encrypted.ciphertext, tierKeys.fullKey);
    expect(new TextDecoder().decode(decrypted)).toBe('This is a secret photo!');
  });

  it('rejects bundle from unknown sender', () => {
    // Attacker tries to send a fake bundle
    const attackerSalts = generateSalts();
    const attackerIdentity = deriveIdentityKeypair(
      sodium.crypto_generichash(32, attackerSalts.userSalt)
    );

    const fakeBundle = createEpochKeyBundle(
      albumId,
      epochKey.epochId,
      epochKey.epochSeed,
      epochKey.signKeypair,
      recipientIdentity.ed25519.publicKey
    );

    const sealed = sealAndSignBundle(
      fakeBundle,
      recipientIdentity.ed25519.publicKey,
      attackerIdentity // Signed by attacker, not owner
    );

    // Recipient verifies with owner's pubkey - should fail
    expect(() =>
      verifyAndOpenBundle(
        sealed.sealed,
        sealed.signature,
        ownerIdentity.ed25519.publicKey, // Expected owner
        recipientIdentity,
        { albumId, minEpochId: 0 }
      )
    ).toThrow();
  });

  it('rejects bundle for wrong album', () => {
    const bundle = createEpochKeyBundle(
      albumId,
      epochKey.epochId,
      epochKey.epochSeed,
      epochKey.signKeypair,
      recipientIdentity.ed25519.publicKey
    );

    const sealed = sealAndSignBundle(
      bundle,
      recipientIdentity.ed25519.publicKey,
      ownerIdentity
    );

    // Try to open for different album
    expect(() =>
      verifyAndOpenBundle(
        sealed.sealed,
        sealed.signature,
        ownerIdentity.ed25519.publicKey,
        recipientIdentity,
        { albumId: 'different-album', minEpochId: 0 }
      )
    ).toThrow('albumId');
  });
});

describe('integration: epoch key rotation', () => {
  let ownerIdentity: IdentityKeypair;
  let memberIdentity: IdentityKeypair;
  let removedMemberIdentity: IdentityKeypair;
  let epoch1: EpochKey;
  let epoch2: EpochKey;
  const albumId = 'rotating-album-' + Date.now();

  beforeAll(async () => {
    const params = getArgon2Params();

    // Create three users
    for (const password of ['owner', 'member', 'removed-member']) {
      const salts = generateSalts();
      const keys = await deriveKeys(password, salts.userSalt, salts.accountSalt, params);
      const identity = deriveIdentityKeypair(keys.accountKey);
      memzero(keys.masterKey);
      memzero(keys.rootKey);
      memzero(keys.accountKey);

      if (password === 'owner') ownerIdentity = identity;
      else if (password === 'member') memberIdentity = identity;
      else removedMemberIdentity = identity;
    }

    // Create initial epoch
    epoch1 = generateEpochKey(1);
    // Create rotated epoch
    epoch2 = generateEpochKey(2);
  });

  it('old photos encrypted with epoch1 are still readable after rotation', async () => {
    // Encrypt photo with epoch 1
    const oldPhoto = new TextEncoder().encode('Photo from before rotation');
    const encrypted = await encryptShard(oldPhoto, epoch1.fullKey, 1, 0, ShardTier.ORIGINAL);

    // Rotation happens - epoch 2 created
    // Member should still have epoch 1 key cached

    // Decrypt with epoch 1 key still works
    const decrypted = await decryptShard(encrypted.ciphertext, epoch1.fullKey);
    expect(new TextDecoder().decode(decrypted)).toBe('Photo from before rotation');
  });

  it('new photos use epoch2 key', async () => {
    // New photo uploaded after rotation
    const newPhoto = new TextEncoder().encode('Photo after rotation');
    const encrypted = await encryptShard(newPhoto, epoch2.fullKey, 2, 0, ShardTier.ORIGINAL);

    // Cannot decrypt with old epoch key
    await expect(decryptShard(encrypted.ciphertext, epoch1.fullKey)).rejects.toThrow();

    // Can decrypt with new epoch key
    const decrypted = await decryptShard(encrypted.ciphertext, epoch2.fullKey);
    expect(new TextDecoder().decode(decrypted)).toBe('Photo after rotation');
  });

  it('remaining member receives epoch2 bundle, removed member does not', () => {
    // Owner creates epoch2 bundle only for remaining member
    const memberBundle = createEpochKeyBundle(
      albumId,
      epoch2.epochId,
      epoch2.epochSeed,
      epoch2.signKeypair,
      memberIdentity.ed25519.publicKey
    );

    const sealed = sealAndSignBundle(
      memberBundle,
      memberIdentity.ed25519.publicKey,
      ownerIdentity
    );

    // Member can open the bundle
    const opened = verifyAndOpenBundle(
      sealed.sealed,
      sealed.signature,
      ownerIdentity.ed25519.publicKey,
      memberIdentity,
      { albumId, minEpochId: 0 }
    );
    expect(opened.epochId).toBe(2);

    // Removed member cannot open (was encrypted for memberIdentity)
    expect(() =>
      verifyAndOpenBundle(
        sealed.sealed,
        sealed.signature,
        ownerIdentity.ed25519.publicKey,
        removedMemberIdentity, // Wrong recipient
        { albumId, minEpochId: 0 }
      )
    ).toThrow();
  });
});

describe('integration: base64 serialization for API transport', () => {
  it('round-trips binary data through base64', async () => {
    const originalData = sodium.randombytes_buf(256);

    const base64 = toBase64(originalData);
    expect(typeof base64).toBe('string');

    const recovered = fromBase64(base64);
    expect(recovered).toEqual(originalData);
  });

  it('serializes epoch key bundle for API transport', () => {
    const epochKey = generateEpochKey(1);

    // Simulate API payload (now uses epochSeed for distribution)
    const apiPayload = {
      epochId: epochKey.epochId,
      epochSeed: toBase64(epochKey.epochSeed),
      signPubkey: toBase64(epochKey.signKeypair.publicKey),
    };

    // Verify it's valid JSON
    const json = JSON.stringify(apiPayload);
    const parsed = JSON.parse(json);

    // Recover binary
    const recoveredEpochSeed = fromBase64(parsed.epochSeed);
    expect(recoveredEpochSeed).toEqual(epochKey.epochSeed);
  });
});

describe('integration: complete photo lifecycle', () => {
  it('simulates full photo upload → sync → view flow', async () => {
    const params = getArgon2Params();

    // === STEP 1: User Registration ===
    const { userSalt, accountSalt } = generateSalts();
    const keys = await deriveKeys('user-password', userSalt, accountSalt, params);
    const identity = deriveIdentityKeypair(keys.accountKey);

    // === STEP 2: Album Creation ===
    const albumId = 'lifecycle-album-' + Date.now();
    const epochKey = generateEpochKey(1);

    // === STEP 3: Photo Upload ===
    const photoMetadata = {
      id: 'photo-' + Date.now(),
      filename: 'vacation.jpg',
      mimeType: 'image/jpeg',
      width: 4000,
      height: 3000,
      takenAt: new Date().toISOString(),
      tags: ['vacation', '2024'],
    };

    // Encrypt photo data (simulated 2MB file) using fullKey
    const photoData = sodium.randombytes_buf(2 * 1024 * 1024);
    const encrypted = await encryptShard(photoData, epochKey.fullKey, 1, 0, ShardTier.ORIGINAL);

    // Encrypt and sign manifest (also using fullKey for metadata)
    const manifestJson = JSON.stringify(photoMetadata);
    const manifestEncrypted = await encryptShard(
      new TextEncoder().encode(manifestJson),
      epochKey.fullKey,
      1,
      0,
      ShardTier.ORIGINAL
    );
    const signature = signManifest(
      manifestEncrypted.ciphertext,
      epochKey.signKeypair.secretKey
    );

    // === STEP 4: Simulate API Storage ===
    const serverRecord = {
      id: photoMetadata.id,
      albumId,
      encryptedMeta: toBase64(manifestEncrypted.ciphertext),
      signature: toBase64(signature),
      signerPubkey: toBase64(epochKey.signKeypair.publicKey),
      shardIds: [encrypted.sha256],
    };

    // === STEP 5: Sync and Decrypt ===
    // Client receives record from server
    const receivedMeta = fromBase64(serverRecord.encryptedMeta);
    const receivedSig = fromBase64(serverRecord.signature);
    const receivedPubkey = fromBase64(serverRecord.signerPubkey);

    // Verify signature
    const sigValid = verifyManifest(receivedMeta, receivedSig, receivedPubkey);
    expect(sigValid).toBe(true);

    // Decrypt manifest
    const decryptedManifest = await decryptShard(receivedMeta, epochKey.fullKey);
    const metadata = JSON.parse(new TextDecoder().decode(decryptedManifest));
    expect(metadata.filename).toBe('vacation.jpg');
    expect(metadata.tags).toContain('vacation');

    // === STEP 6: View Photo ===
    // Download and decrypt shard
    const decryptedPhoto = await decryptShard(encrypted.ciphertext, epochKey.fullKey);
    expect(decryptedPhoto).toEqual(photoData);

    // Cleanup
    memzero(keys.masterKey);
    memzero(keys.rootKey);
    memzero(keys.accountKey);
    memzero(identity.ed25519.secretKey);
    memzero(identity.x25519.secretKey);
    memzero(epochKey.epochSeed);
    memzero(epochKey.thumbKey);
    memzero(epochKey.previewKey);
    memzero(epochKey.fullKey);
    memzero(epochKey.signKeypair.secretKey);
  });
});
