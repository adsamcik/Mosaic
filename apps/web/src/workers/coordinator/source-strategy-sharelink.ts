import { downloadShardViaShareLink, ShardDownloadError } from '../../lib/shard-service';
import { ApiError } from '../../lib/api';
import { getCryptoClient } from '../../lib/crypto-client';
import { deriveVisitorScopeKey } from '../../lib/scope-key';
import { DownloadError } from '../crypto-pool';
import type { LinkDecryptionKey } from '../types';
import type { ResolvedKeyMaterial, SourceStrategy } from './source-strategy';

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
 * caller-supplied tier-3 handle lookup.
 */
export function createShareLinkSourceStrategy(
  opts: ShareLinkSourceStrategyOptions,
): SourceStrategy {
  const { linkId, grantToken, getTierKey } = opts;
  const grant = grantToken ?? undefined;
  // Precondition: caller awaited nsureScopeKeySodiumReady() so this is sync.
  const scopeKey = deriveVisitorScopeKey(linkId, grantToken ?? null);

  /**
   * Map server status codes 401 / 403 / 410 to a stable `AccessRevoked`
   * `DownloadError`. The coordinator (Phase 1) already treats this code
   * as job-fatal and transitions the job to Errored, so the visitor tray
   * can surface a clear "share link revoked or expired" message.
   *
   * Other failures keep their current behavior — propagate as ShardDownloadError
   * so the photo-pipeline retry / classification stays unchanged.
   */
  const fetchOne = async (shardId: string, signal: AbortSignal): Promise<Uint8Array> => {
    throwIfAborted(signal);
    try {
      const bytes = await downloadShardViaShareLink(linkId, shardId, grant);
      throwIfAborted(signal);
      return bytes;
    } catch (err) {
      const status = extractHttpStatus(err);
      if (status === 401 || status === 403 || status === 410) {
        // ZK-safe: never log linkId or grant token; only the status family.
        throw new DownloadError(
          'AccessRevoked',
          `Share link revoked or expired (HTTP ${status})`,
        );
      }
      throw err;
    }
  };

  function extractHttpStatus(err: unknown): number | null {
    if (err instanceof ApiError) return err.status;
    if (err instanceof ShardDownloadError && err.cause instanceof ApiError) {
      return err.cause.status;
    }
    return null;
  }

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
    async resolveKey(_albumId: string, epochId: number): Promise<ResolvedKeyMaterial> {
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
      if (typeof key !== 'string') {
        throw new DownloadError(
          'IllegalState',
          'Share-link tier key must be an opaque link-tier handle',
        );
      }
      return { kind: 'link-tier-handle', handleId: key };
    },
    async decryptResolvedShard(
      keyMaterial: ResolvedKeyMaterial,
      envelopeBytes: Uint8Array,
    ): Promise<Uint8Array> {
      if (keyMaterial.kind !== 'link-tier-handle') {
        throw new DownloadError(
          'IllegalState',
          'Share-link source can only owner-decrypt link-tier handles',
        );
      }
      const crypto = await getCryptoClient();
      try {
        return await crypto.decryptShardWithLinkTierHandle(keyMaterial.handleId, envelopeBytes);
      } catch (error) {
        throw new DownloadError('Decrypt', 'Shard AEAD decrypt failed', { cause: error });
      }
    },
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Download aborted', 'AbortError');
  }
}
