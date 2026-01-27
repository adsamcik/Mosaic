/**
 * Mosaic Crypto Library - Epochs Module
 *
 * Epoch key management for album encryption.
 * Each epoch has tiered keys (thumb, preview, full) derived via HKDF
 * and a SignKeypair (Ed25519) for manifest signing.
 */

import sodium from 'libsodium-wrappers-sumo';
import { CryptoError, CryptoErrorCode, KEY_SIZE, ShardTier, type EpochKey } from './types';
import { randomBytes, toBytes } from './utils';
import { wrapKey, unwrapKey } from './keybox';

/** HKDF context for thumb tier key derivation */
const THUMB_KEY_CONTEXT = toBytes('mosaic:tier:thumb:v1');
/** HKDF context for preview tier key derivation */
const PREVIEW_KEY_CONTEXT = toBytes('mosaic:tier:preview:v1');
/** HKDF context for full tier key derivation */
const FULL_KEY_CONTEXT = toBytes('mosaic:tier:full:v1');

/**
 * Derive a tier key from epoch seed using HKDF-style BLAKE2b.
 *
 * @param epochSeed - 32-byte master seed
 * @param context - Domain separation context
 * @returns 32-byte derived tier key
 */
function deriveTierKey(epochSeed: Uint8Array, context: Uint8Array): Uint8Array {
  return sodium.crypto_generichash(KEY_SIZE, context, epochSeed);
}

/**
 * Derive all tier keys from an epoch seed.
 *
 * @param epochSeed - 32-byte master seed
 * @returns Object with thumbKey, previewKey, fullKey
 */
export function deriveTierKeys(epochSeed: Uint8Array): {
  thumbKey: Uint8Array;
  previewKey: Uint8Array;
  fullKey: Uint8Array;
} {
  if (epochSeed.length !== KEY_SIZE) {
    throw new CryptoError(
      `Epoch seed must be ${KEY_SIZE} bytes, got ${epochSeed.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH,
    );
  }
  return {
    thumbKey: deriveTierKey(epochSeed, THUMB_KEY_CONTEXT),
    previewKey: deriveTierKey(epochSeed, PREVIEW_KEY_CONTEXT),
    fullKey: deriveTierKey(epochSeed, FULL_KEY_CONTEXT),
  };
}

/**
 * Get the appropriate tier key for a given shard tier.
 *
 * @param epochKey - Epoch key with all tier keys
 * @param tier - Shard tier to get key for
 * @returns The tier-specific encryption key
 */
export function getTierKey(epochKey: EpochKey, tier: ShardTier): Uint8Array {
  switch (tier) {
    case 1: // THUMB
      return epochKey.thumbKey;
    case 2: // PREVIEW
      return epochKey.previewKey;
    case 3: // ORIGINAL
      return epochKey.fullKey;
    default:
      throw new CryptoError(`Invalid shard tier: ${tier}`, CryptoErrorCode.INVALID_INPUT);
  }
}

/**
 * Generate a new epoch key set with tiered keys.
 * Creates a random seed, derives tier keys, and generates Ed25519 signing keypair.
 *
 * @param epochId - Epoch identifier (increments on key rotation)
 * @returns New epoch key with tiered keys and SignKeypair
 */
export function generateEpochKey(epochId: number): EpochKey {
  // Generate random seed for deriving tier keys
  const epochSeed = randomBytes(KEY_SIZE);

  // Derive tier keys via HKDF
  const { thumbKey, previewKey, fullKey } = deriveTierKeys(epochSeed);

  // Generate Ed25519 keypair for manifest signing
  const signKeypair = sodium.crypto_sign_keypair();

  return {
    epochId,
    epochSeed,
    thumbKey,
    previewKey,
    fullKey,
    signKeypair: {
      publicKey: signKeypair.publicKey,
      secretKey: signKeypair.privateKey,
    },
  };
}

/**
 * Serialize epoch key for storage/transmission.
 * Does NOT include secret keys - only public components.
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
      sodium.base64_variants.URLSAFE_NO_PADDING,
    ),
  };
}

/**
 * Wrap epoch key for secure storage.
 * Encrypts epochSeed and signKeypair.secretKey.
 * Tier keys can be re-derived from epochSeed when unwrapped.
 *
 * Format: length(2) || wrappedSeed || wrappedSignSecret
 *
 * @param epochKey - Epoch key to wrap
 * @param wrapper - Wrapping key (32 bytes)
 * @returns Wrapped epoch key data
 */
export function wrapEpochKey(
  epochKey: EpochKey,
  wrapper: Uint8Array,
): {
  epochId: number;
  signPublicKey: Uint8Array;
  wrapped: Uint8Array;
} {
  // Wrap the epoch seed (tier keys will be re-derived on unwrap)
  const wrappedSeed = wrapKey(epochKey.epochSeed, wrapper);

  // Wrap the signing secret key
  const wrappedSignSecret = wrapKey(epochKey.signKeypair.secretKey, wrapper);

  // Combine: length(2) || wrappedSeed || wrappedSignSecret
  const wrapped = new Uint8Array(
    2 + wrappedSeed.length + wrappedSignSecret.length,
  );
  const view = new DataView(wrapped.buffer);
  view.setUint16(0, wrappedSeed.length, true);
  wrapped.set(wrappedSeed, 2);
  wrapped.set(wrappedSignSecret, 2 + wrappedSeed.length);

  return {
    epochId: epochKey.epochId,
    signPublicKey: epochKey.signKeypair.publicKey,
    wrapped,
  };
}

/**
 * Unwrap epoch key from storage.
 * Derives tier keys from the unwrapped epochSeed.
 *
 * @param epochId - Epoch identifier
 * @param signPublicKey - Ed25519 signing public key
 * @param wrapped - Wrapped key data
 * @param wrapper - Wrapping key (32 bytes)
 * @returns Unwrapped epoch key with all tier keys
 */
export function unwrapEpochKey(
  epochId: number,
  signPublicKey: Uint8Array,
  wrapped: Uint8Array,
  wrapper: Uint8Array,
): EpochKey {
  const view = new DataView(wrapped.buffer, wrapped.byteOffset);
  const seedLen = view.getUint16(0, true);

  const wrappedSeed = wrapped.slice(2, 2 + seedLen);
  const wrappedSignSecret = wrapped.slice(2 + seedLen);

  const epochSeed = unwrapKey(wrappedSeed, wrapper);
  const signSecretKey = unwrapKey(wrappedSignSecret, wrapper);

  // Derive tier keys from seed
  const { thumbKey, previewKey, fullKey } = deriveTierKeys(epochSeed);

  return {
    epochId,
    epochSeed,
    thumbKey,
    previewKey,
    fullKey,
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

  if (epochKey.epochSeed.length !== KEY_SIZE) {
    return false;
  }

  if (epochKey.thumbKey.length !== KEY_SIZE) {
    return false;
  }

  if (epochKey.previewKey.length !== KEY_SIZE) {
    return false;
  }

  if (epochKey.fullKey.length !== KEY_SIZE) {
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
