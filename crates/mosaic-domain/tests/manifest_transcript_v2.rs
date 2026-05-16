//! Manifest transcript v2 freshness tests (batch 6a — A3).
//!
//! Locks the canonical byte layout of
//! `canonical_manifest_transcript_bytes_v2` and verifies:
//! - v2 prefix is byte-distinct from v1 (no signature cross-acceptance)
//! - `manifest_seq` field is encoded as i64 LE at the expected offset
//! - Layout matches the v1 layout with `manifest_seq` inserted after
//!   `epoch_id` and before `encrypted_meta_len`
//! - distinct seq values yield distinct transcript bytes (the entire
//!   point of the freshness field — a server cannot replay an older
//!   signed manifest under a higher seq value)
//!
//! Closes audit `crypto-correctness H-1 (no manifest freshness)` at
//! the transcript layer; signing/verify reuses the existing per-epoch
//! Ed25519 helpers in `mosaic-crypto` (no new crypto primitive).

#![allow(clippy::expect_used)]

use mosaic_domain::{
    EncryptedMetadataEnvelope, MANIFEST_SIGN_CONTEXT, MANIFEST_SIGN_CONTEXT_V2,
    MANIFEST_TRANSCRIPT_VERSION, MANIFEST_TRANSCRIPT_VERSION_V2, ManifestShardRef,
    ManifestTranscript, ShardTier, canonical_manifest_transcript_bytes,
    canonical_manifest_transcript_bytes_v2,
};

const ALBUM_A: [u8; 16] = [
    0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf,
];
const ENCRYPTED_META: &[u8] = &[0x10, 0x20, 0x30];
const SHARD_ID: [u8; 16] = [
    0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
];
const SHARD_SHA256: [u8; 32] = [0x55_u8; 32];

fn one_shard_transcript() -> ManifestTranscript<'static> {
    static SHARD_REFS: std::sync::OnceLock<[ManifestShardRef; 1]> = std::sync::OnceLock::new();
    let shards = SHARD_REFS.get_or_init(|| {
        [ManifestShardRef::new(
            0,
            SHARD_ID,
            ShardTier::Thumbnail,
            SHARD_SHA256,
        )]
    });
    ManifestTranscript::new(
        ALBUM_A,
        7_u32,
        EncryptedMetadataEnvelope::new(ENCRYPTED_META),
        shards,
    )
}

#[test]
fn v2_context_constants_are_byte_distinct_from_v1() {
    assert_eq!(MANIFEST_SIGN_CONTEXT, b"Mosaic_Manifest_v1");
    assert_eq!(MANIFEST_SIGN_CONTEXT_V2, b"Mosaic_Manifest_v2");
    assert_eq!(MANIFEST_TRANSCRIPT_VERSION, 1);
    assert_eq!(MANIFEST_TRANSCRIPT_VERSION_V2, 2);
    assert!(
        !MANIFEST_SIGN_CONTEXT_V2.starts_with(MANIFEST_SIGN_CONTEXT),
        "v2 context must not be a prefix extension of v1 (signature confusion)"
    );
    assert!(
        !MANIFEST_SIGN_CONTEXT.starts_with(MANIFEST_SIGN_CONTEXT_V2),
        "v1 context must not be a prefix extension of v2"
    );
}

#[test]
fn v2_transcript_includes_manifest_seq_after_epoch_id() {
    let transcript = one_shard_transcript();
    let bytes = canonical_manifest_transcript_bytes_v2(&transcript, 42_i64)
        .expect("v2 transcript should succeed");

    // Layout offsets:
    // - 18-byte context prefix
    // - 1-byte version
    // - 16-byte album_id
    // - 4-byte epoch_id LE
    // - 8-byte manifest_seq LE (NEW in v2) at offset 18+1+16+4 = 39
    let prefix_len = MANIFEST_SIGN_CONTEXT_V2.len();
    assert_eq!(&bytes[..prefix_len], MANIFEST_SIGN_CONTEXT_V2);
    assert_eq!(bytes[prefix_len], MANIFEST_TRANSCRIPT_VERSION_V2);
    let album_off = prefix_len + 1;
    assert_eq!(&bytes[album_off..album_off + 16], &ALBUM_A);
    let epoch_off = album_off + 16;
    assert_eq!(&bytes[epoch_off..epoch_off + 4], &7_u32.to_le_bytes());
    let seq_off = epoch_off + 4;
    assert_eq!(&bytes[seq_off..seq_off + 8], &42_i64.to_le_bytes());
    // After seq comes encrypted_meta_len then bytes — same as v1 from
    // this point onward.
    let meta_len_off = seq_off + 8;
    assert_eq!(&bytes[meta_len_off..meta_len_off + 4], &3_u32.to_le_bytes());
}

#[test]
fn v2_transcript_differs_from_v1_at_the_prefix() {
    let transcript = one_shard_transcript();
    let v1 = canonical_manifest_transcript_bytes(&transcript).expect("v1");
    let v2 = canonical_manifest_transcript_bytes_v2(&transcript, 1).expect("v2");
    assert_ne!(
        v1, v2,
        "v1 and v2 bytes must differ (no signature cross-accept)"
    );
    assert_ne!(
        &v1[..MANIFEST_SIGN_CONTEXT.len()],
        &v2[..MANIFEST_SIGN_CONTEXT_V2.len()],
        "context prefixes must differ"
    );
}

#[test]
fn v2_transcript_differs_on_manifest_seq_change() {
    let transcript = one_shard_transcript();
    let a = canonical_manifest_transcript_bytes_v2(&transcript, 1).expect("a");
    let b = canonical_manifest_transcript_bytes_v2(&transcript, 2).expect("b");
    assert_ne!(a, b, "different manifest_seq must yield different bytes");
}

#[test]
fn v2_transcript_handles_extreme_manifest_seq_values() {
    let transcript = one_shard_transcript();
    let min = canonical_manifest_transcript_bytes_v2(&transcript, i64::MIN).expect("min");
    let max = canonical_manifest_transcript_bytes_v2(&transcript, i64::MAX).expect("max");
    let zero = canonical_manifest_transcript_bytes_v2(&transcript, 0).expect("zero");
    assert_ne!(min, max);
    assert_ne!(min, zero);
    assert_ne!(max, zero);
}

#[test]
fn v2_transcript_is_deterministic() {
    let transcript = one_shard_transcript();
    let a = canonical_manifest_transcript_bytes_v2(&transcript, 99).expect("a");
    let b = canonical_manifest_transcript_bytes_v2(&transcript, 99).expect("b");
    assert_eq!(a, b);
}

#[test]
fn v2_transcript_total_length_is_v1_plus_8_bytes() {
    let transcript = one_shard_transcript();
    let v1 = canonical_manifest_transcript_bytes(&transcript).expect("v1");
    let v2 = canonical_manifest_transcript_bytes_v2(&transcript, 0).expect("v2");
    // v2 prefix and v1 prefix have the same length (18 bytes each), so
    // the only size difference is the new 8-byte manifest_seq field.
    assert_eq!(
        MANIFEST_SIGN_CONTEXT.len(),
        MANIFEST_SIGN_CONTEXT_V2.len(),
        "v1 and v2 prefixes must have the same byte length"
    );
    assert_eq!(v2.len(), v1.len() + 8);
}
