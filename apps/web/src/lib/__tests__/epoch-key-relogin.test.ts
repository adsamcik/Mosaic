/**
 * v1.0.x `v101-epoch-key-not-restored-on-relogin` regression coverage.
 *
 * Failure mode (rerun-08, P0-IDENTITY-4):
 *   1. New user registers, uploads a photo (sealed to derived identity).
 *   2. User explicitly logs out — crypto worker terminated, epoch cache
 *      cleared, identity handle closed.
 *   3. User logs back in with the same password.
 *   4. Album opens, but `photoCount === 0` — every shard decrypt fails
 *      because the fresh worker minted a brand-new random identity
 *      (rust code 222 / BundleSealOpenFailed) instead of re-opening the
 *      one persisted on the server.
 *
 * Root cause class: `session.localLogin` must thread the
 * `wrappedIdentitySeed` returned by `localAuthLogin` into
 * `cryptoClient.initWithWrappedKey` so the worker calls
 * `openIdentityForAccount(seed)` instead of falling back to
 * `createIdentityForAccount` (which mints a random identity).
 *
 * Pre-existing tests cover boundaries 1 and 2:
 *   - `local-auth-identity-seed.test.ts` pins that `localAuthRegister`
 *     uploads the seed and `localAuthLogin` returns it.
 *   - `bundle-handle-flow.test.ts` (rotate-password-identity-invariant)
 *     pins that the WASM core round-trips a bundle across handle-registry
 *     teardown when the wrapped identity seed survives.
 *
 * This file pins boundary 3: the session glue itself. Without these
 * assertions a future refactor of `session.localLogin` could silently
 * stop forwarding the seed (the regression that produced rerun-08), and
 * neither of the above suites would catch it because they mock the
 * surface in question.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { initializeRustWasmForTests } from '../../../tests/wasm-test-init';
import type { User } from '../api-types';

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api');
  return {
    ...actual,
    getApi: vi.fn(),
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
  isLocalAuthMode: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../settings-service', () => ({
  getIdleTimeoutMs: vi.fn(() => 30 * 60 * 1000),
  getKeyCacheDurationMs: vi.fn(() => 0),
  subscribeToSettings: vi.fn(() => () => {}),
}));

const baseUser: User = {
  id: 'user-relogin-1',
  authSub: 'alice@e2e.local',
  identityPubkey: 'aWRlbnRpdHlQdWJrZXk=',
  createdAt: '2024-01-01T00:00:00Z',
  kdfMemoryKib: 65536,
  kdfIterations: 3,
  kdfParallelism: 1,
  kdfAlgVersion: 0x13,
};

const USER_SALT = new Uint8Array(16).fill(0x11);
const ACCOUNT_SALT = new Uint8Array(16).fill(0x22);
const WRAPPED_ACCOUNT_KEY = new Uint8Array(72).fill(0x33);
// 32-byte wrapped seed envelope — opaque ciphertext from the server.
const WRAPPED_IDENTITY_SEED = new Uint8Array(64).fill(0x44);

function makeCryptoClientMock() {
  return {
    init: vi.fn(),
    initWithWrappedKey: vi.fn(),
    deriveIdentity: vi.fn(),
    wrapDbBlob: vi.fn(async (plaintext: Uint8Array) => plaintext),
    unwrapDbBlob: vi.fn(async (wrapped: Uint8Array) => wrapped),
    getWrappedAccountKey: vi.fn(() => new Uint8Array([0xAA])),
    getWrappedIdentitySeed: vi.fn(() => WRAPPED_IDENTITY_SEED),
    getIdentityPublicKey: vi.fn(() => new Uint8Array(32)),
    serializeSessionState: vi.fn(() => null),
    encryptUserSaltEnvelopeV2: vi.fn(async (salt: Uint8Array) => ({
      ciphertext: new Uint8Array([...salt, ...new Uint8Array(16)]),
      nonce: new Uint8Array(12),
    })),
    decryptUserSaltEnvelopeV2: vi.fn(async (ciphertext: Uint8Array) =>
      ciphertext.subarray(0, Math.max(0, ciphertext.length - 16)),
    ),
    clear: vi.fn(),
  };
}

function makeDbClientMock() {
  return {
    init: vi.fn(),
    close: vi.fn(),
  };
}

async function getSessionModule() {
  vi.resetModules();

  vi.doMock('../api', async () => {
    const actual = await vi.importActual('../api');
    return { ...actual, getApi: vi.fn() };
  });
  vi.doMock('../crypto-client', () => ({
    getCryptoClient: vi.fn(),
    closeCryptoClient: vi.fn(),
  }));
  vi.doMock('../db-client', () => ({
    getDbClient: vi.fn(),
    closeDbClient: vi.fn(),
  }));
  vi.doMock('../geo-client', () => ({ closeGeoClient: vi.fn() }));
  vi.doMock('../epoch-key-store', () => ({ clearAllEpochKeys: vi.fn() }));
  vi.doMock('../album-cover-service', () => ({ clearAllCovers: vi.fn() }));
  vi.doMock('../album-metadata-service', () => ({
    clearAllCachedMetadata: vi.fn(),
  }));
  vi.doMock('../thumbhash-decoder', () => ({
    clearPlaceholderCache: vi.fn(),
  }));
  vi.doMock('../photo-service', () => ({ clearPhotoCache: vi.fn() }));
  vi.doMock('../key-cache', () => ({
    clearCacheEncryptionKey: vi.fn(),
    cacheKeys: vi.fn(),
    getCachedKeys: vi.fn(),
    hasCachedKeys: vi.fn(() => false),
  }));
  vi.doMock('../link-tier-key-store', () => ({
    clearLinkKeyEncryption: vi.fn(),
  }));
  vi.doMock('../local-auth', () => ({
    localAuthLogin: vi.fn(),
    localAuthRegister: vi.fn(),
    isLocalAuthMode: vi.fn(() => Promise.resolve(true)),
  }));
  vi.doMock('../settings-service', () => ({
    getIdleTimeoutMs: vi.fn(() => 30 * 60 * 1000),
    getKeyCacheDurationMs: vi.fn(() => 0),
    subscribeToSettings: vi.fn(() => () => {}),
  }));

  const { initializeRustWasmForTests } = await import(
    '../../../tests/wasm-test-init'
  );
  await initializeRustWasmForTests();

  const sessionModule = await import('../session');
  const apiModule = await import('../api');
  const cryptoClient = await import('../crypto-client');
  const dbClient = await import('../db-client');
  const localAuth = await import('../local-auth');
  const epochKeyStore = await import('../epoch-key-store');

  return {
    session: sessionModule.session,
    getApi: apiModule.getApi,
    getCryptoClient: cryptoClient.getCryptoClient,
    closeCryptoClient: cryptoClient.closeCryptoClient,
    getDbClient: dbClient.getDbClient,
    localAuthLogin: localAuth.localAuthLogin,
    clearAllEpochKeys: epochKeyStore.clearAllEpochKeys,
  };
}

beforeAll(async () => {
  await initializeRustWasmForTests();
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ success: true }),
  });
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('v101-epoch-key-not-restored-on-relogin: session.localLogin threads wrappedIdentitySeed', () => {
  it(
    'forwards wrappedIdentitySeed from localAuthLogin into cryptoClient.initWithWrappedKey',
    { timeout: 60_000 },
    async () => {
      const {
        session,
        getApi,
        getCryptoClient,
        getDbClient,
        localAuthLogin,
      } = await getSessionModule();

      const cryptoMock = makeCryptoClientMock();
      const dbMock = makeDbClientMock();
      const apiMock = {
        getCurrentUser: vi.fn().mockResolvedValue({ ...baseUser }),
        updateCurrentUser: vi.fn(),
        updateCurrentUserWrappedKey: vi.fn().mockResolvedValue(undefined),
      };

      (getApi as Mock).mockReturnValue(apiMock);
      (getCryptoClient as Mock).mockResolvedValue(cryptoMock);
      (getDbClient as Mock).mockResolvedValue(dbMock);

      (localAuthLogin as Mock).mockResolvedValue({
        userId: baseUser.id,
        userSalt: USER_SALT,
        accountSalt: ACCOUNT_SALT,
        isNewUser: false,
        wrappedAccountKey: WRAPPED_ACCOUNT_KEY,
        wrappedIdentitySeed: WRAPPED_IDENTITY_SEED,
        kdfParams: {
          memory: 65536,
          iterations: 3,
          parallelism: 1,
          algVersion: 0x13,
        },
      });

      await session.localLogin('alice', 'correct horse battery staple');

      expect(cryptoMock.initWithWrappedKey).toHaveBeenCalledTimes(1);
      const call = cryptoMock.initWithWrappedKey.mock.calls[0];
      expect(call).toBeDefined();
      // Positional args: (password, userSalt, accountSalt, wrappedAccountKey, kdfParams, wrappedIdentitySeed)
      expect(call?.[0]).toBe('correct horse battery staple');
      expect(call?.[3]).toEqual(WRAPPED_ACCOUNT_KEY);
      // The 6th argument is the critical regression surface. Without it
      // the worker mints a fresh random identity and every previously
      // sealed bundle fails to open (rust code 222).
      expect(call?.[5]).toBeInstanceOf(Uint8Array);
      expect(call?.[5]).toEqual(WRAPPED_IDENTITY_SEED);

      // Fallback path must NOT have been used.
      expect(cryptoMock.init).not.toHaveBeenCalled();
    },
  );

  it(
    'passes undefined (NOT null) when localAuthLogin returns no wrappedIdentitySeed (legacy user)',
    { timeout: 60_000 },
    async () => {
      const {
        session,
        getApi,
        getCryptoClient,
        getDbClient,
        localAuthLogin,
      } = await getSessionModule();

      const cryptoMock = makeCryptoClientMock();
      const dbMock = makeDbClientMock();
      const apiMock = {
        getCurrentUser: vi.fn().mockResolvedValue({ ...baseUser }),
        updateCurrentUser: vi.fn(),
        updateCurrentUserWrappedKey: vi.fn().mockResolvedValue(undefined),
      };

      (getApi as Mock).mockReturnValue(apiMock);
      (getCryptoClient as Mock).mockResolvedValue(cryptoMock);
      (getDbClient as Mock).mockResolvedValue(dbMock);

      (localAuthLogin as Mock).mockResolvedValue({
        userId: baseUser.id,
        userSalt: USER_SALT,
        accountSalt: ACCOUNT_SALT,
        isNewUser: false,
        wrappedAccountKey: WRAPPED_ACCOUNT_KEY,
        wrappedIdentitySeed: null,
        kdfParams: {
          memory: 65536,
          iterations: 3,
          parallelism: 1,
          algVersion: 0x13,
        },
      });

      await session.localLogin('alice', 'pw');

      expect(cryptoMock.initWithWrappedKey).toHaveBeenCalledTimes(1);
      const call = cryptoMock.initWithWrappedKey.mock.calls[0];
      // `null` would crash the worker contract (it expects Uint8Array |
      // undefined). The session glue must normalise null → undefined.
      expect(call?.[5]).toBeUndefined();
    },
  );

  it(
    'threads wrappedIdentitySeed on every re-login after explicit logout',
    { timeout: 60_000 },
    async () => {
      // This pins the actual P0-IDENTITY-4 scenario: logout clears
      // identity, re-login must hand the seed back to the fresh worker.
      // The bug class would manifest as the second initWithWrappedKey
      // call receiving `undefined` as the 6th arg.
      const {
        session,
        getApi,
        getCryptoClient,
        closeCryptoClient,
        getDbClient,
        localAuthLogin,
        clearAllEpochKeys,
      } = await getSessionModule();

      const cryptoMock = makeCryptoClientMock();
      const dbMock = makeDbClientMock();
      const apiMock = {
        getCurrentUser: vi.fn().mockResolvedValue({ ...baseUser }),
        updateCurrentUser: vi.fn(),
        updateCurrentUserWrappedKey: vi.fn().mockResolvedValue(undefined),
      };

      (getApi as Mock).mockReturnValue(apiMock);
      (getCryptoClient as Mock).mockResolvedValue(cryptoMock);
      (getDbClient as Mock).mockResolvedValue(dbMock);

      const loginResult = {
        userId: baseUser.id,
        userSalt: USER_SALT,
        accountSalt: ACCOUNT_SALT,
        isNewUser: false,
        wrappedAccountKey: WRAPPED_ACCOUNT_KEY,
        wrappedIdentitySeed: WRAPPED_IDENTITY_SEED,
        kdfParams: {
          memory: 65536,
          iterations: 3,
          parallelism: 1,
          algVersion: 0x13,
        },
      };
      (localAuthLogin as Mock).mockResolvedValue(loginResult);

      // First login (PHASE 1 of the e2e scenario).
      await session.localLogin('alice', 'pw');

      // PHASE 3: explicit logout. logout() must clear epoch keys AND
      // terminate the crypto worker so the next login starts fresh.
      await session.logout();
      expect(clearAllEpochKeys).toHaveBeenCalled();
      expect(closeCryptoClient).toHaveBeenCalled();

      // PHASE 4: re-login with the same password. The seed must once
      // again flow into the new worker.
      await session.localLogin('alice', 'pw');

      expect(cryptoMock.initWithWrappedKey).toHaveBeenCalledTimes(2);
      const firstSeed = cryptoMock.initWithWrappedKey.mock.calls[0]?.[5];
      const secondSeed = cryptoMock.initWithWrappedKey.mock.calls[1]?.[5];
      expect(firstSeed).toEqual(WRAPPED_IDENTITY_SEED);
      expect(secondSeed).toEqual(WRAPPED_IDENTITY_SEED);
      // Specifically guard against the regression where the seed silently
      // becomes undefined on the second call.
      expect(secondSeed).toBeInstanceOf(Uint8Array);
      expect((secondSeed as Uint8Array | undefined)?.length).toBeGreaterThan(
        0,
      );
    },
  );
});
