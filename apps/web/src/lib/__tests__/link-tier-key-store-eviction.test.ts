/**
 * v1.0.2 storage/eviction hardening — regression tests for
 * `link-tier-key-store`.
 *
 * Covers:
 *  - Item 1 (v102-s28): `IDBOpenDBRequest` `VersionError` is surfaced as
 *    `IDBVersionMismatchError` with a clear user-facing message.
 *  - Item 5 (v102-s34): `evictLink(linkId)` deletes the per-link record
 *    from the IDB so the `mosaic-link-keys` cache cannot grow unbounded
 *    when sync reports the link revoked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
      mintLinkTierHandleFromRawKey: vi.fn(async () => 'link-tier-handle-0'),
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

/**
 * Minimal IDB shim shared with the existing link-tier-key-store test
 * suite. Re-implemented here so the eviction tests can independently
 * inject a `VersionError`-throwing variant without polluting the legacy
 * test module.
 */
function installFakeIndexedDB(opts?: {
  failOpenWith?: { name: string; message?: string };
}): { stores: Map<string, Map<string, unknown>> } {
  const stores = new Map<string, Map<string, unknown>>();

  function makeFakeDb() {
    return {
      objectStoreNames: {
        contains: (name: string) => stores.has(name),
      },
      createObjectStore: (name: string) => {
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
            const make = <T>(fulfill: (req: { onsuccess: ((e: Event) => void) | null; onerror: ((e: Event) => void) | null; result: T; error: unknown }) => void) => {
              const r = { onsuccess: null as ((e: Event) => void) | null, onerror: null as ((e: Event) => void) | null, result: undefined as unknown as T, error: null as unknown };
              queueMicrotask(() => {
                fulfill(r);
                queueMicrotask(() => tx.oncomplete?.());
              });
              return r;
            };
            return {
              put: (value: { linkId: string }) =>
                make<void>((r) => {
                  records.set(value.linkId, value);
                  r.onsuccess?.(new Event('success'));
                }),
              get: (key: string) =>
                make((r) => {
                  r.result = records.get(key);
                  r.onsuccess?.(new Event('success'));
                }),
              delete: (key: string) =>
                make<void>((r) => {
                  records.delete(key);
                  r.onsuccess?.(new Event('success'));
                }),
              clear: () =>
                make<void>((r) => {
                  records.clear();
                  r.onsuccess?.(new Event('success'));
                }),
            };
          },
        };
        return tx;
      },
      close: () => {},
    };
  }

  const fakeIDB = {
    open(_name: string, _version?: number) {
      const req: {
        onerror: ((ev: Event) => unknown) | null;
        onsuccess: ((ev: Event) => unknown) | null;
        onupgradeneeded: ((ev: Event) => unknown) | null;
        result: ReturnType<typeof makeFakeDb> | undefined;
        error: { name: string; message?: string } | null;
      } = {
        onerror: null,
        onsuccess: null,
        onupgradeneeded: null,
        result: undefined,
        error: null,
      };
      queueMicrotask(() => {
        if (opts?.failOpenWith) {
          req.error = opts.failOpenWith;
          const errEvent = { target: req } as unknown as Event;
          req.onerror?.(errEvent);
          return;
        }
        const db = makeFakeDb();
        req.result = db;
        if (!stores.has('keys')) {
          const upgradeEvent = { target: req } as unknown as Event;
          req.onupgradeneeded?.(upgradeEvent);
        }
        req.onsuccess?.(new Event('success'));
      });
      return req;
    },
  };

  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    writable: true,
    value: fakeIDB,
  });

  return { stores };
}

describe('link-tier-key-store — VersionError handling (v102-s28)', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('rethrows IDB VersionError as IDBVersionMismatchError with a user-facing message', async () => {
    installFakeIndexedDB({ failOpenWith: { name: 'VersionError', message: 'newer schema in another tab' } });
    vi.resetModules();
    const mod = await import('../link-tier-key-store');

    await expect(mod.getTierKeys('linkX')).rejects.toBeInstanceOf(mod.IDBVersionMismatchError);

    // And the error carries an actionable, user-facing message — not a
    // raw DOMException stringification.
    await expect(mod.getTierKeys('linkX')).rejects.toThrowError(/close other tabs/i);
  });

  it('non-VersionError IDB open failures propagate unchanged', async () => {
    installFakeIndexedDB({ failOpenWith: { name: 'InvalidStateError', message: 'db closing' } });
    vi.resetModules();
    const mod = await import('../link-tier-key-store');

    await expect(mod.getTierKeys('linkX')).rejects.not.toBeInstanceOf(mod.IDBVersionMismatchError);
  });
});

describe('link-tier-key-store — per-link eviction (v102-s34)', () => {
  beforeEach(() => {
    installFakeIndexedDB();
    vi.resetModules();
  });

  it('evictLink deletes the record so a subsequent get returns null', async () => {
    const mod = await import('../link-tier-key-store');
    const tierKeys = new Map<number, Map<number, { epochId: number; tier: number; key: Uint8Array }>>();
    const inner = new Map<number, { epochId: number; tier: number; key: Uint8Array }>();
    const fakeKey = new Uint8Array(32);
    for (let i = 0; i < 32; i++) fakeKey[i] = i;
    inner.set(1, { epochId: 1, tier: 1, key: fakeKey });
    tierKeys.set(1, inner);

    // saveTierKeys' signature requires AccessTier; use `as any` for fixture
    await mod.saveTierKeys('linkEvict', 'albumEvict', 1 as never, tierKeys as never);

    expect(await mod.getTierKeys('linkEvict')).not.toBeNull();

    await mod.evictLink('linkEvict');

    expect(await mod.getTierKeys('linkEvict')).toBeNull();
  });

  it('evictLink is idempotent — calling on an unknown linkId is a no-op', async () => {
    const mod = await import('../link-tier-key-store');
    await expect(mod.evictLink('never-existed')).resolves.toBeUndefined();
  });
});
