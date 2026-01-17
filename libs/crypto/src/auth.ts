/**
 * Mosaic Crypto Library - Authentication Module
 *
 * Challenge-response authentication using Ed25519 signatures.
 * Provides zero-knowledge proof of identity ownership.
 */

import sodium from 'libsodium-wrappers-sumo';
import { CryptoError, CryptoErrorCode, KEY_SIZE } from './types';
import { concat, toBytes, randomBytes, toBase64, fromBase64 } from './utils';

/** Domain separation context for auth challenges */
const AUTH_CHALLENGE_CONTEXT = 'Mosaic_Auth_Challenge_v1';

/** Challenge size in bytes */
export const CHALLENGE_SIZE = 32;

/** Ed25519 signature length */
const SIGNATURE_LENGTH = 64;

/** Ed25519 public key length */
const PUBLIC_KEY_LENGTH = 32;

/** Ed25519 secret key length */
const SECRET_KEY_LENGTH = 64;

/**
 * Generate a random authentication challenge.
 *
 * @returns 32-byte random challenge
 */
export function generateAuthChallenge(): Uint8Array {
  return randomBytes(CHALLENGE_SIZE);
}

/**
 * Sign an authentication challenge with Ed25519 identity key.
 * Uses domain separation to prevent cross-protocol attacks.
 *
 * The challenge is bound with:
 * - Domain context ("Mosaic_Auth_Challenge_v1")
 * - Username (prevents challenge reuse across users)
 * - Timestamp (optional binding for replay window enforcement)
 *
 * @param challenge - Server-provided 32-byte challenge
 * @param username - Username being authenticated
 * @param signSecretKey - Ed25519 signing secret key (64 bytes)
 * @param timestamp - Optional timestamp for additional binding (milliseconds)
 * @returns Base64-encoded signature
 * @throws CryptoError if parameters are invalid
 */
export function signAuthChallenge(
  challenge: Uint8Array,
  username: string,
  signSecretKey: Uint8Array,
  timestamp?: number,
): string {
  // Validate inputs
  if (challenge.length !== CHALLENGE_SIZE) {
    throw new CryptoError(
      `Challenge must be ${CHALLENGE_SIZE} bytes, got ${challenge.length}`,
      CryptoErrorCode.INVALID_INPUT,
    );
  }

  if (signSecretKey.length !== SECRET_KEY_LENGTH) {
    throw new CryptoError(
      `Signing secret key must be ${SECRET_KEY_LENGTH} bytes, got ${signSecretKey.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH,
    );
  }

  if (!username || username.length === 0) {
    throw new CryptoError(
      'Username cannot be empty',
      CryptoErrorCode.INVALID_INPUT,
    );
  }

  // Build message: context || username_length(4 bytes) || username || timestamp(8 bytes, optional) || challenge
  const contextBytes = toBytes(AUTH_CHALLENGE_CONTEXT);
  const usernameBytes = toBytes(username);
  const usernameLenBytes = new Uint8Array(4);
  new DataView(usernameLenBytes.buffer).setUint32(
    0,
    usernameBytes.length,
    false,
  ); // Big-endian

  let message: Uint8Array;
  if (timestamp !== undefined) {
    const timestampBytes = new Uint8Array(8);
    const view = new DataView(timestampBytes.buffer);
    // Store as two 32-bit values for JavaScript number precision
    view.setUint32(0, Math.floor(timestamp / 0x100000000), false);
    view.setUint32(4, timestamp >>> 0, false);
    message = concat(
      contextBytes,
      usernameLenBytes,
      usernameBytes,
      timestampBytes,
      challenge,
    );
  } else {
    message = concat(contextBytes, usernameLenBytes, usernameBytes, challenge);
  }

  const signature = sodium.crypto_sign_detached(message, signSecretKey);
  return toBase64(signature);
}

/**
 * Verify an authentication challenge signature.
 *
 * @param challenge - Original 32-byte challenge
 * @param username - Username being authenticated
 * @param signatureBase64 - Base64-encoded Ed25519 signature
 * @param signPublicKey - Ed25519 signing public key (32 bytes)
 * @param timestamp - Optional timestamp (must match what was signed)
 * @returns true if signature is valid
 */
export function verifyAuthChallenge(
  challenge: Uint8Array,
  username: string,
  signatureBase64: string,
  signPublicKey: Uint8Array,
  timestamp?: number,
): boolean {
  // Validate inputs
  if (challenge.length !== CHALLENGE_SIZE) {
    return false;
  }

  if (signPublicKey.length !== PUBLIC_KEY_LENGTH) {
    return false;
  }

  if (!username || username.length === 0) {
    return false;
  }

  let signature: Uint8Array;
  try {
    signature = fromBase64(signatureBase64);
  } catch {
    return false;
  }

  if (signature.length !== SIGNATURE_LENGTH) {
    return false;
  }

  // Rebuild message exactly as in signAuthChallenge
  const contextBytes = toBytes(AUTH_CHALLENGE_CONTEXT);
  const usernameBytes = toBytes(username);
  const usernameLenBytes = new Uint8Array(4);
  new DataView(usernameLenBytes.buffer).setUint32(
    0,
    usernameBytes.length,
    false,
  );

  let message: Uint8Array;
  if (timestamp !== undefined) {
    const timestampBytes = new Uint8Array(8);
    const view = new DataView(timestampBytes.buffer);
    view.setUint32(0, Math.floor(timestamp / 0x100000000), false);
    view.setUint32(4, timestamp >>> 0, false);
    message = concat(
      contextBytes,
      usernameLenBytes,
      usernameBytes,
      timestampBytes,
      challenge,
    );
  } else {
    message = concat(contextBytes, usernameLenBytes, usernameBytes, challenge);
  }

  try {
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
 * Derive an authentication signing key directly from password + salts.
 * This is a separate derivation path from the account key for security isolation.
 *
 * The auth key is derived as:
 *   L0 = Argon2id(password, userSalt)
 *   authKey = HKDF-SHA256(L0, "Mosaic_AuthKey_v1")
 *
 * This provides:
 * - Separate key material from account key (L2)
 * - Can verify identity before releasing wrapped account key
 * - Same password, different derived key
 *
 * @param password - User password
 * @param userSalt - User's Argon2 salt (16 bytes)
 * @param argon2Params - Argon2 parameters (memory, iterations, parallelism)
 * @returns Ed25519 keypair derived from auth key seed
 */
export async function deriveAuthKeypair(
  password: string,
  userSalt: Uint8Array,
  argon2Params?: {
    memoryKiB: number;
    iterations: number;
    parallelism: number;
  },
): Promise<{ publicKey: Uint8Array; secretKey: Uint8Array }> {
  // Ensure libsodium WASM is fully initialized before using crypto_pwhash
  await sodium.ready;

  // Verify crypto_pwhash is actually bound (race condition guard)
  // In rare cases, sodium.ready can resolve before all WASM bindings complete
  if (typeof sodium.crypto_pwhash !== 'function') {
    throw new CryptoError(
      'libsodium WASM not fully initialized - crypto_pwhash not available',
      CryptoErrorCode.NOT_INITIALIZED,
    );
  }

  if (userSalt.length !== 16) {
    throw new CryptoError(
      'User salt must be 16 bytes',
      CryptoErrorCode.INVALID_INPUT,
    );
  }

  // Default to reasonable params if not provided
  const params = argon2Params ?? {
    memoryKiB: 65536, // 64 MiB
    iterations: 3,
    parallelism: 1,
  };

  // Derive L0 master key
  const l0 = sodium.crypto_pwhash(
    KEY_SIZE,
    password,
    userSalt,
    params.iterations,
    params.memoryKiB * 1024,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );

  // Derive auth key seed using HKDF-like construction
  // Using BLAKE2b for key derivation with domain separation
  const authContext = toBytes('Mosaic_AuthKey_v1');
  const authSeed = sodium.crypto_generichash(KEY_SIZE, concat(authContext, l0));

  // Clear L0 from memory
  sodium.memzero(l0);

  // Generate Ed25519 keypair from seed
  const keypair = sodium.crypto_sign_seed_keypair(authSeed);

  // Clear seed
  sodium.memzero(authSeed);

  return {
    publicKey: keypair.publicKey,
    secretKey: keypair.privateKey,
  };
}

/**
 * Generate fake challenge data for non-existent users.
 * This prevents user enumeration by returning consistent-looking responses.
 *
 * The fake salt is deterministically derived from the username so:
 * - Same username always gets same fake salt
 * - Attacker can't distinguish real from fake users
 * - No database lookup needed for fake users
 *
 * @param username - The (non-existent) username
 * @param serverSecret - Server-side secret for deterministic generation
 * @returns Fake user salt that looks real
 */
export function generateFakeUserSalt(
  username: string,
  serverSecret: Uint8Array,
): Uint8Array {
  if (serverSecret.length !== KEY_SIZE) {
    throw new CryptoError(
      'Server secret must be 32 bytes',
      CryptoErrorCode.INVALID_KEY_LENGTH,
    );
  }

  // Deterministic fake salt: BLAKE2b(serverSecret || "fake_salt" || username)
  const context = toBytes('fake_salt');
  const usernameBytes = toBytes(username);
  return sodium.crypto_generichash(
    16,
    concat(serverSecret, context, usernameBytes),
  );
}

/**
 * Generate a deterministic fake challenge for non-existent users.
 * Combined with fake salt, this makes enumeration attacks impractical.
 *
 * @param username - The (non-existent) username
 * @param serverSecret - Server-side secret
 * @param timestamp - Current timestamp for uniqueness
 * @returns Fake challenge that looks real
 */
export function generateFakeChallenge(
  username: string,
  serverSecret: Uint8Array,
  timestamp: number,
): Uint8Array {
  if (serverSecret.length !== KEY_SIZE) {
    throw new CryptoError(
      'Server secret must be 32 bytes',
      CryptoErrorCode.INVALID_KEY_LENGTH,
    );
  }

  // Deterministic fake challenge: BLAKE2b(serverSecret || "fake_challenge" || username || timestamp)
  const context = toBytes('fake_challenge');
  const usernameBytes = toBytes(username);
  const timestampBytes = new Uint8Array(8);
  const view = new DataView(timestampBytes.buffer);
  view.setUint32(0, Math.floor(timestamp / 0x100000000), false);
  view.setUint32(4, timestamp >>> 0, false);

  return sodium.crypto_generichash(
    CHALLENGE_SIZE,
    concat(serverSecret, context, usernameBytes, timestampBytes),
  );
}
