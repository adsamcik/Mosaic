/**
 * Album Content Encryption Tests
 *
 * Tests for deriving content keys and encrypting/decrypting album content.
 * Content key is derived separately from shard tier keys but uses the same
 * epoch seed for cryptographic binding.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import {
  generateEpochKey,
  deriveContentKey,
  encryptContent,
  decryptContent,
} from '../src';

beforeAll(async () => {
  await sodium.ready;
});

describe('content key derivation', () => {
  it('derives 32-byte content key from epoch seed', () => {
    const epoch = generateEpochKey(1);
    const contentKey = deriveContentKey(epoch.epochSeed);

    expect(contentKey).toBeInstanceOf(Uint8Array);
    expect(contentKey.length).toBe(32);
  });

  it('derives consistent key from same seed', () => {
    const epoch = generateEpochKey(1);
    const key1 = deriveContentKey(epoch.epochSeed);
    const key2 = deriveContentKey(epoch.epochSeed);

    expect(key1).toEqual(key2);
  });

  it('derives different key from different seed', () => {
    const epoch1 = generateEpochKey(1);
    const epoch2 = generateEpochKey(2);
    const key1 = deriveContentKey(epoch1.epochSeed);
    const key2 = deriveContentKey(epoch2.epochSeed);

    expect(key1).not.toEqual(key2);
  });

  it('derives key different from tier keys', () => {
    const epoch = generateEpochKey(1);
    const contentKey = deriveContentKey(epoch.epochSeed);

    expect(contentKey).not.toEqual(epoch.thumbKey);
    expect(contentKey).not.toEqual(epoch.previewKey);
    expect(contentKey).not.toEqual(epoch.fullKey);
  });

  it('rejects invalid seed length', () => {
    const shortSeed = new Uint8Array(16);
    const longSeed = new Uint8Array(64);

    expect(() => deriveContentKey(shortSeed)).toThrow();
    expect(() => deriveContentKey(longSeed)).toThrow();
  });
});

describe('content encryption', () => {
  it('round-trips content encryption/decryption', () => {
    const epoch = generateEpochKey(1);
    const contentKey = deriveContentKey(epoch.epochSeed);

    const content = JSON.stringify({
      blocks: [
        { type: 'heading', id: 'abc', level: 1, text: 'My Album' },
        { type: 'text', id: 'def', text: 'A story about my trip.' },
      ],
    });
    const plaintext = new TextEncoder().encode(content);

    const encrypted = encryptContent(plaintext, contentKey, epoch.epochId);
    expect(encrypted.ciphertext.length).toBeGreaterThan(plaintext.length);
    expect(encrypted.nonce.length).toBe(24);

    const decrypted = decryptContent(
      encrypted.ciphertext,
      encrypted.nonce,
      contentKey,
      epoch.epochId,
    );
    expect(decrypted).toEqual(plaintext);

    const recovered = new TextDecoder().decode(decrypted);
    expect(recovered).toBe(content);
  });

  it('uses fresh nonce for each encryption', () => {
    const epoch = generateEpochKey(1);
    const contentKey = deriveContentKey(epoch.epochSeed);
    const plaintext = new TextEncoder().encode('test');

    const enc1 = encryptContent(plaintext, contentKey, epoch.epochId);
    const enc2 = encryptContent(plaintext, contentKey, epoch.epochId);

    expect(enc1.nonce).not.toEqual(enc2.nonce);
    expect(enc1.ciphertext).not.toEqual(enc2.ciphertext);
  });

  it('fails decryption with wrong key', () => {
    const epoch = generateEpochKey(1);
    const contentKey = deriveContentKey(epoch.epochSeed);
    const wrongKey = sodium.randombytes_buf(32);

    const plaintext = new TextEncoder().encode('secret content');
    const encrypted = encryptContent(plaintext, contentKey, epoch.epochId);

    expect(() =>
      decryptContent(encrypted.ciphertext, encrypted.nonce, wrongKey, epoch.epochId),
    ).toThrow();
  });

  it('fails decryption with tampered ciphertext', () => {
    const epoch = generateEpochKey(1);
    const contentKey = deriveContentKey(epoch.epochSeed);
    const plaintext = new TextEncoder().encode('secret content');

    const encrypted = encryptContent(plaintext, contentKey, epoch.epochId);

    // Tamper with ciphertext
    encrypted.ciphertext[10] ^= 0xff;

    expect(() =>
      decryptContent(encrypted.ciphertext, encrypted.nonce, contentKey, epoch.epochId),
    ).toThrow();
  });

  it('fails decryption with wrong epoch id (AAD mismatch)', () => {
    const epoch = generateEpochKey(1);
    const contentKey = deriveContentKey(epoch.epochSeed);
    const plaintext = new TextEncoder().encode('secret content');

    const encrypted = encryptContent(plaintext, contentKey, epoch.epochId);

    // Try to decrypt with different epoch ID
    expect(() =>
      decryptContent(encrypted.ciphertext, encrypted.nonce, contentKey, 999),
    ).toThrow();
  });

  it('handles empty content', () => {
    const epoch = generateEpochKey(1);
    const contentKey = deriveContentKey(epoch.epochSeed);
    const plaintext = new Uint8Array(0);

    const encrypted = encryptContent(plaintext, contentKey, epoch.epochId);
    const decrypted = decryptContent(
      encrypted.ciphertext,
      encrypted.nonce,
      contentKey,
      epoch.epochId,
    );

    expect(decrypted).toEqual(plaintext);
  });

  it('handles large content', () => {
    const epoch = generateEpochKey(1);
    const contentKey = deriveContentKey(epoch.epochSeed);
    // 100KB of content
    const plaintext = sodium.randombytes_buf(100 * 1024);

    const encrypted = encryptContent(plaintext, contentKey, epoch.epochId);
    const decrypted = decryptContent(
      encrypted.ciphertext,
      encrypted.nonce,
      contentKey,
      epoch.epochId,
    );

    expect(decrypted).toEqual(plaintext);
  });

  it('rejects invalid key length in encryptContent', () => {
    const shortKey = new Uint8Array(16);
    const plaintext = new Uint8Array([1, 2, 3]);

    expect(() => encryptContent(plaintext, shortKey, 1)).toThrow('Content key must be 32 bytes');
  });

  it('rejects invalid key length in decryptContent', () => {
    const epoch = generateEpochKey(1);
    const contentKey = deriveContentKey(epoch.epochSeed);
    const plaintext = new TextEncoder().encode('test');
    const encrypted = encryptContent(plaintext, contentKey, epoch.epochId);

    const shortKey = new Uint8Array(16);
    expect(() =>
      decryptContent(encrypted.ciphertext, encrypted.nonce, shortKey, epoch.epochId),
    ).toThrow('Content key must be 32 bytes');
  });

  it('rejects invalid nonce length in decryptContent', () => {
    const epoch = generateEpochKey(1);
    const contentKey = deriveContentKey(epoch.epochSeed);
    const plaintext = new TextEncoder().encode('test');
    const encrypted = encryptContent(plaintext, contentKey, epoch.epochId);

    const shortNonce = new Uint8Array(12);
    expect(() =>
      decryptContent(encrypted.ciphertext, shortNonce, contentKey, epoch.epochId),
    ).toThrow('Nonce must be 24 bytes');
  });
});
