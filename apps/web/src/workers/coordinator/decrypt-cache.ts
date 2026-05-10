/**
 * In-memory LRU cache of resolved decryption contexts.
 *
 * Caches opaque worker-owned handles per `epochId` so multiple photos in the
 * same album sharing an epoch don't re-resolve the key. Opaque handles are not
 * JS-visible key material; their Rust resources are released by the owning
 * crypto-worker handle registry.
 *
 * Concurrency: the underlying Map is touched only from a single worker
 * thread (the coordinator). No locking is required.
 */

import type { ResolvedKeyMaterial } from './source-strategy';

export interface DecryptContext {
  readonly epochId: string;
  readonly epochKey: ResolvedKeyMaterial;
}

export interface DecryptCache {
  get(epochId: string): DecryptContext | null;
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
    get(epochId: string): DecryptContext | null {
      const ctx = entries.get(epochId);
      if (!ctx) return null;
      // LRU bump: re-insert to move to end.
      entries.delete(epochId);
      entries.set(epochId, ctx);
      return ctx;
    },
    put(ctx: DecryptContext): void {
      const existing = entries.get(ctx.epochId);
      if (existing) {
        entries.delete(ctx.epochId);
      }
      entries.set(ctx.epochId, ctx);
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
