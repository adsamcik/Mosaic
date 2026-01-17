/**
 * Mosaic Crypto Library - Keychain Module
 *
 * Key derivation using Argon2id for password hashing
 * and HKDF-style expansion for key hierarchy.
 */

import sodium from 'libsodium-wrappers-sumo';
import type { DerivedKeys, DeriveKeysResult, Argon2Params } from './types';
import { CryptoError, CryptoErrorCode } from './types';
import { getArgon2Params } from './argon2-params';
import { memzero, randomBytes } from './utils';

/** Domain separation context for root key derivation */
const ROOT_KEY_CONTEXT = new TextEncoder().encode('Mosaic_RootKey_v1');

/** Domain separation context for account salt mixing */
const ACCOUNT_CONTEXT = new TextEncoder().encode('Mosaic_AccountKey_v1');

/**
 * Derive all key layers from password (internal - exposes L0/L1).
 *
 * ⚠️ SECURITY WARNING: This function returns masterKey (L0) and rootKey (L1)
 * which MUST be zeroed by the caller using memzero() immediately after use.
 * Use deriveKeys() for production code which handles zeroing automatically.
 *
 * Key Hierarchy:
 * - L0 (Master): Argon2id(password, userSalt) - MUST BE ZEROED AFTER USE
 * - L1 (Root): HKDF-style(L0, accountSalt) - MUST BE ZEROED AFTER USE
 * - L2 (Account): random(32), wrapped by L1 - stored encrypted
 *
 * @internal For testing purposes only. Production code should use deriveKeys().
 * @param password - User password
 * @param userSalt - 16-byte salt stored on server (per-user)
 * @param accountSalt - 16-byte salt stored on server (unique per account)
 * @param params - Optional Argon2 parameters (auto-detected if not provided)
 * @returns Full derived key hierarchy including L0/L1 (caller MUST call memzero on masterKey and rootKey)
 */
export async function deriveKeysInternal(
  password: string,
  userSalt: Uint8Array,
  accountSalt: Uint8Array,
  params?: Argon2Params,
): Promise<DerivedKeys> {
  await sodium.ready;

  // Verify crypto_pwhash is actually bound (race condition guard)
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
  if (accountSalt.length !== 16) {
    throw new CryptoError(
      'Account salt must be 16 bytes',
      CryptoErrorCode.INVALID_INPUT,
    );
  }

  const argon2Params = params ?? getArgon2Params();

  // L0: Master Key from Argon2id(password, userSalt)
  const masterKey = sodium.crypto_pwhash(
    32,
    password,
    userSalt,
    argon2Params.iterations,
    argon2Params.memory * 1024, // Convert KiB to bytes
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );

  // L1: Root Key - HKDF-style derivation using BLAKE2b
  // First, derive intermediate key with context
  const rootKeyIntermediate = sodium.crypto_generichash(
    32,
    ROOT_KEY_CONTEXT,
    masterKey,
  );

  // Mix in account salt for domain separation
  const rootKey = sodium.crypto_generichash(
    32,
    sodium.crypto_generichash(32, ACCOUNT_CONTEXT, accountSalt),
    rootKeyIntermediate,
  );

  // Clean intermediate key
  memzero(rootKeyIntermediate);

  // L2: Generate random account key
  const accountKey = randomBytes(32);

  // Wrap L2 with L1 using XChaCha20-Poly1305
  const nonce = randomBytes(24);
  const ciphertext = sodium.crypto_secretbox_easy(accountKey, nonce, rootKey);

  // accountKeyWrapped = nonce || ciphertext
  const accountKeyWrapped = new Uint8Array(24 + ciphertext.length);
  accountKeyWrapped.set(nonce, 0);
  accountKeyWrapped.set(ciphertext, 24);

  return {
    masterKey,
    rootKey,
    accountKey,
    accountKeyWrapped,
  };
}

/**
 * Derive account key from password.
 *
 * This is the safe public API that zeros L0 (masterKey) and L1 (rootKey)
 * before returning. Only L2 (accountKey) and its wrapped form are returned.
 *
 * Key Hierarchy:
 * - L0 (Master): Argon2id(password, userSalt) - zeroed before return
 * - L1 (Root): HKDF-style(L0, accountSalt) - zeroed before return
 * - L2 (Account): random(32), wrapped by L1 - returned
 *
 * @param password - User password
 * @param userSalt - 16-byte salt stored on server (per-user)
 * @param accountSalt - 16-byte salt stored on server (unique per account)
 * @param params - Optional Argon2 parameters (auto-detected if not provided)
 * @returns Account key and wrapped account key (L0/L1 are zeroed before return)
 */
export async function deriveKeys(
  password: string,
  userSalt: Uint8Array,
  accountSalt: Uint8Array,
  params?: Argon2Params,
): Promise<DeriveKeysResult> {
  const keys = await deriveKeysInternal(
    password,
    userSalt,
    accountSalt,
    params,
  );

  // Zero L0 and L1 before returning - they must never be stored
  memzero(keys.masterKey);
  memzero(keys.rootKey);

  // Return only the safe fields
  return {
    accountKey: keys.accountKey,
    accountKeyWrapped: keys.accountKeyWrapped,
  };
}

/**
 * Unwrap an existing account key using derived root key.
 * Used when logging in to an existing account.
 *
 * @param password - User password
 * @param userSalt - 16-byte salt stored on server
 * @param accountSalt - 16-byte salt stored on server
 * @param wrappedAccountKey - Previously wrapped account key
 * @param params - Optional Argon2 parameters
 * @returns Unwrapped account key
 */
export async function unwrapAccountKey(
  password: string,
  userSalt: Uint8Array,
  accountSalt: Uint8Array,
  wrappedAccountKey: Uint8Array,
  params?: Argon2Params,
): Promise<Uint8Array> {
  await sodium.ready;

  // Verify crypto_pwhash is actually bound (race condition guard)
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
  if (accountSalt.length !== 16) {
    throw new CryptoError(
      'Account salt must be 16 bytes',
      CryptoErrorCode.INVALID_INPUT,
    );
  }
  if (wrappedAccountKey.length < 24 + 16 + 1) {
    // nonce + tag + at least 1 byte
    throw new CryptoError(
      'Wrapped account key too short',
      CryptoErrorCode.INVALID_INPUT,
    );
  }

  const argon2Params = params ?? getArgon2Params();

  // Derive L0 and L1
  const masterKey = sodium.crypto_pwhash(
    32,
    password,
    userSalt,
    argon2Params.iterations,
    argon2Params.memory * 1024,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );

  const rootKeyIntermediate = sodium.crypto_generichash(
    32,
    ROOT_KEY_CONTEXT,
    masterKey,
  );

  const rootKey = sodium.crypto_generichash(
    32,
    sodium.crypto_generichash(32, ACCOUNT_CONTEXT, accountSalt),
    rootKeyIntermediate,
  );

  // Clean up
  memzero(masterKey);
  memzero(rootKeyIntermediate);

  // Unwrap L2
  const nonce = wrappedAccountKey.slice(0, 24);
  const ciphertext = wrappedAccountKey.slice(24);

  try {
    const accountKey = sodium.crypto_secretbox_open_easy(
      ciphertext,
      nonce,
      rootKey,
    );
    memzero(rootKey);
    return accountKey;
  } catch (e) {
    memzero(rootKey);
    throw new CryptoError(
      'Failed to unwrap account key - wrong password or corrupted data',
      CryptoErrorCode.DECRYPTION_FAILED,
      e,
    );
  }
}

/**
 * Re-wrap account key with new password.
 * Used for password change.
 *
 * @param accountKey - Unwrapped account key (32 bytes)
 * @param newPassword - New password
 * @param userSalt - User salt (16 bytes)
 * @param accountSalt - Account salt (16 bytes)
 * @param params - Optional Argon2 parameters
 * @returns New wrapped account key
 */
export async function rewrapAccountKey(
  accountKey: Uint8Array,
  newPassword: string,
  userSalt: Uint8Array,
  accountSalt: Uint8Array,
  params?: Argon2Params,
): Promise<Uint8Array> {
  await sodium.ready;

  // Verify crypto_pwhash is actually bound (race condition guard)
  if (typeof sodium.crypto_pwhash !== 'function') {
    throw new CryptoError(
      'libsodium WASM not fully initialized - crypto_pwhash not available',
      CryptoErrorCode.NOT_INITIALIZED,
    );
  }

  if (accountKey.length !== 32) {
    throw new CryptoError(
      'Account key must be 32 bytes',
      CryptoErrorCode.INVALID_INPUT,
    );
  }

  const argon2Params = params ?? getArgon2Params();

  // Derive new root key
  const masterKey = sodium.crypto_pwhash(
    32,
    newPassword,
    userSalt,
    argon2Params.iterations,
    argon2Params.memory * 1024,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );

  const rootKeyIntermediate = sodium.crypto_generichash(
    32,
    ROOT_KEY_CONTEXT,
    masterKey,
  );

  const rootKey = sodium.crypto_generichash(
    32,
    sodium.crypto_generichash(32, ACCOUNT_CONTEXT, accountSalt),
    rootKeyIntermediate,
  );

  // Clean up intermediates
  memzero(masterKey);
  memzero(rootKeyIntermediate);

  // Wrap with new nonce
  const nonce = randomBytes(24);
  const ciphertext = sodium.crypto_secretbox_easy(accountKey, nonce, rootKey);
  memzero(rootKey);

  const wrapped = new Uint8Array(24 + ciphertext.length);
  wrapped.set(nonce, 0);
  wrapped.set(ciphertext, 24);

  return wrapped;
}

/**
 * Generate new random salts for account creation.
 *
 * @returns Object with userSalt and accountSalt (16 bytes each)
 */
export function generateSalts(): {
  userSalt: Uint8Array;
  accountSalt: Uint8Array;
} {
  return {
    userSalt: randomBytes(16),
    accountSalt: randomBytes(16),
  };
}
