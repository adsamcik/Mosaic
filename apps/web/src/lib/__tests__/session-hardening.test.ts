/**
 * Session lifecycle hardening tests (M3, M4, M9, L1, L2, L3).
 *
 * Each test covers one finding from the Mosaic security audit. The
 * surface under test is `apps/web/src/lib/session.ts` (the
 * SessionManager singleton) plus the new
 * `api.updateCurrentUserWrappedKey` method (M9).
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';

// =============================================================================
// Mock collaborators
// ---------------------------------------------------------------------------
// session.ts pulls in worker clients, settings, syncCoordinator, etc. We
// keep the mock surface minimal but mirror what the existing
// `tests/lib/session.test.ts` does so the SessionManager runs to
// completion without touching real workers.
// =============================================================================

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

vi.mock('../local-auth', () => ({
  localAuthLogin: vi.fn(),
  localAuthRegister: vi.fn(),
  isLocalAuthMode: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('../settings-service', () => ({
  getIdleTimeoutMs: vi.fn(() => 30 * 60 * 1000),
  subscribeToSettings: vi.fn(() => () => {}),
}));

import { getApi } from '../api';
import { getCryptoClient } from '../crypto-client';
import { getDbClient } from '../db-client';
import type { User } from '../api-types';

// Unused imports above are kept so vi.mock factories above remain
// active for downstream require() resolution; reference them so tsc's
// noUnusedLocals doesn't complain.
void getApi;
void getCryptoClient;
void getDbClient;

/**
 * Reset the module registry, re-apply all mocks via doMock, and import
 * a fresh SessionManager. Each test gets its own clean instance — the
 * `session` export in `session.ts` is module-scoped so this is the
 * only way to avoid state bleeding between tests.
 */
async function getSessionModule() {
  vi.resetModules();

  vi.doMock('../api', async () => {
    const actual = await vi.importActual('../api');
    return {
      ...actual,
      getApi: vi.fn(),
    };
  });

  vi.doMock('../crypto-client', () => ({
    getCryptoClient: vi.fn(),
    closeCryptoClient: vi.fn(),
  }));

  vi.doMock('../db-client', () => ({
    getDbClient: vi.fn(),
    closeDbClient: vi.fn(),
  }));

  vi.doMock('../geo-client', () => ({
    closeGeoClient: vi.fn(),
  }));

  vi.doMock('../epoch-key-store', () => ({
    clearAllEpochKeys: vi.fn(),
  }));

  vi.doMock('../album-cover-service', () => ({
    clearAllCovers: vi.fn(),
  }));

  vi.doMock('../album-metadata-service', () => ({
    clearAllCachedMetadata: vi.fn(),
  }));

  vi.doMock('../thumbhash-decoder', () => ({
    clearPlaceholderCache: vi.fn(),
  }));

  vi.doMock('../photo-service', () => ({
    clearPhotoCache: vi.fn(),
  }));

  vi.doMock('../key-cache', () => ({
    clearCacheEncryptionKey: vi.fn(),
    cacheKeys: vi.fn(),
    getCachedKeys: vi.fn(),
    hasCachedKeys: vi.fn(() => false),
  }));

  vi.doMock('../local-auth', () => ({
    localAuthLogin: vi.fn(),
    localAuthRegister: vi.fn(),
    isLocalAuthMode: vi.fn(() => Promise.resolve(false)),
  }));

  vi.doMock('../settings-service', () => ({
    getIdleTimeoutMs: vi.fn(() => 30 * 60 * 1000),
    subscribeToSettings: vi.fn(() => () => {}),
  }));

  const sessionModule = await import('../session');
  const apiModule = await import('../api');
  const cryptoClient = await import('../crypto-client');
  const dbClient = await import('../db-client');
  const localAuth = await import('../local-auth');

  return {
    session: sessionModule.session,
    WrappedKeyConflictError: sessionModule.WrappedKeyConflictError,
    getApi: apiModule.getApi,
    getCryptoClient: cryptoClient.getCryptoClient,
    getDbClient: dbClient.getDbClient,
    localAuthLogin: localAuth.localAuthLogin,
  };
}

// =============================================================================
// Shared test fixtures
// =============================================================================

const baseUser: User = {
  id: 'user-123',
  authSub: 'testuser@example.com',
  identityPubkey: 'mock-pubkey',
  createdAt: '2024-01-01T00:00:00Z',
};

function makeCryptoClientMock() {
  return {
    init: vi.fn(),
    initWithWrappedKey: vi.fn(),
    deriveIdentity: vi.fn(),
    getSessionKey: vi.fn(() => new Uint8Array(32)),
    getWrappedAccountKey: vi.fn(() => new Uint8Array([0xAA, 0xBB, 0xCC])),
    getIdentityPublicKey: vi.fn(() => new Uint8Array(32)),
    exportKeys: vi.fn(() => null),
    clear: vi.fn(),
  };
}

function makeDbClientMock() {
  return {
    init: vi.fn(),
    close: vi.fn(),
  };
}

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

// ===========================================================================
// M3: login re-entrancy
// ---------------------------------------------------------------------------
// All login-style entry points must be serialised by a shared in-flight
// promise. Concurrent callers reject with "Login already in progress"
// instead of clobbering the cached-keys store.
// ===========================================================================

describe('M3: login re-entrancy guard', () => {
  it('rejects a second concurrent login() with "Login already in progress"', async () => {
    const { session, getApi, getCryptoClient, getDbClient } =
      await getSessionModule();

    const cryptoMock = makeCryptoClientMock();
    const dbMock = makeDbClientMock();
    const apiMock = {
      getCurrentUser: vi.fn().mockResolvedValue({
        ...baseUser,
        wrappedAccountKey: 'AA==',
      }),
      updateCurrentUser: vi.fn(),
      updateCurrentUserWrappedKey: vi.fn().mockResolvedValue(undefined),
    };

    (getApi as Mock).mockReturnValue(apiMock);
    (getCryptoClient as Mock).mockResolvedValue(cryptoMock);
    (getDbClient as Mock).mockResolvedValue(dbMock);

    // Pre-seed a salt so login() doesn't try to generate one
    localStorage.setItem('mosaic:userSalt', 'AAAAAAAAAAAAAAAAAAAAAA==');

    // Fire both calls back-to-back without awaiting either.
    const first = session.login('p1');
    const second = session.login('p2');

    await expect(second).rejects.toThrow('Login already in progress');
    // First should still complete successfully.
    await expect(first).resolves.toBeUndefined();
  });

  it('rejects localLogin() racing with restoreSession()', async () => {
    const { session, getApi, getCryptoClient, getDbClient, localAuthLogin } =
      await getSessionModule();

    const cryptoMock = makeCryptoClientMock();
    const dbMock = makeDbClientMock();
    const apiMock = {
      getCurrentUser: vi.fn().mockResolvedValue({
        ...baseUser,
        wrappedAccountKey: 'AA==',
      }),
      updateCurrentUser: vi.fn(),
      updateCurrentUserWrappedKey: vi.fn().mockResolvedValue(undefined),
    };

    (getApi as Mock).mockReturnValue(apiMock);
    (getCryptoClient as Mock).mockResolvedValue(cryptoMock);
    (getDbClient as Mock).mockResolvedValue(dbMock);

    (localAuthLogin as Mock).mockResolvedValue({
      userId: 'user-123',
      userSalt: new Uint8Array(16).fill(7),
      accountSalt: new Uint8Array(16).fill(8),
      isNewUser: false,
      wrappedAccountKey: new Uint8Array(72),
    });

    // Pre-seed salt for restoreSession
    localStorage.setItem('mosaic:userSalt', 'AAAAAAAAAAAAAAAAAAAAAA==');

    const localLoginPromise = session.localLogin('alice', 'secret');
    const restorePromise = session.restoreSession('secret');

    // Whichever lands the in-flight promise first wins; the other rejects.
    const results = await Promise.allSettled([
      localLoginPromise,
      restorePromise,
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult[];

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = rejected[0]?.reason as Error | undefined;
    expect(reason?.message).toMatch(/Login already in progress/);
  });
});

// ===========================================================================
// M4: first-login wrapped-key TOCTOU
// ---------------------------------------------------------------------------
// Before PUT-ing a freshly generated wrapped key the login flow must
// re-fetch /users/me. If the latest copy reports a wrappedAccountKey,
// another device beat us — abort with WrappedKeyConflictError instead
// of silently overwriting the winning copy.
// ===========================================================================

describe('M4: first-login wrapped-key TOCTOU guard', () => {
  it('throws WrappedKeyConflictError and skips upload when a peer wins the race', async () => {
    const { session, WrappedKeyConflictError, getApi, getCryptoClient, getDbClient } =
      await getSessionModule();

    const cryptoMock = makeCryptoClientMock();
    const dbMock = makeDbClientMock();

    // First call: server has no wrapped key — we proceed to generate one.
    // Second call (the M4 re-fetch): server now reports a wrapped key,
    // meaning another device just uploaded.
    const apiMock = {
      getCurrentUser: vi
        .fn()
        .mockResolvedValueOnce({ ...baseUser })
        .mockResolvedValueOnce({ ...baseUser, wrappedAccountKey: 'AA==' }),
      updateCurrentUser: vi.fn().mockResolvedValue({ ...baseUser }),
      updateCurrentUserWrappedKey: vi.fn().mockResolvedValue(undefined),
    };

    (getApi as Mock).mockReturnValue(apiMock);
    (getCryptoClient as Mock).mockResolvedValue(cryptoMock);
    (getDbClient as Mock).mockResolvedValue(dbMock);

    localStorage.setItem('mosaic:userSalt', 'AAAAAAAAAAAAAAAAAAAAAA==');

    await expect(session.login('p1')).rejects.toBeInstanceOf(
      WrappedKeyConflictError,
    );

    // The wrapped-key upload must NOT have been called.
    expect(apiMock.updateCurrentUserWrappedKey).not.toHaveBeenCalled();
    // We still asked the server for the latest copy.
    expect(apiMock.getCurrentUser).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
// M9: wrapped-key upload routes through the centralised API client
// ---------------------------------------------------------------------------
// On first login the wrapped key must be PUT via api.updateCurrentUserWrappedKey
// rather than a raw fetch — so failures surface as ApiError and feed M4's
// recovery path instead of being silently swallowed.
// ===========================================================================

describe('M9: wrapped-key upload via centralised API client', () => {
  it('invokes api.updateCurrentUserWrappedKey with the freshly generated key', async () => {
    const { session, getApi, getCryptoClient, getDbClient } =
      await getSessionModule();

    const wrappedKey = new Uint8Array([1, 2, 3, 4, 5]);

    const cryptoMock = makeCryptoClientMock();
    cryptoMock.getWrappedAccountKey = vi.fn(() => wrappedKey);

    const dbMock = makeDbClientMock();

    const apiMock = {
      // First fetch: no wrapped key; second fetch (M4): still no wrapped key.
      getCurrentUser: vi
        .fn()
        .mockResolvedValueOnce({ ...baseUser })
        .mockResolvedValueOnce({ ...baseUser }),
      updateCurrentUser: vi.fn().mockResolvedValue({ ...baseUser }),
      updateCurrentUserWrappedKey: vi.fn().mockResolvedValue(undefined),
    };

    (getApi as Mock).mockReturnValue(apiMock);
    (getCryptoClient as Mock).mockResolvedValue(cryptoMock);
    (getDbClient as Mock).mockResolvedValue(dbMock);

    localStorage.setItem('mosaic:userSalt', 'AAAAAAAAAAAAAAAAAAAAAA==');

    await session.login('p1');

    expect(apiMock.updateCurrentUserWrappedKey).toHaveBeenCalledTimes(1);
    expect(apiMock.updateCurrentUserWrappedKey).toHaveBeenCalledWith(
      wrappedKey,
    );

    // No raw fetch to /api/users/me/wrapped-key — the centralised method
    // is responsible for the network call.
    const fetchCalls = (global.fetch as Mock).mock.calls.map(
      (call) => call[0] as string,
    );
    expect(
      fetchCalls.some((url) => url.includes('/users/me/wrapped-key')),
    ).toBe(false);
  });
});

// ===========================================================================
// L1: localStorage retention on logout
// ---------------------------------------------------------------------------
// `mosaic:userSalt` is intentionally retained across logout for
// multi-device support. The salt is non-secret without the password.
// ===========================================================================

describe('L1: logout retains mosaic:userSalt in localStorage', () => {
  it('preserves mosaic:userSalt while clearing sessionStorage', async () => {
    const { session, getApi, getCryptoClient, getDbClient } =
      await getSessionModule();

    const cryptoMock = makeCryptoClientMock();
    const dbMock = makeDbClientMock();
    const apiMock = {
      getCurrentUser: vi.fn().mockResolvedValue({
        ...baseUser,
        wrappedAccountKey: 'AA==',
      }),
      updateCurrentUser: vi.fn(),
      updateCurrentUserWrappedKey: vi.fn().mockResolvedValue(undefined),
    };

    (getApi as Mock).mockReturnValue(apiMock);
    (getCryptoClient as Mock).mockResolvedValue(cryptoMock);
    (getDbClient as Mock).mockResolvedValue(dbMock);

    const saltBase64 = 'BBBBBBBBBBBBBBBBBBBBBB==';
    localStorage.setItem('mosaic:userSalt', saltBase64);

    await session.login('p1');
    expect(sessionStorage.getItem('mosaic:sessionState')).toBe('active');

    await session.logout();

    expect(sessionStorage.getItem('mosaic:sessionState')).toBeNull();
    // The user salt MUST survive logout.
    expect(localStorage.getItem('mosaic:userSalt')).toBe(saltBase64);
  });
});

// ===========================================================================
// L2: cross-tab logout via BroadcastChannel
// ---------------------------------------------------------------------------
// logout() posts { type: 'logout' } so peer tabs can drop their
// in-memory state. A peer receiving the message clears local state but
// does NOT re-broadcast (preventing a feedback loop).
// ===========================================================================

interface MockBroadcastChannel {
  name: string;
  postMessage: Mock;
  addEventListener: Mock;
  removeEventListener: Mock;
  close: Mock;
  dispatchInbound: (data: unknown) => void;
}

class FakeBroadcastChannel implements MockBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];

  name: string;
  postMessage = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  close = vi.fn();
  private listeners: ((event: MessageEvent) => void)[] = [];

  constructor(name: string) {
    this.name = name;
    FakeBroadcastChannel.instances.push(this);
    // capture listeners passed via addEventListener
    this.addEventListener.mockImplementation(
      (_type: string, listener: (event: MessageEvent) => void) => {
        this.listeners.push(listener);
      },
    );
  }

  dispatchInbound(data: unknown): void {
    const event = { data } as MessageEvent;
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

describe('L2: cross-tab logout BroadcastChannel', () => {
  let originalBC: typeof globalThis.BroadcastChannel | undefined;

  beforeEach(() => {
    originalBC = globalThis.BroadcastChannel;
    FakeBroadcastChannel.instances = [];
    // @ts-expect-error - swapping in a test-only stub
    globalThis.BroadcastChannel = FakeBroadcastChannel;
  });

  afterEach(() => {
    if (originalBC) {
      globalThis.BroadcastChannel = originalBC;
    } else {
      // @ts-expect-error - restore undefined
      delete globalThis.BroadcastChannel;
    }
  });

  it('posts { type: "logout" } when logging out locally', async () => {
    const { session, getApi, getCryptoClient, getDbClient } =
      await getSessionModule();

    const cryptoMock = makeCryptoClientMock();
    const dbMock = makeDbClientMock();
    const apiMock = {
      getCurrentUser: vi.fn().mockResolvedValue({
        ...baseUser,
        wrappedAccountKey: 'AA==',
      }),
      updateCurrentUser: vi.fn(),
      updateCurrentUserWrappedKey: vi.fn().mockResolvedValue(undefined),
    };

    (getApi as Mock).mockReturnValue(apiMock);
    (getCryptoClient as Mock).mockResolvedValue(cryptoMock);
    (getDbClient as Mock).mockResolvedValue(dbMock);
    localStorage.setItem('mosaic:userSalt', 'AAAAAAAAAAAAAAAAAAAAAA==');

    await session.login('p1');

    // The SessionManager should have created exactly one channel
    // (constructor-time initialisation).
    expect(FakeBroadcastChannel.instances.length).toBeGreaterThan(0);
    const channel = FakeBroadcastChannel.instances.at(-1);
    if (!channel) throw new Error('expected a BroadcastChannel instance');
    expect(channel.name).toBe('mosaic-session');

    await session.logout();

    expect(channel.postMessage).toHaveBeenCalledWith({ type: 'logout' });
  });

  it('clears local state on inbound logout WITHOUT re-broadcasting', async () => {
    const { session, getApi, getCryptoClient, getDbClient } =
      await getSessionModule();

    const cryptoMock = makeCryptoClientMock();
    const dbMock = makeDbClientMock();
    const apiMock = {
      getCurrentUser: vi.fn().mockResolvedValue({
        ...baseUser,
        wrappedAccountKey: 'AA==',
      }),
      updateCurrentUser: vi.fn(),
      updateCurrentUserWrappedKey: vi.fn().mockResolvedValue(undefined),
    };

    (getApi as Mock).mockReturnValue(apiMock);
    (getCryptoClient as Mock).mockResolvedValue(cryptoMock);
    (getDbClient as Mock).mockResolvedValue(dbMock);
    localStorage.setItem('mosaic:userSalt', 'AAAAAAAAAAAAAAAAAAAAAA==');

    await session.login('p1');

    const channel = FakeBroadcastChannel.instances.at(-1);
    if (!channel) throw new Error('expected a BroadcastChannel instance');
    // Reset postMessage call history so we can assert "no further posts"
    channel.postMessage.mockClear();

    expect(session.isLoggedIn).toBe(true);

    // Simulate an inbound logout from another tab.
    channel.dispatchInbound({ type: 'logout' });

    // logout() runs asynchronously inside the message handler — flush.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Local state cleared.
    expect(session.isLoggedIn).toBe(false);
    // CRITICAL: no re-broadcast (skipBroadcast: true was passed).
    expect(channel.postMessage).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// L3: idle-timeout activity event coverage
// ---------------------------------------------------------------------------
// The SessionManager must subscribe to pointerdown, wheel, and
// visibilitychange in addition to the legacy keydown/scroll/mousedown
// /touchstart set. pointermove/mousemove must NOT be present (too noisy).
// ===========================================================================

describe('L3: idle-timeout activity event coverage', () => {
  it('attaches listeners for pointerdown, wheel, and visibilitychange on login', async () => {
    const { session, getApi, getCryptoClient, getDbClient } =
      await getSessionModule();

    const addEventSpy = vi.spyOn(document, 'addEventListener');

    const cryptoMock = makeCryptoClientMock();
    const dbMock = makeDbClientMock();
    const apiMock = {
      getCurrentUser: vi.fn().mockResolvedValue({
        ...baseUser,
        wrappedAccountKey: 'AA==',
      }),
      updateCurrentUser: vi.fn(),
      updateCurrentUserWrappedKey: vi.fn().mockResolvedValue(undefined),
    };

    (getApi as Mock).mockReturnValue(apiMock);
    (getCryptoClient as Mock).mockResolvedValue(cryptoMock);
    (getDbClient as Mock).mockResolvedValue(dbMock);
    localStorage.setItem('mosaic:userSalt', 'AAAAAAAAAAAAAAAAAAAAAA==');

    await session.login('p1');

    const events = addEventSpy.mock.calls.map((c) => c[0] as string);

    // The new events MUST be present.
    expect(events).toContain('pointerdown');
    expect(events).toContain('wheel');
    expect(events).toContain('visibilitychange');

    // Legacy events still present.
    expect(events).toContain('mousedown');
    expect(events).toContain('keydown');
    expect(events).toContain('touchstart');
    expect(events).toContain('scroll');

    // The deliberately-excluded noisy events must NOT be present.
    expect(events).not.toContain('pointermove');
    expect(events).not.toContain('mousemove');
  });
});
