/**
 * Base64 Compatibility Tests
 *
 * Verifies that the crypto library correctly handles both standard Base64
 * (what .NET produces when serializing byte[] to JSON) and URL-safe Base64
 * (what we use internally).
 *
 * This is critical for share link functionality where:
 * - Frontend sends wrapped keys as URL-safe Base64
 * - Backend stores them as byte[]
 * - Backend returns them as standard Base64 in JSON responses
 * - Frontend must decode standard Base64 in useLinkKeys hook
 */

import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { fromBase64, toBase64 } from '@mosaic/crypto';

beforeAll(async () => {
  await sodium.ready;
});

describe('Base64 format compatibility', () => {
  describe('fromBase64 handles standard Base64 from .NET backend', () => {
    it('should decode standard Base64 with padding', () => {
      // "hello" in standard Base64
      const standard = 'aGVsbG8=';
      const decoded = fromBase64(standard);
      expect(new TextDecoder().decode(decoded)).toBe('hello');
    });

    it('should decode standard Base64 with + character', () => {
      // 0xFB produces + in standard Base64
      const bytes = new Uint8Array([0xfb]);
      const standardBase64 = btoa(String.fromCharCode(...bytes));
      expect(standardBase64).toContain('+');

      const decoded = fromBase64(standardBase64);
      expect(decoded).toEqual(bytes);
    });

    it('should decode standard Base64 with / character', () => {
      // Bytes that produce / in standard Base64
      // 0xFF 0xFF produces //8= which contains /
      const bytes = new Uint8Array([0xff, 0xff]);
      const standardBase64 = btoa(String.fromCharCode(...bytes));
      expect(standardBase64).toContain('/');

      const decoded = fromBase64(standardBase64);
      expect(decoded).toEqual(bytes);
    });

    it('should decode 24-byte nonce from .NET (simulates LinkEpochKeyResponse.Nonce)', () => {
      // Simulate a real nonce that would come from the backend
      const nonce = new Uint8Array([
        0xfb, 0xef, 0xbe, 0xff, 0xff, 0xff, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04,
        0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
      ]);

      // .NET serializes byte[] to standard Base64
      const standardBase64 = btoa(String.fromCharCode(...nonce));

      const decoded = fromBase64(standardBase64);
      expect(decoded).toEqual(nonce);
      expect(decoded.length).toBe(24);
    });

    it('should decode 48-byte encrypted key from .NET (simulates LinkEpochKeyResponse.EncryptedKey)', () => {
      // Simulate a real encrypted key (32 bytes key + 16 bytes auth tag)
      const encryptedKey = new Uint8Array(48);
      for (let i = 0; i < 48; i++) {
        encryptedKey[i] = (i * 17 + 0xab) % 256; // Pseudo-random pattern
      }

      // .NET serializes byte[] to standard Base64
      const standardBase64 = btoa(String.fromCharCode(...encryptedKey));

      const decoded = fromBase64(standardBase64);
      expect(decoded).toEqual(encryptedKey);
      expect(decoded.length).toBe(48);
    });

    it('should decode 32-byte signPubkey from .NET (simulates LinkEpochKeyResponse.SignPubkey)', () => {
      // Simulate an Ed25519 public key
      const signPubkey = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        signPubkey[i] = (i * 7 + 0x3f) % 256;
      }

      // .NET serializes byte[] to standard Base64
      const standardBase64 = btoa(String.fromCharCode(...signPubkey));

      const decoded = fromBase64(standardBase64);
      expect(decoded).toEqual(signPubkey);
      expect(decoded.length).toBe(32);
    });
  });

  describe('fromBase64 handles URL-safe Base64 from frontend', () => {
    it('should decode URL-safe Base64 without padding', () => {
      const bytes = new Uint8Array([1, 2, 3, 4, 5]);
      const urlSafe = toBase64(bytes);

      // Verify it's actually URL-safe
      expect(urlSafe).not.toContain('+');
      expect(urlSafe).not.toContain('/');
      expect(urlSafe).not.toContain('=');

      const decoded = fromBase64(urlSafe);
      expect(decoded).toEqual(bytes);
    });

    it('should handle URL-safe characters - and _', () => {
      // Create data that would produce + and / in standard Base64
      const bytes = new Uint8Array([0xfb, 0xef, 0xbe, 0xff]);
      const urlSafe = toBase64(bytes);

      // URL-safe uses - and _ instead of + and /
      expect(urlSafe).toMatch(/^[A-Za-z0-9_-]+$/);

      const decoded = fromBase64(urlSafe);
      expect(decoded).toEqual(bytes);
    });
  });

  describe('round-trip compatibility', () => {
    it('should decode standard Base64 and URL-safe Base64 to same result', () => {
      const originalBytes = new Uint8Array([
        0xfb, 0xef, 0xbe, 0xff, 0x00, 0xff,
      ]);

      // Standard Base64 (what .NET produces)
      const standard = btoa(String.fromCharCode(...originalBytes));

      // URL-safe Base64 (what our frontend produces)
      const urlSafe = toBase64(originalBytes);

      // Both should decode to the same bytes
      const fromStandard = fromBase64(standard);
      const fromUrlSafe = fromBase64(urlSafe);

      expect(fromStandard).toEqual(originalBytes);
      expect(fromUrlSafe).toEqual(originalBytes);
      expect(fromStandard).toEqual(fromUrlSafe);
    });

    it('should handle the complete key response lifecycle', () => {
      // Step 1: Frontend creates wrapped key using URL-safe Base64
      const nonce = sodium.randombytes_buf(24);
      const encryptedKey = sodium.randombytes_buf(48);

      const requestPayload = {
        nonce: toBase64(nonce),
        encryptedKey: toBase64(encryptedKey),
      };

      // Step 2: Backend receives, parses (standard Base64 parser is lenient),
      // stores as bytes, then serializes back to standard Base64

      // Simulate what the backend returns (standard Base64)
      const responseNonce = btoa(String.fromCharCode(...nonce));
      const responseEncryptedKey = btoa(String.fromCharCode(...encryptedKey));

      // Step 3: Frontend receives and decodes
      const decodedNonce = fromBase64(responseNonce);
      const decodedEncryptedKey = fromBase64(responseEncryptedKey);

      // Should match original
      expect(decodedNonce).toEqual(nonce);
      expect(decodedEncryptedKey).toEqual(encryptedKey);
    });
  });

  describe('edge cases', () => {
    it('should handle empty input', () => {
      expect(fromBase64('')).toEqual(new Uint8Array(0));
    });

    it('should handle single character differences between standard and URL-safe', () => {
      // '+' in standard == '-' in URL-safe
      // '/' in standard == '_' in URL-safe

      // Test case that produces a single +
      const withPlus = new Uint8Array([0xfb]);
      const standardWithPlus = btoa(String.fromCharCode(...withPlus));
      expect(standardWithPlus).toBe('+w==');

      const urlSafeWithMinus = toBase64(withPlus);
      expect(urlSafeWithMinus).toBe('-w');

      // Both should decode to same result
      expect(fromBase64('+w==')).toEqual(withPlus);
      expect(fromBase64('-w')).toEqual(withPlus);
    });
  });
});
