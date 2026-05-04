use std::fmt::Debug;

use mosaic_wasm::{
    AccountUnlockRequest, AuthKeypairResult, BytesResult, ClientCoreUploadJobEffect,
    ClientCoreUploadJobEvent, ClientCoreUploadJobSnapshot, ClientCoreUploadShardRef,
    CreateAccountResult, CreateLinkShareHandleResult, CryptoDomainGoldenVectorSnapshot,
    DecryptedContentResult, DecryptedShardResult, EncryptedContentResult, EncryptedShardResult,
    EpochKeyHandleResult, HeaderResult, IdentityHandleResult, LinkTierHandleResult,
    SealedBundleResult, WrappedTierKeyResult,
};

const SENTINEL: u8 = 0xab;

#[test]
fn wasm_boundary_debug_output_redacts_vec_payloads() {
    assert_debug_redacts(
        &HeaderResult {
            code: 0,
            epoch_id: 1,
            shard_index: 2,
            tier: 3,
            nonce: bytes(24),
        },
        &["nonce_len: 24"],
    );
    assert_debug_redacts(
        &BytesResult {
            code: 0,
            bytes: bytes(32),
        },
        &["bytes_len: 32"],
    );
    assert_debug_redacts(
        &AccountUnlockRequest {
            user_salt: bytes(16),
            account_salt: bytes(16),
            wrapped_account_key: bytes(32),
            kdf_memory_kib: 65_536,
            kdf_iterations: 3,
            kdf_parallelism: 1,
        },
        &[
            "user_salt_len: 16",
            "account_salt_len: 16",
            "wrapped_account_key_len: 32",
        ],
    );
    assert_debug_redacts(
        &CreateAccountResult {
            code: 0,
            handle: 7,
            wrapped_account_key: bytes(32),
        },
        &["wrapped_account_key_len: 32"],
    );
    assert_debug_redacts(
        &IdentityHandleResult {
            code: 0,
            handle: 8,
            signing_pubkey: bytes(32),
            encryption_pubkey: bytes(32),
            wrapped_seed: bytes(32),
        },
        &[
            "signing_pubkey_len: 32",
            "encryption_pubkey_len: 32",
            "wrapped_seed_len: 32",
        ],
    );
    assert_debug_redacts(
        &EpochKeyHandleResult {
            code: 0,
            handle: 9,
            epoch_id: 10,
            wrapped_epoch_seed: bytes(32),
            sign_public_key: bytes(32),
        },
        &["wrapped_epoch_seed_len: 32", "sign_public_key_len: 32"],
    );
    assert_debug_redacts(
        &EncryptedShardResult {
            code: 0,
            envelope_bytes: bytes(128),
            sha256: "digest".to_owned(),
        },
        &["envelope_bytes_len: 128"],
    );
    assert_debug_redacts(
        &DecryptedShardResult {
            code: 0,
            plaintext: bytes(128),
        },
        &["plaintext_len: 128"],
    );
    assert_debug_redacts(
        &CryptoDomainGoldenVectorSnapshot {
            code: 0,
            envelope_header: bytes(64),
            envelope_epoch_id: 11,
            envelope_shard_index: 12,
            envelope_tier: 13,
            envelope_nonce: bytes(24),
            manifest_transcript: bytes(96),
            identity_message: bytes(17),
            identity_signing_pubkey: bytes(32),
            identity_encryption_pubkey: bytes(32),
            identity_signature: bytes(64),
        },
        &[
            "envelope_header_len: 64",
            "envelope_nonce_len: 24",
            "manifest_transcript_len: 96",
            "identity_message_len: 17",
            "identity_signing_pubkey_len: 32",
            "identity_encryption_pubkey_len: 32",
            "identity_signature_len: 64",
        ],
    );
    assert_debug_redacts(&sample_shard_ref(), &["sha256_len: 32"]);
    assert_debug_redacts(
        &ClientCoreUploadJobSnapshot {
            schema_version: 1,
            job_id: "job".to_owned(),
            album_id: "album".to_owned(),
            phase: "phase".to_owned(),
            retry_count: 0,
            max_retry_count: 3,
            next_retry_not_before_ms: 0,
            has_next_retry_not_before_ms: false,
            idempotency_key: "idem".to_owned(),
            tiered_shards: vec![sample_shard_ref()],
            shard_set_hash: bytes(32),
            snapshot_revision: 1,
            last_effect_id: "effect".to_owned(),
            last_acknowledged_effect_id: "ack".to_owned(),
            last_applied_event_id: "applied".to_owned(),
            failure_code: 0,
        },
        &["sha256_len: 32", "shard_set_hash_len: 32"],
    );
    assert_debug_redacts(
        &ClientCoreUploadJobEvent {
            kind: "ShardUploaded".to_owned(),
            effect_id: "effect".to_owned(),
            tier: 1,
            shard_index: 0,
            shard_id: "shard".to_owned(),
            sha256: bytes(32),
            content_length: 128,
            envelope_version: 1,
            uploaded: true,
            tiered_shards: vec![sample_shard_ref()],
            shard_set_hash: bytes(32),
            asset_id: "asset".to_owned(),
            since_metadata_version: 1,
            recovery_outcome: "none".to_owned(),
            now_ms: 1,
            base_backoff_ms: 1,
            server_retry_after_ms: 0,
            has_server_retry_after_ms: false,
            has_error_code: false,
            error_code: 0,
            target_phase: "Done".to_owned(),
        },
        &["sha256_len: 32", "shard_set_hash_len: 32"],
    );
    assert_debug_redacts(
        &ClientCoreUploadJobEffect {
            kind: "UploadShard".to_owned(),
            effect_id: "effect".to_owned(),
            tier: 1,
            shard_index: 0,
            shard_id: "shard".to_owned(),
            sha256: bytes(32),
            content_length: 128,
            envelope_version: 1,
            attempt: 1,
            not_before_ms: 0,
            target_phase: "Uploading".to_owned(),
            reason: "test".to_owned(),
            asset_id: "asset".to_owned(),
            since_metadata_version: 1,
            idempotency_key: "idem".to_owned(),
            shard_set_hash: bytes(32),
        },
        &["sha256_len: 32", "shard_set_hash_len: 32"],
    );
    assert_debug_redacts(
        &AuthKeypairResult {
            code: 0,
            auth_public_key: bytes(32),
        },
        &["auth_public_key_len: 32"],
    );
    assert_debug_redacts(
        &CreateLinkShareHandleResult {
            code: 0,
            handle: 12,
            link_id: bytes(16),
            link_secret_for_url: bytes(32),
            tier: 1,
            nonce: bytes(24),
            encrypted_key: bytes(48),
        },
        &[
            "link_id_len: 16",
            "link_secret_for_url_len: 32",
            "nonce_len: 24",
            "encrypted_key_len: 48",
        ],
    );
    assert_debug_redacts(
        &LinkTierHandleResult {
            code: 0,
            handle: 13,
            link_id: bytes(16),
            tier: 1,
        },
        &["link_id_len: 16"],
    );
    assert_debug_redacts(
        &WrappedTierKeyResult {
            code: 0,
            tier: 1,
            nonce: bytes(24),
            encrypted_key: bytes(48),
        },
        &["nonce_len: 24", "encrypted_key_len: 48"],
    );
    assert_debug_redacts(
        &SealedBundleResult {
            code: 0,
            sealed: bytes(96),
            signature: bytes(64),
            sharer_pubkey: bytes(32),
        },
        &[
            "sealed_len: 96",
            "signature_len: 64",
            "sharer_pubkey_len: 32",
        ],
    );
    assert_debug_redacts(
        &EncryptedContentResult {
            code: 0,
            nonce: bytes(24),
            ciphertext: bytes(128),
        },
        &["nonce_len: 24", "ciphertext_len: 128"],
    );
    assert_debug_redacts(
        &DecryptedContentResult {
            code: 0,
            plaintext: bytes(128),
        },
        &["plaintext_len: 128"],
    );
}

fn sample_shard_ref() -> ClientCoreUploadShardRef {
    ClientCoreUploadShardRef {
        tier: 1,
        shard_index: 0,
        shard_id: "shard".to_owned(),
        sha256: bytes(32),
        content_length: 128,
        envelope_version: 1,
        uploaded: true,
    }
}

fn bytes(len: usize) -> Vec<u8> {
    vec![SENTINEL; len]
}

fn assert_debug_redacts<T: Debug>(value: &T, expected_fragments: &[&str]) {
    let debug = format!("{value:?}");
    for fragment in expected_fragments {
        assert!(
            debug.contains(fragment),
            "expected debug output to contain {fragment:?}: {debug}"
        );
    }
    for forbidden in ["171", "0xab", "SENTINEL"] {
        assert!(
            !debug.contains(forbidden),
            "debug output leaked sentinel fragment {forbidden:?}: {debug}"
        );
    }
}
