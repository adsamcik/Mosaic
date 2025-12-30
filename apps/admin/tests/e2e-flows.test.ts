/**
 * End-to-End Flow Integration Tests
 *
 * These tests simulate complete user journeys through the system,
 * validating that all components work together correctly.
 *
 * Note: These tests use the real crypto library but mock the network
 * layer and storage APIs since we're testing in Node/happy-dom environment.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import {
  deriveKeysInternal,
  unwrapAccountKey,
  generateSalts,
  getArgon2Params,
  deriveIdentityKeypair,
  generateEpochKey,
  encryptShard,
  decryptShard,
  signManifest,
  verifyManifest,
  createEpochKeyBundle,
  sealAndSignBundle,
  verifyAndOpenBundle,
  deriveTierKeys,
  toBase64,
  fromBase64,
  memzero,
  ShardTier,
  type IdentityKeypair,
  type EpochKey,
} from '../../../libs/crypto/src';

beforeAll(async () => {
  await sodium.ready;
});

/**
 * Simulates a user session with derived keys
 */
interface SimulatedUser {
  id: string;
  password: string;
  userSalt: Uint8Array;
  accountSalt: Uint8Array;
  identity: IdentityKeypair;
}

async function createSimulatedUser(id: string, password: string): Promise<SimulatedUser> {
  const { userSalt, accountSalt } = generateSalts();
  const params = getArgon2Params();
  const keys = await deriveKeysInternal(password, userSalt, accountSalt, params);
  const identity = deriveIdentityKeypair(keys.accountKey);

  memzero(keys.masterKey);
  memzero(keys.rootKey);
  memzero(keys.accountKey);

  return { id, password, userSalt, accountSalt, identity };
}

/**
 * Simulates a photo with encrypted shards
 */
interface SimulatedPhoto {
  id: string;
  metadata: {
    filename: string;
    mimeType: string;
    width: number;
    height: number;
    takenAt?: string;
    tags: string[];
  };
  originalData: Uint8Array;
  encryptedShards: Array<{ ciphertext: Uint8Array; sha256: string }>;
  encryptedManifest: Uint8Array;
  signature: Uint8Array;
}

describe('e2e: new user registration flow', () => {
  it('user can register and derive keys on multiple devices', async () => {
    const password = 'my-secure-password-123';
    const { userSalt, accountSalt } = generateSalts();
    const params = getArgon2Params();

    // Device 1: Initial registration - generates random L2 account key
    const keysDevice1 = await deriveKeysInternal(password, userSalt, accountSalt, params);
    const identityDevice1 = deriveIdentityKeypair(keysDevice1.accountKey);

    // Simulate storing wrapped account key and identity pubkey on server
    const storedWrappedKey = keysDevice1.accountKeyWrapped;
    const storedIdentityPubkey = toBase64(identityDevice1.ed25519.publicKey);

    // Device 2: Login on new device - unwrap the stored account key
    const accountKeyDevice2 = await unwrapAccountKey(
      password,
      userSalt,
      accountSalt,
      storedWrappedKey,
      params
    );
    const identityDevice2 = deriveIdentityKeypair(accountKeyDevice2);

    // Both devices should derive the same identity (since they use the same account key)
    const device2Pubkey = toBase64(identityDevice2.ed25519.publicKey);
    expect(device2Pubkey).toBe(storedIdentityPubkey);

    // Cleanup
    memzero(keysDevice1.masterKey);
    memzero(keysDevice1.rootKey);
    memzero(keysDevice1.accountKey);
    memzero(accountKeyDevice2);
  });

  it('wrong password produces different identity', async () => {
    const { userSalt, accountSalt } = generateSalts();
    const params = getArgon2Params();

    const correctKeys = await deriveKeysInternal('correct-password', userSalt, accountSalt, params);
    const wrongKeys = await deriveKeysInternal('wrong-password', userSalt, accountSalt, params);

    const correctIdentity = deriveIdentityKeypair(correctKeys.accountKey);
    const wrongIdentity = deriveIdentityKeypair(wrongKeys.accountKey);

    expect(toBase64(wrongIdentity.ed25519.publicKey)).not.toBe(
      toBase64(correctIdentity.ed25519.publicKey)
    );

    memzero(correctKeys.masterKey);
    memzero(correctKeys.rootKey);
    memzero(correctKeys.accountKey);
    memzero(wrongKeys.masterKey);
    memzero(wrongKeys.rootKey);
    memzero(wrongKeys.accountKey);
  });
});

describe('e2e: album creation and photo upload', () => {
  let owner: SimulatedUser;
  let epochKey: EpochKey;
  const albumId = 'test-album-' + Date.now();

  beforeAll(async () => {
    owner = await createSimulatedUser('owner-123', 'owner-password');
    epochKey = generateEpochKey(1);
  });

  it('owner can create album with initial epoch key', async () => {
    // Create epoch key bundle for self (owner is also a member)
    const bundle = createEpochKeyBundle(
      albumId,
      epochKey.epochId,
      epochKey.epochSeed,
      epochKey.signKeypair,
      owner.identity.ed25519.publicKey
    );

    const sealed = sealAndSignBundle(
      bundle,
      owner.identity.ed25519.publicKey,
      owner.identity
    );

    // Simulate API request payload
    const apiRequest = {
      albumId,
      initialEpochKey: {
        recipientId: owner.id,
        epochId: epochKey.epochId,
        encryptedKeyBundle: toBase64(sealed.sealed),
        ownerSignature: toBase64(sealed.signature),
        sharerPubkey: toBase64(owner.identity.ed25519.publicKey),
        signPubkey: toBase64(epochKey.signKeypair.publicKey),
      },
    };

    expect(apiRequest.initialEpochKey.epochId).toBe(1);
    expect(apiRequest.albumId).toBe(albumId);
  });

  it('owner can upload and encrypt a photo', async () => {
    // Simulate photo file (100KB)
    const photoData = sodium.randombytes_buf(100 * 1024);

    // Encrypt photo shard
    const encrypted = await encryptShard(photoData, epochKey.fullKey, 1, 0, ShardTier.ORIGINAL);

    // Create manifest
    const manifestData = {
      id: 'photo-' + Date.now(),
      filename: 'test-photo.jpg',
      mimeType: 'image/jpeg',
      width: 1920,
      height: 1080,
      tags: ['test'],
    };

    // Encrypt manifest metadata
    const manifestJson = JSON.stringify(manifestData);
    const encryptedManifest = await encryptShard(
      new TextEncoder().encode(manifestJson),
      epochKey.fullKey,
      1,
      0,
      ShardTier.ORIGINAL
    );

    // Sign the encrypted manifest
    const signature = signManifest(
      encryptedManifest.ciphertext,
      epochKey.signKeypair.secretKey
    );

    // Simulate API request
    const apiRequest = {
      albumId,
      encryptedMeta: toBase64(encryptedManifest.ciphertext),
      signature: toBase64(signature),
      signerPubkey: toBase64(epochKey.signKeypair.publicKey),
      shardIds: [encrypted.sha256],
    };

    expect(apiRequest.shardIds).toHaveLength(1);
  });
});

describe('e2e: album sharing workflow', () => {
  let owner: SimulatedUser;
  let viewer: SimulatedUser;
  let epochKey: EpochKey;
  let uploadedPhoto: SimulatedPhoto;
  const albumId = 'shared-album-' + Date.now();

  beforeAll(async () => {
    // Setup users
    owner = await createSimulatedUser('owner-456', 'owner-password');
    viewer = await createSimulatedUser('viewer-789', 'viewer-password');
    epochKey = generateEpochKey(1);

    // Owner uploads a photo
    const photoData = new TextEncoder().encode('This is a secret photo content!');
    const encryptedShards = [
      await encryptShard(photoData, epochKey.fullKey, 1, 0, ShardTier.ORIGINAL),
    ];

    const metadata = {
      filename: 'secret.jpg',
      mimeType: 'image/jpeg',
      width: 800,
      height: 600,
      tags: ['private'],
    };

    const manifestJson = JSON.stringify(metadata);
    const encryptedManifest = await encryptShard(
      new TextEncoder().encode(manifestJson),
      epochKey.fullKey,
      1,
      0,
      ShardTier.ORIGINAL
    );

    const signature = signManifest(
      encryptedManifest.ciphertext,
      epochKey.signKeypair.secretKey
    );

    uploadedPhoto = {
      id: 'photo-' + Date.now(),
      metadata,
      originalData: photoData,
      encryptedShards,
      encryptedManifest: encryptedManifest.ciphertext,
      signature,
    };
  });

  it('owner invites viewer with epoch key bundle', async () => {
    // Owner creates epoch key bundle for viewer
    const bundle = createEpochKeyBundle(
      albumId,
      epochKey.epochId,
      epochKey.epochSeed,
      epochKey.signKeypair,
      viewer.identity.ed25519.publicKey
    );

    const sealed = sealAndSignBundle(
      bundle,
      viewer.identity.ed25519.publicKey,
      owner.identity
    );

    // Simulate invite API request
    const inviteRequest = {
      recipientId: viewer.id,
      role: 'viewer' as const,
      epochKeys: [
        {
          recipientId: viewer.id,
          epochId: epochKey.epochId,
          encryptedKeyBundle: toBase64(sealed.sealed),
          ownerSignature: toBase64(sealed.signature),
          sharerPubkey: toBase64(owner.identity.ed25519.publicKey),
          signPubkey: toBase64(epochKey.signKeypair.publicKey),
        },
      ],
    };

    expect(inviteRequest.epochKeys).toHaveLength(1);
    expect(inviteRequest.role).toBe('viewer');
  });

  it('viewer receives and decrypts epoch key bundle', async () => {
    // Simulate what viewer receives from API
    const bundle = createEpochKeyBundle(
      albumId,
      epochKey.epochId,
      epochKey.epochSeed,
      epochKey.signKeypair,
      viewer.identity.ed25519.publicKey
    );

    const sealed = sealAndSignBundle(
      bundle,
      viewer.identity.ed25519.publicKey,
      owner.identity
    );

    // Viewer opens the bundle
    const opened = verifyAndOpenBundle(
      sealed.sealed,
      sealed.signature,
      owner.identity.ed25519.publicKey,
      viewer.identity,
      { albumId, minEpochId: 0 }
    );

    expect(opened.albumId).toBe(albumId);
    expect(opened.epochId).toBe(epochKey.epochId);
    expect(opened.epochSeed).toEqual(epochKey.epochSeed);
  });

  it('viewer can decrypt shared photos', async () => {
    // Viewer has the epoch key from previous step
    // Now they sync and decrypt the manifest

    // Verify manifest signature
    const isValid = verifyManifest(
      uploadedPhoto.encryptedManifest,
      uploadedPhoto.signature,
      epochKey.signKeypair.publicKey
    );
    expect(isValid).toBe(true);

    // Decrypt manifest
    const decryptedManifest = await decryptShard(
      uploadedPhoto.encryptedManifest,
      epochKey.fullKey
    );
    const metadata = JSON.parse(new TextDecoder().decode(decryptedManifest));
    expect(metadata.filename).toBe('secret.jpg');

    // Decrypt photo shard
    const decryptedPhoto = await decryptShard(
      uploadedPhoto.encryptedShards[0].ciphertext,
      epochKey.fullKey
    );
    expect(new TextDecoder().decode(decryptedPhoto)).toBe('This is a secret photo content!');
  });
});

describe('e2e: member removal and key rotation', () => {
  let owner: SimulatedUser;
  let trustedMember: SimulatedUser;
  let removedMember: SimulatedUser;
  let epoch1: EpochKey;
  let epoch2: EpochKey;
  const albumId = 'rotating-album-' + Date.now();

  beforeAll(async () => {
    owner = await createSimulatedUser('owner-rot', 'owner-password');
    trustedMember = await createSimulatedUser('trusted-member', 'trusted-password');
    removedMember = await createSimulatedUser('removed-member', 'removed-password');
    epoch1 = generateEpochKey(1);
    epoch2 = generateEpochKey(2);
  });

  it('old photos remain accessible with epoch1 key', async () => {
    const oldPhotoData = new TextEncoder().encode('Photo from before rotation');
    const encrypted = await encryptShard(oldPhotoData, epoch1.fullKey, 1, 0, ShardTier.ORIGINAL);

    // After rotation, trusted member still has epoch1 cached
    const decrypted = await decryptShard(encrypted.ciphertext, epoch1.fullKey);
    expect(new TextDecoder().decode(decrypted)).toBe('Photo from before rotation');
  });

  it('new photos use epoch2 key', async () => {
    const newPhotoData = new TextEncoder().encode('Photo after rotation');
    const encrypted = await encryptShard(newPhotoData, epoch2.fullKey, 2, 0, ShardTier.ORIGINAL);

    // Cannot decrypt with epoch1
    await expect(decryptShard(encrypted.ciphertext, epoch1.fullKey)).rejects.toThrow();

    // Can decrypt with epoch2
    const decrypted = await decryptShard(encrypted.ciphertext, epoch2.fullKey);
    expect(new TextDecoder().decode(decrypted)).toBe('Photo after rotation');
  });

  it('only trusted member receives epoch2 bundle', () => {
    // Owner creates epoch2 bundle ONLY for trusted member
    const bundle = createEpochKeyBundle(
      albumId,
      epoch2.epochId,
      epoch2.epochSeed,
      epoch2.signKeypair,
      trustedMember.identity.ed25519.publicKey
    );

    const sealed = sealAndSignBundle(
      bundle,
      trustedMember.identity.ed25519.publicKey,
      owner.identity
    );

    // Trusted member can open
    const opened = verifyAndOpenBundle(
      sealed.sealed,
      sealed.signature,
      owner.identity.ed25519.publicKey,
      trustedMember.identity,
      { albumId, minEpochId: 0 }
    );
    expect(opened.epochId).toBe(2);

    // Removed member cannot open (encrypted for different recipient)
    expect(() =>
      verifyAndOpenBundle(
        sealed.sealed,
        sealed.signature,
        owner.identity.ed25519.publicKey,
        removedMember.identity,
        { albumId, minEpochId: 0 }
      )
    ).toThrow();
  });

  it('removed member cannot access new photos', async () => {
    const newPhotoData = new TextEncoder().encode('New secret photo');
    const encrypted = await encryptShard(newPhotoData, epoch2.fullKey, 2, 0, ShardTier.ORIGINAL);

    // Removed member only has epoch1 key
    await expect(decryptShard(encrypted.ciphertext, epoch1.fullKey)).rejects.toThrow();
  });
});

describe('e2e: sync and offline support', () => {
  let user: SimulatedUser;
  let epochKey: EpochKey;
  const albumId = 'sync-album-' + Date.now();

  beforeAll(async () => {
    user = await createSimulatedUser('sync-user', 'sync-password');
    epochKey = generateEpochKey(1);
  });

  it('manifests can be serialized for local storage', async () => {
    // Create multiple photos
    const photos = [];
    for (let i = 0; i < 5; i++) {
      const data = new TextEncoder().encode(`Photo ${i} content`);
      const encrypted = await encryptShard(data, epochKey.fullKey, 1, 0, ShardTier.ORIGINAL);

      const manifest = {
        id: `photo-${i}`,
        filename: `photo${i}.jpg`,
        mimeType: 'image/jpeg',
        width: 1000 + i,
        height: 800 + i,
      };

      const encryptedManifest = await encryptShard(
        new TextEncoder().encode(JSON.stringify(manifest)),
        epochKey.fullKey,
        1,
        0,
        ShardTier.ORIGINAL
      );

      const signature = signManifest(
        encryptedManifest.ciphertext,
        epochKey.signKeypair.secretKey
      );

      photos.push({
        id: `manifest-${i}`,
        albumId,
        versionCreated: i + 1,
        isDeleted: false,
        encryptedMeta: toBase64(encryptedManifest.ciphertext),
        signature: toBase64(signature),
        signerPubkey: toBase64(epochKey.signKeypair.publicKey),
        shardIds: [encrypted.sha256],
      });
    }

    // Simulate sync response
    const syncResponse = {
      manifests: photos,
      albumVersion: 5,
      hasMore: false,
    };

    expect(syncResponse.manifests).toHaveLength(5);

    // All manifests should be valid JSON strings
    for (const m of syncResponse.manifests) {
      expect(() => fromBase64(m.encryptedMeta)).not.toThrow();
      expect(() => fromBase64(m.signature)).not.toThrow();
    }
  });

  it('delta sync respects version boundaries', async () => {
    // Simulate local state: we have up to version 3
    const localVersion = 3;

    // Server has versions 1-5
    const allManifests = [];
    for (let v = 1; v <= 5; v++) {
      allManifests.push({
        id: `manifest-v${v}`,
        versionCreated: v,
        isDeleted: false,
      });
    }

    // Delta sync should only return versions > localVersion
    const delta = allManifests.filter((m) => m.versionCreated > localVersion);
    expect(delta).toHaveLength(2);
    expect(delta[0].versionCreated).toBe(4);
    expect(delta[1].versionCreated).toBe(5);
  });
});

describe('e2e: security boundaries', () => {
  it('cannot forge manifest signatures', async () => {
    const epochKey = generateEpochKey(1);

    // Legitimate manifest
    const manifest = { filename: 'real.jpg' };
    const encryptedManifest = await encryptShard(
      new TextEncoder().encode(JSON.stringify(manifest)),
      epochKey.fullKey,
      1,
      0,
      ShardTier.ORIGINAL
    );

    const realSignature = signManifest(
      encryptedManifest.ciphertext,
      epochKey.signKeypair.secretKey
    );

    // Attacker tries to create forged manifest
    const forgedManifest = { filename: 'evil.jpg' };
    const forgedEncrypted = await encryptShard(
      new TextEncoder().encode(JSON.stringify(forgedManifest)),
      epochKey.fullKey,
      1,
      0,
      ShardTier.ORIGINAL
    );

    // Attacker tries to reuse the real signature
    const isValid = verifyManifest(
      forgedEncrypted.ciphertext,
      realSignature,
      epochKey.signKeypair.publicKey
    );
    expect(isValid).toBe(false);
  });

  it('cannot decrypt without correct epoch key', async () => {
    const realKey = generateEpochKey(1);
    const fakeKey = generateEpochKey(2);

    const secretData = new TextEncoder().encode('Top secret!');
    const encrypted = await encryptShard(secretData, realKey.fullKey, 1, 0, ShardTier.ORIGINAL);

    // Cannot decrypt with wrong key
    await expect(decryptShard(encrypted.ciphertext, fakeKey.fullKey)).rejects.toThrow();
  });

  it('cannot impersonate album owner', async () => {
    const realOwner = await createSimulatedUser('real-owner', 'real-password');
    const attacker = await createSimulatedUser('attacker', 'attack-password');
    const victim = await createSimulatedUser('victim', 'victim-password');
    const epochKey = generateEpochKey(1);
    const albumId = 'secure-album';

    // Attacker creates a malicious bundle pretending to be from owner
    const maliciousBundle = createEpochKeyBundle(
      albumId,
      epochKey.epochId,
      epochKey.epochSeed,
      epochKey.signKeypair,
      victim.identity.ed25519.publicKey
    );

    const sealed = sealAndSignBundle(
      maliciousBundle,
      victim.identity.ed25519.publicKey,
      attacker.identity // Signed by attacker!
    );

    // Victim verifies expecting real owner's pubkey - should fail
    expect(() =>
      verifyAndOpenBundle(
        sealed.sealed,
        sealed.signature,
        realOwner.identity.ed25519.publicKey, // Victim expects real owner
        victim.identity,
        { albumId, minEpochId: 0 }
      )
    ).toThrow();
  });
});
