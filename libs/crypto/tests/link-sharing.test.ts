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
  encodeLinkId,
  decodeLinkId,
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

      const wrapped = wrapTierKeyForLink(
        epoch.thumbKey,
        AccessTier.THUMB,
        wrappingKey,
      );
      const unwrapped = unwrapTierKeyFromLink(
        wrapped,
        AccessTier.THUMB,
        wrappingKey,
      );

      expect(unwrapped).toEqual(epoch.thumbKey);
    });

    it('produces different ciphertext for different tiers', () => {
      const secret = generateLinkSecret();
      const { wrappingKey } = deriveLinkKeys(secret);
      const epoch = generateEpochKey(1);

      const wrapped1 = wrapTierKeyForLink(
        epoch.thumbKey,
        AccessTier.THUMB,
        wrappingKey,
      );
      const wrapped2 = wrapTierKeyForLink(
        epoch.previewKey,
        AccessTier.PREVIEW,
        wrappingKey,
      );
      const wrapped3 = wrapTierKeyForLink(
        epoch.fullKey,
        AccessTier.FULL,
        wrappingKey,
      );

      // Ciphertexts should differ (different keys, different nonces)
      expect(wrapped1.encryptedKey).not.toEqual(wrapped2.encryptedKey);
      expect(wrapped2.encryptedKey).not.toEqual(wrapped3.encryptedKey);
    });

    it('fails to unwrap with wrong tier', () => {
      const secret = generateLinkSecret();
      const { wrappingKey } = deriveLinkKeys(secret);
      const epoch = generateEpochKey(1);

      const wrapped = wrapTierKeyForLink(
        epoch.thumbKey,
        AccessTier.THUMB,
        wrappingKey,
      );

      // Try to unwrap with wrong tier
      expect(() =>
        unwrapTierKeyFromLink(wrapped, AccessTier.PREVIEW, wrappingKey),
      ).toThrow('mismatch');
    });

    it('fails to unwrap with wrong wrapping key', () => {
      const secret1 = generateLinkSecret();
      const secret2 = generateLinkSecret();
      const { wrappingKey: wk1 } = deriveLinkKeys(secret1);
      const { wrappingKey: wk2 } = deriveLinkKeys(secret2);
      const epoch = generateEpochKey(1);

      const wrapped = wrapTierKeyForLink(epoch.thumbKey, AccessTier.THUMB, wk1);

      expect(() =>
        unwrapTierKeyFromLink(wrapped, AccessTier.THUMB, wk2),
      ).toThrow();
    });

    it('rejects invalid wrapping key length', () => {
      const epoch = generateEpochKey(1);
      const invalidKey = new Uint8Array(16);

      expect(() =>
        wrapTierKeyForLink(epoch.thumbKey, AccessTier.THUMB, invalidKey),
      ).toThrow('32 bytes');
    });

    it('rejects invalid tier key length', () => {
      const secret = generateLinkSecret();
      const { wrappingKey } = deriveLinkKeys(secret);
      const invalidTierKey = new Uint8Array(16);

      expect(() =>
        wrapTierKeyForLink(invalidTierKey, AccessTier.THUMB, wrappingKey),
      ).toThrow('32 bytes');
    });
  });

  describe('wrapAllTierKeysForLink', () => {
    it('wraps keys up to specified access tier', () => {
      const secret = generateLinkSecret();
      const { wrappingKey } = deriveLinkKeys(secret);
      const epoch = generateEpochKey(1);

      // Thumb only
      const thumbOnly = wrapAllTierKeysForLink(
        {
          thumbKey: epoch.thumbKey,
          previewKey: epoch.previewKey,
          fullKey: epoch.fullKey,
        },
        AccessTier.THUMB,
        wrappingKey,
      );
      expect(thumbOnly.length).toBe(1);
      expect(thumbOnly[0].tier).toBe(AccessTier.THUMB);

      // Preview includes thumb
      const preview = wrapAllTierKeysForLink(
        {
          thumbKey: epoch.thumbKey,
          previewKey: epoch.previewKey,
          fullKey: epoch.fullKey,
        },
        AccessTier.PREVIEW,
        wrappingKey,
      );
      expect(preview.length).toBe(2);
      expect(preview.map((w) => w.tier).sort()).toEqual(
        [AccessTier.THUMB, AccessTier.PREVIEW].sort(),
      );

      // Full includes all
      const full = wrapAllTierKeysForLink(
        {
          thumbKey: epoch.thumbKey,
          previewKey: epoch.previewKey,
          fullKey: epoch.fullKey,
        },
        AccessTier.FULL,
        wrappingKey,
      );
      expect(full.length).toBe(3);
    });

    it('all wrapped keys can be unwrapped', () => {
      const secret = generateLinkSecret();
      const { wrappingKey } = deriveLinkKeys(secret);
      const epoch = generateEpochKey(1);

      const wrapped = wrapAllTierKeysForLink(
        {
          thumbKey: epoch.thumbKey,
          previewKey: epoch.previewKey,
          fullKey: epoch.fullKey,
        },
        AccessTier.FULL,
        wrappingKey,
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
      const short = sodium.to_base64(
        new Uint8Array(16),
        sodium.base64_variants.URLSAFE_NO_PADDING,
      );
      expect(() => decodeLinkSecret(short)).toThrow('32');
    });
  });

  describe('createShareLinkUrl / parseShareLinkUrl', () => {
    it('creates valid share URL', () => {
      const secret = generateLinkSecret();

      const url = createShareLinkUrl('https://photos.example.com', secret);

      expect(url).toMatch(
        /^https:\/\/photos\.example\.com\/s\/[A-Za-z0-9_-]+#k=[A-Za-z0-9_-]+$/,
      );
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
      const result = parseShareLinkUrl(
        'https://photos.example.com/album/123#k=abc',
      );
      expect(result).toBeNull();
    });

    it('returns null for URL without fragment key', () => {
      const secret = generateLinkSecret();
      const { linkId } = deriveLinkKeys(secret);
      const encoded = sodium.to_base64(
        linkId,
        sodium.base64_variants.URLSAFE_NO_PADDING,
      );

      const result = parseShareLinkUrl(
        `https://photos.example.com/s/${encoded}`,
      );
      expect(result).toBeNull();
    });

    it('returns null for URL with invalid linkId length', () => {
      const shortId = sodium.to_base64(
        new Uint8Array(8),
        sodium.base64_variants.URLSAFE_NO_PADDING,
      );
      const secret = generateLinkSecret();
      const encodedSecret = encodeLinkSecret(secret);

      const result = parseShareLinkUrl(
        `https://photos.example.com/s/${shortId}#k=${encodedSecret}`,
      );
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
      const result = parseShareLinkUrl(
        `https://photos.example.com/s/@@@invalid@@@#k=${encodedSecret}`,
      );
      expect(result).toBeNull();
    });

    it('returns null for URL with invalid base64 in secret', () => {
      const secret = generateLinkSecret();
      const { linkId } = deriveLinkKeys(secret);
      const encoded = sodium.to_base64(
        linkId,
        sodium.base64_variants.URLSAFE_NO_PADDING,
      );

      // Use invalid base64 characters for secret
      const result = parseShareLinkUrl(
        `https://photos.example.com/s/${encoded}#k=!!!invalid!!!`,
      );
      expect(result).toBeNull();
    });

    it('returns null for tampered linkId that does not match secret', () => {
      // Create a valid link first
      const secret = generateLinkSecret();
      const encodedSecret = encodeLinkSecret(secret);

      // Create a DIFFERENT linkId that doesn't match the secret
      const wrongLinkId = sodium.randombytes_buf(16);
      const wrongEncodedLinkId = sodium.to_base64(
        wrongLinkId,
        sodium.base64_variants.URLSAFE_NO_PADDING,
      );

      // This URL has valid format but linkId doesn't match the secret's derived linkId
      const result = parseShareLinkUrl(
        `https://photos.example.com/s/${wrongEncodedLinkId}#k=${encodedSecret}`,
      );
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
        {
          thumbKey: epoch.thumbKey,
          previewKey: epoch.previewKey,
          fullKey: epoch.fullKey,
        },
        AccessTier.PREVIEW,
        wrappingKey,
      );

      // Create the URL
      const shareUrl = createShareLinkUrl(
        'https://photos.example.com',
        linkSecret,
      );

      // === STEP 2: Simulate storing wrapped keys on server ===
      const serverRecord = {
        linkId: sodium.to_base64(
          linkId,
          sodium.base64_variants.URLSAFE_NO_PADDING,
        ),
        epochId: epoch.epochId,
        accessTier: AccessTier.PREVIEW,
        wrappedKeys: wrappedKeys.map((w) => ({
          tier: w.tier,
          nonce: sodium.to_base64(
            w.nonce,
            sodium.base64_variants.URLSAFE_NO_PADDING,
          ),
          encryptedKey: sodium.to_base64(
            w.encryptedKey,
            sodium.base64_variants.URLSAFE_NO_PADDING,
          ),
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
          nonce: sodium.from_base64(
            stored.nonce,
            sodium.base64_variants.URLSAFE_NO_PADDING,
          ),
          encryptedKey: sodium.from_base64(
            stored.encryptedKey,
            sodium.base64_variants.URLSAFE_NO_PADDING,
          ),
        };

        const tierKey = unwrapTierKeyFromLink(
          wrapped,
          wrapped.tier,
          visitorKeys.wrappingKey,
        );

        // Verify correct tier key recovered
        if (wrapped.tier === AccessTier.THUMB) {
          expect(tierKey).toEqual(epoch.thumbKey);
        } else if (wrapped.tier === AccessTier.PREVIEW) {
          expect(tierKey).toEqual(epoch.previewKey);
        }
      }

      // === STEP 5: Visitor should NOT have full key ===
      expect(
        wrappedKeys.find((w) => w.tier === AccessTier.FULL),
      ).toBeUndefined();
    });

    it('supports multiple epochs with same link secret', () => {
      const epoch1 = generateEpochKey(1);
      const epoch2 = generateEpochKey(2);
      const linkSecret = generateLinkSecret();
      const { wrappingKey } = deriveLinkKeys(linkSecret);

      // Wrap keys for both epochs
      const wrapped1 = wrapAllTierKeysForLink(
        {
          thumbKey: epoch1.thumbKey,
          previewKey: epoch1.previewKey,
          fullKey: epoch1.fullKey,
        },
        AccessTier.FULL,
        wrappingKey,
      );
      const wrapped2 = wrapAllTierKeysForLink(
        {
          thumbKey: epoch2.thumbKey,
          previewKey: epoch2.previewKey,
          fullKey: epoch2.fullKey,
        },
        AccessTier.FULL,
        wrappingKey,
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

  describe('mutation testing - killing surviving mutants', () => {
    describe('wrapTierKeyForLink wrapping key validation', () => {
      it('rejects wrapping key of 31 bytes (one below threshold)', () => {
        const epoch = generateEpochKey(1);
        const shortKey = new Uint8Array(31);

        expect(() =>
          wrapTierKeyForLink(epoch.thumbKey, AccessTier.THUMB, shortKey),
        ).toThrow('32 bytes');
      });

      it('rejects wrapping key of 33 bytes (one above threshold)', () => {
        const epoch = generateEpochKey(1);
        const longKey = new Uint8Array(33);

        expect(() =>
          wrapTierKeyForLink(epoch.thumbKey, AccessTier.THUMB, longKey),
        ).toThrow('32 bytes');
      });

      it('error message includes actual key length received', () => {
        const epoch = generateEpochKey(1);
        const badKey = new Uint8Array(17);

        expect(() =>
          wrapTierKeyForLink(epoch.thumbKey, AccessTier.THUMB, badKey),
        ).toThrow('got 17');
      });

      it('accepts exactly 32-byte wrapping key (boundary)', () => {
        const epoch = generateEpochKey(1);
        const secret = generateLinkSecret();
        const { wrappingKey } = deriveLinkKeys(secret);

        // Should not throw - 32 bytes is valid
        expect(wrappingKey.length).toBe(32);
        const wrapped = wrapTierKeyForLink(
          epoch.thumbKey,
          AccessTier.THUMB,
          wrappingKey,
        );
        expect(wrapped.tier).toBe(AccessTier.THUMB);
      });
    });

    describe('decodeLinkId validation', () => {
      it('rejects decoded linkId of 15 bytes (one below threshold)', () => {
        const shortId = sodium.to_base64(
          new Uint8Array(15),
          sodium.base64_variants.URLSAFE_NO_PADDING,
        );
        const secret = generateLinkSecret();
        const encodedSecret = encodeLinkSecret(secret);

        const result = parseShareLinkUrl(
          `https://photos.example.com/s/${shortId}#k=${encodedSecret}`,
        );
        expect(result).toBeNull();
      });

      it('rejects decoded linkId of 17 bytes (one above threshold)', () => {
        const longId = sodium.to_base64(
          new Uint8Array(17),
          sodium.base64_variants.URLSAFE_NO_PADDING,
        );
        const secret = generateLinkSecret();
        const encodedSecret = encodeLinkSecret(secret);

        const result = parseShareLinkUrl(
          `https://photos.example.com/s/${longId}#k=${encodedSecret}`,
        );
        expect(result).toBeNull();
      });

      it('error message in decodeLinkId includes expected and actual length', () => {
        // Direct test of decodeLinkId function to verify error message
        const wrongLengthId = sodium.to_base64(
          new Uint8Array(10),
          sodium.base64_variants.URLSAFE_NO_PADDING,
        );

        expect(() => decodeLinkId(wrongLengthId)).toThrow('expected 16');
        expect(() => decodeLinkId(wrongLengthId)).toThrow('got 10');
      });
    });

    describe('createShareLinkUrl trailing slash normalization', () => {
      it('removes trailing slash from base URL', () => {
        const secret = generateLinkSecret();
        const urlWithSlash = createShareLinkUrl(
          'https://photos.example.com/',
          secret,
        );
        const urlWithoutSlash = createShareLinkUrl(
          'https://photos.example.com',
          secret,
        );

        // Both should produce identical URLs (no double slashes)
        expect(urlWithSlash).toBe(urlWithoutSlash);
        expect(urlWithSlash).not.toContain('//s/');
      });

      it('resulting URL does not have consecutive slashes before /s/', () => {
        const secret = generateLinkSecret();
        const url = createShareLinkUrl('https://photos.example.com/', secret);

        // Check the path starts correctly
        expect(url).toMatch(/\.com\/s\//);
        expect(url).not.toMatch(/\.com\/\/s\//);
      });
    });

    describe('parseShareLinkUrl regex anchoring', () => {
      it('rejects URL with /s/ in middle of path (not at end)', () => {
        const secret = generateLinkSecret();
        const { linkId } = deriveLinkKeys(secret);
        const encodedLinkId = sodium.to_base64(
          linkId,
          sodium.base64_variants.URLSAFE_NO_PADDING,
        );
        const encodedSecret = encodeLinkSecret(secret);

        // URL has /s/{linkId} but with extra path segments after
        const result = parseShareLinkUrl(
          `https://photos.example.com/s/${encodedLinkId}/extra#k=${encodedSecret}`,
        );
        expect(result).toBeNull();
      });

      it('rejects URL with /s/ not followed by proper base64url linkId', () => {
        const secret = generateLinkSecret();
        const encodedSecret = encodeLinkSecret(secret);

        // The linkId contains characters not in the regex character class
        const result = parseShareLinkUrl(
          `https://photos.example.com/s/link.id.with.dots#k=${encodedSecret}`,
        );
        expect(result).toBeNull();
      });

      it('rejects URL with fragment containing extra content before #k=', () => {
        const secret = generateLinkSecret();
        const { linkId } = deriveLinkKeys(secret);
        const encodedLinkId = sodium.to_base64(
          linkId,
          sodium.base64_variants.URLSAFE_NO_PADDING,
        );
        const encodedSecret = encodeLinkSecret(secret);

        // Fragment has content before #k=
        const result = parseShareLinkUrl(
          `https://photos.example.com/s/${encodedLinkId}#prefix&k=${encodedSecret}`,
        );
        expect(result).toBeNull();
      });

      it('rejects URL with fragment containing extra content after secret', () => {
        const secret = generateLinkSecret();
        const { linkId } = deriveLinkKeys(secret);
        const encodedLinkId = sodium.to_base64(
          linkId,
          sodium.base64_variants.URLSAFE_NO_PADDING,
        );
        const encodedSecret = encodeLinkSecret(secret);

        // Fragment has content after the secret
        const result = parseShareLinkUrl(
          `https://photos.example.com/s/${encodedLinkId}#k=${encodedSecret}&extra=data`,
        );
        expect(result).toBeNull();
      });
    });

    describe('parseShareLinkUrl conditional guards', () => {
      it('returns null when pathname does not contain /s/', () => {
        const secret = generateLinkSecret();
        const encodedSecret = encodeLinkSecret(secret);

        // Path without /s/
        const result = parseShareLinkUrl(
          `https://photos.example.com/album/123#k=${encodedSecret}`,
        );
        expect(result).toBeNull();
      });

      it('returns null when pathname has /s/ but no linkId', () => {
        const secret = generateLinkSecret();
        const encodedSecret = encodeLinkSecret(secret);

        // Path with /s/ but nothing after
        const result = parseShareLinkUrl(
          `https://photos.example.com/s/#k=${encodedSecret}`,
        );
        expect(result).toBeNull();
      });

      it('returns null when fragment is empty', () => {
        const secret = generateLinkSecret();
        const { linkId } = deriveLinkKeys(secret);
        const encodedLinkId = sodium.to_base64(
          linkId,
          sodium.base64_variants.URLSAFE_NO_PADDING,
        );

        // No fragment at all
        const result = parseShareLinkUrl(
          `https://photos.example.com/s/${encodedLinkId}`,
        );
        expect(result).toBeNull();
      });

      it('returns null when fragment has #k= but no value', () => {
        const secret = generateLinkSecret();
        const { linkId } = deriveLinkKeys(secret);
        const encodedLinkId = sodium.to_base64(
          linkId,
          sodium.base64_variants.URLSAFE_NO_PADDING,
        );

        // Fragment with #k= but empty value
        const result = parseShareLinkUrl(
          `https://photos.example.com/s/${encodedLinkId}#k=`,
        );
        expect(result).toBeNull();
      });
    });

    describe('deriveLinkKeys context strings', () => {
      it('produces different linkId and wrappingKey (verifies different contexts)', () => {
        const secret = generateLinkSecret();
        const { linkId, wrappingKey } = deriveLinkKeys(secret);

        // If contexts were the same (or empty), these would be related
        // linkId is 16 bytes, wrappingKey is 32 bytes, so they can't be equal
        // But we verify they're derived differently by checking the first 16 bytes
        const wrappingKeyPrefix = wrappingKey.subarray(0, 16);
        expect(linkId).not.toEqual(wrappingKeyPrefix);
      });

      it('produces consistent results across multiple derivations', () => {
        const secret = generateLinkSecret();

        const result1 = deriveLinkKeys(secret);
        const result2 = deriveLinkKeys(secret);

        // Same secret should produce identical results
        expect(result1.linkId).toEqual(result2.linkId);
        expect(result1.wrappingKey).toEqual(result2.wrappingKey);
      });

      it('different secrets produce completely different linkIds', () => {
        const secret1 = generateLinkSecret();
        const secret2 = generateLinkSecret();

        const keys1 = deriveLinkKeys(secret1);
        const keys2 = deriveLinkKeys(secret2);

        // Verify no overlap (kills mutation that makes context empty)
        expect(keys1.linkId).not.toEqual(keys2.linkId);
        expect(keys1.wrappingKey).not.toEqual(keys2.wrappingKey);
      });

      it('linkId derivation uses proper context (verifiable via known input)', () => {
        // Using a fixed secret to verify context string is being used
        const fixedSecret = new Uint8Array(32);
        for (let i = 0; i < 32; i++) {
          fixedSecret[i] = i;
        }

        const { linkId, wrappingKey } = deriveLinkKeys(fixedSecret);

        // With empty context, BLAKE2b would produce deterministic but different output
        // We verify the output is non-zero and has expected structure
        expect(linkId.length).toBe(16);
        expect(wrappingKey.length).toBe(32);

        // Verify they're not all zeros (which could happen with bad implementation)
        const linkIdSum = linkId.reduce((a, b) => a + b, 0);
        const wrappingKeySum = wrappingKey.reduce((a, b) => a + b, 0);
        expect(linkIdSum).toBeGreaterThan(0);
        expect(wrappingKeySum).toBeGreaterThan(0);
      });

      it('LINK_ID_CONTEXT affects linkId derivation (kills empty string mutation)', () => {
        // Using a known fixed secret to verify context affects output
        const fixedSecret = new Uint8Array(32).fill(0xab);
        const { linkId } = deriveLinkKeys(fixedSecret);

        // Manually compute what BLAKE2b would produce with empty context
        // If context is "", this would be: crypto_generichash(16, "", fixedSecret)
        // We compute directly using sodium to compare
        const emptyContextHash = sodium.crypto_generichash(
          16,
          new Uint8Array(0),
          fixedSecret,
        );

        // The actual linkId should differ because it uses non-empty context
        expect(linkId).not.toEqual(emptyContextHash);
      });

      it('LINK_WRAP_CONTEXT affects wrappingKey derivation (kills empty string mutation)', () => {
        // Using a known fixed secret to verify context affects output
        const fixedSecret = new Uint8Array(32).fill(0xcd);
        const { wrappingKey } = deriveLinkKeys(fixedSecret);

        // Manually compute what BLAKE2b would produce with empty context
        const emptyContextHash = sodium.crypto_generichash(
          32,
          new Uint8Array(0),
          fixedSecret,
        );

        // The actual wrappingKey should differ because it uses non-empty context
        expect(wrappingKey).not.toEqual(emptyContextHash);
      });
    });

    describe('wrapTierKeyForLink validation edge cases (spy-based)', () => {
      afterEach(() => {
        vi.restoreAllMocks();
      });

      it('throws before calling wrapKey when wrapping key is invalid length', () => {
        const epoch = generateEpochKey(1);
        const invalidKey = new Uint8Array(31);

        // Spy on secretbox - it should NOT be called if validation works
        const spy = vi.spyOn(sodium, 'crypto_secretbox_easy');

        expect(() =>
          wrapTierKeyForLink(epoch.thumbKey, AccessTier.THUMB, invalidKey),
        ).toThrow('Wrapping key must be 32 bytes');

        // The validation should have rejected before calling crypto
        expect(spy).not.toHaveBeenCalled();
      });
    });

    describe('parseShareLinkUrl path guard edge cases', () => {
      it('returns null when path matches /s/ but regex capture group is empty', () => {
        const secret = generateLinkSecret();
        const encodedSecret = encodeLinkSecret(secret);

        // The regex /\/s\/([A-Za-z0-9_-]+)$/ should not match when there's nothing after /s/
        // This tests the !pathMatch[1] branch specifically
        const result = parseShareLinkUrl(
          `https://photos.example.com/s/#k=${encodedSecret}`,
        );
        expect(result).toBeNull();
      });

      it('returns null when no /s/ pattern exists at all (tests !pathMatch)', () => {
        const secret = generateLinkSecret();
        const encodedSecret = encodeLinkSecret(secret);

        // No /s/ in path - pathMatch will be null
        const result = parseShareLinkUrl(
          `https://photos.example.com/album#k=${encodedSecret}`,
        );
        expect(result).toBeNull();
      });

      it('returns null for path ending with just /s (no trailing slash or id)', () => {
        const secret = generateLinkSecret();
        const encodedSecret = encodeLinkSecret(secret);

        // Path ends with /s but no / after it and no id
        const result = parseShareLinkUrl(
          `https://photos.example.com/s#k=${encodedSecret}`,
        );
        expect(result).toBeNull();
      });

      it('returns null (not throws) for invalid path - verifies early return', () => {
        const secret = generateLinkSecret();
        const encodedSecret = encodeLinkSecret(secret);

        // This should return null, not throw an error
        // If the BlockStatement is removed, it would continue and crash on decodeLinkId
        const result = parseShareLinkUrl(
          `https://photos.example.com/notshare/path#k=${encodedSecret}`,
        );
        expect(result).toBeNull();
      });

      it('gracefully returns null for path with /s/ in wrong position', () => {
        const secret = generateLinkSecret();
        const encodedSecret = encodeLinkSecret(secret);

        // /s/ exists but not at the end followed by linkId
        const result = parseShareLinkUrl(
          `https://photos.example.com/s/abc/def#k=${encodedSecret}`,
        );
        expect(result).toBeNull();
      });
    });

    describe('parseShareLinkUrl fragment guard edge cases', () => {
      it('returns null when fragment has content before k= parameter', () => {
        const secret = generateLinkSecret();
        const { linkId } = deriveLinkKeys(secret);
        const encodedLinkId = encodeLinkId(linkId);
        const encodedSecret = encodeLinkSecret(secret);

        // Fragment has #other&k=... - the ^ anchor should reject this
        const result = parseShareLinkUrl(
          `https://photos.example.com/s/${encodedLinkId}#other&k=${encodedSecret}`,
        );
        expect(result).toBeNull();
      });

      it('returns null when fragment exists but has no k= at all', () => {
        const secret = generateLinkSecret();
        const { linkId } = deriveLinkKeys(secret);
        const encodedLinkId = encodeLinkId(linkId);

        // Fragment without k= - secretMatch will be null
        const result = parseShareLinkUrl(
          `https://photos.example.com/s/${encodedLinkId}#something`,
        );
        expect(result).toBeNull();
      });

      it('returns null when fragment is just hash with no content', () => {
        const secret = generateLinkSecret();
        const { linkId } = deriveLinkKeys(secret);
        const encodedLinkId = encodeLinkId(linkId);

        // Just # with nothing after - secretMatch is null
        const result = parseShareLinkUrl(
          `https://photos.example.com/s/${encodedLinkId}#`,
        );
        expect(result).toBeNull();
      });

      it('returns null for fragment with k= but missing value (tests !secretMatch[1])', () => {
        const secret = generateLinkSecret();
        const { linkId } = deriveLinkKeys(secret);
        const encodedLinkId = encodeLinkId(linkId);

        // #k= with nothing after - the capture group is empty
        const result = parseShareLinkUrl(
          `https://photos.example.com/s/${encodedLinkId}#k=`,
        );
        expect(result).toBeNull();
      });

      it('returns null (not throws) when fragment is missing - verifies early return', () => {
        const secret = generateLinkSecret();
        const { linkId } = deriveLinkKeys(secret);
        const encodedLinkId = encodeLinkId(linkId);

        // No fragment at all - should return null, not throw
        // If the BlockStatement is removed, it would continue and crash on decodeLinkSecret
        const result = parseShareLinkUrl(
          `https://photos.example.com/s/${encodedLinkId}`,
        );
        expect(result).toBeNull();
      });

      it('returns null for fragment with wrong key name', () => {
        const secret = generateLinkSecret();
        const { linkId } = deriveLinkKeys(secret);
        const encodedLinkId = encodeLinkId(linkId);
        const encodedSecret = encodeLinkSecret(secret);

        // Uses 's=' instead of 'k='
        const result = parseShareLinkUrl(
          `https://photos.example.com/s/${encodedLinkId}#s=${encodedSecret}`,
        );
        expect(result).toBeNull();
      });

      it('rejects fragment with leading content before #k= (kills ^ anchor removal)', () => {
        const secret = generateLinkSecret();
        const { linkId } = deriveLinkKeys(secret);
        const encodedLinkId = encodeLinkId(linkId);
        const encodedSecret = encodeLinkSecret(secret);

        // Fragment has leading content: #prefix#k=...
        // Without ^ anchor, the regex would match k= anywhere
        const result = parseShareLinkUrl(
          `https://photos.example.com/s/${encodedLinkId}#prefix#k=${encodedSecret}`,
        );
        expect(result).toBeNull();
      });
    });

    describe('parseShareLinkUrl mutation-killing assertions', () => {
      afterEach(() => {
        vi.restoreAllMocks();
      });

      it('path guard at L244 prevents decodeLinkId call - from_base64 NOT called', () => {
        const secret = generateLinkSecret();
        const encodedSecret = encodeLinkSecret(secret);

        // Spy on sodium.from_base64 which is called by decodeLinkId
        const spy = vi.spyOn(sodium, 'from_base64');

        // URL with no /s/ pattern - pathMatch is null
        // If L244 check works, we return null BEFORE calling decodeLinkId
        // If L244 check is mutated to false, code tries decodeLinkId(undefined) which calls from_base64
        const result = parseShareLinkUrl(
          `https://photos.example.com/album#k=${encodedSecret}`,
        );

        expect(result).toBeNull();
        // CRITICAL: from_base64 should NOT have been called
        // If it was called, the L244 early return did not happen
        expect(spy).not.toHaveBeenCalled();
      });

      it('fragment guard at L252 prevents decodeLinkSecret call - from_base64 called once', () => {
        const secret = generateLinkSecret();
        const { linkId } = deriveLinkKeys(secret);
        const encodedLinkId = encodeLinkId(linkId);

        // Spy on sodium.from_base64
        const spy = vi.spyOn(sodium, 'from_base64');

        // Valid path but invalid fragment (no k= pattern)
        // from_base64 should be called once for linkId, but NOT for secret
        const result = parseShareLinkUrl(
          `https://photos.example.com/s/${encodedLinkId}#something`,
        );

        expect(result).toBeNull();
        // from_base64 called exactly once (for linkId only)
        // If L252 check is mutated to false, it would try decodeLinkSecret(undefined) = 2 calls
        expect(spy).toHaveBeenCalledTimes(1);
      });

      it('valid URL calls from_base64 exactly twice (linkId + secret)', () => {
        const secret = generateLinkSecret();
        const { linkId } = deriveLinkKeys(secret);
        const encodedLinkId = encodeLinkId(linkId);
        const encodedSecret = encodeLinkSecret(secret);

        const spy = vi.spyOn(sodium, 'from_base64');

        // Valid URL - should call from_base64 twice
        const result = parseShareLinkUrl(
          `https://photos.example.com/s/${encodedLinkId}#k=${encodedSecret}`,
        );

        expect(result).not.toBeNull();
        expect(spy).toHaveBeenCalledTimes(2);
      });

      it('|| to && mutation at L244 would crash on null access', () => {
        // This test verifies the short-circuit behavior of ||
        // When pathMatch is null, !pathMatch is true, || short-circuits, returns null
        // With &&, it would try to access pathMatch[1] on null = crash
        // But the crash is caught by try-catch, so we test via spy

        const secret = generateLinkSecret();
        const encodedSecret = encodeLinkSecret(secret);

        const spy = vi.spyOn(sodium, 'from_base64');

        // No /s/ in path - pathMatch will be null
        const result = parseShareLinkUrl(
          `https://photos.example.com/noshare#k=${encodedSecret}`,
        );

        expect(result).toBeNull();
        // With correct || logic, from_base64 is never called
        expect(spy).not.toHaveBeenCalled();
      });

      it('|| to && mutation at L252 would crash on null access', () => {
        const secret = generateLinkSecret();
        const { linkId } = deriveLinkKeys(secret);
        const encodedLinkId = encodeLinkId(linkId);

        const spy = vi.spyOn(sodium, 'from_base64');

        // Valid path but no k= in fragment - secretMatch will be null
        const result = parseShareLinkUrl(
          `https://photos.example.com/s/${encodedLinkId}#nok`,
        );

        expect(result).toBeNull();
        // With correct || logic, from_base64 called once for linkId only
        expect(spy).toHaveBeenCalledTimes(1);
      });

      it('BlockStatement removal at L244 would call from_base64', () => {
        const secret = generateLinkSecret();
        const encodedSecret = encodeLinkSecret(secret);

        const spy = vi.spyOn(sodium, 'from_base64');

        // Path without valid /s/{id} pattern
        const result = parseShareLinkUrl(
          `https://photos.example.com/share#k=${encodedSecret}`,
        );

        expect(result).toBeNull();
        // If BlockStatement is removed, code continues to decodeLinkId which calls from_base64
        // With proper code, we return null and from_base64 is never called
        expect(spy).not.toHaveBeenCalled();
      });

      it('BlockStatement removal at L252 would call from_base64 twice', () => {
        const secret = generateLinkSecret();
        const { linkId } = deriveLinkKeys(secret);
        const encodedLinkId = encodeLinkId(linkId);

        const spy = vi.spyOn(sodium, 'from_base64');

        // Valid path but fragment without k=
        const result = parseShareLinkUrl(
          `https://photos.example.com/s/${encodedLinkId}#nomatch`,
        );

        expect(result).toBeNull();
        // If BlockStatement is removed, code continues to decodeLinkSecret which calls from_base64
        // With proper code, from_base64 is called once (for linkId only)
        expect(spy).toHaveBeenCalledTimes(1);
      });
    });
  });
});
