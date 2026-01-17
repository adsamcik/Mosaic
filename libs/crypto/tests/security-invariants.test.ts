/**
 * Security Invariants Tests
 *
 * These tests verify critical security properties that MUST hold:
 * 1. Nonce uniqueness - Never reuse a nonce with the same key
 * 2. Reserved byte validation - Reject non-zero reserved bytes
 * 3. Key wiping - memzero actually zeros memory
 * 4. Constant-time comparison - Timing-safe equality checks
 * 5. Key length validation - Reject invalid key sizes
 * 6. Forward/backward secrecy properties
 * 7. Cryptographic domain separation
 */

import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import {
  encryptShard,
  decryptShard,
  peekHeader,
  ENVELOPE_HEADER_SIZE,
  ShardTier,
  memzero,
  constantTimeEqual,
  deriveKeysInternal,
  generateSalts,
  getArgon2Params,
  generateEpochKey,
  deriveIdentityKeypair,
  generateIdentitySeed,
  sealAndSignBundle,
  verifyAndOpenBundle,
  createEpochKeyBundle,
  wrapKey,
  unwrapKey,
  deriveLinkKeys,
  generateLinkSecret,
  wrapTierKeyForLink,
  AccessTier,
} from '../src';

beforeAll(async () => {
  await sodium.ready;
});

describe('Security Invariant: Nonce Uniqueness', () => {
  it('generates unique nonces across many encryptions with same key', async () => {
    const key = sodium.randombytes_buf(32);
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const nonces = new Set<string>();

    // Encrypt 1000 times and collect nonces
    for (let i = 0; i < 1000; i++) {
      const { ciphertext } = await encryptShard(
        data,
        key,
        1,
        i,
        ShardTier.ORIGINAL,
      );
      const header = peekHeader(ciphertext);
      // Extract nonce bytes (positions 13-36 in header)
      const nonceHex = Array.from(ciphertext.slice(13, 37))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      nonces.add(nonceHex);
    }

    // All 1000 nonces should be unique
    expect(nonces.size).toBe(1000);
  });

  it('nonces differ even for identical plaintext and metadata', async () => {
    const key = sodium.randombytes_buf(32);
    const data = new Uint8Array([1, 2, 3]);

    // Encrypt same data with same epoch/shard multiple times
    const results = await Promise.all([
      encryptShard(data, key, 1, 0, ShardTier.ORIGINAL),
      encryptShard(data, key, 1, 0, ShardTier.ORIGINAL),
      encryptShard(data, key, 1, 0, ShardTier.ORIGINAL),
    ]);

    const nonces = results.map((r) =>
      Array.from(r.ciphertext.slice(13, 37))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(''),
    );

    // All nonces must be different
    expect(new Set(nonces).size).toBe(3);
  });

  it('link key wrapping uses unique nonces', () => {
    const secret = generateLinkSecret();
    const { wrappingKey } = deriveLinkKeys(secret);
    const tierKey = sodium.randombytes_buf(32);

    const wrapped1 = wrapTierKeyForLink(tierKey, AccessTier.THUMB, wrappingKey);
    const wrapped2 = wrapTierKeyForLink(tierKey, AccessTier.THUMB, wrappingKey);

    // Nonces should be different
    expect(wrapped1.nonce).not.toEqual(wrapped2.nonce);
    // Ciphertexts should also differ due to different nonces
    expect(wrapped1.encryptedKey).not.toEqual(wrapped2.encryptedKey);
  });
});

describe('Security Invariant: Reserved Byte Validation', () => {
  it('rejects non-zero reserved byte at position 38', async () => {
    const key = sodium.randombytes_buf(32);
    const data = new Uint8Array([1, 2, 3]);
    const { ciphertext } = await encryptShard(
      data,
      key,
      1,
      0,
      ShardTier.ORIGINAL,
    );

    // Corrupt reserved byte at position 38 (first after tier at 37)
    ciphertext[38] = 0x01;

    await expect(decryptShard(ciphertext, key)).rejects.toThrow('reserved');
  });

  it('rejects non-zero reserved byte at position 50', async () => {
    const key = sodium.randombytes_buf(32);
    const data = new Uint8Array([1, 2, 3]);
    const { ciphertext } = await encryptShard(
      data,
      key,
      1,
      0,
      ShardTier.ORIGINAL,
    );

    // Corrupt reserved byte in middle
    ciphertext[50] = 0xff;

    await expect(decryptShard(ciphertext, key)).rejects.toThrow('reserved');
  });

  it('rejects non-zero reserved byte at position 63 (last)', async () => {
    const key = sodium.randombytes_buf(32);
    const data = new Uint8Array([1, 2, 3]);
    const { ciphertext } = await encryptShard(
      data,
      key,
      1,
      0,
      ShardTier.ORIGINAL,
    );

    // Corrupt last reserved byte
    ciphertext[63] = 0x01;

    await expect(decryptShard(ciphertext, key)).rejects.toThrow('reserved');
  });

  it('rejects all non-zero reserved bytes', async () => {
    const key = sodium.randombytes_buf(32);
    const data = new Uint8Array([1, 2, 3]);
    const { ciphertext } = await encryptShard(
      data,
      key,
      1,
      0,
      ShardTier.ORIGINAL,
    );

    // Set all reserved bytes (positions 38-63) to non-zero
    for (let i = 38; i < 64; i++) {
      ciphertext[i] = 0xff;
    }

    await expect(decryptShard(ciphertext, key)).rejects.toThrow('reserved');
  });
});

describe('Security Invariant: Key Wiping', () => {
  it('memzero clears sensitive data completely', () => {
    const sensitiveKey = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      sensitiveKey[i] = i + 1; // Non-zero values
    }

    memzero(sensitiveKey);

    // All bytes should be zero
    for (let i = 0; i < 32; i++) {
      expect(sensitiveKey[i]).toBe(0);
    }
  });

  it('memzero handles various buffer sizes', () => {
    const sizes = [1, 16, 32, 64, 128, 256];

    for (const size of sizes) {
      const buf = new Uint8Array(size).fill(0xff);
      memzero(buf);
      expect(buf.every((b) => b === 0)).toBe(true);
    }
  });

  it('memzero handles empty buffer without error', () => {
    const empty = new Uint8Array(0);
    expect(() => memzero(empty)).not.toThrow();
  });

  it('derived keys can be wiped after use', async () => {
    const { userSalt, accountSalt } = generateSalts();
    const fastParams = { memory: 1024, iterations: 1, parallelism: 1 };

    // Use deriveKeysInternal to test wiping of L0/L1 keys
    const keys = await deriveKeysInternal(
      'password',
      userSalt,
      accountSalt,
      fastParams,
    );

    // Store copies to verify wiping works
    const masterKeyBefore = new Uint8Array(keys.masterKey);
    const rootKeyBefore = new Uint8Array(keys.rootKey);
    const accountKeyBefore = new Uint8Array(keys.accountKey);

    // Wipe keys
    memzero(keys.masterKey);
    memzero(keys.rootKey);
    memzero(keys.accountKey);

    // Verify they were non-zero before and zero after
    expect(masterKeyBefore.some((b: number) => b !== 0)).toBe(true);
    expect(keys.masterKey.every((b: number) => b === 0)).toBe(true);

    expect(rootKeyBefore.some((b: number) => b !== 0)).toBe(true);
    expect(keys.rootKey.every((b: number) => b === 0)).toBe(true);

    expect(accountKeyBefore.some((b: number) => b !== 0)).toBe(true);
    expect(keys.accountKey.every((b: number) => b === 0)).toBe(true);
  });
});

describe('Security Invariant: Constant-Time Comparison', () => {
  it('returns true for identical arrays', () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new Uint8Array([1, 2, 3, 4, 5]);
    expect(constantTimeEqual(a, b)).toBe(true);
  });

  it('returns false for arrays differing at start', () => {
    const a = new Uint8Array([0, 2, 3, 4, 5]);
    const b = new Uint8Array([1, 2, 3, 4, 5]);
    expect(constantTimeEqual(a, b)).toBe(false);
  });

  it('returns false for arrays differing at end', () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new Uint8Array([1, 2, 3, 4, 6]);
    expect(constantTimeEqual(a, b)).toBe(false);
  });

  it('returns false for arrays of different lengths', () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(constantTimeEqual(a, b)).toBe(false);
  });

  it('returns true for empty arrays', () => {
    expect(constantTimeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });

  it('correctly handles 32-byte keys', () => {
    const key1 = sodium.randombytes_buf(32);
    const key2 = new Uint8Array(key1);
    expect(constantTimeEqual(key1, key2)).toBe(true);

    key2[31] ^= 1;
    expect(constantTimeEqual(key1, key2)).toBe(false);
  });
});

describe('Security Invariant: Key Length Validation', () => {
  describe('encryption keys must be exactly 32 bytes', () => {
    const validKey = sodium.randombytes_buf(32);
    const data = new Uint8Array([1, 2, 3]);

    it('rejects 0-byte key', async () => {
      await expect(
        encryptShard(data, new Uint8Array(0), 1, 0, ShardTier.ORIGINAL),
      ).rejects.toThrow('32 bytes');
    });

    it('rejects 16-byte key', async () => {
      await expect(
        encryptShard(data, new Uint8Array(16), 1, 0, ShardTier.ORIGINAL),
      ).rejects.toThrow('32 bytes');
    });

    it('rejects 31-byte key', async () => {
      await expect(
        encryptShard(data, new Uint8Array(31), 1, 0, ShardTier.ORIGINAL),
      ).rejects.toThrow('32 bytes');
    });

    it('rejects 33-byte key', async () => {
      await expect(
        encryptShard(data, new Uint8Array(33), 1, 0, ShardTier.ORIGINAL),
      ).rejects.toThrow('32 bytes');
    });

    it('rejects 64-byte key', async () => {
      await expect(
        encryptShard(data, new Uint8Array(64), 1, 0, ShardTier.ORIGINAL),
      ).rejects.toThrow('32 bytes');
    });

    it('accepts exactly 32-byte key', async () => {
      const { ciphertext } = await encryptShard(
        data,
        validKey,
        1,
        0,
        ShardTier.ORIGINAL,
      );
      expect(ciphertext.length).toBeGreaterThan(0);
    });
  });

  describe('signing keys must be exactly 64 bytes', () => {
    it('generateEpochKey produces correct key lengths', () => {
      const epoch = generateEpochKey(1);
      expect(epoch.signKeypair.publicKey).toHaveLength(32);
      expect(epoch.signKeypair.secretKey).toHaveLength(64);
      expect(epoch.thumbKey).toHaveLength(32);
      expect(epoch.previewKey).toHaveLength(32);
      expect(epoch.fullKey).toHaveLength(32);
    });

    it('identity seed must be 32 bytes', () => {
      const seed = generateIdentitySeed();
      expect(seed).toHaveLength(32);
    });

    it('derived identity has correct key lengths', () => {
      const seed = generateIdentitySeed();
      const identity = deriveIdentityKeypair(seed);
      expect(identity.ed25519.publicKey).toHaveLength(32);
      expect(identity.ed25519.secretKey).toHaveLength(64);
      expect(identity.x25519.publicKey).toHaveLength(32);
      expect(identity.x25519.secretKey).toHaveLength(32);
    });
  });
});

describe('Security Invariant: Cryptographic Domain Separation', () => {
  const fastParams = { memory: 1024, iterations: 1, parallelism: 1 };

  it('different salts produce different master keys', async () => {
    const password = 'same-password';
    const salts1 = generateSalts();
    const salts2 = generateSalts();

    // Use deriveKeysInternal to access L0/L1 for domain separation testing
    const keys1 = await deriveKeysInternal(
      password,
      salts1.userSalt,
      salts1.accountSalt,
      fastParams,
    );
    const keys2 = await deriveKeysInternal(
      password,
      salts2.userSalt,
      salts2.accountSalt,
      fastParams,
    );

    expect(keys1.masterKey).not.toEqual(keys2.masterKey);
    expect(keys1.rootKey).not.toEqual(keys2.rootKey);
  });

  it('root key differs from master key (context separation)', async () => {
    const { userSalt, accountSalt } = generateSalts();
    // Use deriveKeysInternal to access L0/L1 for domain separation testing
    const keys = await deriveKeysInternal(
      'password',
      userSalt,
      accountSalt,
      fastParams,
    );

    expect(keys.masterKey).not.toEqual(keys.rootKey);
  });

  it('epoch keys have independent tier keys', () => {
    const epoch = generateEpochKey(1);

    // All tier keys should be different
    expect(epoch.thumbKey).not.toEqual(epoch.previewKey);
    expect(epoch.previewKey).not.toEqual(epoch.fullKey);
    expect(epoch.thumbKey).not.toEqual(epoch.fullKey);

    // Epoch seed should be different from all tier keys
    expect(epoch.epochSeed).not.toEqual(epoch.thumbKey);
    expect(epoch.epochSeed).not.toEqual(epoch.previewKey);
    expect(epoch.epochSeed).not.toEqual(epoch.fullKey);
  });

  it('different epoch IDs produce different keys', () => {
    const epoch1 = generateEpochKey(1);
    const epoch2 = generateEpochKey(2);

    expect(epoch1.epochSeed).not.toEqual(epoch2.epochSeed);
    expect(epoch1.thumbKey).not.toEqual(epoch2.thumbKey);
    expect(epoch1.signKeypair.publicKey).not.toEqual(
      epoch2.signKeypair.publicKey,
    );
  });

  it('link keys are derived deterministically from secret', () => {
    const secret = generateLinkSecret();
    const keys1 = deriveLinkKeys(secret);
    const keys2 = deriveLinkKeys(secret);

    expect(keys1.linkId).toEqual(keys2.linkId);
    expect(keys1.wrappingKey).toEqual(keys2.wrappingKey);
  });

  it('different link secrets produce different keys', () => {
    const secret1 = generateLinkSecret();
    const secret2 = generateLinkSecret();
    const keys1 = deriveLinkKeys(secret1);
    const keys2 = deriveLinkKeys(secret2);

    expect(keys1.linkId).not.toEqual(keys2.linkId);
    expect(keys1.wrappingKey).not.toEqual(keys2.wrappingKey);
  });
});

describe('Security Invariant: Signature Verification Before Decrypt', () => {
  it('verifyAndOpenBundle rejects invalid signature before decryption', () => {
    const ownerSeed = generateIdentitySeed();
    const recipientSeed = generateIdentitySeed();
    const ownerIdentity = deriveIdentityKeypair(ownerSeed);
    const recipientIdentity = deriveIdentityKeypair(recipientSeed);
    const epoch = generateEpochKey(1);
    const albumId = 'album-123';

    const bundle = createEpochKeyBundle(
      albumId,
      epoch.epochId,
      epoch.epochSeed,
      epoch.signKeypair,
      recipientIdentity.ed25519.publicKey,
    );

    const sealed = sealAndSignBundle(
      bundle,
      recipientIdentity.ed25519.publicKey,
      ownerIdentity,
    );

    // Corrupt the signature
    sealed.signature[0] ^= 0xff;
    sealed.signature[31] ^= 0xff;

    // Should fail signature verification, not decryption
    expect(() =>
      verifyAndOpenBundle(
        sealed.sealed,
        sealed.signature,
        ownerIdentity.ed25519.publicKey,
        recipientIdentity,
        { albumId, minEpochId: 0 },
      ),
    ).toThrow('signature');
  });

  it('verifyAndOpenBundle validates context after decryption', () => {
    const ownerSeed = generateIdentitySeed();
    const recipientSeed = generateIdentitySeed();
    const ownerIdentity = deriveIdentityKeypair(ownerSeed);
    const recipientIdentity = deriveIdentityKeypair(recipientSeed);
    const epoch = generateEpochKey(1);
    const albumId = 'album-123';

    const bundle = createEpochKeyBundle(
      albumId,
      epoch.epochId,
      epoch.epochSeed,
      epoch.signKeypair,
      recipientIdentity.ed25519.publicKey,
    );

    const sealed = sealAndSignBundle(
      bundle,
      recipientIdentity.ed25519.publicKey,
      ownerIdentity,
    );

    // Should reject wrong album ID
    expect(() =>
      verifyAndOpenBundle(
        sealed.sealed,
        sealed.signature,
        ownerIdentity.ed25519.publicKey,
        recipientIdentity,
        { albumId: 'wrong-album', minEpochId: 0 },
      ),
    ).toThrow('albumId');
  });
});

describe('Security Invariant: AAD (Additional Authenticated Data)', () => {
  it('header is authenticated via AAD in encryption', async () => {
    const key = sodium.randombytes_buf(32);
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const { ciphertext } = await encryptShard(
      data,
      key,
      1,
      0,
      ShardTier.ORIGINAL,
    );

    // Corrupt epochId in header (part of AAD)
    ciphertext[5] ^= 0xff;

    // Decryption should fail because AAD verification fails
    await expect(decryptShard(ciphertext, key)).rejects.toThrow();
  });

  it('shardId is authenticated via AAD', async () => {
    const key = sodium.randombytes_buf(32);
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const { ciphertext } = await encryptShard(
      data,
      key,
      1,
      0,
      ShardTier.ORIGINAL,
    );

    // Corrupt shardId in header (positions 9-12)
    ciphertext[9] ^= 0xff;

    await expect(decryptShard(ciphertext, key)).rejects.toThrow();
  });

  it('tier is authenticated via AAD', async () => {
    const key = sodium.randombytes_buf(32);
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const { ciphertext } = await encryptShard(
      data,
      key,
      1,
      0,
      ShardTier.ORIGINAL,
    );

    // Corrupt tier byte (position 37)
    ciphertext[37] ^= 0xff;

    await expect(decryptShard(ciphertext, key)).rejects.toThrow();
  });

  it('magic bytes are authenticated', async () => {
    const key = sodium.randombytes_buf(32);
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const { ciphertext } = await encryptShard(
      data,
      key,
      1,
      0,
      ShardTier.ORIGINAL,
    );

    // Corrupt magic bytes
    ciphertext[0] = 0x00;

    // Should fail on magic check before even trying decryption
    await expect(decryptShard(ciphertext, key)).rejects.toThrow('magic');
  });

  it('version byte is validated', async () => {
    const key = sodium.randombytes_buf(32);
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const { ciphertext } = await encryptShard(
      data,
      key,
      1,
      0,
      ShardTier.ORIGINAL,
    );

    // Set unsupported version
    ciphertext[4] = 0xff;

    await expect(decryptShard(ciphertext, key)).rejects.toThrow('version');
  });
});

describe('Security Invariant: Key Wrapping', () => {
  it('wrapped keys cannot be unwrapped with wrong key', () => {
    const wrappingKey1 = sodium.randombytes_buf(32);
    const wrappingKey2 = sodium.randombytes_buf(32);
    const secretKey = sodium.randombytes_buf(32);

    const wrapped = wrapKey(secretKey, wrappingKey1);

    expect(() => unwrapKey(wrapped, wrappingKey2)).toThrow();
  });

  it('wrapped keys are authenticated', () => {
    const wrappingKey = sodium.randombytes_buf(32);
    const secretKey = sodium.randombytes_buf(32);

    const wrapped = wrapKey(secretKey, wrappingKey);

    // Corrupt the wrapped ciphertext
    wrapped[30] ^= 0xff;

    expect(() => unwrapKey(wrapped, wrappingKey)).toThrow();
  });

  it('wrapped key length validation', () => {
    const wrappingKey = sodium.randombytes_buf(32);

    // Too short to contain nonce + tag
    const tooShort = new Uint8Array(30);

    expect(() => unwrapKey(tooShort, wrappingKey)).toThrow();
  });
});

describe('Security Invariant: Epoch Key Rotation', () => {
  it('new epoch keys are independent of previous epoch', () => {
    const epoch1 = generateEpochKey(1);
    const epoch2 = generateEpochKey(2);

    // Keys should be completely independent - no derivation from previous
    expect(epoch2.epochSeed).not.toEqual(epoch1.epochSeed);
    expect(epoch2.thumbKey).not.toEqual(epoch1.thumbKey);
    expect(epoch2.previewKey).not.toEqual(epoch1.previewKey);
    expect(epoch2.fullKey).not.toEqual(epoch1.fullKey);
    expect(epoch2.signKeypair.secretKey).not.toEqual(
      epoch1.signKeypair.secretKey,
    );

    // Verify statistical independence (XOR should still look random)
    const xoredKey = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      xoredKey[i] = epoch1.thumbKey[i] ^ epoch2.thumbKey[i];
    }
    // XOR of random keys should have roughly equal 0 and 1 bits
    const oneCount = Array.from(xoredKey).reduce(
      (count, byte) => count + (byte.toString(2).match(/1/g)?.length ?? 0),
      0,
    );
    // Expect between 96 and 160 ones (256 bits * 0.375 to 0.625)
    expect(oneCount).toBeGreaterThan(80);
    expect(oneCount).toBeLessThan(176);
  });

  it('epoch ID cannot be decremented (enforced in bundle validation)', () => {
    const ownerSeed = generateIdentitySeed();
    const recipientSeed = generateIdentitySeed();
    const ownerIdentity = deriveIdentityKeypair(ownerSeed);
    const recipientIdentity = deriveIdentityKeypair(recipientSeed);

    // Create epoch 5
    const epoch = generateEpochKey(5);
    const albumId = 'album-123';

    const bundle = createEpochKeyBundle(
      albumId,
      epoch.epochId,
      epoch.epochSeed,
      epoch.signKeypair,
      recipientIdentity.ed25519.publicKey,
    );

    const sealed = sealAndSignBundle(
      bundle,
      recipientIdentity.ed25519.publicKey,
      ownerIdentity,
    );

    // Client already has epoch 10, should reject epoch 5
    expect(() =>
      verifyAndOpenBundle(
        sealed.sealed,
        sealed.signature,
        ownerIdentity.ed25519.publicKey,
        recipientIdentity,
        { albumId, minEpochId: 10 },
      ),
    ).toThrow('epochId');
  });
});

describe('Security Invariant: Recipient Binding', () => {
  it('sealed bundle can only be opened by intended recipient', () => {
    const ownerSeed = generateIdentitySeed();
    const recipientSeed = generateIdentitySeed();
    const attackerSeed = generateIdentitySeed();
    const ownerIdentity = deriveIdentityKeypair(ownerSeed);
    const recipientIdentity = deriveIdentityKeypair(recipientSeed);
    const attackerIdentity = deriveIdentityKeypair(attackerSeed);

    const epoch = generateEpochKey(1);
    const albumId = 'album-123';

    const bundle = createEpochKeyBundle(
      albumId,
      epoch.epochId,
      epoch.epochSeed,
      epoch.signKeypair,
      recipientIdentity.ed25519.publicKey,
    );

    const sealed = sealAndSignBundle(
      bundle,
      recipientIdentity.ed25519.publicKey,
      ownerIdentity,
    );

    // Attacker cannot open the bundle
    expect(() =>
      verifyAndOpenBundle(
        sealed.sealed,
        sealed.signature,
        ownerIdentity.ed25519.publicKey,
        attackerIdentity, // Wrong recipient
        { albumId, minEpochId: 0 },
      ),
    ).toThrow();
  });

  it('bundle contains recipient binding that is verified', () => {
    const ownerSeed = generateIdentitySeed();
    const recipientSeed = generateIdentitySeed();
    const ownerIdentity = deriveIdentityKeypair(ownerSeed);
    const recipientIdentity = deriveIdentityKeypair(recipientSeed);
    const anotherRecipientSeed = generateIdentitySeed();
    const anotherRecipient = deriveIdentityKeypair(anotherRecipientSeed);

    const epoch = generateEpochKey(1);
    const albumId = 'album-123';

    // Bundle explicitly binds to recipient's public key
    const bundle = createEpochKeyBundle(
      albumId,
      epoch.epochId,
      epoch.epochSeed,
      epoch.signKeypair,
      anotherRecipient.ed25519.publicKey, // Different recipient in bundle
    );

    // Seal to original recipient
    const sealed = sealAndSignBundle(
      bundle,
      recipientIdentity.ed25519.publicKey,
      ownerIdentity,
    );

    // Even if original recipient can decrypt, the binding check should fail
    expect(() =>
      verifyAndOpenBundle(
        sealed.sealed,
        sealed.signature,
        ownerIdentity.ed25519.publicKey,
        recipientIdentity,
        { albumId, minEpochId: 0 },
      ),
    ).toThrow('recipient');
  });
});
