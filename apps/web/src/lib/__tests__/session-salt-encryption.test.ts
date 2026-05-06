/**
 * Salt Encryption Migration Tests (H1 + H2)
 *
 * Verifies that the salt-encryption KDF has been switched from PBKDF2-100k
 * (with username-as-salt) to Argon2id, and that legacy v1 payloads are
 * transparently migrated to the v2 versioned envelope on next login.
 *
 * Envelope layout (after base64 decode of `User.encryptedSalt`):
 *   v2: 0x02 || AES-GCM ciphertext+tag
 *   v1: AES-GCM ciphertext+tag (no version byte; legacy)
 *
 * Both use the existing 12-byte AES-GCM nonce stored separately in
 * `User.saltNonce`. Argon2id's per-user salt is derived from a domain-
 * separated BLAKE2b hash of the username and is therefore not stored.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import initRustWasm, {
  consumeMasterKeyHandleForAesGcm,
  deriveMasterKeyFromPassword,
  deriveSessionSaltFromUsername,
  initSync,
} from '../../generated/mosaic-wasm/mosaic_wasm.js';

// ---------------------------------------------------------------------------
// Mocks (registered before the SUT import)
// ---------------------------------------------------------------------------

const updateCurrentUserMock = vi.fn();

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    getApi: vi.fn(() => ({
      updateCurrentUser: updateCurrentUserMock,
    })),
  };
});

vi.mock('../crypto-client', () => ({
  getCryptoClient: vi.fn(),
  closeCryptoClient: vi.fn(),
}));

vi.mock('../db-client', () => ({
  getDbClient: vi.fn(),
  closeDbClient: vi.fn(),
}));

vi.mock('../geo-client', () => ({
  closeGeoClient: vi.fn(),
}));

vi.mock('../epoch-key-store', () => ({
  clearAllEpochKeys: vi.fn(),
}));

vi.mock('../album-cover-service', () => ({
  clearAllCovers: vi.fn(),
}));

vi.mock('../album-metadata-service', () => ({
  clearAllCachedMetadata: vi.fn(),
}));

vi.mock('../thumbhash-decoder', () => ({
  clearPlaceholderCache: vi.fn(),
}));

vi.mock('../photo-service', () => ({
  clearPhotoCache: vi.fn(),
}));

vi.mock('../key-cache', () => ({
  clearCacheEncryptionKey: vi.fn(),
  cacheKeys: vi.fn(),
  getCachedKeys: vi.fn(),
  hasCachedKeys: vi.fn(() => false),
}));

vi.mock('../link-tier-key-store', () => ({
  clearLinkKeyEncryption: vi.fn(),
}));

vi.mock('../local-auth', () => ({
  localAuthLogin: vi.fn(),
  localAuthRegister: vi.fn(),
  isLocalAuthMode: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('../settings-service', () => ({
  getIdleTimeoutMs: vi.fn(() => 30 * 60 * 1000),
  subscribeToSettings: vi.fn(() => () => {}),
}));

vi.mock('../sync-coordinator', () => ({
  syncCoordinator: { dispose: vi.fn() },
}));

// Imports must come after the mocks are registered.
import { fromBase64, toBase64 } from '../api';
import { decryptSalt, encryptSalt, SaltDecryptionError } from '../session';
import { getArgon2Params } from '@mosaic/crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SALT_VERSION_V2 = 0x02;
const LEGACY_PBKDF2_ITERATIONS = 100000;
const SALT_ENCRYPTION_DOMAIN_V2 = 'mosaic-salt-encryption-v2|';
const WASM_BYTES_PATH = resolve(
  process.cwd(),
  'src',
  'generated',
  'mosaic-wasm',
  'mosaic_wasm_bg.wasm',
);

/**
 * Hand-craft a legacy v1 payload using PBKDF2-100k(username) + AES-GCM.
 * Mirrors the pre-fix behaviour exactly, so decryptSalt's legacy fallback
 * MUST be able to decrypt this without any version byte prefix.
 */
async function craftLegacyV1Payload(
  salt: Uint8Array,
  password: string,
  username: string,
): Promise<{ encryptedSalt: string; saltNonce: string }> {
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const usernameSalt = new TextEncoder().encode(username);
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: usernameSalt,
      iterations: LEGACY_PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as Uint8Array<ArrayBuffer> },
    aesKey,
    salt as Uint8Array<ArrayBuffer>,
  );
  return {
    encryptedSalt: toBase64(new Uint8Array(ciphertext)),
    saltNonce: toBase64(nonce),
  };
}

const TEST_USERNAME = 'h1h2-tester@example.com';
const TEST_PASSWORD = 'correct horse battery staple';
const TEST_SALT = new Uint8Array([
  0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
  0x1d, 0x1e, 0x1f,
]);

beforeAll(async () => {
  initSync({ module: readFileSync(WASM_BYTES_PATH) });
  await initRustWasm();
});

beforeEach(() => {
  updateCurrentUserMock.mockReset();
  updateCurrentUserMock.mockResolvedValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('encryptSalt / decryptSalt - v2 round trip', () => {
  it('round-trips a 16-byte user salt through v2 (Argon2id) encryption', async () => {
    const { encryptedSalt, saltNonce } = await encryptSalt(
      TEST_SALT,
      TEST_PASSWORD,
      TEST_USERNAME,
    );

    const decoded = fromBase64(encryptedSalt);
    expect(decoded[0]).toBe(SALT_VERSION_V2);
    expect(decoded.length).toBe(1 + TEST_SALT.length + 16);

    const decrypted = await decryptSalt(
      encryptedSalt,
      saltNonce,
      TEST_PASSWORD,
      TEST_USERNAME,
    );
    expect(decrypted).toEqual(TEST_SALT);
    expect(updateCurrentUserMock).not.toHaveBeenCalled();
  });

  it('throws SaltDecryptionError for a wrong password', async () => {
    const { encryptedSalt, saltNonce } = await encryptSalt(
      TEST_SALT,
      TEST_PASSWORD,
      TEST_USERNAME,
    );

    await expect(
      decryptSalt(encryptedSalt, saltNonce, 'wrong-password', TEST_USERNAME),
    ).rejects.toBeInstanceOf(SaltDecryptionError);
  });

  it('throws SaltDecryptionError when the v2 ciphertext is tampered with', async () => {
    const { encryptedSalt, saltNonce } = await encryptSalt(
      TEST_SALT,
      TEST_PASSWORD,
      TEST_USERNAME,
    );

    const bytes = fromBase64(encryptedSalt);
    // Flip a byte inside the AES-GCM ciphertext (skip the version marker).
    const original = bytes[5] ?? 0;
    bytes[5] = original ^ 0xff;
    const tamperedB64 = toBase64(bytes);

    await expect(
      decryptSalt(tamperedB64, saltNonce, TEST_PASSWORD, TEST_USERNAME),
    ).rejects.toBeInstanceOf(SaltDecryptionError);
  });
});

describe('decryptSalt - legacy v1 → v2 migration', () => {
  it('decrypts a hand-crafted v1 payload and re-encrypts it as v2', async () => {
    const legacy = await craftLegacyV1Payload(
      TEST_SALT,
      TEST_PASSWORD,
      TEST_USERNAME,
    );

    // Sanity: legacy payload has NO version byte and matches old-format length.
    const legacyBytes = fromBase64(legacy.encryptedSalt);
    expect(legacyBytes.length).toBe(TEST_SALT.length + 16);

    const decrypted = await decryptSalt(
      legacy.encryptedSalt,
      legacy.saltNonce,
      TEST_PASSWORD,
      TEST_USERNAME,
    );
    expect(decrypted).toEqual(TEST_SALT);

    // Migration MUST have triggered a re-encryption upload with v2 bytes.
    expect(updateCurrentUserMock).toHaveBeenCalledTimes(1);
    const callArg = updateCurrentUserMock.mock.calls[0]?.[0] as
      | { encryptedSalt: string; saltNonce: string }
      | undefined;
    expect(callArg).toBeDefined();
    if (!callArg) return;
    expect(callArg).toHaveProperty('encryptedSalt');
    expect(callArg).toHaveProperty('saltNonce');
    const migratedBytes = fromBase64(callArg.encryptedSalt);
    expect(migratedBytes[0]).toBe(SALT_VERSION_V2);
    expect(migratedBytes.length).toBe(1 + TEST_SALT.length + 16);

    // The migrated payload must round-trip cleanly under v2 decryption.
    updateCurrentUserMock.mockClear();
    const re = await decryptSalt(
      callArg.encryptedSalt,
      callArg.saltNonce,
      TEST_PASSWORD,
      TEST_USERNAME,
    );
    expect(re).toEqual(TEST_SALT);
    expect(updateCurrentUserMock).not.toHaveBeenCalled();
  });

  it('still resolves successfully when the migration upload fails', async () => {
    const legacy = await craftLegacyV1Payload(
      TEST_SALT,
      TEST_PASSWORD,
      TEST_USERNAME,
    );

    updateCurrentUserMock.mockRejectedValueOnce(
      new Error('network down - server unreachable'),
    );

    const decrypted = await decryptSalt(
      legacy.encryptedSalt,
      legacy.saltNonce,
      TEST_PASSWORD,
      TEST_USERNAME,
    );

    // Migration error MUST NOT propagate; login must still succeed.
    expect(decrypted).toEqual(TEST_SALT);
    expect(updateCurrentUserMock).toHaveBeenCalledTimes(1);
  });

  it('does not migrate when v1 decryption fails (wrong password)', async () => {
    const legacy = await craftLegacyV1Payload(
      TEST_SALT,
      TEST_PASSWORD,
      TEST_USERNAME,
    );

    await expect(
      decryptSalt(
        legacy.encryptedSalt,
        legacy.saltNonce,
        'wrong-password',
        TEST_USERNAME,
      ),
    ).rejects.toBeInstanceOf(SaltDecryptionError);

    // No upload should have been attempted because v1 decrypt failed.
    expect(updateCurrentUserMock).not.toHaveBeenCalled();
  });
});

describe('Rust-core Argon2id KDF parameters', () => {
  it('matches libsodium BLAKE2b salt and Argon2id master-key reference bytes', async () => {
    await sodium.ready;
    const params = getArgon2Params();
    const encodedDomainUsername = new TextEncoder().encode(
      SALT_ENCRYPTION_DOMAIN_V2 + TEST_USERNAME,
    );
    const sodiumSalt = sodium.crypto_generichash(16, encodedDomainUsername);
    const rustSalt = deriveSessionSaltFromUsername(
      SALT_ENCRYPTION_DOMAIN_V2,
      TEST_USERNAME,
    );

    expect(rustSalt).toEqual(sodiumSalt);
    expect(rustSalt.length).toBe(16);
    expect(rustSalt).not.toEqual(new TextEncoder().encode(TEST_USERNAME).slice(0, 16));

    const passwordBytesForRust = new TextEncoder().encode(TEST_PASSWORD);
    const passwordBytesForSodium = new TextEncoder().encode(TEST_PASSWORD);
    let rustMasterKey: Uint8Array | null = null;
    let sodiumMasterKey: Uint8Array | null = null;
    try {
      const handle = deriveMasterKeyFromPassword(
        passwordBytesForRust,
        rustSalt,
        params.iterations,
        params.memory,
      );
      rustMasterKey = consumeMasterKeyHandleForAesGcm(handle);
      sodiumMasterKey = sodium.crypto_pwhash(
        32,
        passwordBytesForSodium,
        sodiumSalt,
        params.iterations,
        params.memory * 1024,
        sodium.crypto_pwhash_ALG_ARGON2ID13,
      );
      expect(rustMasterKey).toEqual(sodiumMasterKey);
    } finally {
      sodium.memzero(passwordBytesForRust);
      sodium.memzero(passwordBytesForSodium);
      sodium.memzero(sodiumSalt);
      sodium.memzero(rustSalt);
      if (rustMasterKey) sodium.memzero(rustMasterKey);
      if (sodiumMasterKey) sodium.memzero(sodiumMasterKey);
    }
  });
});
