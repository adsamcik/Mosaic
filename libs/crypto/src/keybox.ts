/**
 * Mosaic Crypto Library - Keybox Module
 *
 * Key wrapping and unwrapping using XChaCha20-Poly1305.
 * Used for encrypting keys with other keys.
 */

import sodium from 'libsodium-wrappers-sumo';
import {
  CryptoError,
  CryptoErrorCode,
  KEY_SIZE,
  NONCE_SIZE,
  TAG_SIZE,
} from './types';

/** Minimum wrapped key length: nonce (24) + tag (16) + at least 1 byte */
const MIN_WRAPPED_LENGTH = NONCE_SIZE + TAG_SIZE + 1;

/**
 * Wrap (encrypt) a key with another key.
 * Uses XChaCha20-Poly1305 with a random 24-byte nonce.
 *
 * Output format: nonce (24 bytes) || ciphertext || tag (16 bytes)
 *
 * @param key - Key to wrap (any length)
 * @param wrapper - Wrapping key (32 bytes)
 * @returns Wrapped key bytes
 * @throws CryptoError if wrapper key is not 32 bytes
 */
export function wrapKey(key: Uint8Array, wrapper: Uint8Array): Uint8Array {
  if (wrapper.length !== KEY_SIZE) {
    throw new CryptoError(
      `Wrapper key must be ${KEY_SIZE} bytes, got ${wrapper.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH,
    );
  }

  // Generate fresh random nonce - CRITICAL for security
  const nonce = sodium.randombytes_buf(NONCE_SIZE);

  // Encrypt with XChaCha20-Poly1305 (secretbox uses this internally)
  const ciphertext = sodium.crypto_secretbox_easy(key, nonce, wrapper);

  // Prepend nonce to ciphertext
  const result = new Uint8Array(NONCE_SIZE + ciphertext.length);
  result.set(nonce, 0);
  result.set(ciphertext, NONCE_SIZE);

  return result;
}

/**
 * Unwrap (decrypt) a wrapped key.
 *
 * @param wrapped - Wrapped key from wrapKey()
 * @param wrapper - Wrapping key (32 bytes)
 * @returns Unwrapped key bytes
 * @throws CryptoError if decryption fails or inputs are invalid
 */
export function unwrapKey(
  wrapped: Uint8Array,
  wrapper: Uint8Array,
): Uint8Array {
  if (wrapper.length !== KEY_SIZE) {
    throw new CryptoError(
      `Wrapper key must be ${KEY_SIZE} bytes, got ${wrapper.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH,
    );
  }

  if (wrapped.length < MIN_WRAPPED_LENGTH) {
    throw new CryptoError(
      `Wrapped key too short: ${wrapped.length} bytes, minimum ${MIN_WRAPPED_LENGTH}`,
      CryptoErrorCode.DECRYPTION_FAILED,
    );
  }

  const nonce = wrapped.slice(0, NONCE_SIZE);
  const ciphertext = wrapped.slice(NONCE_SIZE);

  try {
    const plaintext = sodium.crypto_secretbox_open_easy(
      ciphertext,
      nonce,
      wrapper,
    );
    return plaintext;
  } catch (error) {
    throw new CryptoError(
      'Failed to unwrap key - authentication failed',
      CryptoErrorCode.DECRYPTION_FAILED,
      error,
    );
  }
}

/**
 * Wrap a 32-byte symmetric key with another 32-byte key.
 * Convenience function that validates both keys are 32 bytes.
 *
 * @param key - Key to wrap (32 bytes)
 * @param wrapper - Wrapping key (32 bytes)
 * @returns Wrapped key bytes
 */
export function wrapSymmetricKey(
  key: Uint8Array,
  wrapper: Uint8Array,
): Uint8Array {
  if (key.length !== KEY_SIZE) {
    throw new CryptoError(
      `Key must be ${KEY_SIZE} bytes, got ${key.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH,
    );
  }
  return wrapKey(key, wrapper);
}

/**
 * Unwrap a 32-byte symmetric key.
 * Convenience function that validates the unwrapped key is 32 bytes.
 *
 * @param wrapped - Wrapped key
 * @param wrapper - Wrapping key (32 bytes)
 * @returns Unwrapped key (32 bytes)
 */
export function unwrapSymmetricKey(
  wrapped: Uint8Array,
  wrapper: Uint8Array,
): Uint8Array {
  const key = unwrapKey(wrapped, wrapper);
  if (key.length !== KEY_SIZE) {
    throw new CryptoError(
      `Unwrapped key expected to be ${KEY_SIZE} bytes, got ${key.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH,
    );
  }
  return key;
}
