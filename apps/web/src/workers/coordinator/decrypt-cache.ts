/**
 * In-memory LRU cache of resolved decryption contexts.
 *
 * Caches opaque worker-owned handles per `scopeKey` (album + epoch composite,
 * formed by the caller as e.g. `"${albumId}:${epochId}"`) so multiple photos
 * in the same album sharing an epoch don't re-resolve the key. Opaque handles
 * are not JS-visible key material; their Rust resources are released by the
 * owning crypto-worker handle registry.
 *
 * The field is intentionally named `scopeKey` rather than `epochId` because
 * the actual key the call-site composes is `albumId:epochId` — a per-album
 * cache scope, not a bare epoch identifier. Naming it `epochId` was
 * misleading and risked cross-album cache collisions if a future caller
 * passed a bare epoch number instead of the composite.
 *
 * Concurrency: the underlying Map is touched only from a single worker
 * thread (the coordinator). No locking is required.
 */

import type { ResolvedKeyMaterial } from './source-strategy';

export interface DecryptContext {
  /** Composite cache scope, currently `"${albumId}:${epochId}"`. */
  readonly scopeKey: string;
  readonly epochKey: ResolvedKeyMaterial;
}

export interface DecryptCache {
  get(scopeKey: string): DecryptContext | null;
  put(ctx: DecryptContext): void;
  clear(): void;
  /** @internal — for tests; reports the current entry count. */
  readonly _size: () => number;
}

const DEFAULT_MAX_ENTRIES = 32;

export function createDecryptCache(maxEntries: number = DEFAULT_MAX_ENTRIES): DecryptCache {
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
    throw new Error('maxEntries must be a positive integer');
  }
  // Map preserves insertion order, which we use as LRU order: most-recently
  // used = last inserted/refreshed.
  const entries = new Map<string, DecryptContext>();

  return {
    get(scopeKey: string): DecryptContext | null {
      const ctx = entries.get(scopeKey);
      if (!ctx) return null;
      // LRU bump: re-insert to move to end.
      entries.delete(scopeKey);
      entries.set(scopeKey, ctx);
      return ctx;
    },
    put(ctx: DecryptContext): void {
      const existing = entries.get(ctx.scopeKey);
      if (existing) {
        entries.delete(ctx.scopeKey);
      }
      entries.set(ctx.scopeKey, ctx);
      while (entries.size > maxEntries) {
        const oldestKey = entries.keys().next().value;
        if (oldestKey === undefined) break;
        entries.delete(oldestKey);
      }
    },
    clear(): void {
      entries.clear();
    },
    _size: (): number => entries.size,
  };
}
