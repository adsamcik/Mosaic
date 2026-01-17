import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import {
  concat,
  constantTimeEqual,
  sha256,
  sha256Sync,
  memzero,
  randomBytes,
  toBase64,
  fromBase64,
  toBytes,
  fromBytes,
} from '../src/utils';

beforeAll(async () => {
  await sodium.ready;
});

describe('utils', () => {
  describe('concat', () => {
    it('concatenates multiple arrays', () => {
      const a = new Uint8Array([1, 2]);
      const b = new Uint8Array([3, 4, 5]);
      const c = new Uint8Array([6]);
      expect(concat(a, b, c)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    });

    it('handles empty arrays', () => {
      expect(concat()).toEqual(new Uint8Array(0));
      expect(concat(new Uint8Array([1]), new Uint8Array(0))).toEqual(
        new Uint8Array([1]),
      );
    });
  });

  describe('constantTimeEqual', () => {
    it('returns true for equal arrays', () => {
      const a = new Uint8Array([1, 2, 3]);
      const b = new Uint8Array([1, 2, 3]);
      expect(constantTimeEqual(a, b)).toBe(true);
    });

    it('returns false for different arrays', () => {
      expect(
        constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])),
      ).toBe(false);
    });

    it('returns false for different lengths', () => {
      expect(
        constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])),
      ).toBe(false);
    });
  });

  describe('sha256', () => {
    it('produces consistent hashes', async () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const hash1 = await sha256(data);
      const hash2 = await sha256(data);
      expect(hash1).toBe(hash2);
    });

    it('produces different hashes for different data', async () => {
      const hash1 = await sha256(new Uint8Array([1, 2, 3]));
      const hash2 = await sha256(new Uint8Array([1, 2, 4]));
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('sha256Sync', () => {
    it('produces consistent hashes', () => {
      const data = new Uint8Array([1, 2, 3]);
      expect(sha256Sync(data)).toBe(sha256Sync(data));
    });

    it('returns a non-empty base64url string', () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const hash = sha256Sync(data);
      // Must be a non-empty string
      expect(typeof hash).toBe('string');
      expect(hash.length).toBeGreaterThan(0);
      // SHA256 produces 32 bytes = 43 base64url chars (no padding)
      expect(hash.length).toBe(43);
      // Verify it's valid base64url (no + or / or =)
      expect(hash).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('produces different hashes for different data', () => {
      const hash1 = sha256Sync(new Uint8Array([1, 2, 3]));
      const hash2 = sha256Sync(new Uint8Array([1, 2, 4]));
      expect(hash1).not.toBe(hash2);
    });

    it('handles empty input', () => {
      const hash = sha256Sync(new Uint8Array(0));
      expect(typeof hash).toBe('string');
      expect(hash.length).toBe(43);
    });
  });

  describe('randomBytes', () => {
    it('generates bytes of correct length', () => {
      expect(randomBytes(16).length).toBe(16);
      expect(randomBytes(32).length).toBe(32);
    });

    it('generates different values each time', () => {
      const a = randomBytes(32);
      const b = randomBytes(32);
      expect(constantTimeEqual(a, b)).toBe(false);
    });
  });

  describe('base64 round-trip', () => {
    it('encodes and decodes correctly', () => {
      const original = randomBytes(32);
      const encoded = toBase64(original);
      const decoded = fromBase64(encoded);
      expect(decoded).toEqual(original);
    });

    it('toBase64 produces URL-safe encoding without padding', () => {
      // Use data that would produce + and / in standard Base64
      // 0xFB 0xFF produces /w== in standard Base64
      const data = new Uint8Array([0xfb, 0xff]);
      const encoded = toBase64(data);
      // Should not contain standard Base64 characters
      expect(encoded).not.toContain('+');
      expect(encoded).not.toContain('/');
      expect(encoded).not.toContain('=');
      // Should use URL-safe characters
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('fromBase64 decodes URL-safe Base64 without padding', () => {
      // URL-safe encoded "hello"
      const urlSafe = 'aGVsbG8';
      const decoded = fromBase64(urlSafe);
      expect(new TextDecoder().decode(decoded)).toBe('hello');
    });

    it('fromBase64 decodes standard Base64 with padding', () => {
      // Standard Base64 encoded "hello" (with padding)
      const standard = 'aGVsbG8=';
      const decoded = fromBase64(standard);
      expect(new TextDecoder().decode(decoded)).toBe('hello');
    });

    it('fromBase64 handles standard Base64 with + and / characters', () => {
      // This is key: when .NET serializes byte[] to JSON, it uses standard Base64
      // which includes + and / characters instead of - and _
      // "0xFB 0xEF 0xBE" would encode to ++++ in standard Base64 (with special chars)

      // Test data that produces + in standard Base64
      // 0xFB -> standard: +w==, urlsafe: -w
      const standardWithPlus = '+w==';
      const urlSafeEquiv = '-w';

      // Both should decode to the same bytes
      const decodedStandard = fromBase64(standardWithPlus);
      const decodedUrlSafe = fromBase64(urlSafeEquiv);
      expect(decodedStandard).toEqual(decodedUrlSafe);
    });

    it('fromBase64 handles standard Base64 with / character', () => {
      // Test data that produces / in standard Base64
      // Base64 "/" maps to "_" in URL-safe
      const standardWithSlash = '/w==';
      const urlSafeEquiv = '_w';

      const decodedStandard = fromBase64(standardWithSlash);
      const decodedUrlSafe = fromBase64(urlSafeEquiv);
      expect(decodedStandard).toEqual(decodedUrlSafe);
    });

    it('fromBase64 handles mixed content from .NET backend', () => {
      // Simulate what comes from .NET backend for a nonce (24 bytes)
      // Generate known test data that would have +, /, and = in standard Base64
      const testBytes = new Uint8Array([
        0xfb, 0xef, 0xbe, 0xff, 0xff, 0xff, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04,
        0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
      ]);

      // Encode using standard Base64 (what .NET would produce)
      const standardBase64 = btoa(String.fromCharCode(...testBytes));

      // This should decode correctly even with standard Base64
      const decoded = fromBase64(standardBase64);
      expect(decoded).toEqual(testBytes);
    });
  });

  describe('memzero', () => {
    it('zeros buffer contents', () => {
      const buf = new Uint8Array([1, 2, 3, 4]);
      memzero(buf);
      expect(buf).toEqual(new Uint8Array([0, 0, 0, 0]));
    });
  });

  describe('toBytes and fromBytes', () => {
    it('converts string to bytes and back', () => {
      const original = 'Hello, World! 🌍';
      const bytes = toBytes(original);
      const restored = fromBytes(bytes);
      expect(restored).toBe(original);
    });

    it('handles empty string', () => {
      const empty = '';
      const bytes = toBytes(empty);
      expect(bytes.length).toBe(0);
      expect(fromBytes(bytes)).toBe(empty);
    });

    it('handles unicode characters', () => {
      const unicode = '日本語テスト';
      const bytes = toBytes(unicode);
      expect(fromBytes(bytes)).toBe(unicode);
    });

    it('fromBytes decodes known UTF-8 byte sequence', () => {
      // "Hello" in UTF-8 bytes
      const helloBytes = new Uint8Array([72, 101, 108, 108, 111]);
      const result = fromBytes(helloBytes);
      expect(result).toBe('Hello');
      expect(typeof result).toBe('string');
      expect(result.length).toBe(5);
    });

    it('fromBytes handles multi-byte UTF-8 sequences', () => {
      // "é" is 0xC3 0xA9 in UTF-8
      const accentBytes = new Uint8Array([0xc3, 0xa9]);
      expect(fromBytes(accentBytes)).toBe('é');

      // "€" is 0xE2 0x82 0xAC in UTF-8
      const euroBytes = new Uint8Array([0xe2, 0x82, 0xac]);
      expect(fromBytes(euroBytes)).toBe('€');
    });

    it('fromBytes is the inverse of toBytes', () => {
      const testStrings = ['', 'a', 'abc', 'Hello World', '日本語', '🎉🎊🎁'];
      for (const str of testStrings) {
        expect(fromBytes(toBytes(str))).toBe(str);
      }
    });
  });
});
