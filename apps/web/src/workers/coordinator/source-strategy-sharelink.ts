import { downloadShardViaShareLink } from '../../lib/shard-service';
import { deriveVisitorScopeKey } from '../../lib/scope-key';
import { DownloadError } from '../crypto-pool';
import type { LinkDecryptionKey } from '../types';
import type { SourceStrategy } from './source-strategy';

const DEFAULT_MAX_CONCURRENT = 4;

export interface ShareLinkSourceStrategyOptions {
  readonly linkId: string;
  /** Optional per-grant token; when present, sent as `X-Share-Grant` header. */
  readonly grantToken?: string | null;
  /**
   * Look up the tier-3 `LinkDecryptionKey` for the given epoch. Mirrors the
   * lookup pattern in `shared-album-download.ts` and `SharedPhotoLightbox`.
   * Returning `undefined` is treated as access revoked / link downgraded.
   */
  readonly getTierKey: (epochId: number) => LinkDecryptionKey | undefined;
}

/**
 * Share-link visitor source strategy.
 *
 * Fetches encrypted shards via `/api/s/{linkId}/shards/{shardId}` (with an
 * optional grant token) and resolves the per-epoch decryption key from a
 * caller-supplied tier-3 lookup. The pool's `decryptShard` accepts any
 * 32-byte secret, so the tier-3 key flows through the same code path as an
 * authenticated viewer's epoch seed.
 *
 * Limitations (current):
 *   - `LinkDecryptionKey` may be a tier-handle ID (opaque string) when
 *     keys are kept inside the crypto worker. The coordinator pipeline path
 *     currently requires raw bytes; handle-based keys throw `IllegalState`.
 *     Lifting this is tracked alongside the broader tier-handle work.
 */
export function createShareLinkSourceStrategy(
  opts: ShareLinkSourceStrategyOptions,
): SourceStrategy {
  const { linkId, grantToken, getTierKey } = opts;
  const grant = grantToken ?? undefined;
  // Precondition: caller awaited nsureScopeKeySodiumReady() so this is sync.
  const scopeKey = deriveVisitorScopeKey(linkId, grantToken ?? null);

  const fetchOne = async (shardId: string, signal: AbortSignal): Promise<Uint8Array> => {
    throwIfAborted(signal);
    const bytes = await downloadShardViaShareLink(linkId, shardId, grant);
    throwIfAborted(signal);
    return bytes;
  };

  return {
    kind: 'share-link',
    getScopeKey(): string {
      return scopeKey;
    },
    fetchShard: fetchOne,
    async fetchShards(
      shardIds: ReadonlyArray<string>,
      signal: AbortSignal,
    ): Promise<Uint8Array[]> {
      throwIfAborted(signal);
      if (shardIds.length === 0) return [];
      // Bounded concurrency, preserving input order.
      const out: Uint8Array[] = new Array<Uint8Array>(shardIds.length);
      for (let start = 0; start < shardIds.length; start += DEFAULT_MAX_CONCURRENT) {
        throwIfAborted(signal);
        const end = Math.min(start + DEFAULT_MAX_CONCURRENT, shardIds.length);
        const slice = shardIds.slice(start, end);
        const fetched = await Promise.all(
          slice.map((id) => fetchOne(id, signal)),
        );
        for (let i = 0; i < fetched.length; i += 1) {
          out[start + i] = fetched[i]!;
        }
      }
      return out;
    },
    async resolveKey(_albumId: string, epochId: number): Promise<Uint8Array> {
      const key = getTierKey(epochId);
      if (key === undefined) {
        // Link revoked or tier-3 grant downgraded; surface as a stable code
        // so the pipeline maps it to a job-fatal access reason rather than
        // retrying network errors.
        throw new DownloadError(
          'AccessRevoked',
          'Share-link tier-3 key unavailable for epoch',
        );
      }
      if (typeof key === 'string') {
        // Tier-handle path not yet supported through the coordinator pipeline.
        throw new DownloadError(
          'IllegalState',
          'Tier-handle keys not supported by coordinator source strategy',
        );
      }
      return key;
    },
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Download aborted', 'AbortError');
  }
}