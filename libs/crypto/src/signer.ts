/**
 * Mosaic Crypto Library - Signer Module
 *
 * Ed25519 signing and verification for manifests and shards.
 * Uses domain separation to prevent cross-protocol attacks.
 */

import sodium from 'libsodium-wrappers-sumo';
import { CryptoError, CryptoErrorCode, MANIFEST_SIGN_CONTEXT } from './types';
import { concat, toBytes } from './utils';

/** Signing context for shards */
const SHARD_SIGN_CONTEXT = toBytes('Mosaic_Shard_v1');

/** Signing context for manifests (also exported from types) */
const MANIFEST_CONTEXT = toBytes(MANIFEST_SIGN_CONTEXT);

/** Ed25519 signature length */
const SIGNATURE_LENGTH = 64;

/** Ed25519 public key length */
const PUBLIC_KEY_LENGTH = 32;

/** Ed25519 secret key length */
const SECRET_KEY_LENGTH = 64;

/**
 * Sign manifest data with epoch signing key.
 * Uses domain separation context to prevent signature reuse.
 *
 * @param manifest - Manifest bytes to sign
 * @param signSecretKey - Ed25519 signing secret key (64 bytes)
 * @returns Ed25519 signature (64 bytes)
 * @throws CryptoError if key length is invalid
 */
export function signManifest(
  manifest: Uint8Array,
  signSecretKey: Uint8Array,
): Uint8Array {
  if (signSecretKey.length !== SECRET_KEY_LENGTH) {
    throw new CryptoError(
      `Signing secret key must be ${SECRET_KEY_LENGTH} bytes, got ${signSecretKey.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH,
    );
  }

  // Domain-separate: sign(context || manifest)
  const message = concat(MANIFEST_CONTEXT, manifest);
  return sodium.crypto_sign_detached(message, signSecretKey);
}

/**
 * Verify manifest signature.
 *
 * @param manifest - Manifest bytes
 * @param signature - Ed25519 signature (64 bytes)
 * @param signPublicKey - Ed25519 signing public key (32 bytes)
 * @returns true if signature is valid
 */
export function verifyManifest(
  manifest: Uint8Array,
  signature: Uint8Array,
  signPublicKey: Uint8Array,
): boolean {
  if (signature.length !== SIGNATURE_LENGTH) {
    return false;
  }
  if (signPublicKey.length !== PUBLIC_KEY_LENGTH) {
    return false;
  }

  try {
    const message = concat(MANIFEST_CONTEXT, manifest);
    return sodium.crypto_sign_verify_detached(
      signature,
      message,
      signPublicKey,
    );
  } catch {
    return false;
  }
}

/**
 * Sign shard envelope (header + ciphertext).
 * Uses domain separation context to prevent signature reuse.
 *
 * @param header - Shard header (64 bytes)
 * @param ciphertext - Encrypted shard data
 * @param signSecretKey - Ed25519 signing secret key (64 bytes)
 * @returns Ed25519 signature (64 bytes)
 * @throws CryptoError if key length is invalid
 */
export function signShard(
  header: Uint8Array,
  ciphertext: Uint8Array,
  signSecretKey: Uint8Array,
): Uint8Array {
  if (signSecretKey.length !== SECRET_KEY_LENGTH) {
    throw new CryptoError(
      `Signing secret key must be ${SECRET_KEY_LENGTH} bytes, got ${signSecretKey.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH,
    );
  }

  // Domain-separate: sign(context || header || ciphertext)
  const message = concat(SHARD_SIGN_CONTEXT, header, ciphertext);
  return sodium.crypto_sign_detached(message, signSecretKey);
}

/**
 * Verify shard signature.
 *
 * @param header - Shard header (64 bytes)
 * @param ciphertext - Encrypted shard data
 * @param signature - Ed25519 signature (64 bytes)
 * @param signPublicKey - Ed25519 signing public key (32 bytes)
 * @returns true if signature is valid
 */
export function verifyShard(
  header: Uint8Array,
  ciphertext: Uint8Array,
  signature: Uint8Array,
  signPublicKey: Uint8Array,
): boolean {
  if (signature.length !== SIGNATURE_LENGTH) {
    return false;
  }
  if (signPublicKey.length !== PUBLIC_KEY_LENGTH) {
    return false;
  }

  try {
    const message = concat(SHARD_SIGN_CONTEXT, header, ciphertext);
    return sodium.crypto_sign_verify_detached(
      signature,
      message,
      signPublicKey,
    );
  } catch {
    return false;
  }
}

/**
 * Sign arbitrary data with domain separation.
 * Generic signing function with custom context.
 *
 * @param data - Data to sign
 * @param context - Domain separation string (will be UTF-8 encoded)
 * @param signSecretKey - Ed25519 signing secret key (64 bytes)
 * @returns Ed25519 signature (64 bytes)
 */
export function signWithContext(
  data: Uint8Array,
  context: string,
  signSecretKey: Uint8Array,
): Uint8Array {
  if (signSecretKey.length !== SECRET_KEY_LENGTH) {
    throw new CryptoError(
      `Signing secret key must be ${SECRET_KEY_LENGTH} bytes, got ${signSecretKey.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH,
    );
  }

  const message = concat(toBytes(context), data);
  return sodium.crypto_sign_detached(message, signSecretKey);
}

/**
 * Verify signature with domain separation.
 *
 * @param data - Signed data
 * @param signature - Ed25519 signature (64 bytes)
 * @param context - Domain separation string
 * @param signPublicKey - Ed25519 signing public key (32 bytes)
 * @returns true if signature is valid
 */
export function verifyWithContext(
  data: Uint8Array,
  signature: Uint8Array,
  context: string,
  signPublicKey: Uint8Array,
): boolean {
  if (signature.length !== SIGNATURE_LENGTH) {
    return false;
  }
  if (signPublicKey.length !== PUBLIC_KEY_LENGTH) {
    return false;
  }

  try {
    const message = concat(toBytes(context), data);
    return sodium.crypto_sign_verify_detached(
      signature,
      message,
      signPublicKey,
    );
  } catch {
    return false;
  }
}
