/**
 * Tombstone signing — owner-side write path (batch 5d — A2).
 *
 * Builds the canonical tombstone transcript bytes (matching
 * `mosaic-domain::canonical_tombstone_transcript_bytes`) and signs them
 * with the per-epoch Ed25519 `ManifestSigningSecretKey` so other clients'
 * sync engines verify the deletion before purging local state
 * (audit `sync C2`).
 */

import { getCryptoClient } from './crypto-client';
import { fetchAndUnwrapEpochKeys } from './epoch-key-service';
import { getCurrentEpochKey } from './epoch-key-store';
import { buildTombstoneTranscriptBytes } from './tombstone-transcript';

/**
 * The bytes a signed delete sends to the backend, ready to drop into the
 * DELETE /manifests/{id} body.
 */
export interface SignedTombstone {
  /** Base64 of the 64-byte Ed25519 signature. */
  tombstoneSignature: string;
  /** Epoch ID whose `ManifestSigningSecretKey` produced the signature. */
  signerEpochId: number;
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

  const transcriptBytes = buildTombstoneTranscriptBytes({
    albumId: input.albumId,
    epochId: epochBundle.epochId,
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
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
