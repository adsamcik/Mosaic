/**
 * Mosaic Crypto Library - Epochs Module
 *
 * Epoch key management for album encryption.
 * Each epoch has a ReadKey (symmetric) and SignKeypair (Ed25519).
 */

import sodium from 'libsodium-wrappers';
import { KEY_SIZE, type EpochKey } from './types';
import { randomBytes } from './utils';
import { wrapKey, unwrapKey } from './keybox';

/**
 * Generate a new epoch key set.
 * Creates a random read key and Ed25519 signing keypair.
 *
 * @param epochId - Epoch identifier (increments on key rotation)
 * @returns New epoch key with ReadKey and SignKeypair
 */
export function generateEpochKey(epochId: number): EpochKey {
  // Generate random read key for content encryption
  const readKey = randomBytes(KEY_SIZE);

  // Generate Ed25519 keypair for manifest signing
  const signKeypair = sodium.crypto_sign_keypair();

  return {
    epochId,
    readKey,
    signKeypair: {
      publicKey: signKeypair.publicKey,
      secretKey: signKeypair.privateKey,
    },
  };
}

/**
 * Serialize epoch key for storage/transmission.
 * Does NOT include the secret key - only public components.
 *
 * @param epochKey - Epoch key to serialize
 * @returns JSON-safe object (public info only)
 */
export function serializeEpochKeyPublic(epochKey: EpochKey): {
  epochId: number;
  signPublicKey: string;
} {
  return {
    epochId: epochKey.epochId,
    signPublicKey: sodium.to_base64(
      epochKey.signKeypair.publicKey,
      sodium.base64_variants.URLSAFE_NO_PADDING
    ),
  };
}

/**
 * Wrap epoch key for secure storage.
 * Encrypts both readKey and signKeypair.secretKey.
 *
 * Format: wrappedReadKey || wrappedSignSecret
 *
 * @param epochKey - Epoch key to wrap
 * @param wrapper - Wrapping key (32 bytes)
 * @returns Wrapped epoch key data
 */
export function wrapEpochKey(
  epochKey: EpochKey,
  wrapper: Uint8Array
): {
  epochId: number;
  signPublicKey: Uint8Array;
  wrapped: Uint8Array;
} {
  // Wrap the read key
  const wrappedReadKey = wrapKey(epochKey.readKey, wrapper);

  // Wrap the signing secret key
  const wrappedSignSecret = wrapKey(epochKey.signKeypair.secretKey, wrapper);

  // Combine: length(2) || wrappedReadKey || wrappedSignSecret
  const wrapped = new Uint8Array(2 + wrappedReadKey.length + wrappedSignSecret.length);
  const view = new DataView(wrapped.buffer);
  view.setUint16(0, wrappedReadKey.length, true);
  wrapped.set(wrappedReadKey, 2);
  wrapped.set(wrappedSignSecret, 2 + wrappedReadKey.length);

  return {
    epochId: epochKey.epochId,
    signPublicKey: epochKey.signKeypair.publicKey,
    wrapped,
  };
}

/**
 * Unwrap epoch key from storage.
 *
 * @param epochId - Epoch identifier
 * @param signPublicKey - Ed25519 signing public key
 * @param wrapped - Wrapped key data
 * @param wrapper - Wrapping key (32 bytes)
 * @returns Unwrapped epoch key
 */
export function unwrapEpochKey(
  epochId: number,
  signPublicKey: Uint8Array,
  wrapped: Uint8Array,
  wrapper: Uint8Array
): EpochKey {
  const view = new DataView(wrapped.buffer, wrapped.byteOffset);
  const readKeyLen = view.getUint16(0, true);

  const wrappedReadKey = wrapped.slice(2, 2 + readKeyLen);
  const wrappedSignSecret = wrapped.slice(2 + readKeyLen);

  const readKey = unwrapKey(wrappedReadKey, wrapper);
  const signSecretKey = unwrapKey(wrappedSignSecret, wrapper);

  return {
    epochId,
    readKey,
    signKeypair: {
      publicKey: signPublicKey,
      secretKey: signSecretKey,
    },
  };
}

/**
 * Create the next epoch key (for key rotation).
 * Increments epochId from current epoch.
 *
 * @param currentEpoch - Current epoch key
 * @returns New epoch key with incremented epochId
 */
export function rotateEpochKey(currentEpoch: EpochKey): EpochKey {
  return generateEpochKey(currentEpoch.epochId + 1);
}

/**
 * Validate epoch key structure.
 *
 * @param epochKey - Epoch key to validate
 * @returns true if valid
 */
export function isValidEpochKey(epochKey: EpochKey): boolean {
  if (typeof epochKey.epochId !== 'number' || epochKey.epochId < 0) {
    return false;
  }

  if (epochKey.readKey.length !== KEY_SIZE) {
    return false;
  }

  if (epochKey.signKeypair.publicKey.length !== 32) {
    return false;
  }

  if (epochKey.signKeypair.secretKey.length !== 64) {
    return false;
  }

  return true;
}
