import { downloadShard, downloadShards } from '../../lib/shard-service';
import { getOrFetchEpochKey } from '../../lib/epoch-key-service';
import type { SourceStrategy } from './source-strategy';

const DEFAULT_MAX_CONCURRENT = 4;

/**
 * Authenticated viewer source strategy.
 *
 * Wraps the `/api/shards/{id}` endpoint and the user's epoch-key service.
 * Behavior matches the pre-existing hard-coded coordinator path; this is a
 * pure refactor for the auth path.
 */
export function createAuthenticatedSourceStrategy(): SourceStrategy {
  return {
    kind: 'authenticated',
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