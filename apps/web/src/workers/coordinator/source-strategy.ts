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
 * Both modes converge on `pool.decryptShard(bytes, key)` where `key` is a
 * 32-byte secret (epoch seed for authenticated viewers, tier-3 secret for
 * share-link visitors). This unification is sound per the Phase 2 stateless
 * `rust_decrypt_shard_with_seed` design (the tier key is also a SecretKey).
 *
 * Future strategies (e.g. P2P sidecar) plug in here.
 */
export type SourceStrategyKind = 'authenticated' | 'share-link';

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
   * Resolve the 32-byte decryption key for a given epoch.
   *
   * - Authenticated: epoch seed from the epoch-key service.
   * - Share-link: tier-3 link decryption key from the tier-key store.
   *
   * Implementations MUST throw a DownloadError with an appropriate code
   * (e.g. `AccessRevoked`) when the key cannot be resolved.
   */
  resolveKey(albumId: string, epochId: number): Promise<Uint8Array>;
}