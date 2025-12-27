/**
 * Mosaic Crypto Library - Identity Module
 *
 * Identity keypair derivation and Ed25519 ↔ X25519 conversion.
 * Ed25519 is used for signatures (identity verification).
 * X25519 is used for key exchange (sealed boxes).
 */

import sodium from 'libsodium-wrappers';
import { CryptoError, CryptoErrorCode, KEY_SIZE, type IdentityKeypair } from './types';
import { randomBytes } from './utils';

/** Ed25519 public key length */
const ED25519_PUBLIC_KEY_LENGTH = 32;

/** Ed25519 secret key length */
const ED25519_SECRET_KEY_LENGTH = 64;

/**
 * Generate identity keypair from a 32-byte seed.
 * Returns both Ed25519 (signing) and X25519 (encryption) keypairs.
 *
 * The X25519 keypair is derived from Ed25519 using libsodium's
 * clamping functions, which ensures proper key handling.
 *
 * @param seed - 32-byte seed (typically unwrapped from storage)
 * @returns Identity keypair with Ed25519 and X25519 keys
 * @throws CryptoError if seed is not 32 bytes
 */
export function deriveIdentityKeypair(seed: Uint8Array): IdentityKeypair {
  if (seed.length !== KEY_SIZE) {
    throw new CryptoError(
      `Identity seed must be ${KEY_SIZE} bytes, got ${seed.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH
    );
  }

  // Generate Ed25519 keypair from seed
  const ed25519 = sodium.crypto_sign_seed_keypair(seed);

  // Convert Ed25519 to X25519 for encryption
  // libsodium handles clamping internally
  let x25519Secret: Uint8Array;
  let x25519Public: Uint8Array;

  try {
    x25519Secret = sodium.crypto_sign_ed25519_sk_to_curve25519(ed25519.privateKey);
    x25519Public = sodium.crypto_sign_ed25519_pk_to_curve25519(ed25519.publicKey);
  } catch (error) {
    throw new CryptoError(
      'Failed to convert Ed25519 to X25519',
      CryptoErrorCode.KEY_CONVERSION_FAILED,
      error
    );
  }

  return {
    ed25519: {
      publicKey: ed25519.publicKey,
      secretKey: ed25519.privateKey,
    },
    x25519: {
      publicKey: x25519Public,
      secretKey: x25519Secret,
    },
  };
}

/**
 * Convert Ed25519 public key to X25519 public key.
 * Used for encrypting to a recipient given their Ed25519 identity.
 *
 * @param ed25519Pub - Ed25519 public key (32 bytes)
 * @returns X25519 public key (32 bytes)
 * @throws CryptoError if conversion fails
 */
export function ed25519PubToX25519(ed25519Pub: Uint8Array): Uint8Array {
  if (ed25519Pub.length !== ED25519_PUBLIC_KEY_LENGTH) {
    throw new CryptoError(
      `Ed25519 public key must be ${ED25519_PUBLIC_KEY_LENGTH} bytes, got ${ed25519Pub.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH
    );
  }

  try {
    return sodium.crypto_sign_ed25519_pk_to_curve25519(ed25519Pub);
  } catch (error) {
    throw new CryptoError(
      'Failed to convert Ed25519 public key to X25519',
      CryptoErrorCode.KEY_CONVERSION_FAILED,
      error
    );
  }
}

/**
 * Convert Ed25519 secret key to X25519 secret key.
 * Used for deriving X25519 keypair from stored Ed25519 keypair.
 *
 * @param ed25519Secret - Ed25519 secret key (64 bytes)
 * @returns X25519 secret key (32 bytes)
 * @throws CryptoError if conversion fails
 */
export function ed25519SecretToX25519(ed25519Secret: Uint8Array): Uint8Array {
  if (ed25519Secret.length !== ED25519_SECRET_KEY_LENGTH) {
    throw new CryptoError(
      `Ed25519 secret key must be ${ED25519_SECRET_KEY_LENGTH} bytes, got ${ed25519Secret.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH
    );
  }

  try {
    return sodium.crypto_sign_ed25519_sk_to_curve25519(ed25519Secret);
  } catch (error) {
    throw new CryptoError(
      'Failed to convert Ed25519 secret key to X25519',
      CryptoErrorCode.KEY_CONVERSION_FAILED,
      error
    );
  }
}

/**
 * Generate a new random 32-byte identity seed.
 * Used when creating new accounts.
 *
 * @returns 32 random bytes suitable for deriveIdentityKeypair
 */
export function generateIdentitySeed(): Uint8Array {
  return randomBytes(KEY_SIZE);
}

/**
 * Generate a random Ed25519 keypair.
 * Used when a fresh keypair is needed without a specific seed.
 *
 * @returns Fresh Ed25519 keypair
 */
export function generateEd25519Keypair(): {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
} {
  const keypair = sodium.crypto_sign_keypair();
  return {
    publicKey: keypair.publicKey,
    secretKey: keypair.privateKey,
  };
}

/**
 * Verify that an Ed25519 public key is valid.
 * Attempts conversion to X25519 as a validation check.
 *
 * @param publicKey - Ed25519 public key to validate
 * @returns true if valid
 */
export function isValidEd25519PublicKey(publicKey: Uint8Array): boolean {
  if (publicKey.length !== ED25519_PUBLIC_KEY_LENGTH) {
    return false;
  }

  try {
    // Try to convert to X25519 as validation
    sodium.crypto_sign_ed25519_pk_to_curve25519(publicKey);
    return true;
  } catch {
    return false;
  }
}
