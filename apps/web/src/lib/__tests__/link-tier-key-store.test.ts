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

const mocks = vi.hoisted(() => ({
  mintLinkTierHandleFromRawKey: vi.fn(async (rawKey: Uint8Array) =>
    `link-tier-handle-${rawKey[0] ?? 0}` as never,
  ),
}));

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

vi.mock('../crypto-client', () => ({
  getCryptoClient: vi.fn(() =>
    Promise.resolve({
      mintLinkTierHandleFromRawKey: mocks.mintLinkTierHandleFromRawKey,
    }),
  ),
}));

vi.mock('../../generated/mosaic-wasm/mosaic_wasm.js', () => ({
  default: vi.fn(async () => undefined),
  createLinkTierWrapHandle: vi.fn(() => 1n),
  closeLinkTierWrapHandle: vi.fn(() => 0),
  wrapLinkTierBlob: vi.fn((_handle: bigint, plaintext: Uint8Array) => ({
    code: 0,
    bytes: new Uint8Array(plaintext),
    free: vi.fn(),
  })),
  unwrapLinkTierBlob: vi.fn((_handle: bigint, envelope: Uint8Array) => ({
    code: 0,
    bytes: new Uint8Array(envelope),
    free: vi.fn(),
  })),
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
              openCursor: () => {
                const req: {
                  onerror: ((ev: Event) => unknown) | null;
                  onsuccess: ((ev: Event) => unknown) | null;
                  result: unknown;
                  error: unknown;
                } = {
                  onerror: null,
                  onsuccess: null,
                  result: null,
                  error: null,
                };
                const keys = Array.from(records.keys());
                let index = 0;
                const advance = () => {
                  queueMicrotask(() => {
                    if (index >= keys.length) {
                      req.result = null;
                      req.onsuccess?.call(req, new Event('success'));
                      fireComplete();
                      return;
                    }
                    const k = keys[index]!;
                    const value = records.get(k);
                    const cursor = {
                      value,
                      delete: () => {
                        records.delete(k);
                      },
                      continue: () => {
                        index += 1;
                        advance();
                      },
                    };
                    req.result = cursor;
                    req.onsuccess?.call(req, new Event('success'));
                  });
                };
                advance();
                return req;
              },
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
    vi.clearAllMocks();
    vi.restoreAllMocks();
    // Reset the module so the in-memory `linkEncryptionKey` is fresh per test.
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('routes wrapping through a Rust-owned link-tier wrap handle', async () => {
    const encryptSpy = vi.spyOn(crypto.subtle, 'encrypt');
    const wasm = await import('../../generated/mosaic-wasm/mosaic_wasm.js');

    const { saveTierKeys } = await import('../link-tier-key-store');

    const tierKeys = new Map<number, Map<AccessTier, ReturnType<typeof makeTierKey>>>();
    const inner = new Map<AccessTier, ReturnType<typeof makeTierKey>>();
    inner.set(AccessTier.THUMB, makeTierKey(1, AccessTier.THUMB));
    tierKeys.set(1, inner);

    await saveTierKeys('linkA', 'albumA', AccessTier.THUMB, tierKeys);

    expect(wasm.createLinkTierWrapHandle).toHaveBeenCalledTimes(1);
    expect(wasm.wrapLinkTierBlob).toHaveBeenCalledTimes(1);
    expect(encryptSpy).not.toHaveBeenCalled();
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
    const wasm = await import('../../generated/mosaic-wasm/mosaic_wasm.js');

    const { saveTierKeys } = await import('../link-tier-key-store');

    const tierKeys = new Map<number, Map<AccessTier, ReturnType<typeof makeTierKey>>>();
    const inner = new Map<AccessTier, ReturnType<typeof makeTierKey>>();
    inner.set(AccessTier.FULL, makeTierKey(3, AccessTier.FULL));
    tierKeys.set(3, inner);

    await saveTierKeys('linkC', 'albumC', AccessTier.FULL, tierKeys);

    // Must have minted a fresh Rust wrap handle, not imported the stored one.
    expect(wasm.createLinkTierWrapHandle).toHaveBeenCalledTimes(1);
    expect(generateSpy).not.toHaveBeenCalled();
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

    expect(thumb!.linkTierHandleId).toBe('link-tier-handle-62');
    expect(preview!.linkTierHandleId).toBe('link-tier-handle-75');
    expect(thumb!.key).toBeUndefined();
    expect(preview!.key).toBeUndefined();
  });

  it('clearLinkKeyEncryption drops the in-memory key without retaining state', async () => {
    const mod = await import('../link-tier-key-store');

    const tierKeys = new Map<number, Map<AccessTier, ReturnType<typeof makeTierKey>>>();
    const inner = new Map<AccessTier, ReturnType<typeof makeTierKey>>();
    inner.set(AccessTier.THUMB, makeTierKey(9, AccessTier.THUMB));
    tierKeys.set(9, inner);

    await mod.saveTierKeys('linkD', 'albumD', AccessTier.THUMB, tierKeys);

    // After clearing, a subsequent save must trigger a brand-new Rust handle.
    const generateSpy = vi.spyOn(crypto.subtle, 'generateKey');
    const wasm = await import('../../generated/mosaic-wasm/mosaic_wasm.js');
    mod.clearLinkKeyEncryption();

    await mod.saveTierKeys('linkE', 'albumE', AccessTier.THUMB, tierKeys);

    expect(wasm.createLinkTierWrapHandle).toHaveBeenCalledTimes(2);
    expect(generateSpy).not.toHaveBeenCalled();
    // Still no raw key bytes in sessionStorage afterwards.
    expect(sessionStorage.getItem(LINK_KEY_STORAGE_KEY)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // security-review-2026-05-24-01 regression: legacy plaintext link tier
  // records must never survive a store open, and must never be loaded /
  // migrated. On a shared browser this prevents a stale link tier key from
  // crossing user/session boundaries (linkId-only IDB key was previously
  // sufficient to load and silently migrate another session's keys).
  // -------------------------------------------------------------------------

  /** Open the fake IDB directly and write a record (bypassing the store API). */
  function putRawRecord(value: Record<string, unknown> & { linkId: string }): Promise<void> {
    return new Promise((resolve, reject) => {
      const openReq = (
        globalThis as unknown as { indexedDB: IDBFactory }
      ).indexedDB.open('mosaic-link-keys', 1);
      openReq.onerror = () => reject(openReq.error);
      openReq.onsuccess = () => {
        const db = openReq.result;
        const tx = db.transaction('keys', 'readwrite');
        const store = tx.objectStore('keys');
        const r = store.put(value as unknown as object);
        r.onerror = () => reject(r.error);
        r.onsuccess = () => resolve();
      };
    });
  }

  function getRawRecord(linkId: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const openReq = (
        globalThis as unknown as { indexedDB: IDBFactory }
      ).indexedDB.open('mosaic-link-keys', 1);
      openReq.onerror = () => reject(openReq.error);
      openReq.onsuccess = () => {
        const db = openReq.result;
        const tx = db.transaction('keys', 'readonly');
        const store = tx.objectStore('keys');
        const r = store.get(linkId);
        r.onerror = () => reject(r.error);
        r.onsuccess = () => resolve(r.result);
      };
    });
  }

  it('purges legacy unencrypted records on store open', async () => {
    // Seed a legacy plaintext record (no ciphertext, no version, no
    // wrapVersion — pre-cutover format).
    await putRawRecord({
      linkId: 'legacy-1',
      albumId: 'album-legacy',
      accessTier: AccessTier.PREVIEW,
      keys: [{ epochId: 1, tier: AccessTier.PREVIEW, key: 'AAAA' }],
      storedAt: 0,
    });

    // Sanity: the seed actually landed.
    expect(await getRawRecord('legacy-1')).toBeDefined();

    // Opening the store via the wrapper (any operation does it).
    const { saveTierKeys } = await import('../link-tier-key-store');
    const fresh = new Map<number, Map<AccessTier, ReturnType<typeof makeTierKey>>>();
    const inner = new Map<AccessTier, ReturnType<typeof makeTierKey>>();
    inner.set(AccessTier.THUMB, makeTierKey(2, AccessTier.THUMB));
    fresh.set(2, inner);
    await saveTierKeys('linkSafe', 'albumSafe', AccessTier.THUMB, fresh);

    // Legacy record must have been purged. The new encrypted record stays.
    expect(await getRawRecord('legacy-1')).toBeUndefined();
    expect(await getRawRecord('linkSafe')).toBeDefined();
  });

  it('refuses to load (and deletes) any legacy record that slips past the purge', async () => {
    // Belt-and-braces: even if a non-encrypted record somehow exists at
    // load time, getTierKeys must return null and delete it — never
    // migrate or return it.
    const { getTierKeys } = await import('../link-tier-key-store');

    // Bypass open-time purge by inserting AFTER an initial open completes.
    await getTierKeys('warmup'); // ensures store exists, open completes
    await putRawRecord({
      linkId: 'legacy-2',
      albumId: 'album-legacy-2',
      accessTier: AccessTier.FULL,
      keys: [{ epochId: 3, tier: AccessTier.FULL, key: 'AAAA' }],
      storedAt: 0,
    });

    const loaded = await getTierKeys('legacy-2');
    // Either purge-on-open or load-path rejection MUST kick in.
    expect(loaded).toBeNull();
    expect(await getRawRecord('legacy-2')).toBeUndefined();
  });

  it('fails closed when wrap handle changes between sessions (no cross-session leakage)', async () => {
    const wasm = await import('../../generated/mosaic-wasm/mosaic_wasm.js');
    const mod = await import('../link-tier-key-store');

    // Session A: save with handle 1.
    (wasm.createLinkTierWrapHandle as unknown as { mockReturnValueOnce: (v: bigint) => unknown })
      .mockReturnValueOnce(11n);
    const tierKeys = new Map<number, Map<AccessTier, ReturnType<typeof makeTierKey>>>();
    const inner = new Map<AccessTier, ReturnType<typeof makeTierKey>>();
    inner.set(AccessTier.THUMB, makeTierKey(5, AccessTier.THUMB));
    tierKeys.set(5, inner);
    await mod.saveTierKeys('linkX', 'albumX', AccessTier.THUMB, tierKeys);
    expect(await getRawRecord('linkX')).toBeDefined();

    // Session B: simulate logout — drop the in-memory wrap handle, then
    // arrange a different handle on next mint and make unwrap fail when
    // the handle no longer matches what was used to wrap.
    mod.clearLinkKeyEncryption();
    (wasm.unwrapLinkTierBlob as unknown as {
      mockImplementationOnce: (fn: (h: bigint, _b: Uint8Array) => unknown) => unknown;
    }).mockImplementationOnce((handle: bigint, _bytes: Uint8Array) => ({
      code: handle === 11n ? 0 : 1,
      bytes: new Uint8Array(),
      free: () => {},
    }));
    (wasm.createLinkTierWrapHandle as unknown as { mockReturnValueOnce: (v: bigint) => unknown })
      .mockReturnValueOnce(22n);

    const result = await mod.getTierKeys('linkX');
    // Session B (different handle) must not be able to read session A's
    // record — and the record must be evicted as a cache miss.
    expect(result).toBeNull();
    expect(await getRawRecord('linkX')).toBeUndefined();
  });

  it('purgeAllLinkTierKeys wipes both in-memory handle and IDB', async () => {
    const mod = await import('../link-tier-key-store');

    const tierKeys = new Map<number, Map<AccessTier, ReturnType<typeof makeTierKey>>>();
    const inner = new Map<AccessTier, ReturnType<typeof makeTierKey>>();
    inner.set(AccessTier.THUMB, makeTierKey(1, AccessTier.THUMB));
    tierKeys.set(1, inner);
    await mod.saveTierKeys('linkP', 'albumP', AccessTier.THUMB, tierKeys);
    expect(await getRawRecord('linkP')).toBeDefined();

    await mod.purgeAllLinkTierKeys();

    expect(await getRawRecord('linkP')).toBeUndefined();
    expect(sessionStorage.getItem(LINK_KEY_STORAGE_KEY)).toBeNull();
  });
});
