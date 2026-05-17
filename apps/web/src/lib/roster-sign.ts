/**
 * Owner-side helper that signs and publishes the canonical member
 * roster (audit `threat-model C-3`, batch C2c-4).
 *
 * Companion to `verifyRosterSignature` (visitor read path landed in
 * C2c-2) and `useRosterVerification` (UI gating landed in C2c-3). The
 * owner calls `signAndPublishRoster` after any membership change so
 * the signed roster on the server matches the live `AlbumMember`
 * table; visitor clients then verify before rendering role badges.
 */

import { getApi } from './api';
import { getCryptoClient } from './crypto-client';
import { fetchAndUnwrapEpochKeys } from './epoch-key-service';
import { getCurrentEpochKey } from './epoch-key-store';
import {
  buildMemberRosterTranscriptBytes,
  roleStringToByte,
  type MemberRoleByte,
} from './member-roster-transcript';

/** Member shape consumed by the owner-side signing helper. */
export interface SignableMember {
  userId: string;
  /** Backend role string ('owner' | 'editor' | 'viewer'). */
  role: string;
}

/** Outcome of a `signAndPublishRoster` call. */
export interface SignAndPublishRosterResult {
  /** Monotonic version that was sent (always > previous server value). */
  rosterVersion: number;
  /** Epoch whose signing key produced the signature. */
  signerEpochId: number;
}

/**
 * Builds the canonical roster transcript, signs it with the per-epoch
 * Ed25519 manifest signing key, and POSTs to
 * `/api/v1/albums/{id}/members/roster`. The new `rosterVersion` is
 * `(current memberRosterVersion ?? 0) + 1` so it strictly increases.
 *
 * @throws Error if the current epoch key is not cached (caller should
 *   refresh via `fetchAndUnwrapEpochKeys`), if any member role string
 *   is not in the canonical set, or if the worker signer returns a
 *   non-64-byte signature.
 */
export async function signAndPublishRoster(
  albumId: string,
  members: ReadonlyArray<SignableMember>,
): Promise<SignAndPublishRosterResult> {
  // Translate backend role strings to wire bytes up-front so any bad
  // role label fails before we touch crypto.
  const wireMembers: Array<{ userId: string; roleByte: MemberRoleByte }> = members.map(
    (m) => {
      const byte = roleStringToByte(m.role);
      if (byte == null) {
        throw new Error(`unknown member role '${m.role}' for ${m.userId}`);
      }
      return { userId: m.userId, roleByte: byte };
    },
  );

  // Make sure the epoch cache is warm. Otherwise the signing handle
  // lookup below will return null on a fresh client after rotation.
  await fetchAndUnwrapEpochKeys(albumId);
  const epochBundle = getCurrentEpochKey(albumId);
  if (epochBundle == null) {
    throw new Error(
      `cannot sign roster: no epoch key cached for album ${albumId}`,
    );
  }

  // Fetch authoritative current rosterVersion so the new version is
  // strictly monotonic. A stale local copy could collide with a
  // concurrent owner session on another device — the backend enforces
  // monotonicity but failing fast here yields a better UX.
  const album = await getApi().getAlbum(albumId);
  const currentVersion = album.memberRosterVersion ?? 0;
  const nextVersion = currentVersion + 1;

  const transcriptBytes = buildMemberRosterTranscriptBytes({
    albumId,
    epochId: epochBundle.epochId,
    rosterVersion: nextVersion,
    members: wireMembers,
  });

  const crypto = await getCryptoClient();
  const signatureBytes = await crypto.signManifestWithEpoch(
    epochBundle.epochHandleId,
    transcriptBytes,
  );
  if (signatureBytes.length !== 64) {
    throw new Error(
      `signed roster signature is ${signatureBytes.length} bytes, expected 64`,
    );
  }

  await getApi().publishSignedRoster(albumId, {
    rosterVersion: nextVersion,
    signerEpochId: epochBundle.epochId,
    signature: toBase64(signatureBytes),
    members: wireMembers,
  });

  return {
    rosterVersion: nextVersion,
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
