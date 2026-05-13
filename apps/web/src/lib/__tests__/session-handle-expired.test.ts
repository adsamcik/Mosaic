import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../crypto-client', () => ({
  getCryptoClient: vi.fn(),
  closeCryptoClient: vi.fn(() => Promise.resolve()),
}));
vi.mock('../db-client', () => ({
  getDbClient: vi.fn(),
  closeDbClient: vi.fn(() => Promise.resolve()),
}));
vi.mock('../geo-client', () => ({ closeGeoClient: vi.fn() }));
vi.mock('../epoch-key-store', () => ({ clearAllEpochKeys: vi.fn() }));
vi.mock('../album-cover-service', () => ({ clearAllCovers: vi.fn() }));
vi.mock('../album-metadata-service', () => ({ clearAllCachedMetadata: vi.fn() }));
vi.mock('../thumbhash-decoder', () => ({ clearPlaceholderCache: vi.fn() }));
vi.mock('../photo-service', () => ({ clearPhotoCache: vi.fn() }));
vi.mock('../key-cache', () => ({
  cacheKeys: vi.fn(),
  clearCacheEncryptionKey: vi.fn(),
  getCachedKeys: vi.fn(),
  hasCachedKeys: vi.fn(() => false),
}));
vi.mock('../link-tier-key-store', () => ({ clearLinkKeyEncryption: vi.fn() }));
vi.mock('../local-auth', () => ({
  localAuthLogin: vi.fn(),
  localAuthRegister: vi.fn(),
}));
vi.mock('../settings-service', () => ({
  getIdleTimeoutMs: vi.fn(() => 30 * 60 * 1000),
  subscribeToSettings: vi.fn(() => () => {}),
}));
vi.mock('../sync-coordinator', () => ({
  syncCoordinator: { dispose: vi.fn() },
}));

class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  name: string;
  postMessage = vi.fn();
  addEventListener = vi.fn();
  close = vi.fn();

  constructor(name: string) {
    this.name = name;
    FakeBroadcastChannel.instances.push(this);
  }
}

describe('session.handleSessionExpired', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    FakeBroadcastChannel.instances = [];
    // @ts-expect-error test double
    globalThis.BroadcastChannel = FakeBroadcastChannel;
    global.fetch = vi.fn();
    sessionStorage.setItem('mosaic:sessionState', 'active');
  });

  it('is idempotent, clears local auth state, notifies once, and does not call the API', async () => {
    const { session } = await import('../session');
    const listener = vi.fn();
    session.subscribe(listener);

    (session as unknown as { _isLoggedIn: boolean })._isLoggedIn = true;
    (session as unknown as { _currentUser: object | null })._currentUser = {
      id: 'user-1',
    };

    session.handleSessionExpired('cookie-expired');
    session.handleSessionExpired('cookie-expired');
    session.handleSessionExpired('server-revoked');

    expect(session.isLoggedIn).toBe(false);
    expect(session.currentUser).toBeNull();
    expect(sessionStorage.getItem('mosaic:sessionState')).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();

    const channel = FakeBroadcastChannel.instances.at(-1);
    expect(channel?.postMessage).toHaveBeenCalledTimes(1);
    expect(channel?.postMessage).toHaveBeenCalledWith({
      type: 'session-expired',
      reason: 'cookie-expired',
    });
  });
});
