import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import {
  generateLinkSecret,
  deriveLinkKeys,
  wrapTierKeyForLink,
  unwrapTierKeyFromLink,
  wrapAllTierKeysForLink,
  encodeLinkSecret,
  decodeLinkSecret,
  createShareLinkUrl,
  parseShareLinkUrl,
} from '../src/link-sharing';
import { generateEpochKey } from '../src/epochs';
import { AccessTier } from '../src/types';

beforeAll(async () => {
  await sodium.ready;
});

describe('link-sharing', () => {
  describe('generateLinkSecret', () => {
    it('generates 32-byte random secret', () => {
      const secret = generateLinkSecret();
      expect(secret).toBeInstanceOf(Uint8Array);
      expect(secret.length).toBe(32);
    });

    it('generates unique secrets', () => {
      const s1 = generateLinkSecret();
      const s2 = generateLinkSecret();
      expect(s1).not.toEqual(s2);
    });
  });

  describe('deriveLinkKeys', () => {
    it('derives linkId and wrappingKey from secret', () => {
      const secret = generateLinkSecret();
      const keys = deriveLinkKeys(secret);
      
      expect(keys.linkId).toBeInstanceOf(Uint8Array);
      expect(keys.linkId.length).toBe(16);
      expect(keys.wrappingKey).toBeInstanceOf(Uint8Array);
      expect(keys.wrappingKey.length).toBe(32);
    });

    it('derives deterministic keys from same secret', () => {
      const secret = generateLinkSecret();
      const keys1 = deriveLinkKeys(secret);
      const keys2 = deriveLinkKeys(secret);
      
      expect(keys1.linkId).toEqual(keys2.linkId);
      expect(keys1.wrappingKey).toEqual(keys2.wrappingKey);
    });

    it('derives different keys from different secrets', () => {
      const s1 = generateLinkSecret();
      const s2 = generateLinkSecret();
      const keys1 = deriveLinkKeys(s1);
      const keys2 = deriveLinkKeys(s2);
      
      expect(keys1.linkId).not.toEqual(keys2.linkId);
      expect(keys1.wrappingKey).not.toEqual(keys2.wrappingKey);
    });

    it('rejects invalid secret length', () => {
      expect(() => deriveLinkKeys(new Uint8Array(16))).toThrow('32 bytes');
    });
  });

  describe('wrapTierKeyForLink / unwrapTierKeyFromLink', () => {
    it('round-trips tier key wrapping', () => {
      const secret = generateLinkSecret();
      const { wrappingKey } = deriveLinkKeys(secret);
      const epoch = generateEpochKey(1);
      
      const wrapped = wrapTierKeyForLink(epoch.thumbKey, AccessTier.THUMB, wrappingKey);
      const unwrapped = unwrapTierKeyFromLink(wrapped, AccessTier.THUMB, wrappingKey);
      
      expect(unwrapped).toEqual(epoch.thumbKey);
    });

    it('produces different ciphertext for different tiers', () => {
      const secret = generateLinkSecret();
      const { wrappingKey } = deriveLinkKeys(secret);
      const epoch = generateEpochKey(1);
      
      const wrapped1 = wrapTierKeyForLink(epoch.thumbKey, AccessTier.THUMB, wrappingKey);
      const wrapped2 = wrapTierKeyForLink(epoch.previewKey, AccessTier.PREVIEW, wrappingKey);
      const wrapped3 = wrapTierKeyForLink(epoch.fullKey, AccessTier.FULL, wrappingKey);
      
      // Ciphertexts should differ (different keys, different nonces)
      expect(wrapped1.encryptedKey).not.toEqual(wrapped2.encryptedKey);
      expect(wrapped2.encryptedKey).not.toEqual(wrapped3.encryptedKey);
    });

    it('fails to unwrap with wrong tier', () => {
      const secret = generateLinkSecret();
      const { wrappingKey } = deriveLinkKeys(secret);
      const epoch = generateEpochKey(1);
      
      const wrapped = wrapTierKeyForLink(epoch.thumbKey, AccessTier.THUMB, wrappingKey);
      
      // Try to unwrap with wrong tier
      expect(() => unwrapTierKeyFromLink(wrapped, AccessTier.PREVIEW, wrappingKey))
        .toThrow('mismatch');
    });

    it('fails to unwrap with wrong wrapping key', () => {
      const secret1 = generateLinkSecret();
      const secret2 = generateLinkSecret();
      const { wrappingKey: wk1 } = deriveLinkKeys(secret1);
      const { wrappingKey: wk2 } = deriveLinkKeys(secret2);
      const epoch = generateEpochKey(1);
      
      const wrapped = wrapTierKeyForLink(epoch.thumbKey, AccessTier.THUMB, wk1);
      
      expect(() => unwrapTierKeyFromLink(wrapped, AccessTier.THUMB, wk2))
        .toThrow();
    });

    it('rejects invalid wrapping key length', () => {
      const epoch = generateEpochKey(1);
      const invalidKey = new Uint8Array(16);
      
      expect(() => wrapTierKeyForLink(epoch.thumbKey, AccessTier.THUMB, invalidKey))
        .toThrow('32 bytes');
    });

    it('rejects invalid tier key length', () => {
      const secret = generateLinkSecret();
      const { wrappingKey } = deriveLinkKeys(secret);
      const invalidTierKey = new Uint8Array(16);
      
      expect(() => wrapTierKeyForLink(invalidTierKey, AccessTier.THUMB, wrappingKey))
        .toThrow('32 bytes');
    });
  });

  describe('wrapAllTierKeysForLink', () => {
    it('wraps keys up to specified access tier', () => {
      const secret = generateLinkSecret();
      const { wrappingKey } = deriveLinkKeys(secret);
      const epoch = generateEpochKey(1);
      
      // Thumb only
      const thumbOnly = wrapAllTierKeysForLink(
        { thumbKey: epoch.thumbKey, previewKey: epoch.previewKey, fullKey: epoch.fullKey },
        AccessTier.THUMB,
        wrappingKey
      );
      expect(thumbOnly.length).toBe(1);
      expect(thumbOnly[0].tier).toBe(AccessTier.THUMB);
      
      // Preview includes thumb
      const preview = wrapAllTierKeysForLink(
        { thumbKey: epoch.thumbKey, previewKey: epoch.previewKey, fullKey: epoch.fullKey },
        AccessTier.PREVIEW,
        wrappingKey
      );
      expect(preview.length).toBe(2);
      expect(preview.map(w => w.tier).sort()).toEqual([AccessTier.THUMB, AccessTier.PREVIEW].sort());
      
      // Full includes all
      const full = wrapAllTierKeysForLink(
        { thumbKey: epoch.thumbKey, previewKey: epoch.previewKey, fullKey: epoch.fullKey },
        AccessTier.FULL,
        wrappingKey
      );
      expect(full.length).toBe(3);
    });

    it('all wrapped keys can be unwrapped', () => {
      const secret = generateLinkSecret();
      const { wrappingKey } = deriveLinkKeys(secret);
      const epoch = generateEpochKey(1);
      
      const wrapped = wrapAllTierKeysForLink(
        { thumbKey: epoch.thumbKey, previewKey: epoch.previewKey, fullKey: epoch.fullKey },
        AccessTier.FULL,
        wrappingKey
      );
      
      for (const w of wrapped) {
        const unwrapped = unwrapTierKeyFromLink(w, w.tier, wrappingKey);
        switch (w.tier) {
          case AccessTier.THUMB:
            expect(unwrapped).toEqual(epoch.thumbKey);
            break;
          case AccessTier.PREVIEW:
            expect(unwrapped).toEqual(epoch.previewKey);
            break;
          case AccessTier.FULL:
            expect(unwrapped).toEqual(epoch.fullKey);
            break;
        }
      }
    });
  });

  describe('encodeLinkSecret / decodeLinkSecret', () => {
    it('round-trips secret through base64url', () => {
      const secret = generateLinkSecret();
      const encoded = encodeLinkSecret(secret);
      const decoded = decodeLinkSecret(encoded);
      
      expect(decoded).toEqual(secret);
    });

    it('produces URL-safe characters only', () => {
      const secret = generateLinkSecret();
      const encoded = encodeLinkSecret(secret);
      
      // Should only contain alphanumeric, hyphen, underscore
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      // Should not contain padding
      expect(encoded).not.toContain('=');
    });

    it('rejects invalid base64url', () => {
      expect(() => decodeLinkSecret('!!!invalid!!!')).toThrow();
    });

    it('rejects wrong length after decode', () => {
      // Encode a 16-byte value instead of 32
      const short = sodium.to_base64(new Uint8Array(16), sodium.base64_variants.URLSAFE_NO_PADDING);
      expect(() => decodeLinkSecret(short)).toThrow('32');
    });
  });

  describe('createShareLinkUrl / parseShareLinkUrl', () => {
    it('creates valid share URL', () => {
      const secret = generateLinkSecret();
      
      const url = createShareLinkUrl('https://photos.example.com', secret);
      
      expect(url).toMatch(/^https:\/\/photos\.example\.com\/s\/[A-Za-z0-9_-]+#k=[A-Za-z0-9_-]+$/);
    });

    it('round-trips through URL creation/parsing', () => {
      const secret = generateLinkSecret();
      const { linkId } = deriveLinkKeys(secret);
      
      const url = createShareLinkUrl('https://photos.example.com', secret);
      const parsed = parseShareLinkUrl(url);
      
      expect(parsed).not.toBeNull();
      expect(parsed!.linkId).toEqual(linkId);
      expect(parsed!.linkSecret).toEqual(secret);
    });

    it('parses URL with path prefix', () => {
      const secret = generateLinkSecret();
      const { linkId } = deriveLinkKeys(secret);
      
      const url = createShareLinkUrl('https://photos.example.com/app', secret);
      const parsed = parseShareLinkUrl(url);
      
      expect(parsed).not.toBeNull();
      expect(parsed!.linkId).toEqual(linkId);
      expect(parsed!.linkSecret).toEqual(secret);
    });

    it('returns null for URL without /s/ path', () => {
      const result = parseShareLinkUrl('https://photos.example.com/album/123#k=abc');
      expect(result).toBeNull();
    });

    it('returns null for URL without fragment key', () => {
      const secret = generateLinkSecret();
      const { linkId } = deriveLinkKeys(secret);
      const encoded = sodium.to_base64(linkId, sodium.base64_variants.URLSAFE_NO_PADDING);
      
      const result = parseShareLinkUrl(`https://photos.example.com/s/${encoded}`);
      expect(result).toBeNull();
    });

    it('returns null for URL with invalid linkId length', () => {
      const shortId = sodium.to_base64(new Uint8Array(8), sodium.base64_variants.URLSAFE_NO_PADDING);
      const secret = generateLinkSecret();
      const encodedSecret = encodeLinkSecret(secret);
      
      const result = parseShareLinkUrl(`https://photos.example.com/s/${shortId}#k=${encodedSecret}`);
      expect(result).toBeNull();
    });

    it('returns null for completely invalid URL', () => {
      // This triggers the catch block because new URL() throws for invalid URLs
      // Use undefined/null-like input that will cause URL constructor to throw
      const result = parseShareLinkUrl('://');
      expect(result).toBeNull();
    });

    it('returns null for another invalid URL format', () => {
      const result = parseShareLinkUrl('');
      expect(result).toBeNull();
    });

    it('returns null for URL with invalid base64 in linkId', () => {
      const secret = generateLinkSecret();
      const encodedSecret = encodeLinkSecret(secret);
      
      // Use invalid base64 characters for linkId
      const result = parseShareLinkUrl(`https://photos.example.com/s/@@@invalid@@@#k=${encodedSecret}`);
      expect(result).toBeNull();
    });

    it('returns null for URL with invalid base64 in secret', () => {
      const secret = generateLinkSecret();
      const { linkId } = deriveLinkKeys(secret);
      const encoded = sodium.to_base64(linkId, sodium.base64_variants.URLSAFE_NO_PADDING);
      
      // Use invalid base64 characters for secret
      const result = parseShareLinkUrl(`https://photos.example.com/s/${encoded}#k=!!!invalid!!!`);
      expect(result).toBeNull();
    });

    it('returns null for tampered linkId that does not match secret', () => {
      // Create a valid link first
      const secret = generateLinkSecret();
      const encodedSecret = encodeLinkSecret(secret);
      
      // Create a DIFFERENT linkId that doesn't match the secret
      const wrongLinkId = sodium.randombytes_buf(16);
      const wrongEncodedLinkId = sodium.to_base64(wrongLinkId, sodium.base64_variants.URLSAFE_NO_PADDING);
      
      // This URL has valid format but linkId doesn't match the secret's derived linkId
      const result = parseShareLinkUrl(`https://photos.example.com/s/${wrongEncodedLinkId}#k=${encodedSecret}`);
      expect(result).toBeNull();
    });
  });

  describe('integration: complete link sharing flow', () => {
    it('simulates creating and using a share link', async () => {
      // === STEP 1: Album owner creates share link ===
      const epoch = generateEpochKey(1);
      const linkSecret = generateLinkSecret();
      const { linkId, wrappingKey } = deriveLinkKeys(linkSecret);
      
      // Owner wraps tier keys for the link (preview access)
      const wrappedKeys = wrapAllTierKeysForLink(
        { thumbKey: epoch.thumbKey, previewKey: epoch.previewKey, fullKey: epoch.fullKey },
        AccessTier.PREVIEW,
        wrappingKey
      );
      
      // Create the URL
      const shareUrl = createShareLinkUrl('https://photos.example.com', linkSecret);
      
      // === STEP 2: Simulate storing wrapped keys on server ===
      const serverRecord = {
        linkId: sodium.to_base64(linkId, sodium.base64_variants.URLSAFE_NO_PADDING),
        epochId: epoch.epochId,
        accessTier: AccessTier.PREVIEW,
        wrappedKeys: wrappedKeys.map(w => ({
          tier: w.tier,
          nonce: sodium.to_base64(w.nonce, sodium.base64_variants.URLSAFE_NO_PADDING),
          encryptedKey: sodium.to_base64(w.encryptedKey, sodium.base64_variants.URLSAFE_NO_PADDING),
        })),
      };
      
      // === STEP 3: Visitor opens share link ===
      const parsed = parseShareLinkUrl(shareUrl);
      expect(parsed).not.toBeNull();
      const visitorKeys = deriveLinkKeys(parsed!.linkSecret);
      
      // Verify linkId matches
      expect(visitorKeys.linkId).toEqual(linkId);
      
      // === STEP 4: Server sends wrapped keys, visitor unwraps ===
      for (const stored of serverRecord.wrappedKeys) {
        const wrapped = {
          tier: stored.tier as AccessTier,
          nonce: sodium.from_base64(stored.nonce, sodium.base64_variants.URLSAFE_NO_PADDING),
          encryptedKey: sodium.from_base64(stored.encryptedKey, sodium.base64_variants.URLSAFE_NO_PADDING),
        };
        
        const tierKey = unwrapTierKeyFromLink(wrapped, wrapped.tier, visitorKeys.wrappingKey);
        
        // Verify correct tier key recovered
        if (wrapped.tier === AccessTier.THUMB) {
          expect(tierKey).toEqual(epoch.thumbKey);
        } else if (wrapped.tier === AccessTier.PREVIEW) {
          expect(tierKey).toEqual(epoch.previewKey);
        }
      }
      
      // === STEP 5: Visitor should NOT have full key ===
      expect(wrappedKeys.find(w => w.tier === AccessTier.FULL)).toBeUndefined();
    });

    it('supports multiple epochs with same link secret', () => {
      const epoch1 = generateEpochKey(1);
      const epoch2 = generateEpochKey(2);
      const linkSecret = generateLinkSecret();
      const { wrappingKey } = deriveLinkKeys(linkSecret);
      
      // Wrap keys for both epochs
      const wrapped1 = wrapAllTierKeysForLink(
        { thumbKey: epoch1.thumbKey, previewKey: epoch1.previewKey, fullKey: epoch1.fullKey },
        AccessTier.FULL,
        wrappingKey
      );
      const wrapped2 = wrapAllTierKeysForLink(
        { thumbKey: epoch2.thumbKey, previewKey: epoch2.previewKey, fullKey: epoch2.fullKey },
        AccessTier.FULL,
        wrappingKey
      );
      
      // All can be unwrapped with same wrapping key
      for (const w of wrapped1) {
        const key = unwrapTierKeyFromLink(w, w.tier, wrappingKey);
        expect(key.length).toBe(32);
      }
      for (const w of wrapped2) {
        const key = unwrapTierKeyFromLink(w, w.tier, wrappingKey);
        expect(key.length).toBe(32);
      }
    });
  });

  describe('parseShareLinkUrl error handling', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns null when internal operation throws unexpectedly', () => {
      // Create a valid URL first
      const secret = generateLinkSecret();
      const url = createShareLinkUrl('https://photos.example.com', secret);
      
      // Mock sodium.memcmp to throw (it's called after all validations pass)
      const originalMemcmp = sodium.memcmp;
      const mockMemcmp = () => {
        throw new Error('Simulated internal failure');
      };
      (sodium as Record<string, unknown>).memcmp = mockMemcmp;
      
      try {
        const result = parseShareLinkUrl(url);
        expect(result).toBeNull();
      } finally {
        (sodium as Record<string, unknown>).memcmp = originalMemcmp;
      }
    });
  });
});
