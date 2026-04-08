/**
 * Mosaic Crypto Library - Content Module
 *
 * Implements encryption/decryption for album content (blocks, text, metadata).
 * Uses XChaCha20-Poly1305 AEAD with epochId as additional authenticated data.
 */

import sodium from 'libsodium-wrappers-sumo';
import { CryptoError, CryptoErrorCode, KEY_SIZE, NONCE_SIZE } from './types';

/**
 * Result of content encryption.
 */
export interface EncryptedContent {
  /** 24-byte random nonce */
  nonce: Uint8Array;
  /** Ciphertext including 16-byte Poly1305 auth tag */
  ciphertext: Uint8Array;
}

/**
 * Build AAD (Additional Authenticated Data) for content encryption.
 * Binds the ciphertext to the epoch to prevent cross-epoch replay.
 *
 * @param epochId - Epoch identifier
 * @returns AAD bytes
 */
function buildContentAAD(epochId: number): Uint8Array {
  const aad = new Uint8Array(8);
  const view = new DataView(aad.buffer);
  // Magic prefix for content
  aad[0] = 0x4d; // 'M'
  aad[1] = 0x43; // 'C'
  aad[2] = 0x01; // version
  aad[3] = 0x00; // reserved
  // EpochId (4 bytes, little-endian)
  view.setUint32(4, epochId, true);
  return aad;
}

/**
 * Encrypt album content with XChaCha20-Poly1305.
 *
 * Uses epochId as additional authenticated data (AAD) to bind the
 * ciphertext to a specific epoch. This prevents replay attacks where
 * old encrypted content is substituted after key rotation.
 *
 * @param plaintext - Content to encrypt
 * @param contentKey - 32-byte encryption key from deriveContentKey
 * @param epochId - Epoch identifier for AAD binding
 * @returns Encrypted content with nonce
 */
export function encryptContent(
  plaintext: Uint8Array,
  contentKey: Uint8Array,
  epochId: number,
): EncryptedContent {
  if (contentKey.length !== KEY_SIZE) {
    throw new CryptoError(
      `Content key must be ${KEY_SIZE} bytes, got ${contentKey.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH,
    );
  }

  // CRITICAL: Always use fresh random nonce
  const nonce = sodium.randombytes_buf(NONCE_SIZE);

  // Build AAD with epochId for replay protection
  const aad = buildContentAAD(epochId);

  // Encrypt with XChaCha20-Poly1305
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    aad,
    null, // no secret nonce
    nonce,
    contentKey,
  );

  return { nonce, ciphertext };
}

/**
 * Decrypt album content with XChaCha20-Poly1305.
 *
 * Verifies the AAD (epochId binding) and returns plaintext.
 *
 * @param ciphertext - Encrypted content including auth tag
 * @param nonce - 24-byte nonce from encryption
 * @param contentKey - 32-byte decryption key from deriveContentKey
 * @param epochId - Expected epoch identifier (must match encryption)
 * @returns Decrypted plaintext
 * @throws CryptoError if decryption fails (wrong key, tampered, wrong epoch)
 */
export function decryptContent(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  contentKey: Uint8Array,
  epochId: number,
): Uint8Array {
  if (contentKey.length !== KEY_SIZE) {
    throw new CryptoError(
      `Content key must be ${KEY_SIZE} bytes, got ${contentKey.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH,
    );
  }

  if (nonce.length !== NONCE_SIZE) {
    throw new CryptoError(
      `Nonce must be ${NONCE_SIZE} bytes, got ${nonce.length}`,
      CryptoErrorCode.INVALID_INPUT,
    );
  }

  // Build AAD with expected epochId
  const aad = buildContentAAD(epochId);

  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null, // no secret nonce
      ciphertext,
      aad,
      nonce,
      contentKey,
    );
  } catch (error) {
    throw new CryptoError(
      'Content decryption failed: authentication failed',
      CryptoErrorCode.DECRYPTION_FAILED,
      error,
    );
  }
}
