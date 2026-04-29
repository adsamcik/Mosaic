/**
 * Mosaic Crypto Library - Manifest Transcript Builder
 *
 * Canonical Mosaic manifest transcript builder.
 *
 * Byte-identical mirror of Rust `mosaic_domain::canonical_manifest_transcript_bytes`.
 * Use the output as the input to {@link signManifestCanonical} / {@link verifyManifestCanonical}
 * for cross-implementation manifest-signature parity.
 *
 * Layout (little-endian, no padding):
 *
 *   MANIFEST_SIGN_CONTEXT (18 bytes ASCII "Mosaic_Manifest_v1")
 *   || MANIFEST_TRANSCRIPT_VERSION (1 byte = 0x01)
 *   || album_id (16 bytes)
 *   || epoch_id (LE u32, 4 bytes)
 *   || encrypted_meta_len (LE u32, 4 bytes)
 *   || encrypted_meta (encrypted_meta_len bytes)
 *   || shard_count (LE u32, 4 bytes)
 *   || repeated `shard_count` times, each shard:
 *        chunk_index (LE u32, 4 bytes)
 *     || tier (1 byte: 1=Thumbnail, 2=Preview, 3=Original)
 *     || shard_id (16 bytes)
 *     || sha256 (32 bytes)
 */

import { CryptoError, CryptoErrorCode, MANIFEST_SIGN_CONTEXT } from './types';
import { concat, toBytes } from './utils';

/** Canonical manifest transcript framing version. */
const MANIFEST_TRANSCRIPT_VERSION = 1;

/** Maximum value representable in a little-endian u32 length prefix. */
const U32_MAX = 0xffff_ffff;

/**
 * One shard's contribution to a canonical manifest transcript.
 */
export interface ManifestShardRef {
  /** u32 index of this chunk within the photo. After sorting, must be sequential 0,1,2,... */
  chunkIndex: number;
  /** ShardTier byte: 1=Thumbnail, 2=Preview, 3=Original. */
  tier: 1 | 2 | 3;
  /** 16-byte shard identifier. */
  shardId: Uint8Array;
  /** 32-byte SHA-256 of the encrypted shard payload. */
  sha256: Uint8Array;
}

/**
 * Inputs to {@link buildManifestTranscript}.
 */
export interface ManifestTranscriptInputs {
  /** 16-byte album identifier. */
  albumId: Uint8Array;
  /** u32 epoch identifier. */
  epochId: number;
  /** Encrypted metadata blob, MUST be non-empty (server-opaque ciphertext). */
  encryptedMeta: Uint8Array;
  /** Shards covered by this manifest. MUST be non-empty. Will be sorted by chunkIndex ascending. */
  shards: ManifestShardRef[];
}

/**
 * Encode `n` as a little-endian u32 (4 bytes).
 *
 * @throws CryptoError(LENGTH_TOO_LARGE) if `n` does not fit in a u32.
 */
function u32Le(n: number, field: string): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > U32_MAX) {
    throw new CryptoError(
      `${field} does not fit in u32: ${n}`,
      CryptoErrorCode.LENGTH_TOO_LARGE,
    );
  }
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, n, true);
  return buf;
}

/**
 * Build canonical Mosaic manifest transcript bytes.
 *
 * Byte-identical to Rust `mosaic_domain::canonical_manifest_transcript_bytes`.
 *
 * @param inputs - Album identity, epoch, encrypted metadata, and shards.
 * @returns Canonical transcript bytes ready to feed to {@link signManifestCanonical}.
 * @throws CryptoError with code:
 *   - INVALID_INPUT if albumId, shardId, or sha256 lengths are wrong;
 *   - EMPTY_ENCRYPTED_META if `encryptedMeta` is zero bytes;
 *   - EMPTY_SHARD_LIST if `shards` is empty;
 *   - NON_SEQUENTIAL_SHARD_INDEX if sorted shard indices are not 0,1,2,...,n-1;
 *   - LENGTH_TOO_LARGE if a u32 length prefix would overflow.
 */
export function buildManifestTranscript(
  inputs: ManifestTranscriptInputs,
): Uint8Array {
  if (inputs.albumId.length !== 16) {
    throw new CryptoError(
      `albumId must be 16 bytes, got ${inputs.albumId.length}`,
      CryptoErrorCode.INVALID_INPUT,
    );
  }
  if (inputs.encryptedMeta.length === 0) {
    throw new CryptoError(
      'encryptedMeta must be non-empty',
      CryptoErrorCode.EMPTY_ENCRYPTED_META,
    );
  }
  if (inputs.shards.length === 0) {
    throw new CryptoError(
      'shards must be non-empty',
      CryptoErrorCode.EMPTY_SHARD_LIST,
    );
  }
  for (const shard of inputs.shards) {
    if (shard.shardId.length !== 16) {
      throw new CryptoError(
        `shardId must be 16 bytes, got ${shard.shardId.length}`,
        CryptoErrorCode.INVALID_INPUT,
      );
    }
    if (shard.sha256.length !== 32) {
      throw new CryptoError(
        `sha256 must be 32 bytes, got ${shard.sha256.length}`,
        CryptoErrorCode.INVALID_INPUT,
      );
    }
    if (shard.tier !== 1 && shard.tier !== 2 && shard.tier !== 3) {
      throw new CryptoError(
        `shard tier must be 1, 2, or 3, got ${shard.tier as number}`,
        CryptoErrorCode.INVALID_INPUT,
      );
    }
  }

  // Validate u32 length prefixes BEFORE sorting so error reporting is deterministic.
  const encryptedMetaLen = u32Le(
    inputs.encryptedMeta.length,
    'encrypted_meta length',
  );
  const shardCount = u32Le(inputs.shards.length, 'shard count');

  // Sort shards by chunkIndex ascending; validate sequential 0,1,2,...,n-1.
  const sorted = [...inputs.shards].sort(
    (a, b) => a.chunkIndex - b.chunkIndex,
  );
  for (let i = 0; i < sorted.length; i++) {
    const shard = sorted[i]!;
    if (shard.chunkIndex !== i) {
      throw new CryptoError(
        `non-sequential chunk index: expected ${i}, got ${shard.chunkIndex}`,
        CryptoErrorCode.NON_SEQUENTIAL_SHARD_INDEX,
      );
    }
  }

  const ctx = toBytes(MANIFEST_SIGN_CONTEXT);
  const parts: Uint8Array[] = [
    ctx,
    new Uint8Array([MANIFEST_TRANSCRIPT_VERSION]),
    inputs.albumId,
    u32Le(inputs.epochId, 'epoch_id'),
    encryptedMetaLen,
    inputs.encryptedMeta,
    shardCount,
  ];
  for (const shard of sorted) {
    parts.push(u32Le(shard.chunkIndex, 'chunk_index'));
    parts.push(new Uint8Array([shard.tier]));
    parts.push(shard.shardId);
    parts.push(shard.sha256);
  }
  return concat(...parts);
}
