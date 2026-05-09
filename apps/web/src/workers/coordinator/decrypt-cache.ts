/**
 * In-memory LRU cache of resolved decryption contexts.
 *
 * Caches opaque worker-owned handles per `epochId` so multiple photos in the
 * same album sharing an epoch don't re-resolve the key. Legacy raw bytes are
 * still accepted and are overwritten with `Uint8Array.fill(0)` on eviction and
 * on `clear()` so spent material does not linger in the JS-visible heap longer
 * than necessary. Opaque handles are not JS-visible key material; their Rust
 * resources are released by the owning crypto-worker handle registry.
 *
 * Concurrency: the underlying Map is touched only from a single worker
 * thread (the coordinator). No locking is required.
 */

import type { ResolvedKeyMaterial } from './source-strategy';

export type DecryptCacheKeyMaterial = ResolvedKeyMaterial | Uint8Array;

export interface DecryptContext {
  readonly epochId: string;
  readonly epochKey: DecryptCacheKeyMaterial;
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

  function zeroize(ctx: DecryptContext): void {
    // Rust memzero would only wipe a copy crossing the WASM ABI boundary.
    // Filling this exact Uint8Array overwrites the JS-owned bytes held here.
    if (ctx.epochKey instanceof Uint8Array) {
      ctx.epochKey.fill(0);
      return;
    }
    if (ctx.epochKey.kind === 'raw-bytes') {
      ctx.epochKey.bytes.fill(0);
    }
  }

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
        // If a different buffer was previously cached for this epoch, zero it
        // before dropping the reference.
        if (existing.epochKey !== ctx.epochKey) {
          zeroize(existing);
        }
      }
      entries.set(ctx.epochId, ctx);
      while (entries.size > maxEntries) {
        const oldestKey = entries.keys().next().value;
        if (oldestKey === undefined) break;
        const evicted = entries.get(oldestKey);
        entries.delete(oldestKey);
        if (evicted) zeroize(evicted);
      }
    },
    clear(): void {
      for (const ctx of entries.values()) zeroize(ctx);
      entries.clear();
    },
    _size: (): number => entries.size,
  };
}
