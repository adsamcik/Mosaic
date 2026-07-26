/**
 * Tombstone signing — owner-side write path (batch 5d — A2).
 *
 * Builds the canonical tombstone transcript bytes (matching
 * `mosaic-domain::canonical_tombstone_transcript_bytes`) and signs them
 * with the per-epoch Ed25519 `ManifestSigningSecretKey` so other clients'
 * sync engines verify the deletion before purging local state
 * (audit `sync C2`).
 */

import { getApi, toBase64 } from './api';
import type { DeleteManifestRequest } from './api-types';
import { getCryptoClient } from './crypto-client';
import { fetchAndUnwrapEpochKeys } from './epoch-key-service';
import { getCurrentEpochKey } from './epoch-key-store';
import { buildTombstoneTranscriptBytesV2 } from './tombstone-transcript';

/**
 * The bytes a signed delete sends to the backend, ready to drop into the
 * DELETE /manifests/{id} body.
 */
export interface SignedTombstone extends DeleteManifestRequest {
  /** Base64 of the 64-byte Ed25519 signature. */
  tombstoneSignature: string;
  /** Epoch ID whose `ManifestSigningSecretKey` produced the signature. */
  signerEpochId: number;
  /** Monotonic signer sequence bound into the v2 transcript. */
  tombstoneSeq: number;
  /** Server reservation consumed atomically by the delete. */
  sequenceReservationId: string;
  /** Immutable pre-delete version bound into the signature. */
  tombstoneVersionCreated: number;
}

/**
 * Signs a tombstone for `(albumId, photoId, versionCreated)` using the
 * current album epoch. Returns the encoded DELETE body shape.
 *
 * @throws Error if no epoch key is cached for the album (caller should
 *   refresh via `fetchAndUnwrapEpochKeys` first) or if the signer epoch
 *   has no signing handle.
 */
export async function signTombstone(input: {
  albumId: string;
  photoId: string;
  versionCreated: number;
  /** Stable UUID for retrying the same reservation request. */
  operationId?: string;
}): Promise<SignedTombstone> {
  // Make sure we have at least one epoch key cached; deletes can happen
  // long after the last sync and a stale cache would leave us with no
  // signing handle. fetchAndUnwrapEpochKeys is idempotent and cheap.
  await fetchAndUnwrapEpochKeys(input.albumId);

  const epochBundle = getCurrentEpochKey(input.albumId);
  if (epochBundle == null) {
    throw new Error(
      `cannot sign tombstone: no epoch key cached for album ${input.albumId}`,
    );
  }

  const operationId = input.operationId ?? globalThis.crypto.randomUUID();
  const api = getApi();
  const reservation = await api.reserveManifestSequence({
    albumId: input.albumId,
    signerPubkey: toBase64(epochBundle.signPublicKey),
    targetManifestId: input.photoId,
    operationId,
    operationKind: 'Tombstone',
  });

  const transcriptBytes = buildTombstoneTranscriptBytesV2({
    albumId: input.albumId,
    epochId: epochBundle.epochId,
    tombstoneSeq: reservation.manifestSeq,
    photoId: input.photoId,
    versionCreated: input.versionCreated,
  });

  const crypto = await getCryptoClient();
  const signatureBytes = await crypto.signManifestWithEpoch(
    epochBundle.epochHandleId,
    transcriptBytes,
  );
  if (signatureBytes.length !== 64) {
    throw new Error(
      `signed tombstone is ${signatureBytes.length} bytes, expected 64`,
    );
  }

  return {
    tombstoneSignature: toBase64(signatureBytes),
    signerEpochId: epochBundle.epochId,
    tombstoneSeq: reservation.manifestSeq,
    sequenceReservationId: reservation.reservationId,
    tombstoneVersionCreated: input.versionCreated,
  };
}
