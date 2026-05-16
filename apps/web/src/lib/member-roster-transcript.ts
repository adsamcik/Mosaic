/**
 * Member roster (owner-signed) canonical transcript bytes.
 *
 * Mirrors the canonical Rust producer
 * `mosaic_domain::canonical_member_roster_transcript_bytes` byte-for-byte.
 * Used by the album UI to verify the roster signature BEFORE rendering
 * role badges (audit `threat-model C-3 (server-controlled member roles)`,
 * batch C2c).
 *
 * Layout (`55 + 17·N` bytes total):
 * - 22 bytes: `Mosaic_MemberRoster_v1` UTF-8 prefix
 * - 1 byte: transcript version (`0x01`)
 * - 16 bytes: `album_id` (raw UUID bytes, network order)
 * - 4 bytes: `epoch_id` (little-endian u32)
 * - 8 bytes: `roster_version` (little-endian signed i64)
 * - 4 bytes: `member_count` (little-endian u32)
 * - for each member in ascending `member_id` byte order:
 *   - 16 bytes: `member_id`
 *   - 1 byte: role byte (1=owner, 2=editor, 3=viewer)
 *
 * Byte parity with Rust is locked by
 * `apps/web/src/lib/__tests__/member-roster-transcript.test.ts` against
 * the same fixture as the Rust test
 * `crates/mosaic-domain/tests/member_roster_transcript.rs`.
 */

import { uuidToRawBytes } from './tombstone-transcript';

const MEMBER_ROSTER_SIGN_CONTEXT = new TextEncoder().encode('Mosaic_MemberRoster_v1');
const MEMBER_ROSTER_TRANSCRIPT_VERSION = 1;

export const MEMBER_ROSTER_HEADER_LENGTH =
  MEMBER_ROSTER_SIGN_CONTEXT.length + 1 + 16 + 4 + 8 + 4; // 55
export const MEMBER_ROSTER_ENTRY_LENGTH = 16 + 1; // 17

/** Wire-pinned role byte values. MUST match `mosaic-domain` constants. */
export const MEMBER_ROLE_OWNER_BYTE = 1;
export const MEMBER_ROLE_EDITOR_BYTE = 2;
export const MEMBER_ROLE_VIEWER_BYTE = 3;

export type MemberRoleByte =
  | typeof MEMBER_ROLE_OWNER_BYTE
  | typeof MEMBER_ROLE_EDITOR_BYTE
  | typeof MEMBER_ROLE_VIEWER_BYTE;

/** Maps a backend role string to its wire byte. Returns null for unknown roles. */
export function roleStringToByte(role: string): MemberRoleByte | null {
  switch (role) {
    case 'owner':
      return MEMBER_ROLE_OWNER_BYTE;
    case 'editor':
      return MEMBER_ROLE_EDITOR_BYTE;
    case 'viewer':
      return MEMBER_ROLE_VIEWER_BYTE;
    default:
      return null;
  }
}

/** Maps a wire role byte back to its backend role string. */
export function roleByteToString(byte: number): 'owner' | 'editor' | 'viewer' | null {
  switch (byte) {
    case MEMBER_ROLE_OWNER_BYTE:
      return 'owner';
    case MEMBER_ROLE_EDITOR_BYTE:
      return 'editor';
    case MEMBER_ROLE_VIEWER_BYTE:
      return 'viewer';
    default:
      return null;
  }
}

export interface RosterMember {
  userId: string;
  roleByte: MemberRoleByte;
}

/**
 * Builds the canonical roster transcript that the owner signs with the
 * per-epoch Ed25519 `ManifestSigningSecretKey`.
 *
 * Sorts the supplied members ascending by raw `member_id` bytes; this
 * matches the Rust producer's canonical ordering so the byte layout is
 * sort-invariant.
 *
 * @throws Error if `albumId` or any `userId` is not a 32-hex-char UUID,
 *   if `epochId` is not a u32, if `rosterVersion` is not a safe integer,
 *   or if a duplicate `userId` is present.
 */
export function buildMemberRosterTranscriptBytes(input: {
  albumId: string;
  epochId: number;
  rosterVersion: number;
  members: ReadonlyArray<RosterMember>;
}): Uint8Array {
  if (!Number.isInteger(input.epochId) || input.epochId < 0 || input.epochId > 0xffff_ffff) {
    throw new Error(`roster epochId must be a u32 (got ${input.epochId})`);
  }
  if (!Number.isInteger(input.rosterVersion)) {
    throw new Error(`roster rosterVersion must be an integer (got ${input.rosterVersion})`);
  }
  if (!Number.isSafeInteger(input.rosterVersion)) {
    throw new Error(
      `roster rosterVersion must be within JS safe-integer range (got ${input.rosterVersion})`,
    );
  }
  if (input.members.length > 0xffff_ffff) {
    throw new Error(`roster has too many members to encode (got ${input.members.length})`);
  }

  const albumBytes = uuidToRawBytes(input.albumId);
  // Decode all member UUIDs once and reject duplicates before any allocation.
  const entries: { idBytes: Uint8Array; roleByte: MemberRoleByte }[] = input.members.map(
    (m) => ({ idBytes: uuidToRawBytes(m.userId), roleByte: m.roleByte }),
  );
  // Sort ascending by id bytes — must match the Rust canonical order.
  entries.sort((a, b) => {
    for (let i = 0; i < 16; i += 1) {
      const diff = (a.idBytes[i] ?? 0) - (b.idBytes[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });
  // Reject duplicates AFTER sorting (only need to check adjacent pairs).
  for (let i = 1; i < entries.length; i += 1) {
    const prev = entries[i - 1]!.idBytes;
    const curr = entries[i]!.idBytes;
    let dup = true;
    for (let b = 0; b < 16; b += 1) {
      if (prev[b] !== curr[b]) {
        dup = false;
        break;
      }
    }
    if (dup) {
      throw new Error(`roster has duplicate member_id at sorted index ${i}`);
    }
  }

  const totalLength = MEMBER_ROSTER_HEADER_LENGTH + entries.length * MEMBER_ROSTER_ENTRY_LENGTH;
  const buf = new Uint8Array(totalLength);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 0;
  buf.set(MEMBER_ROSTER_SIGN_CONTEXT, off);
  off += MEMBER_ROSTER_SIGN_CONTEXT.length;
  buf[off] = MEMBER_ROSTER_TRANSCRIPT_VERSION;
  off += 1;
  buf.set(albumBytes, off);
  off += 16;
  view.setUint32(off, input.epochId, /* littleEndian */ true);
  off += 4;
  view.setBigInt64(off, BigInt(input.rosterVersion), /* littleEndian */ true);
  off += 8;
  view.setUint32(off, entries.length, /* littleEndian */ true);
  off += 4;
  for (const entry of entries) {
    buf.set(entry.idBytes, off);
    off += 16;
    buf[off] = entry.roleByte;
    off += 1;
  }
  if (off !== totalLength) {
    throw new Error(`roster transcript length drift: ${off} != ${totalLength}`);
  }
  return buf;
}
