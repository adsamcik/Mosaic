/**
 * Session salt-envelope encryption / decryption (v1 legacy + v2 current).
 *
 * Extracted from `session.ts` (Sweep 39). The session manager calls into
 * these helpers when initialising the Rust account handle and persisting the
 * v2 salt envelope. The legacy v1 (PBKDF2-100k(username)) path is preserved
 * so existing users can still log in; every successful v1 decryption
 * triggers a best-effort upgrade to v2.
 *
 * On-wire layout for the `User.encryptedSalt` blob (after base64 decode):
 *
 *   v2: [0x02][XChaCha20-Poly1305 ciphertext+tag] (current; Rust L2 account key)
 *   v1: [AES-GCM ciphertext+tag]         (legacy; KDF = PBKDF2-100k(username))
 *
 * v2 is deliberately account-handle based: the frontend does not perform
 * WebCrypto/libsodium password-based salt-envelope crypto. During login the
 * local cached user salt bootstraps the account handle, then the server v2
 * envelope is verified through Rust. If the local salt is unavailable, the
 * current generated WASM surface has no password-only v2 decrypt export.
 */
import type { Argon2Params } from '@mosaic/crypto';
import initRustWasm, {
  decryptUserSaltV1Legacy as rustDecryptUserSaltV1Legacy,
} from '../generated/mosaic-wasm/mosaic_wasm.js';
import { getCryptoClient } from './crypto-client';
import { createLogger } from './logger';
import { defaultKdfProfile, isLegacyFallbackEligibleError, isWorkerCryptoErrorCode } from './session-kdf';
import { WorkerCryptoErrorCode } from '../workers/types';

const log = createLogger('session-salt');

// Inline base64 helpers to keep this module independent of `./api` (avoids
// the api.ts <-> session.ts cycle from extending through this file).
function decodeBase64(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function encodeBase64(data: Uint8Array): string {
  const CHUNK_SIZE = 8192;
  if (data.length <= CHUNK_SIZE) {
    return btoa(String.fromCharCode(...data));
  }
  let binary = '';
  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    const chunk = data.subarray(i, Math.min(i + CHUNK_SIZE, data.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export const SALT_ENCRYPTION_VERSION_V2 = 0x02;

/** Salt storage key in localStorage. */
export const USER_SALT_KEY = 'mosaic:userSalt';
export const USER_SALT_LENGTH_BYTES = 16;

/** Error thrown when salt decryption fails (wrong password on new device). */
export class SaltDecryptionError extends Error {
  constructor(message: string = 'Failed to decrypt salt - incorrect password') {
    super(message);
    this.name = 'SaltDecryptionError';
  }
}

let rustWasmInitPromise: Promise<unknown> | null = null;

export async function ensureRustWasmInitialized(): Promise<void> {
  if (!rustWasmInitPromise) {
    rustWasmInitPromise = initRustWasm();
  }
  await rustWasmInitPromise;
}

export function consumeWasmBytesResult(
  result: { readonly code: number; readonly bytes: Uint8Array; free(): void },
  label: string,
): Uint8Array {
  try {
    if (result.code !== 0) {
      throw new Error(`${label} failed (rust code ${String(result.code)})`);
    }
    return new Uint8Array(result.bytes);
  } finally {
    result.free();
  }
}

export function isV2SaltEnvelope(envelope: Uint8Array): boolean {
  return envelope.length > 1 && envelope[0] === SALT_ENCRYPTION_VERSION_V2;
}

export function requireCachedV2BootstrapSalt(): Uint8Array {
  const storedSalt = localStorage.getItem(USER_SALT_KEY);
  if (!storedSalt) {
    throw new SaltDecryptionError(
      'Cannot decrypt v2 user salt before the Rust account handle is open',
    );
  }
  let decodedSalt: Uint8Array;
  try {
    decodedSalt = decodeBase64(storedSalt);
  } catch {
    throw new SaltDecryptionError('Cached v2 user salt is corrupt');
  }
  if (decodedSalt.length !== USER_SALT_LENGTH_BYTES) {
    throw new SaltDecryptionError('Cached v2 user salt has invalid length');
  }
  return decodedSalt;
}

export function assertSaltMatchesServerEnvelope(
  expected: Uint8Array,
  actual: Uint8Array,
): void {
  if (expected.length !== actual.length) {
    throw new SaltDecryptionError('Server user salt does not match local cache');
  }

  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected[i]! ^ actual[i]!;
  }
  if (diff !== 0) {
    throw new SaltDecryptionError('Server user salt does not match local cache');
  }
}

async function tryDecryptV1Salt(
  password: string,
  username: string,
  nonce: Uint8Array,
  envelope: Uint8Array,
): Promise<Uint8Array | null> {
  await ensureRustWasmInitialized();
  try {
    return consumeWasmBytesResult(
      rustDecryptUserSaltV1Legacy(password, username, envelope, nonce),
      'decryptUserSaltV1Legacy',
    );
  } catch {
    return null;
  }
}

/** Build a v2 envelope (`0x02 || ciphertext+tag`) from a raw AES-GCM ciphertext. */
function encodeV2Envelope(ciphertext: Uint8Array): Uint8Array {
  const envelope = new Uint8Array(1 + ciphertext.length);
  envelope[0] = SALT_ENCRYPTION_VERSION_V2;
  envelope.set(ciphertext, 1);
  return envelope;
}

/**
 * Best-effort migration of a legacy v1 payload to v2.
 *
 * Called from {@link decryptSalt} after a successful v1 decryption. A failed
 * upload MUST NOT block login — we simply log a warning and let the next
 * login retry the upgrade.
 */
async function migrateLegacySaltToV2(
  salt: Uint8Array,
  password: string,
  username: string,
  argon2Params: Argon2Params,
): Promise<void> {
  try {
    const { encryptedSalt, saltNonce } = await encryptSalt(
      salt,
      password,
      username,
      argon2Params,
    );
    // Dynamic import to avoid the api.ts <-> session.ts static cycle
    // extending through this file. Only loaded on legacy-migration paths.
    const { getApi } = await import('./api');
    await getApi().updateCurrentUser({ encryptedSalt, saltNonce });
    log.info('Migrated salt encryption from PBKDF2 v1 to Argon2id v2');
  } catch (error) {
    log.warn(
      'Failed to migrate salt encryption to v2 - will retry on next login',
      { error },
    );
  }
}

/**
 * Encrypt the user salt with a password-derived key.
 *
 * Always emits the v2 envelope (Argon2id KDF, version-byte prefix).
 */
export async function encryptSalt(
  salt: Uint8Array,
  password: string,
  username: string,
  argon2Params: Argon2Params = defaultKdfProfile(),
): Promise<{ encryptedSalt: string; saltNonce: string }> {
  // The generated WASM surface only exposes v2 salt-envelope encryption through
  // the open Rust account handle. Keep the legacy signature for callers that
  // still pass password/username/KDF values while avoiding frontend crypto.
  void password;
  void username;
  void argon2Params;
  const cryptoClient = await getCryptoClient();
  const { ciphertext, nonce } = await cryptoClient.encryptUserSaltEnvelopeV2(salt);
  const envelope =
    ciphertext[0] === SALT_ENCRYPTION_VERSION_V2
      ? ciphertext
      : encodeV2Envelope(ciphertext);

  return {
    encryptedSalt: encodeBase64(envelope),
    saltNonce: encodeBase64(nonce),
  };
}

/**
 * Decrypt the user salt with a password-derived key.
 *
 * Tries v2 first (Argon2id, version byte `0x02`). On version-byte mismatch
 * or AES-GCM auth failure, falls back to the legacy v1 path (PBKDF2-100k).
 * A successful v1 decryption transparently re-encrypts the salt with v2
 * and uploads it to the server (best-effort; failures are logged but do
 * not block login).
 *
 * Throws {@link SaltDecryptionError} if both paths fail (wrong password,
 * tampered ciphertext, or unrecognised envelope).
 */
export async function decryptSalt(
  encryptedSaltBase64: string,
  saltNonceBase64: string,
  password: string,
  username: string,
  argon2Params: Argon2Params = defaultKdfProfile(),
  migrateLegacy: boolean = true,
): Promise<Uint8Array> {
  const envelope = decodeBase64(encryptedSaltBase64);
  const nonce = decodeBase64(saltNonceBase64);

  // --- Try v2 first ---
  if (isV2SaltEnvelope(envelope)) {
    try {
      void password;
      void username;
      void argon2Params;
      const cryptoClient = await getCryptoClient();
      const ciphertext = envelope.subarray(1);
      return await cryptoClient.decryptUserSaltEnvelopeV2(ciphertext, nonce);
    } catch (error) {
      if (isWorkerCryptoErrorCode(error, WorkerCryptoErrorCode.WorkerNotInitialized)) {
        throw error;
      }
      if (!isLegacyFallbackEligibleError(error)) {
        throw error;
      }
      // Fall through to v1 in case the version byte happens to coincide
      // with a legacy ciphertext's first byte (1-in-256 chance).
    }
  }

  // --- Try legacy v1 (PBKDF2-100k(username)) ---
  const salt = await tryDecryptV1Salt(password, username, nonce, envelope);

  if (!salt) {
    throw new SaltDecryptionError();
  }

  // v1 succeeded — transparently upgrade the server-stored payload to v2.
  // This MUST NOT throw: a failed migration upload still allows login.
  if (migrateLegacy) {
    await migrateLegacySaltToV2(salt, password, username, argon2Params);
  }

  return salt;
}

