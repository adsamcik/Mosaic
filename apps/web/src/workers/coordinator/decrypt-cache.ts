/**
 * In-memory LRU cache of derived epoch keys (decryption contexts).
 *
 * Caches the parsed epoch key bytes per `epochId` so multiple photos in the
 * same album sharing an epoch don't re-derive the key. Keys are zeroed via
 * `sodium.memzero` on eviction and on `clear()` so spent material does not
 * linger in the heap longer than necessary.
 *
 * Concurrency: the underlying Map is touched only from a single worker
 * thread (the coordinator). No locking is required.
 */
import sodium from 'libsodium-wrappers-sumo';

export interface DecryptContext {
  readonly epochId: string;
  readonly epochKey: Uint8Array;
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
    try {
      sodium.memzero(ctx.epochKey);
    } catch {
      ctx.epochKey.fill(0);
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
