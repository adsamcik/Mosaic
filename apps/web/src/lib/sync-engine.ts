import {
  WorkerCryptoErrorCode,
  type DecryptedManifest,
  type EpochHandleId,
  type ManifestReplayCheckpoint,
  type ManifestSeqHighWaterMark,
  type PhotoMeta,
} from '../workers/types';
import { ApiError, fromBase64, getApi } from './api';
import { getCryptoClient } from './crypto-client';
import { getDbClient } from './db-client';
import {
  fetchAndUnwrapEpochKeys,
  getOrFetchEpochKey,
} from './epoch-key-service';
import {
  clearAllEpochKeys,
  getEpochKey,
  invalidateAlbum as invalidateAlbumEpochKeys,
  setEpochKey as storeEpochKey,
  type EpochKeyBundle,
} from './epoch-key-store';
import { createLogger } from './logger';
import { purgeLocalPhoto } from './local-purge';
import {
  manifestShardIdsMatchTranscript,
  manifestTranscriptInputForPhotoMeta,
} from './manifest-transcript';
import {
  buildTombstoneTranscriptBytes,
  buildTombstoneTranscriptBytesV2,
} from './tombstone-transcript';
import type {
  ContentConflictEventDetail,
  SyncEventDetail,
  SyncEventType,
} from './sync-types';

const log = createLogger('SyncEngine');
const MAX_SYNC_PAGINATION_ITERATIONS = 1000;

function createAbortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('Sync cancelled', 'AbortError');
  }

  const error = new Error('Sync cancelled');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createAbortError();
  }
}

function keysMatch(left: Uint8Array, right: Uint8Array): boolean {
  // Public-key comparison only. Do not use this helper for secrets.
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function hasValidSigningKey(pubkey: Uint8Array): boolean {
  return pubkey.length === 32 && pubkey.some((byte) => byte !== 0);
}

function findUniqueEpochBundleForSigner(
  bundles: readonly EpochKeyBundle[],
  signerPubkey: Uint8Array,
): EpochKeyBundle | null {
  let match: EpochKeyBundle | null = null;
  for (const bundle of bundles) {
    if (
      !hasValidSigningKey(bundle.signPublicKey) ||
      !keysMatch(bundle.signPublicKey, signerPubkey)
    ) {
      continue;
    }
    if (match !== null && match.epochId !== bundle.epochId) {
      return null;
    }
    match = bundle;
  }
  return match;
}

function signingKeyHighWaterKey(pubkey: Uint8Array): string {
  // This is a stable identifier for a public key, not secret material.
  return Array.from(pubkey, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

type ManifestSeqHighWaterCandidate = ManifestSeqHighWaterMark & {
  readonly versionCreated: number;
};

type ManifestReplayCheckpointCandidate = ManifestReplayCheckpoint & {
  readonly versionCreated: number;
};

function signatureFingerprint(signature: Uint8Array): string {
  if (signature.length !== 64) {
    throw new Error(
      `Ed25519 signature must be 64 bytes, got ${signature.length}`,
    );
  }
  return Array.from(signature, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function isExactReplayCheckpoint(
  checkpoint: ManifestReplayCheckpoint | null,
  input: {
    readonly epochId: number;
    readonly signerKey: string;
    readonly manifestSeq: number;
    readonly operationKind: 'Live' | 'Tombstone';
    readonly signatureFingerprint: string;
  },
): boolean {
  return (
    checkpoint !== null &&
    checkpoint.epochId === input.epochId &&
    checkpoint.signerKey === input.signerKey &&
    checkpoint.manifestSeq === input.manifestSeq &&
    checkpoint.operationKind === input.operationKind &&
    checkpoint.signatureFingerprint === input.signatureFingerprint
  );
}

function canSupersedeReplayCheckpoint(
  current: ManifestReplayCheckpoint | null,
  candidate: ManifestReplayCheckpoint,
): boolean {
  if (!current) return true;
  if (candidate.epochId > current.epochId) return true;
  if (candidate.epochId < current.epochId) return false;
  if (candidate.signerKey !== current.signerKey) return false;
  if (candidate.manifestSeq > current.manifestSeq) return true;
  return isExactReplayCheckpoint(current, {
    epochId: candidate.epochId,
    signerKey: candidate.signerKey,
    manifestSeq: candidate.manifestSeq,
    operationKind: candidate.operationKind,
    signatureFingerprint: candidate.signatureFingerprint,
  });
}

function isHandleLifecycleError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return (
    code === WorkerCryptoErrorCode.StaleHandle ||
    code === WorkerCryptoErrorCode.HandleNotFound ||
    code === WorkerCryptoErrorCode.ClosedHandle ||
    code === WorkerCryptoErrorCode.EpochHandleNotFound
  );
}

/**
 * Verifies a tombstone (soft-delete) signature against the published
 * per-epoch manifest signing pubkey. Returns `null` on success, or a
 * short skip-reason string on failure (recorded as a sync skip; cursor
 * does not advance past the suspicious row).
 *
 * Closes audit `sync C2 (unauthenticated tombstones)`: pre-A2 unsigned
 * tombstones surface as `tombstone-unsigned` and the local photo is NOT
 * purged. After every editor has migrated to signed deletes, all
 * tombstones carry valid signatures and this path becomes a no-op.
 */
async function verifyTombstoneOrReason(
  manifest: {
    id: string;
    albumId: string;
    versionCreated: number;
    isDeleted: boolean;
    tombstoneSignature?: string | null;
    tombstoneSignerEpochId?: number | null;
    tombstoneProtocolVersion?: 2 | null;
    tombstoneSeq?: number | null;
    tombstoneVersionCreated?: number | null;
  },
  albumId: string,
  deps: {
    fetchEpochKey: (
      albumId: string,
      epochId: number,
    ) => Promise<{ epochId: number; signPublicKey: Uint8Array }>;
    verifySignature: (
      transcriptBytes: Uint8Array,
      signature: Uint8Array,
      pubkey: Uint8Array,
    ) => Promise<boolean>;
    onVerifiedV2?: (
      signerPubkey: Uint8Array,
      signerEpochId: number,
      tombstoneSeq: number,
      signature: Uint8Array,
    ) => void;
  },
): Promise<string | null> {
  if (!manifest.tombstoneSignature || manifest.tombstoneSignerEpochId == null) {
    return 'tombstone-unsigned';
  }

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = fromBase64(manifest.tombstoneSignature);
  } catch {
    return 'tombstone-bad-base64';
  }
  if (signatureBytes.length !== 64) {
    return 'tombstone-bad-length';
  }

  let signerEpochBundle: { epochId: number; signPublicKey: Uint8Array };
  try {
    signerEpochBundle = await deps.fetchEpochKey(
      albumId,
      manifest.tombstoneSignerEpochId,
    );
  } catch {
    return 'tombstone-unknown-signer-epoch';
  }
  if (!hasValidSigningKey(signerEpochBundle.signPublicKey)) {
    return 'tombstone-empty-signer-pubkey';
  }
  if (signerEpochBundle.epochId !== manifest.tombstoneSignerEpochId) {
    return 'tombstone-signer-epoch-mismatch';
  }

  let transcriptBytes: Uint8Array;
  let verifiedTombstoneSeq: number | undefined;
  try {
    if (manifest.tombstoneProtocolVersion === 2) {
      const tombstoneSeq = manifest.tombstoneSeq;
      const signedVersion = manifest.tombstoneVersionCreated;
      if (
        typeof tombstoneSeq !== 'number' ||
        !Number.isSafeInteger(tombstoneSeq) ||
        tombstoneSeq <= 0
      ) {
        return 'tombstone-invalid-seq';
      }
      if (
        typeof signedVersion !== 'number' ||
        !Number.isSafeInteger(signedVersion) ||
        signedVersion < 0
      ) {
        return 'tombstone-invalid-signed-version';
      }
      verifiedTombstoneSeq = tombstoneSeq;
      transcriptBytes = buildTombstoneTranscriptBytesV2({
        albumId: manifest.albumId,
        epochId: manifest.tombstoneSignerEpochId,
        tombstoneSeq,
        photoId: manifest.id,
        versionCreated: signedVersion,
      });
    } else if (
      manifest.tombstoneProtocolVersion == null &&
      manifest.tombstoneSeq == null &&
      manifest.tombstoneVersionCreated == null
    ) {
      transcriptBytes = buildTombstoneTranscriptBytes({
        albumId: manifest.albumId,
        epochId: manifest.tombstoneSignerEpochId,
        photoId: manifest.id,
        versionCreated: manifest.versionCreated,
      });
    } else {
      return 'tombstone-protocol-mismatch';
    }
  } catch {
    return 'tombstone-transcript-build-failed';
  }

  let isValid = false;
  try {
    isValid = await deps.verifySignature(
      transcriptBytes,
      signatureBytes,
      signerEpochBundle.signPublicKey,
    );
  } catch {
    return 'tombstone-verify-error';
  }
  if (!isValid) {
    return 'tombstone-signature-invalid';
  }
  if (verifiedTombstoneSeq !== undefined) {
    deps.onVerifiedV2?.(
      signerEpochBundle.signPublicKey,
      signerEpochBundle.epochId,
      verifiedTombstoneSeq,
      signatureBytes,
    );
  }
  return null;
}

function createDeletedManifestTombstone(manifest: {
  id: string;
  albumId: string;
  versionCreated: number;
  isDeleted: boolean;
  shardIds: string[];
  createdAt?: string;
  updatedAt?: string;
}): DecryptedManifest {
  const timestamp =
    manifest.updatedAt ?? manifest.createdAt ?? new Date(0).toISOString();
  return {
    id: manifest.id,
    albumId: manifest.albumId,
    versionCreated: manifest.versionCreated,
    isDeleted: true,
    meta: {
      id: manifest.id,
      assetId: manifest.id,
      albumId: manifest.albumId,
      filename: '',
      mimeType: '',
      width: 0,
      height: 0,
      tags: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      shardIds: [],
      epochId: 0,
    },
    shardIds: manifest.shardIds,
  };
}

/** Queued sync request with deferred promise */
interface QueuedSyncRequest {
  epochHandleId: EpochHandleId | undefined;
  resolvers: Array<{ resolve: () => void; reject: (err: Error) => void }>;
}

/**
 * Sync Engine
 * Handles synchronization between local database and server
 */
class SyncEngine extends EventTarget {
  private syncing = false;
  private syncAbortController: AbortController | null = null;

  /** Queued sync requests - album IDs that need sync after current sync completes */
  private pendingSyncQueue = new Map<string, QueuedSyncRequest>();

  /** Whether sync is currently in progress */
  get isSyncing(): boolean {
    return this.syncing;
  }

  /**
   * Sync an album from the server.
   * If sync is already in progress, queues the request and returns a promise
   * that resolves when the queued sync completes.
   * @param albumId - Album ID to sync
   * @param epochHandleId - Epoch handle id for decryption (optional if using cached keys)
   */
  async sync(albumId: string, epochHandleId?: EpochHandleId): Promise<void> {
    log.info(`Sync requested for album ${albumId}`, {
      hasEpochHandle: !!epochHandleId,
    });

    if (this.syncing) {
      // Queue this sync request - it will run after current sync completes
      // Return a promise that resolves when the queued sync actually completes
      log.debug(`Sync in progress, queueing sync for album ${albumId}`);

      return new Promise<void>((resolve, reject) => {
        const existing = this.pendingSyncQueue.get(albumId);
        if (existing) {
          // Album already queued - add this resolver to the list
          // Update epoch handle if provided (latest handle takes precedence)
          if (epochHandleId) existing.epochHandleId = epochHandleId;
          existing.resolvers.push({ resolve, reject });
        } else {
          // New queue entry
          this.pendingSyncQueue.set(albumId, {
            epochHandleId,
            resolvers: [{ resolve, reject }],
          });
        }
      });
    }

    this.syncing = true;
    this.syncAbortController = new AbortController();

    this.dispatchSyncEvent('sync-start', { albumId });

    try {
      const db = await getDbClient();
      const crypto = await getCryptoClient();
      const api = getApi();
      const signal = this.syncAbortController.signal;

      let sinceVersion = await db.getAlbumVersion(albumId);
      const isFullRebuild = sinceVersion === 0;
      const retainedReplayHeads = isFullRebuild
        ? await db.listManifestReplayCheckpoints(albumId)
        : [];
      // Completion requires each retained exact current head to be observed
      // exactly or superseded under the epoch-aware transition rules below.
      const rebuiltManifestIds = new Set<string>();
      let iterationCount = 0;
      // Per-(album, signing public key) maximum v2 sequence. Each signer is
      // initialized lazily from the durable local floor, then retained across
      // pagination so reordering cannot bypass the replay check.
      const maxManifestSeqBySigner = new Map<string, number>();
      let authenticatedEpochBundles: readonly EpochKeyBundle[] | null = null;

      while (true) {
        throwIfAborted(signal);

        if (iterationCount >= MAX_SYNC_PAGINATION_ITERATIONS) {
          const error = new Error(
            `Sync pagination iteration cap reached for album ${albumId}`,
          );
          log.error(error.message, { albumId, sinceVersion, iterationCount });
          throw error;
        }
        iterationCount += 1;

        const response = await api.syncAlbum(albumId, sinceVersion, { signal });
        throwIfAborted(signal);

        // Audit "sync C3": detect server cursor regression. If the server
        // claims `albumVersion < sinceVersion` (DB reset, restore-from-
        // backup, malicious response), we MUST NOT silently rewind the
        // local cursor — that would re-process every manifest from the
        // smaller value forward and risk re-purging local state from
        // stale tombstones. Emit a distinct event the UI can react to
        // (re-auth, full resync) and abort sync.
        if (response.albumVersion < sinceVersion) {
          const regression = new Error(
            `Server reported album version ${String(response.albumVersion)} but client holds ${String(sinceVersion)} for album ${albumId}`,
          );
          log.error(regression.message, {
            albumId,
            sinceVersion,
            responseAlbumVersion: response.albumVersion,
          });
          this.dispatchSyncEvent('sync-server-regression', {
            albumId,
            serverRegression: {
              clientHeld: sinceVersion,
              serverReported: response.albumVersion,
            },
          });
          throw regression;
        }

        if (response.hasMore && response.albumVersion <= sinceVersion) {
          const error = new Error(
            `Sync pagination did not advance album version for album ${albumId}`,
          );
          log.error(error.message, {
            albumId,
            sinceVersion,
            responseAlbumVersion: response.albumVersion,
            iterationCount,
          });
          throw error;
        }

        throwIfAborted(signal);
        const epochBundle = await getOrFetchEpochKey(
          albumId,
          response.currentEpochId,
        );
        throwIfAborted(signal);

        if (!hasValidSigningKey(epochBundle.signPublicKey)) {
          throw new Error(
            `Missing valid epoch signing key for album ${albumId} epoch ${response.currentEpochId}`,
          );
        }
        if (epochBundle.epochId !== response.currentEpochId) {
          throw new Error(
            'Fetched epoch bundle does not match the server epoch',
          );
        }

        const currentSignerKey = signingKeyHighWaterKey(
          epochBundle.signPublicKey,
        );
        const persistedEpochFloor = await db.getAlbumEpochHighWater(albumId);
        if (
          persistedEpochFloor &&
          response.currentEpochId < persistedEpochFloor.epochId
        ) {
          throw new Error(
            `Album signing epoch regressed from ${String(persistedEpochFloor.epochId)} to ${String(response.currentEpochId)}`,
          );
        }
        if (
          persistedEpochFloor?.epochId === response.currentEpochId &&
          persistedEpochFloor.signerKey !== currentSignerKey
        ) {
          throw new Error('Album signing epoch is bound to a different key');
        }
        const albumEpochHighWater = {
          albumId,
          epochId: response.currentEpochId,
          signerKey: currentSignerKey,
        } as const;
        const resolveManifestEpochBundle = async (
          signerPubkey: Uint8Array,
        ): Promise<EpochKeyBundle | null> => {
          if (keysMatch(signerPubkey, epochBundle.signPublicKey)) {
            return epochBundle;
          }
          authenticatedEpochBundles ??= await fetchAndUnwrapEpochKeys(albumId);
          return findUniqueEpochBundleForSigner(
            authenticatedEpochBundles,
            signerPubkey,
          );
        };

        const decrypted: DecryptedManifest[] = [];
        const manifestSeqHighWaterCandidates: ManifestSeqHighWaterCandidate[] =
          [];
        const manifestReplayCheckpointCandidates: ManifestReplayCheckpointCandidate[] =
          [];
        const stagedPurges: Array<{ albumId: string; photoId: string }> = [];
        const replaySatisfiedManifestIds = new Set<string>();
        const getCurrentReplayHead = async (
          manifestId: string,
        ): Promise<ManifestReplayCheckpoint | null> => {
          for (
            let index = manifestReplayCheckpointCandidates.length - 1;
            index >= 0;
            index -= 1
          ) {
            const candidate = manifestReplayCheckpointCandidates[index];
            if (candidate?.manifestId === manifestId) return candidate;
          }
          return db.getManifestReplayCheckpoint(albumId, manifestId);
        };
        // Audit "sync C1": every continue path below is a SKIP that
        // historically advanced the cursor past the skipped manifest,
        // making it permanently invisible. We now collect every skip
        // here and use the minimum skipped versionCreated to clamp the
        // cursor advance below — the cursor is never advanced past a
        // skipped manifest, so the next sync run will retry it.
        const skippedIds: string[] = [];
        const skipReasonCounts: Record<string, number> = {};
        let minSkippedVersion: number | null = null;
        const recordSkip = (
          manifestId: string,
          versionCreated: number,
          reason: string,
        ): void => {
          skippedIds.push(manifestId);
          skipReasonCounts[reason] = (skipReasonCounts[reason] ?? 0) + 1;
          if (
            minSkippedVersion === null ||
            versionCreated < minSkippedVersion
          ) {
            minSkippedVersion = versionCreated;
          }
        };
        let failedVerifyCount = 0;
        for (const manifest of response.manifests) {
          throwIfAborted(signal);
          if (manifest.albumId !== albumId) {
            log.error('Manifest album does not match requested sync album', {
              requestedAlbumId: albumId,
              manifestAlbumId: manifest.albumId,
              manifestId: manifest.id,
            });
            recordSkip(
              manifest.id,
              manifest.versionCreated,
              'manifest-album-mismatch',
            );
            continue;
          }

          if (manifest.isDeleted) {
            const existingHead = await getCurrentReplayHead(manifest.id);
            if (
              manifest.tombstoneProtocolVersion !== 2 &&
              existingHead !== null
            ) {
              log.error('Legacy tombstone cannot replace a retained v2 head', {
                albumId,
                manifestId: manifest.id,
              });
              recordSkip(
                manifest.id,
                manifest.versionCreated,
                'tombstone-v1-downgrade',
              );
              continue;
            }
            if (
              manifest.tombstoneSignerEpochId != null &&
              (!Number.isSafeInteger(manifest.tombstoneSignerEpochId) ||
                manifest.tombstoneSignerEpochId <= 0 ||
                manifest.tombstoneSignerEpochId > response.currentEpochId)
            ) {
              recordSkip(
                manifest.id,
                manifest.versionCreated,
                'tombstone-epoch-mismatch',
              );
              continue;
            }
            // Audit "sync C2" (batch 5c — A2): an unsigned tombstone is
            // suspicious. A malicious or compromised server could fabricate
            // `isDeleted: true` rows to purge local state. We therefore
            // require a valid Ed25519 signature over the canonical
            // tombstone transcript (album_id, signer_epoch_id, photo_id,
            // version_created) before calling purgeLocalPhoto. Failures are
            // recorded as skips so the cursor does not advance past the
            // suspicious row — the next sync run will retry, and the UI
            // can surface "{N} pending deletions need re-authorization".
            // Reservation-backed v2 tombstones share the durable sequence
            // floor with live manifests for the same signing public key.
            let verifiedV2Sequence:
              | {
                  signerPubkey: Uint8Array;
                  signerEpochId: number;
                  tombstoneSeq: number;
                  signatureFingerprint: string;
                }
              | undefined;
            const reason = await verifyTombstoneOrReason(manifest, albumId, {
              fetchEpochKey: getOrFetchEpochKey,
              verifySignature: (transcript, signature, pubkey) =>
                crypto.verifySignatureWithEpoch(transcript, signature, pubkey),
              onVerifiedV2: (
                signerPubkey,
                signerEpochId,
                tombstoneSeq,
                signature,
              ) => {
                verifiedV2Sequence = {
                  signerPubkey,
                  signerEpochId,
                  tombstoneSeq,
                  signatureFingerprint: signatureFingerprint(signature),
                };
              },
            });
            if (reason !== null) {
              log.warn('Refusing to purge on unsigned/invalid tombstone', {
                albumId: manifest.albumId,
                manifestId: manifest.id,
                versionCreated: manifest.versionCreated,
                reason,
              });
              recordSkip(manifest.id, manifest.versionCreated, reason);
              continue;
            }
            if (verifiedV2Sequence !== undefined) {
              const signerKey = signingKeyHighWaterKey(
                verifiedV2Sequence.signerPubkey,
              );
              if (
                verifiedV2Sequence.signerEpochId === response.currentEpochId &&
                signerKey !== currentSignerKey
              ) {
                recordSkip(
                  manifest.id,
                  manifest.versionCreated,
                  'tombstone-signer-epoch-mismatch',
                );
                continue;
              }
              const tombstoneSeq = verifiedV2Sequence.tombstoneSeq;
              const checkpointCandidate: ManifestReplayCheckpointCandidate = {
                albumId,
                epochId: verifiedV2Sequence.signerEpochId,
                signerKey,
                manifestId: manifest.id,
                manifestSeq: tombstoneSeq,
                operationKind: 'Tombstone',
                signatureFingerprint: verifiedV2Sequence.signatureFingerprint,
                versionCreated: manifest.versionCreated,
              };
              let prevMax = maxManifestSeqBySigner.get(signerKey);
              if (prevMax === undefined) {
                const persistedMax = await db.getManifestSeqHighWater(
                  albumId,
                  signerKey,
                );
                if (persistedMax !== null) {
                  prevMax = persistedMax;
                  maxManifestSeqBySigner.set(signerKey, persistedMax);
                }
              }
              if (prevMax !== undefined && tombstoneSeq <= prevMax) {
                if (
                  !isExactReplayCheckpoint(existingHead, {
                    epochId: verifiedV2Sequence.signerEpochId,
                    signerKey,
                    manifestSeq: tombstoneSeq,
                    operationKind: 'Tombstone',
                    signatureFingerprint:
                      verifiedV2Sequence.signatureFingerprint,
                  })
                ) {
                  log.error('Tombstone seq is stale and not an exact head', {
                    albumId,
                    manifestId: manifest.id,
                    seq: tombstoneSeq,
                    prevMax,
                  });
                  recordSkip(
                    manifest.id,
                    manifest.versionCreated,
                    'tombstone-stale-seq',
                  );
                  continue;
                }
              } else {
                if (
                  !canSupersedeReplayCheckpoint(
                    existingHead,
                    checkpointCandidate,
                  )
                ) {
                  recordSkip(
                    manifest.id,
                    manifest.versionCreated,
                    'tombstone-head-regression',
                  );
                  continue;
                }
                maxManifestSeqBySigner.set(signerKey, tombstoneSeq);
                manifestSeqHighWaterCandidates.push({
                  albumId,
                  signerKey,
                  manifestSeq: tombstoneSeq,
                  versionCreated: manifest.versionCreated,
                });
                manifestReplayCheckpointCandidates.push(checkpointCandidate);
              }
              replaySatisfiedManifestIds.add(manifest.id);
            }
            stagedPurges.push({
              albumId: manifest.albumId,
              photoId: manifest.id,
            });
            decrypted.push(createDeletedManifestTombstone(manifest));
            continue;
          }

          try {
            const manifestSeq = manifest.manifestSeq ?? undefined;
            const existingHead = await getCurrentReplayHead(manifest.id);
            if (manifestSeq === undefined && existingHead !== null) {
              log.error('Legacy manifest cannot replace a retained v2 head', {
                albumId,
                manifestId: manifest.id,
              });
              recordSkip(
                manifest.id,
                manifest.versionCreated,
                'manifest-v1-downgrade',
              );
              continue;
            }
            const encryptedMeta = fromBase64(manifest.encryptedMeta);
            const signature = fromBase64(manifest.signature);
            const serverSignerPubkey = fromBase64(manifest.signerPubkey);

            if (signature.length !== 64) {
              log.error('Manifest signature has an invalid length', {
                albumId,
                manifestId: manifest.id,
                signatureLength: signature.length,
              });
              recordSkip(
                manifest.id,
                manifest.versionCreated,
                'signature-bad-length',
              );
              continue;
            }

            if (!hasValidSigningKey(serverSignerPubkey)) {
              log.warn(`Manifest ${manifest.id} has empty signer pubkey`);
              recordSkip(
                manifest.id,
                manifest.versionCreated,
                'empty-signer-pubkey',
              );
              continue;
            }

            const manifestEpochBundle =
              await resolveManifestEpochBundle(serverSignerPubkey);
            if (manifestEpochBundle === null) {
              log.warn(
                'Manifest signer pubkey is not bound to a unique authenticated album epoch',
                { albumId, manifestId: manifest.id },
              );
              recordSkip(
                manifest.id,
                manifest.versionCreated,
                'signer-pubkey-mismatch',
              );
              continue;
            }
            if (manifestEpochBundle.epochId > response.currentEpochId) {
              recordSkip(
                manifest.id,
                manifest.versionCreated,
                'manifest-epoch-ahead',
              );
              continue;
            }

            throwIfAborted(signal);
            // Slice 4 — manifest decryption now routes through the Rust
            // epoch handle. The thumb-tier key is derived inside Rust;
            // the seed and the per-epoch sign-secret never cross Comlink.
            const epochHandleId =
              manifestEpochBundle.epochHandleId as EpochHandleId;
            const plaintextBytes = await crypto.decryptManifestWithEpoch(
              epochHandleId,
              encryptedMeta,
            );
            throwIfAborted(signal);

            let meta: PhotoMeta;
            try {
              meta = JSON.parse(
                new TextDecoder().decode(plaintextBytes),
              ) as PhotoMeta;
            } catch (parseErr) {
              log.warn(`Manifest ${manifest.id} JSON parse failed`, {
                error:
                  parseErr instanceof Error
                    ? parseErr.message
                    : String(parseErr),
              });
              recordSkip(manifest.id, manifest.versionCreated, 'json-parse');
              continue;
            }

            if (meta.id !== manifest.id) {
              log.error('Signed manifest identity does not match server row', {
                signedManifestId: meta.id,
                serverManifestId: manifest.id,
              });
              recordSkip(
                manifest.id,
                manifest.versionCreated,
                'manifest-id-mismatch',
              );
              continue;
            }
            if (meta.albumId !== albumId || meta.albumId !== manifest.albumId) {
              log.error('Signed manifest album does not match server row', {
                requestedAlbumId: albumId,
                signedAlbumId: meta.albumId,
                serverAlbumId: manifest.albumId,
                manifestId: manifest.id,
              });
              recordSkip(
                manifest.id,
                manifest.versionCreated,
                'signed-album-mismatch',
              );
              continue;
            }
            if (meta.epochId !== manifestEpochBundle.epochId) {
              log.error(
                'Signed manifest epoch does not match verified signer epoch',
                {
                  manifestId: manifest.id,
                  signedEpochId: meta.epochId,
                  responseEpochId: response.currentEpochId,
                  verifiedEpochId: manifestEpochBundle.epochId,
                },
              );
              recordSkip(
                manifest.id,
                manifest.versionCreated,
                'manifest-epoch-mismatch',
              );
              continue;
            }

            if (
              manifestSeq !== undefined &&
              (!Number.isSafeInteger(manifestSeq) || manifestSeq <= 0)
            ) {
              log.error(
                'Manifest sequence is outside the browser-safe integer range',
                {
                  albumId,
                  manifestId: manifest.id,
                },
              );
              recordSkip(
                manifest.id,
                manifest.versionCreated,
                'manifest-invalid-seq',
              );
              continue;
            }
            const transcriptInput = {
              ...manifestTranscriptInputForPhotoMeta(meta, encryptedMeta),
              ...(manifestSeq === undefined ? {} : { manifestSeq }),
            };
            if (
              !manifestShardIdsMatchTranscript(
                manifest.shardIds,
                transcriptInput,
              )
            ) {
              failedVerifyCount += 1;
              log.error(
                'Manifest signed shard list does not match sync payload',
                {
                  albumId,
                  manifestId: manifest.id,
                  failedVerifyCount,
                },
              );
              recordSkip(
                manifest.id,
                manifest.versionCreated,
                'transcript-mismatch',
              );
              continue;
            }

            throwIfAborted(signal);
            const isValid = await crypto.verifyManifestWithEpoch(
              transcriptInput,
              signature,
              manifestEpochBundle.signPublicKey,
            );

            if (!isValid) {
              failedVerifyCount += 1;
              log.error('Manifest signature verification failed', {
                albumId,
                manifestId: manifest.id,
                failedVerifyCount,
              });
              recordSkip(
                manifest.id,
                manifest.versionCreated,
                'signature-invalid',
              );
              continue;
            }

            // A v2 `manifestSeq` is included in the Rust-built transcript
            // above, so a server cannot alter it without invalidating the
            // signature. Compare it with the durable local floor before
            // accepting this manifest into the local snapshot.
            if (manifestSeq !== undefined) {
              const signerKey = signingKeyHighWaterKey(serverSignerPubkey);
              const fingerprint = signatureFingerprint(signature);
              const checkpointCandidate: ManifestReplayCheckpointCandidate = {
                albumId,
                epochId: manifestEpochBundle.epochId,
                signerKey,
                manifestId: manifest.id,
                manifestSeq,
                operationKind: 'Live',
                signatureFingerprint: fingerprint,
                versionCreated: manifest.versionCreated,
              };
              let prevMax = maxManifestSeqBySigner.get(signerKey);
              if (prevMax === undefined) {
                const persistedMax = await db.getManifestSeqHighWater(
                  albumId,
                  signerKey,
                );
                if (persistedMax !== null) {
                  prevMax = persistedMax;
                  maxManifestSeqBySigner.set(signerKey, persistedMax);
                }
              }
              if (prevMax !== undefined && manifestSeq <= prevMax) {
                if (
                  !isExactReplayCheckpoint(existingHead, {
                    epochId: manifestEpochBundle.epochId,
                    signerKey,
                    manifestSeq,
                    operationKind: 'Live',
                    signatureFingerprint: fingerprint,
                  })
                ) {
                  log.error('Manifest seq is stale and not an exact head', {
                    albumId,
                    manifestId: manifest.id,
                    seq: manifestSeq,
                    prevMax,
                  });
                  recordSkip(
                    manifest.id,
                    manifest.versionCreated,
                    'manifest-stale-seq',
                  );
                  continue;
                }
              } else {
                if (
                  !canSupersedeReplayCheckpoint(
                    existingHead,
                    checkpointCandidate,
                  )
                ) {
                  recordSkip(
                    manifest.id,
                    manifest.versionCreated,
                    'manifest-head-regression',
                  );
                  continue;
                }
                maxManifestSeqBySigner.set(signerKey, manifestSeq);
                manifestSeqHighWaterCandidates.push({
                  albumId,
                  signerKey,
                  manifestSeq,
                  versionCreated: manifest.versionCreated,
                });
                manifestReplayCheckpointCandidates.push(checkpointCandidate);
              }
              replaySatisfiedManifestIds.add(manifest.id);
            }

            decrypted.push({
              id: manifest.id,
              albumId: manifest.albumId,
              versionCreated: manifest.versionCreated,
              isDeleted: manifest.isDeleted,
              meta,
              shardIds: manifest.shardIds,
            });
          } catch (decryptErr) {
            if (isHandleLifecycleError(decryptErr)) {
              throw decryptErr;
            }

            log.warn(`Failed to process manifest ${manifest.id}`, {
              error:
                decryptErr instanceof Error
                  ? decryptErr.message
                  : String(decryptErr),
            });
            recordSkip(manifest.id, manifest.versionCreated, 'decrypt-error');
          }
        }

        throwIfAborted(signal);

        // Audit "sync C1 + C3": cursor advance is the riskiest line in
        // the engine. The new contract:
        //   - If any manifest was skipped this page, advance only to
        //     `minSkippedVersion - 1` so the skipped manifests will be
        //     re-fetched on the next run.
        //   - Otherwise advance to the response page-max.
        //   - In all cases, never let the persisted cursor go BACKWARDS
        //     (clamp to `max(sinceVersion, …)`). Combined with the
        //     server-regression guard above, this makes silent drift
        //     impossible.
        const desiredAdvance =
          minSkippedVersion !== null
            ? Math.max(sinceVersion, minSkippedVersion - 1)
            : Math.max(sinceVersion, response.albumVersion);
        // Apply only the contiguous verified prefix. A later valid row must
        // not reach cache or security state when an earlier version was
        // skipped, because the next request must replay that whole suffix.
        const committableDecrypted = decrypted.filter(
          (manifest) => manifest.versionCreated <= desiredAdvance,
        );
        const committableManifestIds = new Set(
          committableDecrypted.map((manifest) => manifest.id),
        );
        const manifestReplayCheckpoints =
          manifestReplayCheckpointCandidates.filter(
            (candidate) => candidate.versionCreated <= desiredAdvance,
          );
        const manifestSeqHighWatersBySigner = new Map<
          string,
          ManifestSeqHighWaterMark
        >();
        for (const candidate of manifestSeqHighWaterCandidates) {
          if (candidate.versionCreated > desiredAdvance) continue;
          const existing = manifestSeqHighWatersBySigner.get(
            candidate.signerKey,
          );
          if (!existing || candidate.manifestSeq > existing.manifestSeq) {
            manifestSeqHighWatersBySigner.set(candidate.signerKey, candidate);
          }
        }
        const manifestSeqHighWaters = [
          ...manifestSeqHighWatersBySigner.values(),
        ];
        const committablePurges = stagedPurges.filter((purge) =>
          committableManifestIds.has(purge.photoId),
        );
        // Keep the cursor behind a staged purge until that purge succeeds.
        // Live v2 pages may checkpoint cursor+cache atomically after security.
        const manifestSyncCheckpoint =
          !isFullRebuild &&
          committablePurges.length === 0 &&
          manifestSeqHighWaters.length > 0
            ? { albumId, albumVersion: desiredAdvance }
            : undefined;
        const persistManifestSyncCheckpoint =
          committableDecrypted.length > 0 &&
          manifestSyncCheckpoint !== undefined;

        const shouldPersistVerifiedEpoch =
          committableDecrypted.length > 0 ||
          (response.manifests.length === 0 && skippedIds.length === 0);
        if (shouldPersistVerifiedEpoch) {
          await db.insertManifests(
            committableDecrypted,
            manifestSeqHighWaters,
            manifestSyncCheckpoint,
            manifestReplayCheckpoints,
            [albumEpochHighWater],
          );
          for (const manifestId of replaySatisfiedManifestIds) {
            if (committableManifestIds.has(manifestId)) {
              rebuiltManifestIds.add(manifestId);
            }
          }
          if (committableDecrypted.length > 0) {
            this.dispatchSyncEvent('sync-progress', {
              albumId,
              count: committableDecrypted.length,
            });
          }

          // Deletion side effects run only after the replay floor, exact head,
          // and cache tombstone are durable. A failed security write therefore
          // cannot purge local content.
          for (const purge of committablePurges) {
            const purgeResult = await purgeLocalPhoto({
              ...purge,
              reason: 'sync-deleted',
            });
            if (purgeResult.blockers.length > 0) {
              throw new Error(
                `Local purge did not complete for manifest ${purge.photoId}: ${purgeResult.blockers.join(', ')}`,
              );
            }
          }
        }

        if (!isFullRebuild && !persistManifestSyncCheckpoint) {
          await db.setAlbumVersion(albumId, desiredAdvance);
        }
        sinceVersion = desiredAdvance;

        if (skippedIds.length > 0) {
          this.dispatchSyncEvent('sync-warning', {
            albumId,
            count: skippedIds.length,
            skippedManifestIds: skippedIds,
            skipReasonCounts,
          });
        }

        throwIfAborted(signal);

        if (!response.hasMore) {
          if (isFullRebuild) {
            const missingHeads = retainedReplayHeads.filter(
              (checkpoint) => !rebuiltManifestIds.has(checkpoint.manifestId),
            );
            if (missingHeads.length > 0) {
              const missingManifestIds = [
                ...new Set(missingHeads.map((head) => head.manifestId)),
              ];
              const error = new Error(
                `Full rebuild omitted ${missingManifestIds.length} retained signed manifest head(s)`,
              );
              log.error(error.message, { albumId, missingManifestIds });
              throw error;
            }
            if (
              retainedReplayHeads.length > 0 &&
              (skippedIds.length > 0 ||
                desiredAdvance !== response.albumVersion)
            ) {
              throw new Error(
                'Full rebuild did not reach a fully verified terminal state',
              );
            }
            await db.setAlbumVersion(albumId, desiredAdvance);
          }
          break;
        }

        // If we held the cursor back due to skips AND the server reports
        // hasMore=true, exit the loop too — re-querying with the same
        // sinceVersion would return the same skipped manifests and the
        // pagination-no-advance guard above would error. Wait for the
        // next sync pass to retry the skipped IDs.
        if (
          minSkippedVersion !== null &&
          desiredAdvance < response.albumVersion
        ) {
          if (isFullRebuild) {
            throw new Error(
              'Full rebuild stopped before a terminal server page',
            );
          }
          break;
        }
      }

      log.info(`Dispatching sync-complete event for album ${albumId}`);
      this.dispatchSyncEvent('sync-complete', { albumId });
    } catch (error) {
      // If the server reports we've lost access to the album (membership
      // revoked / soft-deleted), drop every cached epoch handle for it so
      // we cannot serve decrypts off stale keys and so the cache cannot
      // grow unbounded with handles for albums we can no longer touch.
      if (
        error instanceof ApiError &&
        (error.status === 403 || error.status === 404)
      ) {
        try {
          invalidateAlbumEpochKeys(albumId);
        } catch (invalidateErr) {
          log.warn('invalidateAlbum (post-403/404) threw', {
            albumId,
            error:
              invalidateErr instanceof Error
                ? invalidateErr.message
                : String(invalidateErr),
          });
        }
      }
      this.dispatchSyncEvent('sync-error', {
        albumId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    } finally {
      this.syncing = false;
      this.syncAbortController = null;

      // Process queued sync requests
      void this.processQueuedSyncs();
    }
  }

  /**
   * Process any queued sync requests after current sync completes.
   * This ensures uploads that completed during a sync still get synced.
   * Resolves all pending promises for each queued album.
   */
  private async processQueuedSyncs(): Promise<void> {
    if (this.pendingSyncQueue.size === 0) {
      return;
    }

    // Take all queued requests and clear the queue
    const queuedSyncs = Array.from(this.pendingSyncQueue.entries());
    this.pendingSyncQueue.clear();

    log.info(`Processing ${queuedSyncs.length} queued sync request(s)`);

    // Process each queued album (they will queue themselves if another is in progress)
    for (const [queuedAlbumId, request] of queuedSyncs) {
      try {
        await this.sync(queuedAlbumId, request.epochHandleId);
        // Resolve all waiting promises for this album
        for (const { resolve } of request.resolvers) {
          resolve();
        }
      } catch (err) {
        log.error(`Queued sync failed for album ${queuedAlbumId}`, err);
        // Reject all waiting promises for this album
        const error = err instanceof Error ? err : new Error(String(err));
        for (const { reject } of request.resolvers) {
          reject(error);
        }
      }
    }
  }

  /**
   * Cancel ongoing sync
   */
  cancel(): void {
    if (this.syncAbortController) {
      this.syncAbortController.abort();
    }
  }

  /**
   * Clear cached epoch keys (call on logout)
   */
  clearCache(): void {
    clearAllEpochKeys();
  }

  /**
   * Get epoch handle id from cache (if available).
   * Returns null if handle not cached - caller should trigger sync first.
   */
  getEpochKey(albumId: string, epochId: number): EpochHandleId | null {
    const bundle = getEpochKey(albumId, epochId);
    return (bundle?.epochHandleId as EpochHandleId | undefined) ?? null;
  }

  /**
   * Store an epoch handle in the cache.
   * Used when unwrapping keys after sync
   *
   * IMPORTANT: This method preserves existing signKeypair if the epoch key
   * was already cached with complete data. This prevents overwriting a
   * correctly unwrapped bundle with one that has empty signKeypair.
   */
  setEpochKey(
    albumId: string,
    epochId: number,
    epochHandleId: EpochHandleId,
  ): void {
    // Check if we already have a cached bundle with complete signKeypair
    const existing = getEpochKey(albumId, epochId);
    if (existing) {
      // Check if existing bundle has a valid (non-zero) signKeypair
      const hasValidSignKeypair = existing.signKeypair.publicKey.some(
        (b) => b !== 0,
      );
      if (hasValidSignKeypair) {
        // Don't overwrite - we already have complete data
        log.debug(
          `Preserving existing epoch key ${epochId} with valid signKeypair`,
        );
        return;
      }
    }

    // Store minimal bundle (legacy compatibility)
    storeEpochKey(albumId, {
      epochId,
      epochHandleId,
      signKeypair: {
        publicKey: new Uint8Array(32),
        secretKey: new Uint8Array(64),
      },
    });
  }

  /**
   * Ensure epoch keys are loaded for an album before sync.
   * Fetches and unwraps keys from server if not cached.
   */
  async ensureEpochKeys(albumId: string): Promise<void> {
    try {
      await fetchAndUnwrapEpochKeys(albumId);
    } catch (err) {
      log.error(`Failed to load epoch keys for album ${albumId}`, err);
    }
  }

  private dispatchSyncEvent(
    type: SyncEventType,
    detail: SyncEventDetail,
  ): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /**
   * Notify subscribers that an album-content save observed a server-side
   * collision and the local conflict resolver had to merge. The detail
   * payload is intentionally minimal and contains no key material or
   * plaintext block bodies — see `ContentConflictEventDetail` for the
   * exact shape. This is the central seam used by the React
   * `AlbumContentContext` after a 409, so the `SyncCoordinator` can
   * surface a single normalized event to the UI rather than every
   * caller having to discover its own listener path.
   */
  notifyContentConflict(detail: ContentConflictEventDetail): void {
    log.warn(
      `Content conflict resolved for album ${detail.albumId}` +
        ` (strategy=${detail.strategy}, manual=${detail.manualConflictCount},` +
        ` total=${detail.totalDecisionCount})`,
    );
    this.dispatchEvent(new CustomEvent('content-conflict', { detail }));
  }
}

/** Global sync engine instance */
export const syncEngine = new SyncEngine();

// Re-export types for convenience
export type { SyncEventDetail, SyncEventType };
