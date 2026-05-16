/**
 * Tombstone transcript byte-parity tests (batch 5c — A2).
 *
 * These tests lock the TS producer against the canonical Rust producer
 * `mosaic_domain::canonical_tombstone_transcript_bytes` using identical
 * fixture values. If either side ever drifts, the cross-client signature
 * verification breaks immediately. The matching Rust test lives at
 * `crates/mosaic-domain/tests/tombstone_transcript.rs`.
 */

import { describe, expect, it } from 'vitest';

import {
  TOMBSTONE_TRANSCRIPT_LENGTH,
  buildTombstoneTranscriptBytes,
  uuidToRawBytes,
} from '../tombstone-transcript';

// Same fixture as the Rust test:
//   ALBUM_A = 0xa0..0xaf
//   PHOTO_X = 0xc0..0xcf
// Render as canonical UUID (8-4-4-4-12) for the JS input.
const ALBUM_A_UUID = 'a0a1a2a3-a4a5-a6a7-a8a9-aaabacadaeaf';
const PHOTO_X_UUID = 'c0c1c2c3-c4c5-c6c7-c8c9-cacbcccdcecf';

// Expected hex (matches Rust layout: 19-byte prefix + 1 version + 16 album
// + 4 epoch_le + 16 photo + 8 version_created_le).
//   epoch_id = 7   (LE: 07 00 00 00)
//   version_created = 42 (LE: 2a 00 00 00 00 00 00 00)
const EXPECTED_HEX_EPOCH7_VERSION42 =
  '4d6f736169635f546f6d6273746f6e655f7631' + // "Mosaic_Tombstone_v1"
  '01' + // version byte
  'a0a1a2a3a4a5a6a7a8a9aaabacadaeaf' + // ALBUM_A
  '07000000' + // epoch_id u32 LE = 7
  'c0c1c2c3c4c5c6c7c8c9cacbcccdcecf' + // PHOTO_X
  '2a00000000000000'; // version_created i64 LE = 42

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

describe('tombstone-transcript byte parity with Rust canonical producer', () => {
  it('produces a 64-byte transcript for the canonical fixture', () => {
    const bytes = buildTombstoneTranscriptBytes({
      albumId: ALBUM_A_UUID,
      epochId: 7,
      photoId: PHOTO_X_UUID,
      versionCreated: 42,
    });
    expect(bytes.length).toBe(TOMBSTONE_TRANSCRIPT_LENGTH);
    expect(bytes.length).toBe(64);
  });

  it('matches the Rust producer hex byte-for-byte', () => {
    const bytes = buildTombstoneTranscriptBytes({
      albumId: ALBUM_A_UUID,
      epochId: 7,
      photoId: PHOTO_X_UUID,
      versionCreated: 42,
    });
    expect(toHex(bytes)).toBe(EXPECTED_HEX_EPOCH7_VERSION42);
  });

  it('encodes epoch_id as little-endian u32', () => {
    const bytes = buildTombstoneTranscriptBytes({
      albumId: ALBUM_A_UUID,
      epochId: 0x01020304,
      photoId: PHOTO_X_UUID,
      versionCreated: 0,
    });
    // Offset 19 (prefix) + 1 (version) + 16 (album) = 36. Then 4 bytes of epoch_id LE.
    expect(Array.from(bytes.slice(36, 40))).toEqual([0x04, 0x03, 0x02, 0x01]);
  });

  it('encodes version_created as little-endian signed i64', () => {
    const bytes = buildTombstoneTranscriptBytes({
      albumId: ALBUM_A_UUID,
      epochId: 0,
      photoId: PHOTO_X_UUID,
      versionCreated: 256,
    });
    // Offset 19 + 1 + 16 + 4 + 16 = 56. Then 8 bytes of version_created LE.
    // 256 = 0x100 → bytes [0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
    expect(Array.from(bytes.slice(56, 64))).toEqual([0x00, 0x01, 0, 0, 0, 0, 0, 0]);
  });

  it('starts with the byte-exact ASCII context prefix', () => {
    const bytes = buildTombstoneTranscriptBytes({
      albumId: ALBUM_A_UUID,
      epochId: 0,
      photoId: PHOTO_X_UUID,
      versionCreated: 0,
    });
    const prefix = new TextDecoder().decode(bytes.slice(0, 19));
    expect(prefix).toBe('Mosaic_Tombstone_v1');
    expect(bytes[19]).toBe(0x01); // transcript version
  });

  it('rejects malformed album_id UUID', () => {
    expect(() =>
      buildTombstoneTranscriptBytes({
        albumId: 'not-a-uuid',
        epochId: 1,
        photoId: PHOTO_X_UUID,
        versionCreated: 1,
      }),
    ).toThrow(/UUID/);
  });

  it('rejects malformed photo_id UUID', () => {
    expect(() =>
      buildTombstoneTranscriptBytes({
        albumId: ALBUM_A_UUID,
        epochId: 1,
        photoId: 'not-a-uuid',
        versionCreated: 1,
      }),
    ).toThrow(/UUID/);
  });

  it('rejects out-of-range epoch_id (negative)', () => {
    expect(() =>
      buildTombstoneTranscriptBytes({
        albumId: ALBUM_A_UUID,
        epochId: -1,
        photoId: PHOTO_X_UUID,
        versionCreated: 1,
      }),
    ).toThrow(/u32/);
  });

  it('rejects out-of-range epoch_id (overflow u32)', () => {
    expect(() =>
      buildTombstoneTranscriptBytes({
        albumId: ALBUM_A_UUID,
        epochId: 0x1_0000_0000,
        photoId: PHOTO_X_UUID,
        versionCreated: 1,
      }),
    ).toThrow(/u32/);
  });

  it('rejects non-integer version_created', () => {
    expect(() =>
      buildTombstoneTranscriptBytes({
        albumId: ALBUM_A_UUID,
        epochId: 1,
        photoId: PHOTO_X_UUID,
        versionCreated: 1.5,
      }),
    ).toThrow(/integer/);
  });

  it('rejects unsafe integer version_created', () => {
    expect(() =>
      buildTombstoneTranscriptBytes({
        albumId: ALBUM_A_UUID,
        epochId: 1,
        photoId: PHOTO_X_UUID,
        versionCreated: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow(/safe-integer/);
  });

  it('differs on album_id, epoch_id, photo_id, or version_created change', () => {
    const base = buildTombstoneTranscriptBytes({
      albumId: ALBUM_A_UUID,
      epochId: 5,
      photoId: PHOTO_X_UUID,
      versionCreated: 1,
    });
    const swappedAlbum = buildTombstoneTranscriptBytes({
      albumId: 'b0b1b2b3-b4b5-b6b7-b8b9-babbbcbdbebf',
      epochId: 5,
      photoId: PHOTO_X_UUID,
      versionCreated: 1,
    });
    const swappedEpoch = buildTombstoneTranscriptBytes({
      albumId: ALBUM_A_UUID,
      epochId: 6,
      photoId: PHOTO_X_UUID,
      versionCreated: 1,
    });
    const swappedPhoto = buildTombstoneTranscriptBytes({
      albumId: ALBUM_A_UUID,
      epochId: 5,
      photoId: 'd0d1d2d3-d4d5-d6d7-d8d9-dadbdcdddedf',
      versionCreated: 1,
    });
    const swappedVersion = buildTombstoneTranscriptBytes({
      albumId: ALBUM_A_UUID,
      epochId: 5,
      photoId: PHOTO_X_UUID,
      versionCreated: 2,
    });
    expect(toHex(base)).not.toBe(toHex(swappedAlbum));
    expect(toHex(base)).not.toBe(toHex(swappedEpoch));
    expect(toHex(base)).not.toBe(toHex(swappedPhoto));
    expect(toHex(base)).not.toBe(toHex(swappedVersion));
  });

  it('uuidToRawBytes parses the canonical fixture into the expected byte sequence', () => {
    expect(Array.from(uuidToRawBytes(ALBUM_A_UUID))).toEqual([
      0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae,
      0xaf,
    ]);
    expect(Array.from(uuidToRawBytes(PHOTO_X_UUID))).toEqual([
      0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xcb, 0xcc, 0xcd, 0xce,
      0xcf,
    ]);
  });
});
