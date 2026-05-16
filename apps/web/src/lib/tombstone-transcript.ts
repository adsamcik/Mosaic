/**
 * Tombstone (soft-delete) signing transcript bytes.
 *
 * Mirrors the canonical Rust producer
 * `mosaic_domain::canonical_tombstone_transcript_bytes` byte-for-byte.
 * Used by the sync engine to verify Ed25519 signatures on incoming
 * tombstones BEFORE purging local state (audit `sync C2`, batch 5c — A2).
 *
 * Layout (64 bytes total):
 * - 19 bytes: `Mosaic_Tombstone_v1` UTF-8 prefix
 * - 1 byte: transcript version (`0x01`)
 * - 16 bytes: `album_id` (raw UUID bytes, network order)
 * - 4 bytes: `epoch_id` (little-endian)
 * - 16 bytes: `photo_id` (raw UUID bytes, network order)
 * - 8 bytes: `version_created` (little-endian, signed i64)
 *
 * The byte-parity with Rust is locked by
 * `apps/web/src/lib/__tests__/tombstone-transcript.test.ts` using the
 * same fixture as the Rust test
 * `crates/mosaic-domain/tests/tombstone_transcript.rs`.
 */

const TOMBSTONE_SIGN_CONTEXT = new TextEncoder().encode('Mosaic_Tombstone_v1');
const TOMBSTONE_TRANSCRIPT_VERSION = 1;

export const TOMBSTONE_TRANSCRIPT_LENGTH = 64;

/**
 * Parses a UUID string into 16 raw bytes (network byte order, matching
 * Rust's `Guid.ToByteArray` for the .NET backend and Rust's `Uuid::as_bytes`).
 *
 * @throws Error if the input is not a 32-hex-char UUID.
 */
export function uuidToRawBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(`tombstone transcript UUID must be 32 hex chars (got ${hex.length})`);
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Builds the canonical 64-byte tombstone transcript that the editor signs
 * with the per-epoch Ed25519 `ManifestSigningSecretKey`.
 *
 * `versionCreated` is a JS `number` — JavaScript safe-integer range
 * (-2^53..2^53) is a strict subset of the Rust i64 range, so any value
 * supplied here fits. The backend column is BIGINT; we encode as
 * little-endian i64 to match the Rust producer.
 *
 * @throws Error if `albumId` or `photoId` is not a valid UUID string,
 *   `epochId` is out of u32 range, or `versionCreated` is not an
 *   integer in the safe range.
 */
export function buildTombstoneTranscriptBytes(input: {
  albumId: string;
  epochId: number;
  photoId: string;
  versionCreated: number;
}): Uint8Array {
  if (!Number.isInteger(input.epochId) || input.epochId < 0 || input.epochId > 0xffff_ffff) {
    throw new Error(`tombstone epochId must be a u32 (got ${input.epochId})`);
  }
  if (!Number.isInteger(input.versionCreated)) {
    throw new Error(`tombstone versionCreated must be an integer (got ${input.versionCreated})`);
  }
  if (!Number.isSafeInteger(input.versionCreated)) {
    throw new Error(
      `tombstone versionCreated must be within JS safe-integer range (got ${input.versionCreated})`,
    );
  }

  const albumBytes = uuidToRawBytes(input.albumId);
  const photoBytes = uuidToRawBytes(input.photoId);

  const buf = new Uint8Array(TOMBSTONE_TRANSCRIPT_LENGTH);
  let off = 0;
  buf.set(TOMBSTONE_SIGN_CONTEXT, off);
  off += TOMBSTONE_SIGN_CONTEXT.length;
  buf[off] = TOMBSTONE_TRANSCRIPT_VERSION;
  off += 1;
  buf.set(albumBytes, off);
  off += 16;

  // epoch_id as u32 little-endian
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setUint32(off, input.epochId, /* littleEndian */ true);
  off += 4;

  buf.set(photoBytes, off);
  off += 16;

  // version_created as i64 little-endian. JS `number` covers the safe
  // range; BigInt is used for the 64-bit write because DataView's
  // setBigInt64 is the only standard way to land 8 bytes in one shot.
  view.setBigInt64(off, BigInt(input.versionCreated), /* littleEndian */ true);
  off += 8;

  if (off !== TOMBSTONE_TRANSCRIPT_LENGTH) {
    // Defensive: the layout is fixed; the helper has no early-exit path,
    // so this can only fire if a future change forgets to update the
    // constant. Keep the assertion to catch that mismatch immediately.
    throw new Error(`tombstone transcript length drift: ${off} != ${TOMBSTONE_TRANSCRIPT_LENGTH}`);
  }
  return buf;
}
