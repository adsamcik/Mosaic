/**
 * Pluggable source strategy for the coordinator's per-photo download pipeline.
 *
 * Decouples shard fetching + per-epoch key derivation from the rest of the
 * coordinator orchestration so the same coordinator + worker pool + tray UI
 * can drive multiple access modes:
 *
 *   1. {@link createAuthenticatedSourceStrategy} - uses the authenticated
 *      `/api/shards/{id}` endpoint and the user's epoch-key service.
 *
 *   2. {@link createShareLinkSourceStrategy} - uses
 *      `/api/s/{linkId}/shards/{shardId}` with a grant token and a tier-3
 *      `LinkDecryptionKey` from the link tier-key store.
 *
 * Strategies resolve opaque worker-owned handles for production decrypt paths.
 * Raw tier-key bytes remain accepted only as a legacy/transitional escape hatch.
 *
 * Future strategies (e.g. P2P sidecar) plug in here.
 */
import type { EpochHandleId, LinkTierHandleId } from '../types';

export type SourceStrategyKind = 'authenticated' | 'share-link';

export type ResolvedKeyMaterial =
  | { kind: 'epoch-handle'; handleId: EpochHandleId }
  | { kind: 'link-tier-handle'; handleId: LinkTierHandleId }
  | { kind: 'raw-bytes'; bytes: Uint8Array };

export interface SourceStrategy {
  /** Stable identifier for telemetry / ZK-safe logging. */
  readonly kind: SourceStrategyKind;

  /** Fetch one encrypted shard's bytes by ID. Aborts honored. */
  fetchShard(shardId: string, signal: AbortSignal): Promise<Uint8Array>;

  /**
   * Fetch many shards. Implementations choose concurrency. Order of the
   * returned array MUST match `shardIds`.
   */
  fetchShards(
    shardIds: ReadonlyArray<string>,
    signal: AbortSignal,
  ): Promise<Uint8Array[]>;

  /**
   * Resolve the decryption material for a given epoch.
   *
   * - Authenticated: epoch handle from the epoch-key service.
   * - Share-link: tier-3 link-tier handle from the tier-key store.
 * - Raw tier-key bytes: legacy/transitional callers only.
   *
   * Implementations MUST throw a DownloadError with an appropriate code
   * (e.g. `AccessRevoked`) when the key cannot be resolved.
   */
  resolveKey(albumId: string, epochId: number): Promise<ResolvedKeyMaterial>;

  /**
   * Optional owner-context decrypt hook for handles that are meaningful only
   * in the context that created this strategy (for example a main-thread
   * share-link source proxied into the coordinator worker).
   */
  decryptResolvedShard?(
    keyMaterial: ResolvedKeyMaterial,
    envelopeBytes: Uint8Array,
    tier: number,
  ): Promise<Uint8Array>;

  /**
   * Stable per-tray scope key partitioning jobs by identity. Format
   * `<prefix>:<32-hex>` (`auth`/`visitor`/`legacy`). Only the prefix is safe
   * to log; the hex tail is opaque (see `apps/web/src/lib/scope-key.ts`).
   *
   * **Precondition:** the strategy was constructed after
   * `ensureScopeKeySodiumReady()` resolved, so this can be a sync getter.
   */
  getScopeKey(): string;
}
