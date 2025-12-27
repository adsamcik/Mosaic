import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { concat, constantTimeEqual, sha256, sha256Sync, memzero, randomBytes, toBase64, fromBase64, toBytes, fromBytes } from '../src/utils';

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
      expect(concat(new Uint8Array([1]), new Uint8Array(0))).toEqual(new Uint8Array([1]));
    });
  });

  describe('constantTimeEqual', () => {
    it('returns true for equal arrays', () => {
      const a = new Uint8Array([1, 2, 3]);
      const b = new Uint8Array([1, 2, 3]);
      expect(constantTimeEqual(a, b)).toBe(true);
    });

    it('returns false for different arrays', () => {
      expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    });

    it('returns false for different lengths', () => {
      expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
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
  });
});
