//! Pure-Cargo coverage for the UniFFI cross-client vector exports.
//!
//! Android JVM tests exercise these through generated bindings, but CI must also
//! compile and run the gated Rust exports directly so a JNI loading issue cannot
//! silently skip the shared corpus.

#![allow(clippy::expect_used)]
#![cfg(feature = "cross-client-vectors")]

use std::path::PathBuf;

use mosaic_vectors::{
    ParsedVector, default_corpus_dir, load_vector,
    vectors::{
        AuthChallengeVector, ContentEncryptVector, IdentityVector, LinkKeysVector,
        SealedBundleVector,
    },
};

fn corpus_path(name: &str) -> PathBuf {
    let mut path = default_corpus_dir();
    path.push(name);
    path
}

fn load(name: &str) -> ParsedVector {
    let path = corpus_path(name);
    match load_vector(&path) {
        Ok(parsed) => parsed,
        Err(error) => panic!("failed to load {}: {error}", path.display()),
    }
}

fn assert_ok(code: u16, context: &str) {
    assert_eq!(code, 0, "{context} returned code {code}");
}

#[test]
fn link_keys_vector_matches_uniffi_export() {
    let parsed = load("link_keys.json");
    let vector = LinkKeysVector::from(&parsed).expect("link_keys vector");

    let result = mosaic_uniffi::derive_link_keys_from_raw_secret(vector.link_secret);

    assert_ok(result.code, "derive_link_keys_from_raw_secret");
    assert_eq!(result.link_id, vector.expected_link_id);
    assert_ne!(result.link_handle_id, 0);
}

#[test]
fn identity_vector_matches_uniffi_export() {
    let parsed = load("identity.json");
    let vector = IdentityVector::from(&parsed).expect("identity vector");

    let result =
        mosaic_uniffi::derive_identity_from_raw_seed(vector.identity_seed, vector.identity_message);

    assert_ok(result.code, "derive_identity_from_raw_seed");
    assert_eq!(result.signing_pubkey, vector.expected_signing_pubkey);
    assert_eq!(result.encryption_pubkey, vector.expected_encryption_pubkey);
    assert_eq!(result.signature, vector.expected_signature);
}

#[test]
fn content_encrypt_vector_decrypts_through_uniffi_export() {
    let parsed = load("content_encrypt.json");
    let vector = ContentEncryptVector::from(&parsed).expect("content_encrypt vector");

    let result = mosaic_uniffi::decrypt_content_with_raw_key(
        vector.content_key,
        vector.nonce,
        vector.expected_ciphertext,
        vector.epoch_id,
    );

    assert_ok(result.code, "decrypt_content_with_raw_key");
    assert_eq!(result.plaintext, vector.expected_decrypted);
    assert_eq!(result.plaintext, vector.plaintext);
}

#[test]
fn auth_challenge_vector_matches_uniffi_exports() {
    let parsed = load("auth_challenge.json");
    let vector = AuthChallengeVector::from(&parsed).expect("auth_challenge vector");
    let timestamp_ms =
        i64::try_from(vector.timestamp_ms).expect("auth challenge timestamp fits i64");

    let transcript_no_ts = mosaic_uniffi::build_auth_challenge_transcript_bytes(
        vector.username.clone(),
        -1,
        vector.challenge.clone(),
    );
    let transcript_with_ts = mosaic_uniffi::build_auth_challenge_transcript_bytes(
        vector.username,
        timestamp_ms,
        vector.challenge,
    );
    assert_ok(
        transcript_no_ts.code,
        "build_auth_challenge_transcript_bytes without timestamp",
    );
    assert_ok(
        transcript_with_ts.code,
        "build_auth_challenge_transcript_bytes with timestamp",
    );
    assert_eq!(transcript_no_ts.bytes, vector.expected_transcript_no_ts);
    assert_eq!(transcript_with_ts.bytes, vector.expected_transcript_with_ts);

    let signature_no_ts = mosaic_uniffi::sign_auth_challenge_with_raw_seed(
        transcript_no_ts.bytes.clone(),
        vector.auth_signing_seed.clone(),
    );
    let signature_with_ts = mosaic_uniffi::sign_auth_challenge_with_raw_seed(
        transcript_with_ts.bytes.clone(),
        vector.auth_signing_seed,
    );
    assert_ok(
        signature_no_ts.code,
        "sign_auth_challenge_with_raw_seed without timestamp",
    );
    assert_ok(
        signature_with_ts.code,
        "sign_auth_challenge_with_raw_seed with timestamp",
    );
    assert_eq!(signature_no_ts.bytes, vector.expected_signature_no_ts);
    assert_eq!(signature_with_ts.bytes, vector.expected_signature_with_ts);

    let verify_no_ts = mosaic_uniffi::verify_auth_challenge_signature(
        transcript_no_ts.bytes,
        signature_no_ts.bytes,
        vector.auth_public_key.clone(),
    );
    let verify_with_ts = mosaic_uniffi::verify_auth_challenge_signature(
        transcript_with_ts.bytes,
        signature_with_ts.bytes,
        vector.auth_public_key,
    );
    assert_ok(verify_no_ts.code, "verify_auth_challenge_signature no-ts");
    assert_ok(
        verify_with_ts.code,
        "verify_auth_challenge_signature with timestamp",
    );
    assert!(verify_no_ts.valid);
    assert!(verify_with_ts.valid);
}

#[test]
fn sealed_bundle_vector_opens_through_uniffi_recipient_seed_export() {
    let parsed = load("sealed_bundle.json");
    let vector = SealedBundleVector::from(&parsed).expect("sealed_bundle vector");

    let result = mosaic_uniffi::verify_and_open_bundle_with_recipient_seed(
        vector.recipient_identity_seed,
        vector.sealed,
        vector.signature,
        vector.sharer_pubkey,
        vector.expected_owner_ed25519_pub,
        vector.validation_album_id,
        vector.validation_min_epoch_id,
        vector.validation_allow_legacy_empty_album_id,
    );

    assert_ok(result.code, "verify_and_open_bundle_with_recipient_seed");
    assert_eq!(result.version, vector.expected_bundle_version);
    assert_eq!(result.album_id, vector.expected_bundle_album_id);
    assert_eq!(result.epoch_id, vector.expected_bundle_epoch_id);
    assert_eq!(result.recipient_pubkey, vector.expected_recipient_pubkey);
    assert_eq!(result.sign_public_key, vector.expected_sign_public_key);
    assert_ne!(result.epoch_handle_id, 0);

    let close_code = mosaic_uniffi::close_epoch_key_handle(result.epoch_handle_id);
    assert_ok(close_code, "close opened epoch handle");
}
