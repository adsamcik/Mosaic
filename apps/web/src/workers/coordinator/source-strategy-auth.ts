import { downloadShard, downloadShards } from '../../lib/shard-service';
import { getOrFetchEpochKey } from '../../lib/epoch-key-service';
import { deriveAuthScopeKey } from '../../lib/scope-key';
import type { SourceStrategy } from './source-strategy';

const DEFAULT_MAX_CONCURRENT = 4;

/**
 * Authenticated viewer source strategy.
 *
 * Wraps the `/api/shards/{id}` endpoint and the user's epoch-key service.
 *
 * `accountId` is the non-secret stable account identifier used to derive the
 * tray scope key. Caller MUST await `ensureScopeKeySodiumReady()` before
 * calling this factory so `getScopeKey()` can stay synchronous.
 */
export function createAuthenticatedSourceStrategy(accountId: string): SourceStrategy {
  const scopeKey = deriveAuthScopeKey(accountId);
  return {
    kind: 'authenticated',
    getScopeKey(): string {
      return scopeKey;
    },
    async fetchShard(shardId: string, signal: AbortSignal): Promise<Uint8Array> {
      throwIfAborted(signal);
      const bytes = await downloadShard(shardId);
      throwIfAborted(signal);
      return bytes;
    },
    async fetchShards(
      shardIds: ReadonlyArray<string>,
      signal: AbortSignal,
    ): Promise<Uint8Array[]> {
      throwIfAborted(signal);
      if (shardIds.length === 0) return [];
      const shards = await downloadShards([...shardIds], undefined, DEFAULT_MAX_CONCURRENT);
      throwIfAborted(signal);
      return shards;
    },
    async resolveKey(albumId: string, epochId: number): Promise<Uint8Array> {
      const bundle = await getOrFetchEpochKey(albumId, epochId);
      return bundle.epochSeed;
    },
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Download aborted', 'AbortError');
  }
}