/**
 * Link Tier Key Store — security regression tests for finding H3.
 *
 * H3 (Critical): The AES-GCM key protecting wrapped link tier keys was
 * generated with extractable=true and its raw bytes were persisted to
 * sessionStorage as base64. Any same-origin script (XSS, malicious
 * extension) could read sessionStorage and decrypt the IndexedDB-stored
 * link tier keys, defeating the WebCrypto isolation that key-cache.ts
 * already gets right.
 *
 * These tests lock in the post-fix behaviour:
 *   1. The link encryption key MUST be non-extractable.
 *   2. The raw key MUST NOT be written to sessionStorage.
 *   3. Encrypt/decrypt round-trip still works within a single session.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessTier } from '@mosaic/crypto';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Minimal in-memory IndexedDB shim (happy-dom does not provide one).
// Only implements what link-tier-key-store actually uses: open(),
// transaction().objectStore().{put,get,delete,clear}, and the
// onupgradeneeded -> onsuccess request lifecycle.
// ---------------------------------------------------------------------------

interface FakeRequest<T = unknown> {
  onerror: ((this: FakeRequest<T>, ev: Event) => unknown) | null;
  onsuccess: ((this: FakeRequest<T>, ev: Event) => unknown) | null;
  onupgradeneeded?: ((this: FakeRequest<T>, ev: Event) => unknown) | null;
  result: T;
  error: unknown;
}

function installFakeIndexedDB(): void {
  const stores = new Map<string, Map<string, unknown>>();

  function makeRequest<T>(
    fulfill: (req: FakeRequest<T>) => void,
  ): FakeRequest<T> {
    const req: FakeRequest<T> = {
      onerror: null,
      onsuccess: null,
      result: undefined as unknown as T,
      error: null,
    };
    queueMicrotask(() => fulfill(req));
    return req;
  }

  function makeFakeDb() {
    const db = {
      objectStoreNames: {
        contains: (name: string) => stores.has(name),
      },
      createObjectStore: (name: string, _opts?: unknown) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return {};
      },
      transaction: (_storeName: string | string[], _mode?: string) => {
        const tx: {
          oncomplete: (() => void) | null;
          onerror: (() => void) | null;
          objectStore: (n: string) => unknown;
        } = {
          oncomplete: null,
          onerror: null,
          objectStore: (n: string) => {
            if (!stores.has(n)) stores.set(n, new Map());
            const records = stores.get(n)!;
            const fireComplete = () =>
              queueMicrotask(() => tx.oncomplete?.());
            return {
              put: (value: { linkId: string } & Record<string, unknown>) =>
                makeRequest<void>((r) => {
                  records.set(value.linkId, value as unknown);
                  r.onsuccess?.call(r, new Event('success'));
                  fireComplete();
                }),
              get: (key: string) =>
                makeRequest((r) => {
                  r.result = records.get(key);
                  r.onsuccess?.call(r, new Event('success'));
                  fireComplete();
                }),
              delete: (key: string) =>
                makeRequest<void>((r) => {
                  records.delete(key);
                  r.onsuccess?.call(r, new Event('success'));
                  fireComplete();
                }),
              clear: () =>
                makeRequest<void>((r) => {
                  records.clear();
                  r.onsuccess?.call(r, new Event('success'));
                  fireComplete();
                }),
            };
          },
        };
        return tx;
      },
      close: () => {},
    };
    return db;
  }

  const fakeIDB = {
    open(_name: string, _version?: number) {
      const req: FakeRequest<ReturnType<typeof makeFakeDb>> & {
        onupgradeneeded: ((ev: Event) => unknown) | null;
      } = {
        onerror: null,
        onsuccess: null,
        onupgradeneeded: null,
        result: undefined as unknown as ReturnType<typeof makeFakeDb>,
        error: null,
      };
      queueMicrotask(() => {
        const db = makeFakeDb();
        req.result = db;
        if (!stores.has('keys')) {
          const upgradeEvent = { target: req } as unknown as Event;
          req.onupgradeneeded?.(upgradeEvent);
        }
        req.onsuccess?.call(req, new Event('success'));
      });
      return req;
    },
    deleteDatabase: (_name: string) =>
      makeRequest<void>((r) => {
        stores.clear();
        r.onsuccess?.call(r, new Event('success'));
      }),
  };

  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    writable: true,
    value: fakeIDB,
  });
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const LINK_KEY_STORAGE_KEY = 'mosaic:linkKeyEncryption';

function makeTierKey(epochId: number, tier: AccessTier): {
  epochId: number;
  tier: AccessTier;
  key: Uint8Array;
} {
  const key = new Uint8Array(32);
  // Deterministic content so we can assert round-trip.
  for (let i = 0; i < 32; i++) key[i] = (epochId * 7 + tier * 13 + i) & 0xff;
  return { epochId, tier, key };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('link-tier-key-store (H3 security regression)', () => {
  beforeEach(async () => {
    installFakeIndexedDB();
    sessionStorage.clear();
    vi.restoreAllMocks();
    // Reset the module so the in-memory `linkEncryptionKey` is fresh per test.
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('generates a non-extractable AES-GCM key (exportKey rejects)', async () => {
    const encryptSpy = vi.spyOn(crypto.subtle, 'encrypt');

    const { saveTierKeys } = await import('../link-tier-key-store');

    const tierKeys = new Map<number, Map<AccessTier, ReturnType<typeof makeTierKey>>>();
    const inner = new Map<AccessTier, ReturnType<typeof makeTierKey>>();
    inner.set(AccessTier.THUMB, makeTierKey(1, AccessTier.THUMB));
    tierKeys.set(1, inner);

    await saveTierKeys('linkA', 'albumA', AccessTier.THUMB, tierKeys);

    expect(encryptSpy).toHaveBeenCalled();
    const capturedKey = encryptSpy.mock.calls[0]?.[1] as CryptoKey;
    expect(capturedKey).toBeDefined();
    expect(capturedKey.type).toBe('secret');
    // The non-extractable flag is the core of the H3 fix.
    expect(capturedKey.extractable).toBe(false);

    // Direct proof: exportKey('raw', ...) must reject for non-extractable keys.
    await expect(
      crypto.subtle.exportKey('raw', capturedKey),
    ).rejects.toThrow();
  });

  it('does not persist the raw encryption key to sessionStorage', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    const { saveTierKeys } = await import('../link-tier-key-store');

    const tierKeys = new Map<number, Map<AccessTier, ReturnType<typeof makeTierKey>>>();
    const inner = new Map<AccessTier, ReturnType<typeof makeTierKey>>();
    inner.set(AccessTier.PREVIEW, makeTierKey(2, AccessTier.PREVIEW));
    tierKeys.set(2, inner);

    await saveTierKeys('linkB', 'albumB', AccessTier.PREVIEW, tierKeys);

    // The link encryption key must never be written to sessionStorage.
    const linkKeyWrites = setItemSpy.mock.calls.filter(
      (call) => call[0] === LINK_KEY_STORAGE_KEY,
    );
    expect(linkKeyWrites).toHaveLength(0);
    expect(sessionStorage.getItem(LINK_KEY_STORAGE_KEY)).toBeNull();
  });

  it('ignores any pre-existing sessionStorage entry (does not import a stale key)', async () => {
    // Simulate a leftover entry from an older buggy version. The new code must
    // not consume it: any key bytes there are by definition compromised.
    const fakeBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) fakeBytes[i] = i;
    const fakeBase64 = btoa(String.fromCharCode(...fakeBytes));
    sessionStorage.setItem(LINK_KEY_STORAGE_KEY, fakeBase64);

    const importSpy = vi.spyOn(crypto.subtle, 'importKey');
    const generateSpy = vi.spyOn(crypto.subtle, 'generateKey');

    const { saveTierKeys } = await import('../link-tier-key-store');

    const tierKeys = new Map<number, Map<AccessTier, ReturnType<typeof makeTierKey>>>();
    const inner = new Map<AccessTier, ReturnType<typeof makeTierKey>>();
    inner.set(AccessTier.FULL, makeTierKey(3, AccessTier.FULL));
    tierKeys.set(3, inner);

    await saveTierKeys('linkC', 'albumC', AccessTier.FULL, tierKeys);

    // Must have generated a fresh key, not imported the stored one.
    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(importSpy).not.toHaveBeenCalled();
  });

  it('round-trips encrypted tier keys within a session', async () => {
    const { saveTierKeys, getTierKeys } = await import(
      '../link-tier-key-store'
    );

    const original = new Map<number, Map<AccessTier, ReturnType<typeof makeTierKey>>>();
    const inner = new Map<AccessTier, ReturnType<typeof makeTierKey>>();
    inner.set(AccessTier.THUMB, makeTierKey(7, AccessTier.THUMB));
    inner.set(AccessTier.PREVIEW, makeTierKey(7, AccessTier.PREVIEW));
    original.set(7, inner);

    await saveTierKeys('linkRT', 'albumRT', AccessTier.PREVIEW, original);

    const loaded = await getTierKeys('linkRT');
    expect(loaded).not.toBeNull();
    expect(loaded!.albumId).toBe('albumRT');
    expect(loaded!.accessTier).toBe(AccessTier.PREVIEW);

    const loadedInner = loaded!.tierKeys.get(7);
    expect(loadedInner).toBeDefined();

    const thumb = loadedInner!.get(AccessTier.THUMB);
    const preview = loadedInner!.get(AccessTier.PREVIEW);
    expect(thumb).toBeDefined();
    expect(preview).toBeDefined();

    const expectedThumb = makeTierKey(7, AccessTier.THUMB).key;
    const expectedPreview = makeTierKey(7, AccessTier.PREVIEW).key;
    expect(Array.from(thumb!.key!)).toEqual(Array.from(expectedThumb));
    expect(Array.from(preview!.key!)).toEqual(Array.from(expectedPreview));
  });

  it('clearLinkKeyEncryption drops the in-memory key without retaining state', async () => {
    const mod = await import('../link-tier-key-store');

    const tierKeys = new Map<number, Map<AccessTier, ReturnType<typeof makeTierKey>>>();
    const inner = new Map<AccessTier, ReturnType<typeof makeTierKey>>();
    inner.set(AccessTier.THUMB, makeTierKey(9, AccessTier.THUMB));
    tierKeys.set(9, inner);

    await mod.saveTierKeys('linkD', 'albumD', AccessTier.THUMB, tierKeys);

    // After clearing, a subsequent save must trigger a brand-new key.
    const generateSpy = vi.spyOn(crypto.subtle, 'generateKey');
    mod.clearLinkKeyEncryption();

    await mod.saveTierKeys('linkE', 'albumE', AccessTier.THUMB, tierKeys);

    expect(generateSpy).toHaveBeenCalledTimes(1);
    // Still no raw key bytes in sessionStorage afterwards.
    expect(sessionStorage.getItem(LINK_KEY_STORAGE_KEY)).toBeNull();
  });
});
