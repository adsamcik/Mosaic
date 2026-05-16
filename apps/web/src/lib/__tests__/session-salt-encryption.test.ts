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
  closeAccountKeyHandle,
  consumeMasterKeyHandleForAesGcm,
  createAccount,
  deriveMasterKeyFromPassword,
  deriveSessionSaltFromUsername,
  decryptUserSaltEnvelopeV2 as rustDecryptUserSaltEnvelopeV2,
  encryptUserSaltEnvelopeV2 as rustEncryptUserSaltEnvelopeV2,
  initSync,
} from '../../generated/mosaic-wasm/mosaic_wasm.js';
import { WorkerCryptoErrorCode } from '../../workers/types';

// ---------------------------------------------------------------------------
// Mocks (registered before the SUT import)
// ---------------------------------------------------------------------------

const updateCurrentUserMock = vi.fn();
let accountHandleOpen = true;

const cryptoClientMock = {
  encryptUserSaltEnvelopeV2: vi.fn(async (salt: Uint8Array) => {
    if (!accountHandleOpen) {
      throw {
        name: 'WorkerCryptoError',
        code: WorkerCryptoErrorCode.WorkerNotInitialized,
        message: 'crypto worker not initialised - call init() / initWithWrappedKey() first',
      };
    }
    const tag = new Uint8Array(16);
    for (const byte of salt) tag[0] = (tag[0] ?? 0) ^ byte;
    const ciphertext = new Uint8Array(salt.length + tag.length);
    ciphertext.set(salt, 0);
    ciphertext.set(tag, salt.length);
    return { ciphertext, nonce: new Uint8Array(12).fill(7) };
  }),
  decryptUserSaltEnvelopeV2: vi.fn(async (ciphertext: Uint8Array) => {
    if (!accountHandleOpen) {
      throw {
        name: 'WorkerCryptoError',
        code: WorkerCryptoErrorCode.WorkerNotInitialized,
        message: 'crypto worker not initialised - call init() / initWithWrappedKey() first',
      };
    }
    if (ciphertext.length < 17) {
      throw {
        name: 'WorkerCryptoError',
        code: WorkerCryptoErrorCode.InvalidEnvelope,
        message: 'invalid salt envelope',
      };
    }
    const salt = ciphertext.subarray(0, ciphertext.length - 16);
    const tag = ciphertext.subarray(ciphertext.length - 16);
    let checksum = 0;
    for (const byte of salt) checksum ^= byte;
    if (tag[0] !== checksum) {
      throw {
        name: 'WorkerCryptoError',
        code: WorkerCryptoErrorCode.AuthenticationFailed,
        message: 'invalid salt envelope tag',
      };
    }
    return new Uint8Array(salt);
  }),
};

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
  getCryptoClient: vi.fn(() => cryptoClientMock),
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SALT_VERSION_V2 = 0x02;
const LEGACY_PBKDF2_ITERATIONS = 100000;
const SALT_ENCRYPTION_DOMAIN_V2 = 'mosaic-salt-encryption-v2|';
const TEST_KDF_PARAMS = {
  memory: 8 * 1024,
  iterations: 1,
  parallelism: 1,
  algVersion: 0x13,
} as const;
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
  accountHandleOpen = true;
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
      TEST_KDF_PARAMS,
    );

    const decoded = fromBase64(encryptedSalt);
    expect(decoded[0]).toBe(SALT_VERSION_V2);
    expect(decoded.length).toBe(1 + TEST_SALT.length + 16);

    const decrypted = await decryptSalt(
      encryptedSalt,
      saltNonce,
      TEST_PASSWORD,
      TEST_USERNAME,
      TEST_KDF_PARAMS,
    );
    expect(decrypted).toEqual(TEST_SALT);
    expect(updateCurrentUserMock).not.toHaveBeenCalled();
  });

  it('propagates missing-account-handle errors instead of falling back to v1', async () => {
    const { encryptedSalt, saltNonce } = await encryptSalt(
      TEST_SALT,
      TEST_PASSWORD,
      TEST_USERNAME,
      TEST_KDF_PARAMS,
    );

    accountHandleOpen = false;

    await expect(
      decryptSalt(
        encryptedSalt,
        saltNonce,
        TEST_PASSWORD,
        TEST_USERNAME,
        TEST_KDF_PARAMS,
      ),
    ).rejects.toMatchObject({
      name: 'WorkerCryptoError',
      code: WorkerCryptoErrorCode.WorkerNotInitialized,
    });
    expect(updateCurrentUserMock).not.toHaveBeenCalled();
  });

  it('Rust v2 salt envelopes reject a different account handle', () => {
    const passwordBytes = new TextEncoder().encode(TEST_PASSWORD);
    const wrongPasswordBytes = new TextEncoder().encode('wrong-password');
    const userSalt = new Uint8Array(16).fill(0x31);
    const accountSalt = new Uint8Array(16).fill(0x42);
    const owner = createAccount(
      passwordBytes,
      userSalt,
      accountSalt,
      64 * 1024,
      3,
      TEST_KDF_PARAMS.parallelism,
    );
    const wrong = createAccount(
      wrongPasswordBytes,
      userSalt,
      accountSalt,
      64 * 1024,
      3,
      TEST_KDF_PARAMS.parallelism,
    );
    const envelope = rustEncryptUserSaltEnvelopeV2(owner.handle, TEST_SALT);
    const decryptedWithWrongHandle = rustDecryptUserSaltEnvelopeV2(
      wrong.handle,
      envelope.ciphertext,
      envelope.nonce,
    );

    try {
      expect(owner.code).toBe(0);
      expect(wrong.code).toBe(0);
      expect(envelope.code).toBe(0);
      expect(decryptedWithWrongHandle.code).toBe(
        WorkerCryptoErrorCode.AuthenticationFailed,
      );
    } finally {
      decryptedWithWrongHandle.free();
      envelope.free();
      if (owner.handle !== 0n) closeAccountKeyHandle(owner.handle);
      if (wrong.handle !== 0n) closeAccountKeyHandle(wrong.handle);
      owner.free();
      wrong.free();
    }
  });

  it('throws SaltDecryptionError when the v2 ciphertext is tampered with', async () => {
    const { encryptedSalt, saltNonce } = await encryptSalt(
      TEST_SALT,
      TEST_PASSWORD,
      TEST_USERNAME,
      TEST_KDF_PARAMS,
    );

    const bytes = fromBase64(encryptedSalt);
    // Flip a byte inside the AES-GCM ciphertext (skip the version marker).
    const original = bytes[5] ?? 0;
    bytes[5] = original ^ 0xff;
    const tamperedB64 = toBase64(bytes);

    await expect(
      decryptSalt(
        tamperedB64,
        saltNonce,
        TEST_PASSWORD,
        TEST_USERNAME,
        TEST_KDF_PARAMS,
      ),
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
      TEST_KDF_PARAMS,
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
      TEST_KDF_PARAMS,
    );
    expect(re).toEqual(TEST_SALT);
    expect(updateCurrentUserMock).not.toHaveBeenCalled();
  });

  it('rejects raw UTF-8 v1 payloads after the normalized Rust legacy cutover', async () => {
    const rawNfdPassword = 'cafe\u0301';
    const legacy = await craftLegacyV1Payload(
      TEST_SALT,
      rawNfdPassword,
      TEST_USERNAME,
    );

    await expect(
      decryptSalt(
        legacy.encryptedSalt,
        legacy.saltNonce,
        rawNfdPassword,
        TEST_USERNAME,
        TEST_KDF_PARAMS,
      ),
    ).rejects.toBeInstanceOf(SaltDecryptionError);
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
      TEST_KDF_PARAMS,
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
        TEST_KDF_PARAMS,
      ),
    ).rejects.toBeInstanceOf(SaltDecryptionError);

    // No upload should have been attempted because v1 decrypt failed.
    expect(updateCurrentUserMock).not.toHaveBeenCalled();
  });
});

describe('Rust-core Argon2id KDF parameters', () => {
  it('matches libsodium BLAKE2b salt and Argon2id master-key reference bytes', async () => {
    await sodium.ready;
    const params = TEST_KDF_PARAMS;
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

  it('derives deterministic master-key bytes for pinned params regardless of UA', async () => {
    const salt = new Uint8Array(16).fill(4);
    const passwordA = new TextEncoder().encode(TEST_PASSWORD);
    const passwordB = new TextEncoder().encode(TEST_PASSWORD);
    let masterA: Uint8Array | null = null;
    let masterB: Uint8Array | null = null;
    try {
      masterA = consumeMasterKeyHandleForAesGcm(
        deriveMasterKeyFromPassword(
          passwordA,
          salt,
          TEST_KDF_PARAMS.iterations,
          TEST_KDF_PARAMS.memory,
        ),
      );
      masterB = consumeMasterKeyHandleForAesGcm(
        deriveMasterKeyFromPassword(
          passwordB,
          salt,
          TEST_KDF_PARAMS.iterations,
          TEST_KDF_PARAMS.memory,
        ),
      );

      expect(masterA).toEqual(masterB);
    } finally {
      sodium.memzero(passwordA);
      sodium.memzero(passwordB);
      sodium.memzero(salt);
      if (masterA) sodium.memzero(masterA);
      if (masterB) sodium.memzero(masterB);
    }
  });

  it('derives different master-key bytes when pinned params differ', async () => {
    const salt = new Uint8Array(16).fill(5);
    const passwordA = new TextEncoder().encode(TEST_PASSWORD);
    const passwordB = new TextEncoder().encode(TEST_PASSWORD);
    let masterA: Uint8Array | null = null;
    let masterB: Uint8Array | null = null;
    try {
      masterA = consumeMasterKeyHandleForAesGcm(
        deriveMasterKeyFromPassword(passwordA, salt, 1, 8 * 1024),
      );
      masterB = consumeMasterKeyHandleForAesGcm(
        deriveMasterKeyFromPassword(passwordB, salt, 2, 8 * 1024),
      );

      expect(masterA).not.toEqual(masterB);
    } finally {
      sodium.memzero(passwordA);
      sodium.memzero(passwordB);
      sodium.memzero(salt);
      if (masterA) sodium.memzero(masterA);
      if (masterB) sodium.memzero(masterB);
    }
  });
});
