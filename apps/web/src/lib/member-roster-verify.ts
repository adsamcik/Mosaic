/**
 * Member roster signature verification (audit `threat-model C-3`,
 * batch C2c-2).
 *
 * The owner publishes a signed member roster via the C2b-2 endpoint;
 * the album response carries `memberRosterSignature`,
 * `memberRosterSignerEpochId`, and `memberRosterVersion`. The visitor
 * client rebuilds the same canonical transcript from the live members
 * list and verifies the signature against the album's published epoch
 * signing pubkey. If the signature is missing, malformed, or fails to
 * verify, role badges in the UI are gated to an "unverified" state
 * instead of trusting server-told role labels.
 */

import { fromBase64 } from './api';
import {
  buildMemberRosterTranscriptBytes,
  roleStringToByte,
  type MemberRoleByte,
} from './member-roster-transcript';

/**
 * Outcome of a roster verification attempt.
 *
 * `verified: true` means the UI can render role badges from the
 * server-supplied member list with confidence — the owner signed
 * exactly this set of `(userId, role)` pairs at this rosterVersion.
 *
 * `verified: false` ALWAYS comes with a `reason` so the UI can tell
 * users why role badges are hidden (e.g. "Roster has not been
 * published yet" vs "Signature verification failed").
 */
export type RosterVerificationResult =
  | { verified: true; rosterVersion: number; signerEpochId: number }
  | { verified: false; reason: RosterVerificationReason };

export type RosterVerificationReason =
  | 'unsigned' // album has no signature yet (newly created / pre-C2)
  | 'bad-base64' // signature field is not valid base64
  | 'bad-length' // signature is not exactly 64 bytes (Ed25519 strict)
  | 'unknown-signer-epoch' // signer epoch not in the cached epoch key set
  | 'empty-signer-pubkey'
  | 'unknown-role' // a member has a backend role we don't recognise
  | 'transcript-build-failed'
  | 'signature-invalid'
  | 'verify-error';

/** Minimal album shape needed for verification (matches `AlbumSchema`). */
export interface RosterAlbumInput {
  id: string;
  memberRosterSignature?: string | null;
  memberRosterSignerEpochId?: number | null;
  memberRosterVersion?: number | null;
}

/** Minimal member shape needed for verification. */
export interface RosterMemberInput {
  userId: string;
  /** Backend role string ('owner' | 'editor' | 'viewer'). */
  role: string;
}

export interface RosterVerifyDeps {
  fetchEpochKey: (
    albumId: string,
    epochId: number,
  ) => Promise<{ signPublicKey: Uint8Array }>;
  verifySignature: (
    transcriptBytes: Uint8Array,
    signature: Uint8Array,
    pubkey: Uint8Array,
  ) => Promise<boolean>;
}

function hasValidSigningKey(pubkey: Uint8Array): boolean {
  return pubkey.length === 32 && pubkey.some((b) => b !== 0);
}

/**
 * Verifies a signed member roster end-to-end. Returns a tagged result
 * with a reason on failure so the UI can render a precise "unverified"
 * pill (or hide role badges entirely).
 *
 * This function never throws — verification failures, key-lookup
 * failures, and worker errors are all coerced into the
 * `{ verified: false, reason }` shape so the UI degrades gracefully.
 */
export async function verifyRosterSignature(
  album: RosterAlbumInput,
  members: ReadonlyArray<RosterMemberInput>,
  deps: RosterVerifyDeps,
): Promise<RosterVerificationResult> {
  if (
    !album.memberRosterSignature ||
    album.memberRosterSignerEpochId == null ||
    album.memberRosterVersion == null
  ) {
    return { verified: false, reason: 'unsigned' };
  }

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = fromBase64(album.memberRosterSignature);
  } catch {
    return { verified: false, reason: 'bad-base64' };
  }
  if (signatureBytes.length !== 64) {
    return { verified: false, reason: 'bad-length' };
  }

  // Convert backend role strings to wire bytes. Unknown roles are a
  // protocol violation — the UI should never trust badges in that case.
  const wireMembers: { userId: string; roleByte: MemberRoleByte }[] = [];
  for (const m of members) {
    const byte = roleStringToByte(m.role);
    if (byte == null) {
      return { verified: false, reason: 'unknown-role' };
    }
    wireMembers.push({ userId: m.userId, roleByte: byte });
  }

  let signerEpochBundle: { signPublicKey: Uint8Array };
  try {
    signerEpochBundle = await deps.fetchEpochKey(
      album.id,
      album.memberRosterSignerEpochId,
    );
  } catch {
    return { verified: false, reason: 'unknown-signer-epoch' };
  }
  if (!hasValidSigningKey(signerEpochBundle.signPublicKey)) {
    return { verified: false, reason: 'empty-signer-pubkey' };
  }

  let transcriptBytes: Uint8Array;
  try {
    transcriptBytes = buildMemberRosterTranscriptBytes({
      albumId: album.id,
      epochId: album.memberRosterSignerEpochId,
      rosterVersion: album.memberRosterVersion,
      members: wireMembers,
    });
  } catch {
    return { verified: false, reason: 'transcript-build-failed' };
  }

  let ok = false;
  try {
    ok = await deps.verifySignature(
      transcriptBytes,
      signatureBytes,
      signerEpochBundle.signPublicKey,
    );
  } catch {
    return { verified: false, reason: 'verify-error' };
  }

  if (!ok) {
    return { verified: false, reason: 'signature-invalid' };
  }
  return {
    verified: true,
    rosterVersion: album.memberRosterVersion,
    signerEpochId: album.memberRosterSignerEpochId,
  };
}
