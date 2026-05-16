//! Tombstone transcript tests (batch 5a — A2).
//!
//! Locks the canonical byte layout produced by
//! [`canonical_tombstone_transcript_bytes`] and verifies the
//! domain-separation, length-stability, and field-binding properties that
//! the cross-client tombstone signature relies on.
//!
//! Closes audit `sync C2 (unauthenticated tombstones)` at the
//! domain-transcript layer; the matching signing/verify path lives in
//! `mosaic-crypto::{sign_manifest_transcript, verify_manifest_transcript}`
//! (no new crypto primitive — tombstones reuse the per-epoch Ed25519
//! manifest-signing keypair).

#![allow(clippy::expect_used, clippy::unwrap_used)]

use mosaic_domain::{
    MANIFEST_SIGN_CONTEXT, TOMBSTONE_SIGN_CONTEXT, TOMBSTONE_TRANSCRIPT_VERSION,
    TombstoneTranscript, canonical_tombstone_transcript_bytes,
};

const ALBUM_A: [u8; 16] = [
    0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf,
];
const ALBUM_B: [u8; 16] = [
    0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf,
];
const PHOTO_X: [u8; 16] = [
    0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf,
];
const PHOTO_Y: [u8; 16] = [
    0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xdb, 0xdc, 0xdd, 0xde, 0xdf,
];

#[test]
fn tombstone_transcript_has_stable_64_byte_layout() {
    let transcript = TombstoneTranscript::new(ALBUM_A, 7_u32, PHOTO_X, 42_i64);
    let bytes = canonical_tombstone_transcript_bytes(&transcript);

    // Layout: 19 (context) + 1 (version) + 16 (album) + 4 (epoch) + 16 (photo) + 8 (version_created) = 64
    assert_eq!(bytes.len(), 64, "tombstone transcript must be 64 bytes");

    // Context bytes match the documented domain prefix.
    assert_eq!(
        &bytes[..TOMBSTONE_SIGN_CONTEXT.len()],
        TOMBSTONE_SIGN_CONTEXT
    );
    assert_eq!(TOMBSTONE_SIGN_CONTEXT, b"Mosaic_Tombstone_v1");

    // Version byte directly after the context.
    assert_eq!(
        bytes[TOMBSTONE_SIGN_CONTEXT.len()],
        TOMBSTONE_TRANSCRIPT_VERSION
    );
    assert_eq!(TOMBSTONE_TRANSCRIPT_VERSION, 1);

    // Album, epoch_le, photo, version_created_le packed in that order.
    let mut cursor = TOMBSTONE_SIGN_CONTEXT.len() + 1;
    assert_eq!(&bytes[cursor..cursor + 16], &ALBUM_A);
    cursor += 16;
    assert_eq!(&bytes[cursor..cursor + 4], &7_u32.to_le_bytes());
    cursor += 4;
    assert_eq!(&bytes[cursor..cursor + 16], &PHOTO_X);
    cursor += 16;
    assert_eq!(&bytes[cursor..cursor + 8], &42_i64.to_le_bytes());
    cursor += 8;
    assert_eq!(cursor, bytes.len(), "no trailing bytes");
}

#[test]
fn tombstone_transcript_context_is_byte_distinct_from_manifest_context() {
    // The whole point of TOMBSTONE_SIGN_CONTEXT is to prevent a regular
    // manifest signature from being accepted as a tombstone signature. The
    // contexts must therefore have no shared prefix that could allow length-
    // extension confusion under Ed25519's plain message signing.
    assert_ne!(TOMBSTONE_SIGN_CONTEXT, MANIFEST_SIGN_CONTEXT);
    assert_eq!(TOMBSTONE_SIGN_CONTEXT, b"Mosaic_Tombstone_v1");
    assert_eq!(MANIFEST_SIGN_CONTEXT, b"Mosaic_Manifest_v1");
    assert!(
        !TOMBSTONE_SIGN_CONTEXT.starts_with(MANIFEST_SIGN_CONTEXT),
        "tombstone context must not be an extension of manifest context"
    );
    assert!(
        !MANIFEST_SIGN_CONTEXT.starts_with(TOMBSTONE_SIGN_CONTEXT),
        "manifest context must not be an extension of tombstone context"
    );
}

#[test]
fn tombstone_transcript_is_deterministic_for_same_inputs() {
    let transcript = TombstoneTranscript::new(ALBUM_A, 11_u32, PHOTO_X, 99_i64);
    let a = canonical_tombstone_transcript_bytes(&transcript);
    let b = canonical_tombstone_transcript_bytes(&transcript);
    assert_eq!(a, b, "tombstone transcript must be byte-deterministic");
}

#[test]
fn tombstone_transcript_differs_on_album_id_change() {
    let a = canonical_tombstone_transcript_bytes(&TombstoneTranscript::new(
        ALBUM_A, 5_u32, PHOTO_X, 1_i64,
    ));
    let b = canonical_tombstone_transcript_bytes(&TombstoneTranscript::new(
        ALBUM_B, 5_u32, PHOTO_X, 1_i64,
    ));
    assert_ne!(
        a, b,
        "swapping album_id must yield distinct transcript bytes (cross-album tombstone reuse)"
    );
}

#[test]
fn tombstone_transcript_differs_on_epoch_id_change() {
    let a = canonical_tombstone_transcript_bytes(&TombstoneTranscript::new(
        ALBUM_A, 5_u32, PHOTO_X, 1_i64,
    ));
    let b = canonical_tombstone_transcript_bytes(&TombstoneTranscript::new(
        ALBUM_A, 6_u32, PHOTO_X, 1_i64,
    ));
    assert_ne!(
        a, b,
        "swapping epoch_id must yield distinct transcript bytes (out-of-epoch deletion replay)"
    );
}

#[test]
fn tombstone_transcript_differs_on_photo_id_change() {
    let a = canonical_tombstone_transcript_bytes(&TombstoneTranscript::new(
        ALBUM_A, 5_u32, PHOTO_X, 1_i64,
    ));
    let b = canonical_tombstone_transcript_bytes(&TombstoneTranscript::new(
        ALBUM_A, 5_u32, PHOTO_Y, 1_i64,
    ));
    assert_ne!(
        a, b,
        "swapping photo_id must yield distinct transcript bytes (cross-photo tombstone reuse)"
    );
}

#[test]
fn tombstone_transcript_differs_on_version_created_change() {
    let a = canonical_tombstone_transcript_bytes(&TombstoneTranscript::new(
        ALBUM_A, 5_u32, PHOTO_X, 42_i64,
    ));
    let b = canonical_tombstone_transcript_bytes(&TombstoneTranscript::new(
        ALBUM_A, 5_u32, PHOTO_X, 43_i64,
    ));
    assert_ne!(
        a, b,
        "swapping version_created must yield distinct transcript bytes (stale tombstone replay)"
    );
}

#[test]
fn tombstone_transcript_handles_extreme_version_created_values() {
    // Positive overflow path: i64::MAX.
    let max = canonical_tombstone_transcript_bytes(&TombstoneTranscript::new(
        ALBUM_A,
        u32::MAX,
        PHOTO_X,
        i64::MAX,
    ));
    assert_eq!(max.len(), 64);
    // Negative path: i64::MIN — version_created is signed because backend
    // schemas store BIGINT, and we must not panic on the edge.
    let min = canonical_tombstone_transcript_bytes(&TombstoneTranscript::new(
        ALBUM_A,
        0_u32,
        PHOTO_X,
        i64::MIN,
    ));
    assert_eq!(min.len(), 64);
    assert_ne!(max, min);
}

#[test]
fn tombstone_transcript_accessors_return_construction_inputs() {
    let transcript = TombstoneTranscript::new(ALBUM_A, 13_u32, PHOTO_X, 77_i64);
    assert_eq!(transcript.album_id(), &ALBUM_A);
    assert_eq!(transcript.epoch_id(), 13);
    assert_eq!(transcript.photo_id(), &PHOTO_X);
    assert_eq!(transcript.version_created(), 77);
}
