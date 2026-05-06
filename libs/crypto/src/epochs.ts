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

/** HKDF context for thumb tier key derivation */
const THUMB_KEY_CONTEXT = toBytes('mosaic:tier:thumb:v1');
/** HKDF context for preview tier key derivation */
const PREVIEW_KEY_CONTEXT = toBytes('mosaic:tier:preview:v1');
/** HKDF context for full tier key derivation */
const FULL_KEY_CONTEXT = toBytes('mosaic:tier:full:v1');
/** HKDF context for album content key derivation */
const CONTENT_KEY_CONTEXT = toBytes('mosaic:tier:content:v1');

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
 * @deprecated Protocol crypto is Rust-owned. New web code must use the
 * Rust/WASM epoch-handle APIs instead of handling raw epoch seeds.
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
 * Derive the content key for album content encryption.
 * Uses HKDF-style BLAKE2b with domain separation.
 *
 * Content key is used for encrypting album narrative content (blocks, text, etc.)
 * and is derived on-demand rather than stored in EpochKey to keep the interface lean.
 *
 * @deprecated Protocol crypto is Rust-owned. Use Rust/WASM epoch-handle
 * content operations instead of deriving raw content keys in TypeScript.
 *
 * @param epochSeed - 32-byte master seed from epoch
 * @returns 32-byte content encryption key
 */
export function deriveContentKey(epochSeed: Uint8Array): Uint8Array {
  if (epochSeed.length !== KEY_SIZE) {
    throw new CryptoError(
      `Epoch seed must be ${KEY_SIZE} bytes, got ${epochSeed.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH,
    );
  }
  return deriveTierKey(epochSeed, CONTENT_KEY_CONTEXT);
}

/**
 * Get the appropriate tier key for a given shard tier.
 *
 * @deprecated Protocol crypto is Rust-owned. Use Rust/WASM epoch-handle
 * shard operations instead of selecting raw tier keys in TypeScript.
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
 * @deprecated Epoch lifecycle is Rust-owned. Use the WASM handle API for new
 * epoch creation and import/export flows.
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
 * Validate epoch key structure.
 *
 * @deprecated Epoch lifecycle is Rust-owned. Prefer Rust/WASM handle
 * validation paths for any new code.
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
