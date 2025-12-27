/**
 * Salt Synchronization Tests
 *
 * Tests for multi-device salt synchronization functionality.
 * Verifies that encrypted salt can be synced between devices via server.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { encryptSalt, decryptSalt, SaltDecryptionError } from '../src/lib/session';
import { toBase64, fromBase64 } from '../src/lib/api';

describe('Salt Encryption/Decryption', () => {
  const testPassword = 'test-password-123';
  const testUsername = 'testuser@example.com';
  const testSalt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

  describe('encryptSalt', () => {
    it('returns base64-encoded encrypted salt and nonce', async () => {
      const result = await encryptSalt(testSalt, testPassword, testUsername);

      expect(result.encryptedSalt).toBeDefined();
      expect(result.saltNonce).toBeDefined();

      // Verify base64 encoding is valid
      expect(() => fromBase64(result.encryptedSalt)).not.toThrow();
      expect(() => fromBase64(result.saltNonce)).not.toThrow();
    });

    it('produces nonce of correct length (12 bytes for AES-GCM)', async () => {
      const result = await encryptSalt(testSalt, testPassword, testUsername);
      const nonce = fromBase64(result.saltNonce);

      expect(nonce.length).toBe(12);
    });

    it('produces encrypted salt with auth tag (16 bytes + plaintext size)', async () => {
      const result = await encryptSalt(testSalt, testPassword, testUsername);
      const encrypted = fromBase64(result.encryptedSalt);

      // AES-GCM adds 16-byte auth tag
      expect(encrypted.length).toBe(testSalt.length + 16);
    });

    it('produces different ciphertext each time due to random nonce', async () => {
      const result1 = await encryptSalt(testSalt, testPassword, testUsername);
      const result2 = await encryptSalt(testSalt, testPassword, testUsername);

      expect(result1.encryptedSalt).not.toBe(result2.encryptedSalt);
      expect(result1.saltNonce).not.toBe(result2.saltNonce);
    });

    it('produces different ciphertext for different passwords', async () => {
      const result1 = await encryptSalt(testSalt, 'password1', testUsername);
      const result2 = await encryptSalt(testSalt, 'password2', testUsername);

      expect(result1.encryptedSalt).not.toBe(result2.encryptedSalt);
    });

    it('produces different ciphertext for different usernames', async () => {
      const result1 = await encryptSalt(testSalt, testPassword, 'user1');
      const result2 = await encryptSalt(testSalt, testPassword, 'user2');

      expect(result1.encryptedSalt).not.toBe(result2.encryptedSalt);
    });
  });

  describe('decryptSalt', () => {
    it('decrypts salt encrypted with same password and username', async () => {
      const { encryptedSalt, saltNonce } = await encryptSalt(testSalt, testPassword, testUsername);
      const decrypted = await decryptSalt(encryptedSalt, saltNonce, testPassword, testUsername);

      expect(decrypted).toEqual(testSalt);
    });

    it('throws SaltDecryptionError for wrong password', async () => {
      const { encryptedSalt, saltNonce } = await encryptSalt(testSalt, testPassword, testUsername);

      await expect(
        decryptSalt(encryptedSalt, saltNonce, 'wrong-password', testUsername)
      ).rejects.toThrow(SaltDecryptionError);
    });

    it('throws SaltDecryptionError for wrong username', async () => {
      const { encryptedSalt, saltNonce } = await encryptSalt(testSalt, testPassword, testUsername);

      await expect(
        decryptSalt(encryptedSalt, saltNonce, testPassword, 'wrong-username')
      ).rejects.toThrow(SaltDecryptionError);
    });

    it('throws SaltDecryptionError for corrupted ciphertext', async () => {
      const { encryptedSalt, saltNonce } = await encryptSalt(testSalt, testPassword, testUsername);

      // Corrupt the ciphertext
      const corrupted = fromBase64(encryptedSalt);
      corrupted[0] ^= 0xff;
      const corruptedBase64 = toBase64(corrupted);

      await expect(
        decryptSalt(corruptedBase64, saltNonce, testPassword, testUsername)
      ).rejects.toThrow(SaltDecryptionError);
    });

    it('throws SaltDecryptionError for corrupted nonce', async () => {
      const { encryptedSalt, saltNonce } = await encryptSalt(testSalt, testPassword, testUsername);

      // Corrupt the nonce
      const corrupted = fromBase64(saltNonce);
      corrupted[0] ^= 0xff;
      const corruptedBase64 = toBase64(corrupted);

      await expect(
        decryptSalt(encryptedSalt, corruptedBase64, testPassword, testUsername)
      ).rejects.toThrow(SaltDecryptionError);
    });
  });

  describe('round-trip encryption', () => {
    it('handles empty password', async () => {
      const { encryptedSalt, saltNonce } = await encryptSalt(testSalt, '', testUsername);
      const decrypted = await decryptSalt(encryptedSalt, saltNonce, '', testUsername);

      expect(decrypted).toEqual(testSalt);
    });

    it('handles empty username', async () => {
      const { encryptedSalt, saltNonce } = await encryptSalt(testSalt, testPassword, '');
      const decrypted = await decryptSalt(encryptedSalt, saltNonce, testPassword, '');

      expect(decrypted).toEqual(testSalt);
    });

    it('handles unicode password', async () => {
      const unicodePassword = 'пароль-密码-🔐';
      const { encryptedSalt, saltNonce } = await encryptSalt(testSalt, unicodePassword, testUsername);
      const decrypted = await decryptSalt(encryptedSalt, saltNonce, unicodePassword, testUsername);

      expect(decrypted).toEqual(testSalt);
    });

    it('handles unicode username', async () => {
      const unicodeUsername = 'utilisateur@例え.com';
      const { encryptedSalt, saltNonce } = await encryptSalt(testSalt, testPassword, unicodeUsername);
      const decrypted = await decryptSalt(encryptedSalt, saltNonce, testPassword, unicodeUsername);

      expect(decrypted).toEqual(testSalt);
    });

    it('handles very long password', async () => {
      const longPassword = 'a'.repeat(10000);
      const { encryptedSalt, saltNonce } = await encryptSalt(testSalt, longPassword, testUsername);
      const decrypted = await decryptSalt(encryptedSalt, saltNonce, longPassword, testUsername);

      expect(decrypted).toEqual(testSalt);
    });

    it('handles various salt sizes', async () => {
      const sizes = [8, 16, 24, 32, 64, 128];

      for (const size of sizes) {
        const salt = new Uint8Array(size);
        crypto.getRandomValues(salt);

        const { encryptedSalt, saltNonce } = await encryptSalt(salt, testPassword, testUsername);
        const decrypted = await decryptSalt(encryptedSalt, saltNonce, testPassword, testUsername);

        expect(decrypted).toEqual(salt);
      }
    });
  });
});

describe('SaltDecryptionError', () => {
  it('has correct name', () => {
    const error = new SaltDecryptionError();
    expect(error.name).toBe('SaltDecryptionError');
  });

  it('has default message', () => {
    const error = new SaltDecryptionError();
    expect(error.message).toBe('Failed to decrypt salt - incorrect password');
  });

  it('accepts custom message', () => {
    const error = new SaltDecryptionError('Custom error message');
    expect(error.message).toBe('Custom error message');
  });

  it('is instanceof Error', () => {
    const error = new SaltDecryptionError();
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(SaltDecryptionError);
  });
});

describe('Multi-device salt sync simulation', () => {
  it('simulates new device syncing salt from server', async () => {
    const password = 'user-password';
    const username = 'user@example.com';
    const originalSalt = crypto.getRandomValues(new Uint8Array(16));

    // Device 1: Generate salt and encrypt for server storage
    const { encryptedSalt, saltNonce } = await encryptSalt(originalSalt, password, username);

    // Simulate server storage (base64 strings)
    const serverStoredSalt = encryptedSalt;
    const serverStoredNonce = saltNonce;

    // Device 2: Download and decrypt salt from server
    const decryptedSalt = await decryptSalt(
      serverStoredSalt,
      serverStoredNonce,
      password,
      username
    );

    // Both devices should have identical salt
    expect(decryptedSalt).toEqual(originalSalt);
  });

  it('simulates wrong password on new device', async () => {
    const password = 'correct-password';
    const wrongPassword = 'wrong-password';
    const username = 'user@example.com';
    const originalSalt = crypto.getRandomValues(new Uint8Array(16));

    // Device 1: Encrypt salt with correct password
    const { encryptedSalt, saltNonce } = await encryptSalt(originalSalt, password, username);

    // Device 2: Try to decrypt with wrong password
    await expect(
      decryptSalt(encryptedSalt, saltNonce, wrongPassword, username)
    ).rejects.toThrow(SaltDecryptionError);
  });

  it('simulates different users cannot access each others salt', async () => {
    const password = 'shared-password';  // Even if password is same
    const user1 = 'alice@example.com';
    const user2 = 'bob@example.com';
    const salt1 = crypto.getRandomValues(new Uint8Array(16));

    // Alice encrypts her salt
    const { encryptedSalt, saltNonce } = await encryptSalt(salt1, password, user1);

    // Bob cannot decrypt Alice's salt (even with same password)
    await expect(
      decryptSalt(encryptedSalt, saltNonce, password, user2)
    ).rejects.toThrow(SaltDecryptionError);
  });
});
