//! Manifest signing v2 integration tests (batch 6b — A3).
//!
//! `canonical_manifest_transcript_bytes_v2` from mosaic-domain returns
//! plain bytes; the same `sign_manifest_transcript` /
//! `verify_manifest_transcript` Ed25519 helpers serve v1 and v2 byte
//! streams interchangeably. These tests lock the end-to-end
//! round-trip and the cross-version no-silent-downgrade property:
//! a v1 signature MUST NOT verify a v2 transcript and vice versa
//! (different byte-distinct domain prefixes ensure this naturally).

#![allow(clippy::expect_used)]

use mosaic_crypto::{
    ManifestSigningSecretKey, sign_manifest_transcript, verify_manifest_transcript,
};
use mosaic_domain::{
    EncryptedMetadataEnvelope, ManifestShardRef, ManifestTranscript, ShardTier,
    canonical_manifest_transcript_bytes, canonical_manifest_transcript_bytes_v2,
};

const SIGNING_SEED: [u8; 32] = [0x77_u8; 32];
const ALBUM_A: [u8; 16] = [
    0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf,
];
const ENCRYPTED_META: &[u8] = &[0x10, 0x20, 0x30];
const SHARD_ID: [u8; 16] = [
    0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
];
const SHARD_SHA256: [u8; 32] = [0x55_u8; 32];

fn transcript_input() -> (ManifestShardRef, [u8; 16], u32) {
    (
        ManifestShardRef::new(0, SHARD_ID, ShardTier::Thumbnail, SHARD_SHA256),
        ALBUM_A,
        7_u32,
    )
}

fn build_secret() -> ManifestSigningSecretKey {
    let mut seed = SIGNING_SEED;
    ManifestSigningSecretKey::from_seed(&mut seed).expect("from_seed")
}

#[test]
fn v2_transcript_round_trips_through_existing_sign_verify_helpers() {
    let (shard, album, epoch) = transcript_input();
    let shards = [shard];
    let transcript = ManifestTranscript::new(
        album,
        epoch,
        EncryptedMetadataEnvelope::new(ENCRYPTED_META),
        &shards,
    );
    let bytes = canonical_manifest_transcript_bytes_v2(&transcript, 42_i64).expect("v2 bytes");

    let secret = build_secret();
    let pubkey = secret.public_key();
    let signature = sign_manifest_transcript(&bytes, &secret);

    assert!(
        verify_manifest_transcript(&bytes, &signature, &pubkey),
        "v2 signature MUST verify against the same v2 transcript bytes"
    );
}

#[test]
fn v2_signature_does_not_verify_v1_transcript_no_silent_downgrade() {
    let (shard, album, epoch) = transcript_input();
    let shards = [shard];
    let transcript = ManifestTranscript::new(
        album,
        epoch,
        EncryptedMetadataEnvelope::new(ENCRYPTED_META),
        &shards,
    );
    let v1_bytes = canonical_manifest_transcript_bytes(&transcript).expect("v1");
    let v2_bytes = canonical_manifest_transcript_bytes_v2(&transcript, 0_i64).expect("v2");

    let secret = build_secret();
    let pubkey = secret.public_key();
    let v2_sig = sign_manifest_transcript(&v2_bytes, &secret);

    // The v1 verifier (which is just verify_manifest_transcript with v1
    // bytes) MUST reject a v2 signature — otherwise an attacker could
    // strip the manifest_seq freshness binding by routing v2-signed
    // bytes through a v1-only client.
    assert!(
        !verify_manifest_transcript(&v1_bytes, &v2_sig, &pubkey),
        "v2 signature MUST NOT verify against v1 transcript (no silent downgrade)"
    );
}

#[test]
fn v1_signature_does_not_verify_v2_transcript_mirror_no_silent_downgrade() {
    let (shard, album, epoch) = transcript_input();
    let shards = [shard];
    let transcript = ManifestTranscript::new(
        album,
        epoch,
        EncryptedMetadataEnvelope::new(ENCRYPTED_META),
        &shards,
    );
    let v1_bytes = canonical_manifest_transcript_bytes(&transcript).expect("v1");
    let v2_bytes = canonical_manifest_transcript_bytes_v2(&transcript, 0_i64).expect("v2");

    let secret = build_secret();
    let pubkey = secret.public_key();
    let v1_sig = sign_manifest_transcript(&v1_bytes, &secret);

    assert!(
        !verify_manifest_transcript(&v2_bytes, &v1_sig, &pubkey),
        "v1 signature MUST NOT be accepted as v2 (mirror no-silent-upgrade)"
    );
}

#[test]
fn v2_signatures_with_different_manifest_seq_are_distinct() {
    let (shard, album, epoch) = transcript_input();
    let shards = [shard];
    let transcript = ManifestTranscript::new(
        album,
        epoch,
        EncryptedMetadataEnvelope::new(ENCRYPTED_META),
        &shards,
    );
    let bytes_seq1 = canonical_manifest_transcript_bytes_v2(&transcript, 1_i64).expect("1");
    let bytes_seq2 = canonical_manifest_transcript_bytes_v2(&transcript, 2_i64).expect("2");

    let secret = build_secret();
    let pubkey = secret.public_key();
    let sig1 = sign_manifest_transcript(&bytes_seq1, &secret);
    let sig2 = sign_manifest_transcript(&bytes_seq2, &secret);

    assert_ne!(
        sig1.as_bytes(),
        sig2.as_bytes(),
        "signatures must differ across distinct manifest_seq values"
    );
    // Cross-verify: sig1 over bytes_seq2 must fail (the replay attack
    // the freshness binding closes).
    assert!(!verify_manifest_transcript(&bytes_seq2, &sig1, &pubkey));
    assert!(!verify_manifest_transcript(&bytes_seq1, &sig2, &pubkey));
}

#[test]
fn v2_verify_rejects_tampered_manifest_seq() {
    let (shard, album, epoch) = transcript_input();
    let shards = [shard];
    let transcript = ManifestTranscript::new(
        album,
        epoch,
        EncryptedMetadataEnvelope::new(ENCRYPTED_META),
        &shards,
    );
    let bytes = canonical_manifest_transcript_bytes_v2(&transcript, 42_i64).expect("bytes");
    let secret = build_secret();
    let pubkey = secret.public_key();
    let sig = sign_manifest_transcript(&bytes, &secret);

    // Flip a byte in the manifest_seq field (located after the 18-byte
    // context prefix + 1 version + 16 album + 4 epoch_id = 39 bytes).
    let mut tampered = bytes.clone();
    tampered[39] ^= 0x01;
    assert!(
        !verify_manifest_transcript(&tampered, &sig, &pubkey),
        "verify must reject a transcript whose manifest_seq was flipped"
    );
}
