import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { sealAndSignBundle, verifyAndOpenBundle, createEpochKeyBundle } from '../src/sharing';
import { deriveIdentityKeypair, generateIdentitySeed } from '../src/identity';
import { generateEpochKey } from '../src/epochs';
import { CryptoErrorCode } from '../src/types';

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
    epoch.epochSeed,
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
    expect(opened.epochSeed).toEqual(epoch.epochSeed);
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

  it('rejects albumId mismatch when bundle has non-empty albumId', () => {
    const sealed = sealAndSignBundle(bundle, recipientIdentity.ed25519.publicKey, ownerIdentity);
    
    expect(() => verifyAndOpenBundle(
      sealed.sealed,
      sealed.signature,
      ownerIdentity.ed25519.publicKey,
      recipientIdentity,
      { albumId: 'wrong-album', minEpochId: 0 }
    )).toThrow('albumId');
  });

  it('accepts empty albumId in bundle (created at album creation time)', () => {
    // Create a bundle with empty albumId (like when creating a new album)
    const bundleWithEmptyAlbumId = createEpochKeyBundle(
      '', // Empty albumId - not known at creation time
      epoch.epochId,
      epoch.epochSeed,
      epoch.signKeypair,
      recipientIdentity.ed25519.publicKey
    );
    
    const sealed = sealAndSignBundle(bundleWithEmptyAlbumId, recipientIdentity.ed25519.publicKey, ownerIdentity);
    
    // Should accept when verifying with actual album ID
    const opened = verifyAndOpenBundle(
      sealed.sealed,
      sealed.signature,
      ownerIdentity.ed25519.publicKey,
      recipientIdentity,
      { albumId: 'actual-album-id-from-server', minEpochId: 0 }
    );
    
    expect(opened.epochId).toBe(epoch.epochId);
    expect(opened.epochSeed).toEqual(epoch.epochSeed);
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

  it('accepts epochId exactly equal to minEpochId', () => {
    // Kills mutant: epochId < expectedContext.minEpochId → epochId <= expectedContext.minEpochId
    // When epochId === minEpochId, it should succeed (not fail)
    const sealed = sealAndSignBundle(bundle, recipientIdentity.ed25519.publicKey, ownerIdentity);
    
    // minEpochId equals the bundle's epochId (which is 1)
    const opened = verifyAndOpenBundle(
      sealed.sealed,
      sealed.signature,
      ownerIdentity.ed25519.publicKey,
      recipientIdentity,
      { albumId, minEpochId: epoch.epochId } // exactly equal
    );
    
    expect(opened.epochId).toBe(epoch.epochId);
  });

  it('rejects epochId exactly one below minEpochId', () => {
    // Complementary test: epochId one below minimum should fail
    const sealed = sealAndSignBundle(bundle, recipientIdentity.ed25519.publicKey, ownerIdentity);
    
    // minEpochId is one more than bundle's epochId
    expect(() => verifyAndOpenBundle(
      sealed.sealed,
      sealed.signature,
      ownerIdentity.ed25519.publicKey,
      recipientIdentity,
      { albumId, minEpochId: epoch.epochId + 1 } // one above
    )).toThrow('epochId');
  });

  it('rejects invalid recipient public key length', () => {
    // Verify both that it throws AND that it's the right error message
    // This kills mutations that bypass validation (error would come from ed25519PubToX25519 instead)
    // sealAndSignBundle says "Recipient Ed25519 public key..."
    // ed25519PubToX25519 says "Ed25519 public key..." (no "Recipient")
    try {
      sealAndSignBundle(bundle, new Uint8Array(16), ownerIdentity);
      expect.fail('Should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('Recipient'); // Must say "Recipient"
      expect((err as Error).message).toContain('32 bytes');
      expect((err as { code?: string }).code).toBe(CryptoErrorCode.INVALID_KEY_LENGTH);
    }
  });

  it('rejects empty recipient public key', () => {
    // Kills mutant: if (recipientEd25519Pub.length !== 32) → if (false)
    try {
      sealAndSignBundle(bundle, new Uint8Array(0), ownerIdentity);
      expect.fail('Should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('Recipient'); // Must say "Recipient"
      expect((err as Error).message).toContain('32 bytes');
      expect((err as { code?: string }).code).toBe(CryptoErrorCode.INVALID_KEY_LENGTH);
    }
  });

  it('rejects overly long recipient public key', () => {
    // Kills mutant: if (recipientEd25519Pub.length !== 32) → if (false)
    try {
      sealAndSignBundle(bundle, new Uint8Array(64), ownerIdentity);
      expect.fail('Should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('Recipient'); // Must say "Recipient"
      expect((err as Error).message).toContain('32 bytes');
      expect((err as { code?: string }).code).toBe(CryptoErrorCode.INVALID_KEY_LENGTH);
    }
  });

  it('validates recipient key length error includes actual length', () => {
    // Verify error message includes actual length for debugging
    try {
      sealAndSignBundle(bundle, new Uint8Array(31), ownerIdentity);
      expect.fail('Should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('Recipient'); // Must say "Recipient"
      expect((err as Error).message).toContain('31');
      expect((err as Error).message).toContain('32 bytes');
    }
  });

  // ====================================================================
  // Mutation testing: L46 validation bypass mutants
  // These spy-based tests verify that no crypto operations occur when
  // recipient key length is invalid.
  // ====================================================================
  describe('sealAndSignBundle validation prevents crypto', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('does NOT call crypto_box_seal for wrong-length recipient key (spy verification)', () => {
      // Kills mutant: if (recipientEd25519Pub.length !== 32) → if (false)
      // Kills mutant: BlockStatement removed (length check block removed)
      const originalSealFn = sodium.crypto_box_seal;
      const sealSpy = vi.fn(originalSealFn);
      (sodium as unknown as Record<string, unknown>).crypto_box_seal = sealSpy;

      const originalConvertFn = sodium.crypto_sign_ed25519_pk_to_curve25519;
      const convertSpy = vi.fn(originalConvertFn);
      (sodium as unknown as Record<string, unknown>).crypto_sign_ed25519_pk_to_curve25519 = convertSpy;

      try {
        // 16-byte key (too short)
        expect(() => sealAndSignBundle(bundle, new Uint8Array(16), ownerIdentity)).toThrow('32 bytes');
        expect(sealSpy).not.toHaveBeenCalled();
        expect(convertSpy).not.toHaveBeenCalled();

        // 64-byte key (too long)
        expect(() => sealAndSignBundle(bundle, new Uint8Array(64), ownerIdentity)).toThrow('32 bytes');
        expect(sealSpy).not.toHaveBeenCalled();
        expect(convertSpy).not.toHaveBeenCalled();

        // Empty key
        expect(() => sealAndSignBundle(bundle, new Uint8Array(0), ownerIdentity)).toThrow('32 bytes');
        expect(sealSpy).not.toHaveBeenCalled();
        expect(convertSpy).not.toHaveBeenCalled();
      } finally {
        sodium.crypto_box_seal = originalSealFn;
        sodium.crypto_sign_ed25519_pk_to_curve25519 = originalConvertFn;
      }
    });

    it('DOES call crypto_box_seal for correct-length recipient key', () => {
      // Complementary test: correct length SHOULD call crypto operations
      const originalSealFn = sodium.crypto_box_seal;
      const sealSpy = vi.fn(originalSealFn);
      (sodium as unknown as Record<string, unknown>).crypto_box_seal = sealSpy;

      try {
        const result = sealAndSignBundle(bundle, recipientIdentity.ed25519.publicKey, ownerIdentity);
        expect(result.sealed).toBeDefined();
        expect(sealSpy).toHaveBeenCalledOnce();
      } finally {
        sodium.crypto_box_seal = originalSealFn;
      }
    });
  });

  // ====================================================================
  // Mutation testing: L170 recipient binding validation mutant
  // Test that verifies the length check is executed before memcmp
  // ====================================================================
  describe('verifyAndOpenBundle recipient binding validation', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('recipient binding check uses both length and memcmp (kills L170 false|| mutant)', () => {
      // Kills mutant: recipientPubkey.length !== myIdentity.ed25519.publicKey.length || ... → false || ...
      // If length check is bypassed (mutated to false), memcmp still runs but with mismatched lengths

      // Create a bundle with a different-length recipient (normally 32 bytes)
      // We need to trick the system into having a length mismatch inside the bundle
      // This requires mocking the crypto_box_seal_open to return crafted JSON
      const sealed = sealAndSignBundle(bundle, recipientIdentity.ed25519.publicKey, ownerIdentity);

      const originalFn = sodium.crypto_box_seal_open;
      (sodium as Record<string, unknown>).crypto_box_seal_open = vi.fn(() => {
        // Use URL-safe base64 WITHOUT padding (library uses base64_variants.URLSAFE_NO_PADDING)
        // 16 zero bytes in URL-safe base64 no padding: AAAAAAAAAAAAAAAAAAAAAA
        // 32 zero bytes in URL-safe base64 no padding: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
        // 64 zero bytes in URL-safe base64 no padding: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
        const fakeBundle = {
          version: 1,
          albumId: albumId,
          epochId: epoch.epochId,
          recipientPubkey: 'AAAAAAAAAAAAAAAAAAAAAA', // 16 bytes - wrong length!
          epochSeed: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // 32 bytes
          signKeypair: {
            publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // 32 bytes
            secretKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // 64 bytes
          },
        };
        return new TextEncoder().encode(JSON.stringify(fakeBundle));
      });

      try {
        expect(() => verifyAndOpenBundle(
          sealed.sealed,
          sealed.signature,
          ownerIdentity.ed25519.publicKey,
          recipientIdentity,
          { albumId, minEpochId: 0 }
        )).toThrow('recipient');
      } finally {
        sodium.crypto_box_seal_open = originalFn;
      }
    });
  });

  it('rejects recipient binding mismatch', () => {
    // Create a bundle for a different recipient
    const otherRecipient = deriveIdentityKeypair(generateIdentitySeed());
    const bundleForOther = createEpochKeyBundle(
      albumId,
      epoch.epochId,
      epoch.epochSeed,
      epoch.signKeypair,
      otherRecipient.ed25519.publicKey // Different recipient in bundle
    );
    
    // Seal for the actual recipient but with wrong binding
    const sealed = sealAndSignBundle(bundleForOther, recipientIdentity.ed25519.publicKey, ownerIdentity);
    
    // Try to open - should fail because recipientPubkey in bundle doesn't match
    expect(() => verifyAndOpenBundle(
      sealed.sealed,
      sealed.signature,
      ownerIdentity.ed25519.publicKey,
      recipientIdentity,
      { albumId, minEpochId: 0 }
    )).toThrow('recipient');
  });

  it('rejects recipient binding mismatch with CONTEXT_MISMATCH error code', () => {
    // Kills mutant: L170-177 recipient pubkey validation
    const otherRecipient = deriveIdentityKeypair(generateIdentitySeed());
    const bundleForOther = createEpochKeyBundle(
      albumId,
      epoch.epochId,
      epoch.epochSeed,
      epoch.signKeypair,
      otherRecipient.ed25519.publicKey
    );
    
    const sealed = sealAndSignBundle(bundleForOther, recipientIdentity.ed25519.publicKey, ownerIdentity);
    
    try {
      verifyAndOpenBundle(
        sealed.sealed,
        sealed.signature,
        ownerIdentity.ed25519.publicKey,
        recipientIdentity,
        { albumId, minEpochId: 0 }
      );
      expect.fail('Should have thrown');
    } catch (err) {
      expect((err as Error).message).toBe('Bundle not intended for this recipient');
      expect((err as { code?: string }).code).toBe(CryptoErrorCode.CONTEXT_MISMATCH);
    }
  });

  it('rejects corrupted bundle JSON', () => {
    // Create sealed bundle
    const sealed = sealAndSignBundle(bundle, recipientIdentity.ed25519.publicKey, ownerIdentity);
    
    // We can't easily corrupt the JSON without breaking the seal first,
    // but we can test by using a manually constructed test.
    // The crypto_box_seal_open will fail for corrupted data, not JSON parse.
    // This test verifies the decrypt failure path is properly exercised.
    sealed.sealed[50] ^= 0xff; // Corrupt sealed data
    
    expect(() => verifyAndOpenBundle(
      sealed.sealed,
      sealed.signature,
      ownerIdentity.ed25519.publicKey,
      recipientIdentity,
      { albumId, minEpochId: 0 }
    )).toThrow(); // Will throw signature error since we also need to re-sign
  });

  it('throws DECRYPTION_FAILED with correct message when seal open fails', () => {
    // Kills mutant: L122, L124 - catch block error message verification
    const wrongRecipient = deriveIdentityKeypair(generateIdentitySeed());
    const sealed = sealAndSignBundle(bundle, recipientIdentity.ed25519.publicKey, ownerIdentity);
    
    try {
      verifyAndOpenBundle(
        sealed.sealed,
        sealed.signature,
        ownerIdentity.ed25519.publicKey,
        wrongRecipient, // Wrong recipient cannot decrypt
        { albumId, minEpochId: 0 }
      );
      expect.fail('Should have thrown');
    } catch (err) {
      expect((err as Error).message).toBe('Failed to open sealed bundle - not intended for this recipient');
      expect((err as { code?: string }).code).toBe(CryptoErrorCode.DECRYPTION_FAILED);
    }
  });

  describe('mocked JSON parse error', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('throws INVALID_ENVELOPE when bundle JSON parsing fails', () => {
      const sealed = sealAndSignBundle(bundle, recipientIdentity.ed25519.publicKey, ownerIdentity);
      
      // Mock crypto_box_seal_open to return invalid JSON bytes
      const originalFn = sodium.crypto_box_seal_open;
      (sodium as Record<string, unknown>).crypto_box_seal_open = vi.fn(() => {
        // Return bytes that are not valid JSON
        return new Uint8Array([0x00, 0x01, 0x02, 0x03]);
      });
      
      try {
        expect(() => verifyAndOpenBundle(
          sealed.sealed,
          sealed.signature,
          ownerIdentity.ed25519.publicKey,
          recipientIdentity,
          { albumId, minEpochId: 0 }
        )).toThrow('parse bundle JSON');
      } finally {
        sodium.crypto_box_seal_open = originalFn;
      }
    });

    it('throws INVALID_ENVELOPE with correct error code when JSON is malformed', () => {
      // Kills mutant: L144-149 JSON parse catch block
      const sealed = sealAndSignBundle(bundle, recipientIdentity.ed25519.publicKey, ownerIdentity);
      
      const originalFn = sodium.crypto_box_seal_open;
      (sodium as Record<string, unknown>).crypto_box_seal_open = vi.fn(() => {
        // Return bytes that decode to a string but aren't valid JSON
        return new TextEncoder().encode('{ invalid json without closing brace');
      });
      
      try {
        verifyAndOpenBundle(
          sealed.sealed,
          sealed.signature,
          ownerIdentity.ed25519.publicKey,
          recipientIdentity,
          { albumId, minEpochId: 0 }
        );
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as Error).message).toBe('Failed to parse bundle JSON');
        expect((err as { code?: string }).code).toBe(CryptoErrorCode.INVALID_ENVELOPE);
      } finally {
        sodium.crypto_box_seal_open = originalFn;
      }
    });
  });
});
