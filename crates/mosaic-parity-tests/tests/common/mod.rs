//! Shared fixtures, constants, and helper functions for the cross-platform
//! parity integration tests. Lives under `tests/common/` so Cargo does NOT
//! treat it as a standalone test binary; each split `tests/cross_platform_parity_*.rs`
//! file pulls these in via `mod common;` + `use common::*;`.
//!
//! Items are marked `pub` so that they remain accessible from every split
//! test binary that includes this module.
#![allow(dead_code, unused_imports)]

// Test-only allowlist: `expect()` is idiomatic for cross-client parity test
// failure reporting; same convention as the other parity test modules.
#![allow(clippy::expect_used)]

pub use ciborium::value::Value;
pub use mosaic_client::ClientErrorCode;
pub use mosaic_crypto::{
    KdfProfile, MIN_KDF_ITERATIONS, MIN_KDF_MEMORY_KIB, SecretKey, derive_account_key,
};
pub use mosaic_domain::{
    SHARD_ENVELOPE_VERSION_V04, STREAMING_SHARD_FRAME_SIZE, ShardTier, metadata_field_tags,
};
pub use mosaic_uniffi::{
    AccountUnlockRequest as UniAccountUnlockRequest,
    ClientCoreAlbumSyncEffect as UniAlbumSyncEffect, ClientCoreAlbumSyncEvent as UniAlbumSyncEvent,
    ClientCoreAlbumSyncSnapshot as UniAlbumSyncSnapshot,
    ClientCoreAlbumSyncTransition as UniAlbumSyncTransition, ClientCoreManifestShardRef,
    ClientCoreManifestTranscriptInputs, ClientCoreUploadJobEffect as UniUploadJobEffect,
    ClientCoreUploadJobEvent as UniUploadJobEvent,
    ClientCoreUploadJobSnapshot as UniUploadJobSnapshot,
    ClientCoreUploadJobTransition as UniUploadJobTransition,
    ClientCoreUploadShardRef as UniUploadShardRef, DownloadInitInput, DownloadPlanEntryInput,
    DownloadPlanInput, DownloadPlanShardInput, MediaFormat as UniMediaFormat,
};
pub use mosaic_vectors::{ParsedVector, default_corpus_dir, load_vector, vectors::ContentHashVector};
pub use mosaic_wasm::{
    AccountUnlockRequest as WasmAccountUnlockRequest,
    ClientCoreAlbumSyncEffect as WasmAlbumSyncEffect,
    ClientCoreAlbumSyncEvent as WasmAlbumSyncEvent,
    ClientCoreAlbumSyncSnapshot as WasmAlbumSyncSnapshot,
    ClientCoreAlbumSyncTransition as WasmAlbumSyncTransition,
    ClientCoreUploadJobEffect as WasmUploadJobEffect,
    ClientCoreUploadJobEvent as WasmUploadJobEvent,
    ClientCoreUploadJobSnapshot as WasmUploadJobSnapshot,
    ClientCoreUploadJobTransition as WasmUploadJobTransition,
    ClientCoreUploadShardRef as WasmUploadShardRef,
};
pub use proptest::prelude::*;
pub use proptest::test_runner::{Config, TestCaseError, TestRunner};
pub use sha2::{Digest, Sha256};

pub const PASSWORD: &[u8] = b"correct horse battery staple";
pub const USER_SALT: [u8; 16] = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
];
pub const ACCOUNT_SALT: [u8; 16] = [
    0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff,
];
pub const ALBUM_ID_BYTES: [u8; 16] = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
];
pub const PHOTO_ID_BYTES: [u8; 16] = [
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
];
pub const JOB_ID: &str = "018f0000-0000-7000-8000-000000000001";
pub const ALBUM_ID: &str = "018f0000-0000-7000-8000-000000000002";
pub const IDEMPOTENCY_KEY: &str = "018f0000-0000-7000-8000-000000000004";
pub const EFFECT_ID: &str = "018f0000-0000-7000-8000-000000000005";
pub const SHARD_ID: &str = "018f0000-0000-7000-8000-000000000006";
pub const ASSET_ID: &str = "018f0000-0000-7000-8000-000000000007";

pub fn must<T, E: core::fmt::Debug>(result: Result<T, E>, context: &str) -> T {
    match result {
        Ok(value) => value,
        Err(error) => panic!("{context}: {error:?}"),
    }
}

pub fn must_some<T>(option: Option<T>, context: &str) -> T {
    match option {
        Some(value) => value,
        None => panic!("{context}"),
    }
}


pub fn encoded_manifest_shards() -> Vec<u8> {
    let mut encoded = Vec::new();
    push_manifest_shard(&mut encoded, 1, ShardTier::Original, [0x20; 16], [0x22; 32]);
    push_manifest_shard(
        &mut encoded,
        0,
        ShardTier::Thumbnail,
        [0x10; 16],
        [0x11; 32],
    );
    encoded
}

pub fn push_manifest_shard(
    encoded: &mut Vec<u8>,
    chunk_index: u32,
    tier: ShardTier,
    shard_id: [u8; 16],
    sha256: [u8; 32],
) {
    encoded.extend_from_slice(&chunk_index.to_le_bytes());
    encoded.push(tier.to_byte());
    encoded.extend_from_slice(&shard_id);
    encoded.extend_from_slice(&sha256);
}

pub fn wrapped_account_key() -> Vec<u8> {
    fixed_account_material().wrapped_account_key
}

pub fn fixed_account_material() -> mosaic_crypto::AccountKeyMaterial {
    let profile = match KdfProfile::new(MIN_KDF_MEMORY_KIB, MIN_KDF_ITERATIONS, 1) {
        Ok(value) => value,
        Err(error) => panic!("minimum Mosaic KDF profile should be valid: {error:?}"),
    };
    match derive_account_key(PASSWORD.to_vec().into(), &USER_SALT, &ACCOUNT_SALT, profile) {
        Ok(value) => value,
        Err(error) => panic!("account key should derive: {error:?}"),
    }
}

pub fn unlock_wasm_account(wrapped_account_key: Vec<u8>) -> u64 {
    let result = mosaic_wasm::unlock_account_key(
        PASSWORD.to_vec(),
        WasmAccountUnlockRequest {
            user_salt: USER_SALT.to_vec(),
            account_salt: ACCOUNT_SALT.to_vec(),
            wrapped_account_key,
            kdf_memory_kib: MIN_KDF_MEMORY_KIB,
            kdf_iterations: MIN_KDF_ITERATIONS,
            kdf_parallelism: 1,
        },
    );
    assert_ok(result.code, "wasm unlock account");
    result.handle
}

pub fn unlock_uniffi_account(wrapped_account_key: Vec<u8>) -> u64 {
    let result = mosaic_uniffi::unlock_account_key(
        PASSWORD.to_vec(),
        UniAccountUnlockRequest {
            user_salt: USER_SALT.to_vec(),
            account_salt: ACCOUNT_SALT.to_vec(),
            wrapped_account_key,
            kdf_memory_kib: MIN_KDF_MEMORY_KIB,
            kdf_iterations: MIN_KDF_ITERATIONS,
            kdf_parallelism: 1,
        },
    );
    assert_ok(result.code, "uniffi unlock account");
    result.handle
}

pub fn close_epoch_handles(handles: &[u64]) {
    for handle in handles {
        let wasm_code = mosaic_wasm::close_epoch_key_handle(*handle);
        if wasm_code != ClientErrorCode::Ok.as_u16()
            && wasm_code != ClientErrorCode::EpochHandleNotFound.as_u16()
        {
            panic!("unexpected wasm close epoch code: {wasm_code}");
        }
        let uniffi_code = mosaic_uniffi::close_epoch_key_handle(*handle);
        if uniffi_code != ClientErrorCode::Ok.as_u16()
            && uniffi_code != ClientErrorCode::EpochHandleNotFound.as_u16()
        {
            panic!("unexpected uniffi close epoch code: {uniffi_code}");
        }
    }
}

pub fn close_account_handles(handles: &[u64]) {
    for handle in handles {
        let wasm_code = mosaic_wasm::close_account_key_handle(*handle);
        if wasm_code != ClientErrorCode::Ok.as_u16()
            && wasm_code != ClientErrorCode::SecretHandleNotFound.as_u16()
        {
            panic!("unexpected wasm close account code: {wasm_code}");
        }
        let uniffi_code = mosaic_uniffi::close_account_key_handle(*handle);
        if uniffi_code != ClientErrorCode::Ok.as_u16()
            && uniffi_code != ClientErrorCode::SecretHandleNotFound.as_u16()
        {
            panic!("unexpected uniffi close account code: {uniffi_code}");
        }
    }
}

pub fn close_secret_handles(handles: &[u64]) {
    for handle in handles {
        if let Err(error) = mosaic_client::close_secret_handle(*handle) {
            panic!("unexpected close secret handle error: {error:?}");
        }
    }
}

pub fn wasm_upload_snapshot() -> WasmUploadJobSnapshot {
    WasmUploadJobSnapshot {
        schema_version: 1,
        job_id: JOB_ID.to_owned(),
        album_id: ALBUM_ID.to_owned(),
        phase: "AwaitingSyncConfirmation".to_owned(),
        retry_count: 1,
        max_retry_count: 5,
        next_retry_not_before_ms: 1_700_000_020_000,
        has_next_retry_not_before_ms: true,
        idempotency_key: IDEMPOTENCY_KEY.to_owned(),
        tiered_shards: vec![WasmUploadShardRef {
            tier: ShardTier::Original.to_byte(),
            shard_index: 0,
            shard_id: SHARD_ID.to_owned(),
            sha256: vec![0x11; 32],
            content_length: 1024,
            envelope_version: 3,
            uploaded: true,
        }],
        shard_set_hash: vec![0x22; 32],
        snapshot_revision: 2,
        last_effect_id: EFFECT_ID.to_owned(),
        last_acknowledged_effect_id: EFFECT_ID.to_owned(),
        last_applied_event_id: EFFECT_ID.to_owned(),
        failure_code: 0,
    }
}

pub fn uniffi_upload_snapshot() -> UniUploadJobSnapshot {
    UniUploadJobSnapshot {
        schema_version: 1,
        job_id: JOB_ID.to_owned(),
        album_id: ALBUM_ID.to_owned(),
        phase: "AwaitingSyncConfirmation".to_owned(),
        retry_count: 1,
        max_retry_count: 5,
        next_retry_not_before_ms: 1_700_000_020_000,
        has_next_retry_not_before_ms: true,
        idempotency_key: IDEMPOTENCY_KEY.to_owned(),
        tiered_shards: vec![UniUploadShardRef {
            tier: ShardTier::Original.to_byte(),
            shard_index: 0,
            shard_id: SHARD_ID.to_owned(),
            sha256: vec![0x11; 32],
            content_length: 1024,
            envelope_version: 3,
            uploaded: true,
        }],
        shard_set_hash: vec![0x22; 32],
        snapshot_revision: 2,
        last_effect_id: EFFECT_ID.to_owned(),
        last_acknowledged_effect_id: EFFECT_ID.to_owned(),
        last_applied_event_id: EFFECT_ID.to_owned(),
        failure_code: 0,
    }
}

pub struct UploadReducerCase {
    pub name: &'static str,
    pub phase: &'static str,
    pub shard_uploaded: bool,
    pub event_kind: &'static str,
    pub error_code: u16,
}

pub struct AlbumSyncReducerCase {
    pub name: &'static str,
    pub phase: &'static str,
    pub event_kind: &'static str,
    pub error_code: u16,
}

pub fn wasm_upload_snapshot_for_phase(phase: &str, shard_uploaded: bool) -> WasmUploadJobSnapshot {
    WasmUploadJobSnapshot {
        phase: phase.to_owned(),
        tiered_shards: vec![WasmUploadShardRef {
            tier: ShardTier::Original.to_byte(),
            shard_index: 0,
            shard_id: SHARD_ID.to_owned(),
            sha256: vec![0x11; 32],
            content_length: 1024,
            envelope_version: 3,
            uploaded: shard_uploaded,
        }],
        snapshot_revision: 0,
        last_effect_id: String::new(),
        last_acknowledged_effect_id: String::new(),
        last_applied_event_id: String::new(),
        ..wasm_upload_snapshot()
    }
}

pub fn uniffi_upload_snapshot_for_phase(phase: &str, shard_uploaded: bool) -> UniUploadJobSnapshot {
    UniUploadJobSnapshot {
        phase: phase.to_owned(),
        tiered_shards: vec![UniUploadShardRef {
            tier: ShardTier::Original.to_byte(),
            shard_index: 0,
            shard_id: SHARD_ID.to_owned(),
            sha256: vec![0x11; 32],
            content_length: 1024,
            envelope_version: 3,
            uploaded: shard_uploaded,
        }],
        snapshot_revision: 0,
        last_effect_id: String::new(),
        last_acknowledged_effect_id: String::new(),
        last_applied_event_id: String::new(),
        ..uniffi_upload_snapshot()
    }
}

pub fn wasm_upload_event(kind: &str, error_code: u16) -> WasmUploadJobEvent {
    WasmUploadJobEvent {
        kind: kind.to_owned(),
        effect_id: EFFECT_ID.to_owned(),
        tier: ShardTier::Original.to_byte(),
        shard_index: 0,
        shard_id: SHARD_ID.to_owned(),
        sha256: vec![0x11; 32],
        content_length: 1024,
        envelope_version: 3,
        uploaded: kind == "ShardUploaded",
        tiered_shards: Vec::new(),
        shard_set_hash: vec![0x22; 32],
        asset_id: ASSET_ID.to_owned(),
        since_metadata_version: 0,
        recovery_outcome: "Match".to_owned(),
        now_ms: 1_700_000_020_000,
        base_backoff_ms: 1_000,
        server_retry_after_ms: 0,
        has_server_retry_after_ms: false,
        has_error_code: error_code != 0,
        error_code,
        target_phase: "CreatingShardUpload".to_owned(),
    }
}

pub fn uniffi_upload_event(kind: &str, error_code: u16) -> UniUploadJobEvent {
    UniUploadJobEvent {
        kind: kind.to_owned(),
        effect_id: EFFECT_ID.to_owned(),
        tier: ShardTier::Original.to_byte(),
        shard_index: 0,
        shard_id: SHARD_ID.to_owned(),
        sha256: vec![0x11; 32],
        content_length: 1024,
        envelope_version: 3,
        uploaded: kind == "ShardUploaded",
        tiered_shards: Vec::new(),
        shard_set_hash: vec![0x22; 32],
        asset_id: ASSET_ID.to_owned(),
        since_metadata_version: 0,
        recovery_outcome: "Match".to_owned(),
        now_ms: 1_700_000_020_000,
        base_backoff_ms: 1_000,
        server_retry_after_ms: 0,
        has_server_retry_after_ms: false,
        has_error_code: error_code != 0,
        error_code,
        target_phase: "CreatingShardUpload".to_owned(),
    }
}

pub fn wasm_album_sync_snapshot_for_phase(phase: &str) -> WasmAlbumSyncSnapshot {
    WasmAlbumSyncSnapshot {
        schema_version: 1,
        album_id: ALBUM_ID.to_owned(),
        phase: phase.to_owned(),
        active_cursor: "cursor-a".to_owned(),
        pending_cursor: String::new(),
        rerun_requested: false,
        retry_count: 0,
        max_retry_count: 5,
        next_retry_unix_ms: 0,
        last_error_code: 0,
        last_error_stage: String::new(),
        updated_at_unix_ms: 1_700_000_020_000,
    }
}

pub fn uniffi_album_sync_snapshot_for_phase(phase: &str) -> UniAlbumSyncSnapshot {
    UniAlbumSyncSnapshot {
        schema_version: 1,
        album_id: ALBUM_ID.to_owned(),
        phase: phase.to_owned(),
        active_cursor: "cursor-a".to_owned(),
        pending_cursor: String::new(),
        rerun_requested: false,
        retry_count: 0,
        max_retry_count: 5,
        next_retry_unix_ms: 0,
        last_error_code: 0,
        last_error_stage: String::new(),
        updated_at_unix_ms: 1_700_000_020_000,
    }
}

pub fn wasm_album_sync_event(kind: &str, error_code: u16) -> WasmAlbumSyncEvent {
    WasmAlbumSyncEvent {
        kind: kind.to_owned(),
        fetched_cursor: "sync-request-id".to_owned(),
        next_cursor: "cursor-b".to_owned(),
        applied_count: 2,
        observed_asset_ids: vec![ASSET_ID.to_owned()],
        retry_after_unix_ms: 1_500,
        has_error_code: error_code != 0,
        error_code,
    }
}

pub fn uniffi_album_sync_event(kind: &str, error_code: u16) -> UniAlbumSyncEvent {
    UniAlbumSyncEvent {
        kind: kind.to_owned(),
        fetched_cursor: "sync-request-id".to_owned(),
        next_cursor: "cursor-b".to_owned(),
        applied_count: 2,
        observed_asset_ids: vec![ASSET_ID.to_owned()],
        retry_after_unix_ms: 1_500,
        has_error_code: error_code != 0,
        error_code,
    }
}

pub fn canonical_wasm_snapshot_bytes(snapshot: &WasmUploadJobSnapshot) -> Vec<u8> {
    canonical_snapshot_bytes(
        snapshot.schema_version,
        &snapshot.job_id,
        &snapshot.album_id,
        &snapshot.phase,
        snapshot.retry_count,
        snapshot.max_retry_count,
        snapshot.next_retry_not_before_ms,
        snapshot.has_next_retry_not_before_ms,
        &snapshot.idempotency_key,
        snapshot
            .tiered_shards
            .iter()
            .map(|shard| CanonicalShard {
                tier: shard.tier,
                shard_index: shard.shard_index,
                shard_id: &shard.shard_id,
                sha256: &shard.sha256,
                content_length: shard.content_length,
                envelope_version: shard.envelope_version,
                uploaded: shard.uploaded,
            })
            .collect(),
        &snapshot.shard_set_hash,
        snapshot.snapshot_revision,
        &snapshot.last_acknowledged_effect_id,
        &snapshot.last_applied_event_id,
        snapshot.failure_code,
    )
}

pub fn canonical_uniffi_snapshot_bytes(snapshot: &UniUploadJobSnapshot) -> Vec<u8> {
    canonical_snapshot_bytes(
        snapshot.schema_version,
        &snapshot.job_id,
        &snapshot.album_id,
        &snapshot.phase,
        snapshot.retry_count,
        snapshot.max_retry_count,
        snapshot.next_retry_not_before_ms,
        snapshot.has_next_retry_not_before_ms,
        &snapshot.idempotency_key,
        snapshot
            .tiered_shards
            .iter()
            .map(|shard| CanonicalShard {
                tier: shard.tier,
                shard_index: shard.shard_index,
                shard_id: &shard.shard_id,
                sha256: &shard.sha256,
                content_length: shard.content_length,
                envelope_version: shard.envelope_version,
                uploaded: shard.uploaded,
            })
            .collect(),
        &snapshot.shard_set_hash,
        snapshot.snapshot_revision,
        &snapshot.last_acknowledged_effect_id,
        &snapshot.last_applied_event_id,
        snapshot.failure_code,
    )
}

pub fn canonical_wasm_upload_transition_bytes(transition: &WasmUploadJobTransition) -> Vec<u8> {
    canonical_upload_transition_bytes(
        canonical_wasm_snapshot_bytes(&transition.next_snapshot),
        transition
            .effects
            .iter()
            .map(canonical_wasm_upload_effect_value)
            .collect(),
    )
}

pub fn canonical_uniffi_upload_transition_bytes(transition: &UniUploadJobTransition) -> Vec<u8> {
    canonical_upload_transition_bytes(
        canonical_uniffi_snapshot_bytes(&transition.next_snapshot),
        transition
            .effects
            .iter()
            .map(canonical_uniffi_upload_effect_value)
            .collect(),
    )
}

pub fn canonical_upload_transition_bytes(snapshot: Vec<u8>, effects: Vec<Value>) -> Vec<u8> {
    cbor_value_to_bytes(Value::Map(vec![
        cbor_pair(0, Value::Bytes(snapshot)),
        cbor_pair(1, Value::Array(effects)),
    ]))
}

pub fn canonical_wasm_upload_effect_value(effect: &WasmUploadJobEffect) -> Value {
    canonical_upload_effect_value(
        &effect.kind,
        &effect.effect_id,
        effect.tier,
        effect.shard_index,
        &effect.shard_id,
        &effect.sha256,
        effect.content_length,
        effect.envelope_version,
        effect.attempt,
        effect.not_before_ms,
        &effect.target_phase,
        &effect.reason,
        &effect.asset_id,
        effect.since_metadata_version,
        &effect.idempotency_key,
        &effect.shard_set_hash,
    )
}

pub fn canonical_uniffi_upload_effect_value(effect: &UniUploadJobEffect) -> Value {
    canonical_upload_effect_value(
        &effect.kind,
        &effect.effect_id,
        effect.tier,
        effect.shard_index,
        &effect.shard_id,
        &effect.sha256,
        effect.content_length,
        effect.envelope_version,
        effect.attempt,
        effect.not_before_ms,
        &effect.target_phase,
        &effect.reason,
        &effect.asset_id,
        effect.since_metadata_version,
        &effect.idempotency_key,
        &effect.shard_set_hash,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn canonical_upload_effect_value(
    kind: &str,
    effect_id: &str,
    tier: u8,
    shard_index: u32,
    shard_id: &str,
    sha256: &[u8],
    content_length: u64,
    envelope_version: u8,
    attempt: u32,
    not_before_ms: i64,
    target_phase: &str,
    reason: &str,
    asset_id: &str,
    since_metadata_version: u64,
    idempotency_key: &str,
    shard_set_hash: &[u8],
) -> Value {
    Value::Map(vec![
        cbor_pair(0, Value::Text(kind.to_owned())),
        cbor_pair(1, optional_uuid_value(effect_id)),
        cbor_pair(2, Value::Integer(tier.into())),
        cbor_pair(3, Value::Integer(shard_index.into())),
        cbor_pair(4, optional_uuid_value(shard_id)),
        cbor_pair(5, Value::Bytes(sha256.to_vec())),
        cbor_pair(6, Value::Integer(content_length.into())),
        cbor_pair(7, Value::Integer(envelope_version.into())),
        cbor_pair(8, Value::Integer(attempt.into())),
        cbor_pair(9, Value::Integer(not_before_ms.into())),
        cbor_pair(10, Value::Text(target_phase.to_owned())),
        cbor_pair(11, Value::Text(reason.to_owned())),
        cbor_pair(12, optional_uuid_value(asset_id)),
        cbor_pair(13, Value::Integer(since_metadata_version.into())),
        cbor_pair(14, optional_uuid_value(idempotency_key)),
        cbor_pair(15, Value::Bytes(shard_set_hash.to_vec())),
    ])
}

pub fn canonical_wasm_album_sync_transition_bytes(transition: &WasmAlbumSyncTransition) -> Vec<u8> {
    canonical_album_sync_transition_bytes(
        canonical_wasm_album_sync_snapshot_value(&transition.snapshot),
        transition
            .effects
            .iter()
            .map(canonical_wasm_album_sync_effect_value)
            .collect(),
    )
}

pub fn canonical_uniffi_album_sync_transition_bytes(transition: &UniAlbumSyncTransition) -> Vec<u8> {
    canonical_album_sync_transition_bytes(
        canonical_uniffi_album_sync_snapshot_value(&transition.snapshot),
        transition
            .effects
            .iter()
            .map(canonical_uniffi_album_sync_effect_value)
            .collect(),
    )
}

pub fn canonical_album_sync_transition_bytes(snapshot: Value, effects: Vec<Value>) -> Vec<u8> {
    cbor_value_to_bytes(Value::Map(vec![
        cbor_pair(0, snapshot),
        cbor_pair(1, Value::Array(effects)),
    ]))
}

pub fn canonical_wasm_album_sync_snapshot_value(snapshot: &WasmAlbumSyncSnapshot) -> Value {
    canonical_album_sync_snapshot_value(
        snapshot.schema_version,
        &snapshot.album_id,
        &snapshot.phase,
        &snapshot.active_cursor,
        &snapshot.pending_cursor,
        snapshot.rerun_requested,
        snapshot.retry_count,
        snapshot.max_retry_count,
        snapshot.next_retry_unix_ms,
        snapshot.last_error_code,
        &snapshot.last_error_stage,
        snapshot.updated_at_unix_ms,
    )
}

pub fn canonical_uniffi_album_sync_snapshot_value(snapshot: &UniAlbumSyncSnapshot) -> Value {
    canonical_album_sync_snapshot_value(
        snapshot.schema_version,
        &snapshot.album_id,
        &snapshot.phase,
        &snapshot.active_cursor,
        &snapshot.pending_cursor,
        snapshot.rerun_requested,
        snapshot.retry_count,
        snapshot.max_retry_count,
        snapshot.next_retry_unix_ms,
        snapshot.last_error_code,
        &snapshot.last_error_stage,
        snapshot.updated_at_unix_ms,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn canonical_album_sync_snapshot_value(
    schema_version: u32,
    album_id: &str,
    phase: &str,
    active_cursor: &str,
    pending_cursor: &str,
    rerun_requested: bool,
    retry_count: u32,
    max_retry_count: u32,
    next_retry_unix_ms: u64,
    last_error_code: u16,
    last_error_stage: &str,
    updated_at_unix_ms: u64,
) -> Value {
    Value::Map(vec![
        cbor_pair(0, Value::Integer(schema_version.into())),
        cbor_pair(1, Value::Text(album_id.to_owned())),
        cbor_pair(2, Value::Text(phase.to_owned())),
        cbor_pair(3, Value::Text(active_cursor.to_owned())),
        cbor_pair(4, Value::Text(pending_cursor.to_owned())),
        cbor_pair(5, Value::Bool(rerun_requested)),
        cbor_pair(6, Value::Integer(retry_count.into())),
        cbor_pair(7, Value::Integer(max_retry_count.into())),
        cbor_pair(8, Value::Integer(next_retry_unix_ms.into())),
        cbor_pair(9, Value::Integer(last_error_code.into())),
        cbor_pair(10, Value::Text(last_error_stage.to_owned())),
        cbor_pair(11, Value::Integer(updated_at_unix_ms.into())),
    ])
}

pub fn canonical_wasm_album_sync_effect_value(effect: &WasmAlbumSyncEffect) -> Value {
    canonical_album_sync_effect_value(&effect.kind, &effect.cursor)
}

pub fn canonical_uniffi_album_sync_effect_value(effect: &UniAlbumSyncEffect) -> Value {
    canonical_album_sync_effect_value(&effect.kind, &effect.cursor)
}

pub fn canonical_album_sync_effect_value(kind: &str, cursor: &str) -> Value {
    Value::Map(vec![
        cbor_pair(0, Value::Text(kind.to_owned())),
        cbor_pair(1, Value::Text(cursor.to_owned())),
    ])
}

pub struct CanonicalShard<'a> {
    pub tier: u8,
    pub shard_index: u32,
    pub shard_id: &'a str,
    pub sha256: &'a [u8],
    pub content_length: u64,
    pub envelope_version: u8,
    pub uploaded: bool,
}

#[allow(clippy::too_many_arguments)]
pub fn canonical_snapshot_bytes(
    schema_version: u32,
    job_id: &str,
    album_id: &str,
    phase: &str,
    retry_count: u32,
    max_retry_count: u8,
    next_retry_not_before_ms: i64,
    has_next_retry_not_before_ms: bool,
    idempotency_key: &str,
    tiered_shards: Vec<CanonicalShard<'_>>,
    shard_set_hash: &[u8],
    snapshot_revision: u64,
    last_acknowledged_effect_id: &str,
    last_applied_event_id: &str,
    failure_code: u16,
) -> Vec<u8> {
    let value = Value::Map(vec![
        cbor_pair(0, Value::Integer(schema_version.into())),
        cbor_pair(1, Value::Bytes(uuid_to_bytes(job_id))),
        cbor_pair(2, Value::Bytes(uuid_to_bytes(album_id))),
        cbor_pair(3, Value::Text(phase.to_owned())),
        cbor_pair(4, Value::Integer(retry_count.into())),
        cbor_pair(5, Value::Integer(max_retry_count.into())),
        cbor_pair(
            6,
            if has_next_retry_not_before_ms {
                Value::Integer(next_retry_not_before_ms.into())
            } else {
                Value::Null
            },
        ),
        cbor_pair(7, Value::Bytes(uuid_to_bytes(idempotency_key))),
        cbor_pair(
            8,
            Value::Array(
                tiered_shards
                    .into_iter()
                    .map(canonical_shard_value)
                    .collect(),
            ),
        ),
        cbor_pair(9, Value::Bytes(shard_set_hash.to_vec())),
        cbor_pair(10, Value::Integer(snapshot_revision.into())),
        cbor_pair(11, optional_uuid_value(last_acknowledged_effect_id)),
        cbor_pair(12, optional_uuid_value(last_applied_event_id)),
        cbor_pair(
            13,
            if failure_code == 0 {
                Value::Null
            } else {
                Value::Integer(failure_code.into())
            },
        ),
    ]);
    cbor_value_to_bytes(value)
}

pub fn cbor_value_to_bytes(value: Value) -> Vec<u8> {
    let mut bytes = Vec::new();
    if let Err(error) = ciborium::ser::into_writer(&value, &mut bytes) {
        panic!("canonical CBOR should encode: {error:?}");
    }
    bytes
}

pub fn cbor_pair(key: u32, value: Value) -> (Value, Value) {
    (Value::Integer(key.into()), value)
}

pub fn canonical_shard_value(shard: CanonicalShard<'_>) -> Value {
    Value::Map(vec![
        cbor_pair(0, Value::Integer(shard.tier.into())),
        cbor_pair(1, Value::Integer(shard.shard_index.into())),
        cbor_pair(2, Value::Bytes(uuid_to_bytes(shard.shard_id))),
        cbor_pair(3, Value::Bytes(shard.sha256.to_vec())),
        cbor_pair(4, Value::Integer(shard.content_length.into())),
        cbor_pair(5, Value::Integer(shard.envelope_version.into())),
        cbor_pair(6, Value::Bool(shard.uploaded)),
    ])
}

pub fn optional_uuid_value(uuid: &str) -> Value {
    if uuid.is_empty() {
        Value::Null
    } else {
        Value::Bytes(uuid_to_bytes(uuid))
    }
}

#[derive(Clone, Copy)]
pub enum StripFormat {
    Jpeg,
    Png,
    WebP,
    Avif,
    Heic,
    Mp4,
}

pub struct StripCase {
    pub name: &'static str,
    pub format: StripFormat,
    pub input: Vec<u8>,
    pub expected: Option<Vec<u8>>,
}

pub fn strip_cases() -> Vec<StripCase> {
    vec![
        StripCase {
            name: "jpeg web strip corpus",
            format: StripFormat::Jpeg,
            input: include_bytes!(
                "../../../../apps/web/tests/fixtures/strip-corpus/jpeg-with-appn.jpg"
            )
            .to_vec(),
            expected: Some(
                include_bytes!(
                    "../../../../apps/web/tests/fixtures/strip-corpus/jpeg-with-appn.stripped.jpg"
                )
                .to_vec(),
            ),
        },
        StripCase {
            name: "png web strip corpus",
            format: StripFormat::Png,
            input: include_bytes!(
                "../../../../apps/web/tests/fixtures/strip-corpus/png-with-text.png"
            )
            .to_vec(),
            expected: Some(
                include_bytes!(
                    "../../../../apps/web/tests/fixtures/strip-corpus/png-with-text.stripped.png"
                )
                .to_vec(),
            ),
        },
        StripCase {
            name: "webp web strip corpus",
            format: StripFormat::WebP,
            input: include_bytes!(
                "../../../../apps/web/tests/fixtures/strip-corpus/webp-with-metadata.webp"
            )
            .to_vec(),
            expected: Some(
                include_bytes!(
                    "../../../../apps/web/tests/fixtures/strip-corpus/webp-with-metadata.stripped.webp"
                )
                .to_vec(),
            ),
        },
        StripCase {
            name: "avif media strip corpus",
            format: StripFormat::Avif,
            input: include_bytes!(
                "../../../mosaic-media/tests/avif_corpus/synthetic-with-metadata.avif"
            )
            .to_vec(),
            expected: Some(
                include_bytes!(
                    "../../../mosaic-media/tests/avif_corpus/synthetic-with-metadata.stripped.avif"
                )
                .to_vec(),
            ),
        },
        StripCase {
            name: "heic media strip corpus",
            format: StripFormat::Heic,
            input: include_bytes!(
                "../../../mosaic-media/tests/heic_corpus/synthetic-with-metadata.heic"
            )
            .to_vec(),
            expected: Some(
                include_bytes!(
                    "../../../mosaic-media/tests/heic_corpus/synthetic-with-metadata.stripped.heic"
                )
                .to_vec(),
            ),
        },
        StripCase {
            name: "synthetic mp4 strip corpus",
            format: StripFormat::Mp4,
            input: synthetic_mp4(),
            expected: None,
        },
    ]
}

pub fn strip_result_from_media(
    result: Result<mosaic_media::StrippedMedia, mosaic_media::MosaicMediaError>,
) -> SimpleStripResult {
    match result {
        Ok(stripped) => SimpleStripResult {
            code: ClientErrorCode::Ok.as_u16(),
            removed_metadata_count: match u32::try_from(stripped.removed.len()) {
                Ok(value) => value,
                Err(error) => panic!("metadata count should fit u32: {error:?}"),
            },
            stripped_bytes: stripped.bytes,
        },
        Err(error) => SimpleStripResult {
            code: media_error_code(error),
            removed_metadata_count: 0,
            stripped_bytes: Vec::new(),
        },
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct SimpleStripResult {
    pub code: u16,
    pub stripped_bytes: Vec<u8>,
    pub removed_metadata_count: u32,
}

pub fn wasm_strip_result(result: mosaic_wasm::JsStripResult) -> SimpleStripResult {
    SimpleStripResult {
        code: result.code(),
        stripped_bytes: result.stripped_bytes(),
        removed_metadata_count: result.removed_metadata_count(),
    }
}

pub fn media_error_code(error: mosaic_media::MosaicMediaError) -> u16 {
    match error {
        mosaic_media::MosaicMediaError::UnsupportedFormat => {
            ClientErrorCode::UnsupportedMediaFormat.as_u16()
        }
        mosaic_media::MosaicMediaError::InvalidJpeg
        | mosaic_media::MosaicMediaError::InvalidPng
        | mosaic_media::MosaicMediaError::InvalidWebP => {
            ClientErrorCode::InvalidMediaContainer.as_u16()
        }
        mosaic_media::MosaicMediaError::InvalidDimensions => {
            ClientErrorCode::InvalidMediaDimensions.as_u16()
        }
        mosaic_media::MosaicMediaError::OutputTooLarge => {
            ClientErrorCode::MediaOutputTooLarge.as_u16()
        }
        mosaic_media::MosaicMediaError::ImageMetadataMismatch => {
            ClientErrorCode::MediaMetadataMismatch.as_u16()
        }
        mosaic_media::MosaicMediaError::MetadataSidecar(_) => {
            ClientErrorCode::InvalidMediaSidecar.as_u16()
        }
        mosaic_media::MosaicMediaError::EncodedTierMismatch { .. } => {
            ClientErrorCode::MediaAdapterOutputMismatch.as_u16()
        }
    }
}

pub fn encoded_metadata_fields(fields: &[(u16, &[u8])]) -> Vec<u8> {
    let mut encoded = Vec::new();
    for (tag, value) in fields {
        encoded.extend_from_slice(&tag.to_le_bytes());
        let len = match u32::try_from(value.len()) {
            Ok(value) => value,
            Err(error) => panic!("metadata value length should fit u32: {error:?}"),
        };
        encoded.extend_from_slice(&len.to_le_bytes());
        encoded.extend_from_slice(value);
    }
    encoded
}

pub fn patterned_plaintext(len: usize) -> Vec<u8> {
    (0..len)
        .map(|index| {
            let value = index % 251;
            match u8::try_from(value) {
                Ok(byte) => byte,
                Err(error) => panic!("pattern byte should fit u8: {error:?}"),
            }
        })
        .collect()
}

pub fn synthetic_mp4() -> Vec<u8> {
    let mut bytes = ftyp_box(*b"isom");
    let trak = trak_box(*b"avc1", 640, 480, 1_000, 1_000, 25);
    let mut moov_payload = Vec::new();
    moov_payload.extend_from_slice(&trak);
    moov_payload.extend_from_slice(&bmff_box(*b"udta", &bmff_box(*b"name", b"metadata")));
    moov_payload.extend_from_slice(&bmff_box(*b"meta", &[0, 0, 0, 0]));
    bytes.extend_from_slice(&bmff_box(*b"moov", &moov_payload));
    bytes.extend_from_slice(&bmff_box(*b"mdat", b"video-frames"));
    bytes
}

pub fn trak_box(
    codec: [u8; 4],
    width: u32,
    height: u32,
    timescale: u32,
    duration: u32,
    fps: u32,
) -> Vec<u8> {
    let mut mdia = Vec::new();
    mdia.extend_from_slice(&mdhd_box(timescale, duration));
    mdia.extend_from_slice(&hdlr_box());
    mdia.extend_from_slice(&bmff_box(
        *b"minf",
        &bmff_box(*b"stbl", &stbl_box(codec, timescale / fps)),
    ));
    let mut trak = tkhd_box(width, height);
    trak.extend_from_slice(&bmff_box(*b"mdia", &mdia));
    bmff_box(*b"trak", &trak)
}

pub fn ftyp_box(brand: [u8; 4]) -> Vec<u8> {
    let mut payload = brand.to_vec();
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&brand);
    payload.extend_from_slice(b"mp42");
    bmff_box(*b"ftyp", &payload)
}

pub fn tkhd_box(width: u32, height: u32) -> Vec<u8> {
    let mut payload = vec![0, 0, 0, 0];
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&1_u32.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&[0; 8]);
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&[
        0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x01, 0x00, 0x00, 0, 0,
        0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0,
    ]);
    payload.extend_from_slice(&(width << 16).to_be_bytes());
    payload.extend_from_slice(&(height << 16).to_be_bytes());
    bmff_box(*b"tkhd", &payload)
}

pub fn mdhd_box(timescale: u32, duration: u32) -> Vec<u8> {
    let mut payload = vec![0, 0, 0, 0];
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&timescale.to_be_bytes());
    payload.extend_from_slice(&duration.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    bmff_box(*b"mdhd", &payload)
}

pub fn hdlr_box() -> Vec<u8> {
    let mut payload = vec![0, 0, 0, 0];
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(b"vide");
    payload.extend_from_slice(&[0_u8; 12]);
    payload.push(0);
    bmff_box(*b"hdlr", &payload)
}

pub fn stbl_box(codec: [u8; 4], sample_delta: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&stsd_box(codec));
    payload.extend_from_slice(&stts_box(60, sample_delta));
    payload
}

pub fn stsd_box(codec: [u8; 4]) -> Vec<u8> {
    let mut payload = vec![0, 0, 0, 0];
    payload.extend_from_slice(&1_u32.to_be_bytes());
    payload.extend_from_slice(&86_u32.to_be_bytes());
    payload.extend_from_slice(&codec);
    payload.extend_from_slice(&[0; 78]);
    bmff_box(*b"stsd", &payload)
}

pub fn stts_box(sample_count: u32, sample_delta: u32) -> Vec<u8> {
    let mut payload = vec![0, 0, 0, 0];
    payload.extend_from_slice(&1_u32.to_be_bytes());
    payload.extend_from_slice(&sample_count.to_be_bytes());
    payload.extend_from_slice(&sample_delta.to_be_bytes());
    bmff_box(*b"stts", &payload)
}

pub fn bmff_box(kind: [u8; 4], payload: &[u8]) -> Vec<u8> {
    let size = match u32::try_from(payload.len() + 8) {
        Ok(value) => value,
        Err(error) => panic!("box size should fit u32: {error:?}"),
    };
    let mut bytes = Vec::with_capacity(payload.len() + 8);
    bytes.extend_from_slice(&size.to_be_bytes());
    bytes.extend_from_slice(&kind);
    bytes.extend_from_slice(payload);
    bytes
}

pub fn bytes_to_uuid(bytes: &[u8; 16]) -> String {
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

pub fn hex_lower(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

pub fn content_hash_dedup_vector() -> ContentHashVector {
    let mut path = default_corpus_dir();
    path.push("content_hash_dedup.json");
    let parsed = must(load_vector(&path), "load content_hash_dedup vector");
    must(
        ContentHashVector::from(&parsed),
        "parse content_hash_dedup vector",
    )
}

pub fn load_named_vector(name: &str) -> ParsedVector {
    let mut path = default_corpus_dir();
    path.push(name);
    must(load_vector(&path), "load named vector")
}

pub fn json_str<'a>(parsed: &'a ParsedVector, section: &str, field: &str) -> &'a str {
    parsed.document[section][field]
        .as_str()
        .unwrap_or_else(|| panic!("{}.{} must be a string", section, field))
}

pub fn hex_to_bytes(value: &str) -> Vec<u8> {
    assert_eq!(value.len() % 2, 0, "hex length must be even");
    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16)
                .unwrap_or_else(|_| panic!("invalid hex at byte {}", index / 2))
        })
        .collect()
}

pub fn contains_subsequence(bytes: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && bytes.windows(needle.len()).any(|window| window == needle)
}

#[cfg(feature = "cross-client-vectors")]
pub fn auth_challenge_bytes() -> Vec<u8> {
    vec![0x44; 32]
}

#[cfg(feature = "cross-client-vectors")]
pub fn core_auth_challenge_code(username: &str) -> u16 {
    match mosaic_crypto::build_auth_challenge_transcript(username, None, &auth_challenge_bytes()) {
        Ok(_) => ClientErrorCode::Ok.as_u16(),
        Err(mosaic_crypto::MosaicCryptoError::InvalidUsername) => {
            ClientErrorCode::InvalidUsername.as_u16()
        }
        Err(error) => panic!("unexpected core auth challenge error: {error:?}"),
    }
}

pub fn proptest_config() -> Config {
    Config {
        cases: 32,
        failure_persistence: None,
        ..Config::default()
    }
}

pub fn prop_failure<T>(message: String) -> Result<T, TestCaseError> {
    Err(TestCaseError::fail(message))
}

#[cfg(feature = "cross-client-vectors")]
pub fn username_strategy() -> impl Strategy<Value = String> {
    prop_oneof![
        prop::collection::vec(auth_username_char_strategy(), 1..=256)
            .prop_map(|chars| chars.into_iter().collect::<String>()),
        prop::collection::vec(any::<char>(), 0..=256)
            .prop_map(|chars| chars.into_iter().collect::<String>()),
    ]
}

#[cfg(feature = "cross-client-vectors")]
pub fn auth_username_char_strategy() -> impl Strategy<Value = char> {
    prop_oneof![
        (b'a'..=b'z').prop_map(char::from),
        (b'A'..=b'Z').prop_map(char::from),
        (b'0'..=b'9').prop_map(char::from),
        Just('_'),
        Just('-'),
        Just('@'),
        Just('.'),
    ]
}

pub fn uuid_to_bytes(uuid: &str) -> Vec<u8> {
    let compact = uuid.replace('-', "");
    if compact.len() != 32 {
        panic!("uuid should have 32 hex digits after removing hyphens: {uuid}");
    }
    let mut bytes = Vec::with_capacity(16);
    for index in (0..compact.len()).step_by(2) {
        let byte = match u8::from_str_radix(&compact[index..index + 2], 16) {
            Ok(value) => value,
            Err(error) => panic!("uuid should be hex: {error:?}"),
        };
        bytes.push(byte);
    }
    bytes
}

pub fn fixed_identity_seed() -> [u8; 32] {
    [
        0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f, 0x50,
        0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f,
        0x60, 0x61,
    ]
}

#[cfg(feature = "cross-client-vectors")]
pub fn fixed_recipient_identity_seed() -> [u8; 32] {
    [
        0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf,
        0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xbb, 0xbc, 0xbd, 0xbe,
        0xbf, 0xc0,
    ]
}

pub fn fixed_epoch_seed() -> [u8; 32] {
    [
        0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x8c, 0x8d, 0x8e, 0x8f,
        0x90, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9e,
        0x9f, 0xa0,
    ]
}

#[cfg(feature = "cross-client-vectors")]
pub fn fixed_sidecar_seed() -> [u8; 32] {
    [
        0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e,
        0x3f, 0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d,
        0x4e, 0x4f,
    ]
}

pub fn fixed_manifest_transcript() -> Vec<u8> {
    let result = mosaic_wasm::manifest_transcript_bytes(
        ALBUM_ID_BYTES.to_vec(),
        19,
        vec![0x90, 0x91, 0x92, 0x93],
        encoded_manifest_shards(),
    );
    assert_ok(result.code, "fixed manifest transcript");
    result.bytes
}

pub fn fixed_account_and_wrapped_identity_seed() -> (Vec<u8>, Vec<u8>) {
    let material = fixed_account_material();
    let wrapped_identity_seed = match mosaic_crypto::wrap_secret_with_aad(
        &fixed_identity_seed(),
        &material.account_key,
        mosaic_crypto::IDENTITY_SEED_AAD,
    ) {
        Ok(bytes) => bytes,
        Err(error) => panic!("fixed identity seed should wrap: {error:?}"),
    };
    (material.wrapped_account_key, wrapped_identity_seed)
}

pub fn cbor_bytes(value: Value) -> Vec<u8> {
    let mut bytes = Vec::new();
    if let Err(error) = ciborium::ser::into_writer(&value, &mut bytes) {
        panic!("CBOR fixture should encode: {error:?}");
    }
    bytes
}

pub fn download_plan_builder_input_cbor() -> Vec<u8> {
    let shard = Value::Map(vec![
        cbor_pair(0, Value::Bytes(uuid_to_bytes(SHARD_ID))),
        cbor_pair(1, Value::Integer(7.into())),
        cbor_pair(2, Value::Integer(ShardTier::Original.to_byte().into())),
        cbor_pair(3, Value::Bytes(vec![0x55; 32])),
        cbor_pair(4, Value::Integer(1234.into())),
    ]);
    let photo = Value::Map(vec![
        cbor_pair(
            0,
            Value::Text(PHOTO_ID_BYTES.iter().map(|b| format!("{b:02x}")).collect()),
        ),
        cbor_pair(1, Value::Text("IMG_0001.JPG".to_owned())),
        cbor_pair(2, Value::Array(vec![shard])),
    ]);
    cbor_bytes(Value::Map(vec![cbor_pair(0, Value::Array(vec![photo]))]))
}

pub fn download_plan_input() -> DownloadPlanInput {
    DownloadPlanInput {
        album_id: uuid_to_bytes(ALBUM_ID),
        entries: vec![DownloadPlanEntryInput {
            photo_id: PHOTO_ID_BYTES.iter().map(|b| format!("{b:02x}")).collect(),
            filename: "IMG_0001.JPG".to_owned(),
            shards: vec![DownloadPlanShardInput {
                shard_id: uuid_to_bytes(SHARD_ID),
                epoch_id: 7,
                tier: ShardTier::Original.to_byte(),
                expected_hash: vec![0x55; 32],
                declared_size: 1234,
            }],
        }],
    }
}

pub fn download_init_input_cbor(plan_cbor: &[u8]) -> Vec<u8> {
    cbor_bytes(Value::Map(vec![
        cbor_pair(0, Value::Bytes(uuid_to_bytes(JOB_ID))),
        cbor_pair(1, Value::Bytes(uuid_to_bytes(ALBUM_ID))),
        cbor_pair(2, Value::Bytes(plan_cbor.to_vec())),
        cbor_pair(3, Value::Integer(1_700_000_020_000_i64.into())),
        cbor_pair(4, Value::Text(legacy_scope_for_job())),
    ]))
}

pub fn legacy_scope_for_job() -> String {
    format!("legacy:{}", JOB_ID.replace('-', ""))
}

pub fn download_state_cbor(state: u8) -> Vec<u8> {
    cbor_bytes(Value::Map(vec![cbor_pair(0, Value::Integer(state.into()))]))
}

pub fn download_start_event_cbor() -> Vec<u8> {
    cbor_bytes(Value::Map(vec![
        cbor_pair(0, Value::Integer(0.into())),
        cbor_pair(1, Value::Bytes(uuid_to_bytes(JOB_ID))),
        cbor_pair(2, Value::Bytes(uuid_to_bytes(ALBUM_ID))),
    ]))
}

pub fn download_plan_ready_event_cbor() -> Vec<u8> {
    cbor_bytes(Value::Map(vec![cbor_pair(0, Value::Integer(1.into()))]))
}

#[cfg(feature = "cross-client-vectors")]
pub struct SealedBundleFixture {
    pub wasm_account_handle: u64,
    pub wasm_identity_handle: u64,
    pub wasm_epoch_handle: u64,
    pub uniffi_opened_epoch_handle: u64,
    pub opened_epoch_id: u32,
    pub opened_album_id: String,
    pub recipient_pubkey: Vec<u8>,
    pub opened_recipient_pubkey: Vec<u8>,
    pub sign_public_key: Vec<u8>,
    pub wasm_sign_public_key: Vec<u8>,
}

#[cfg(feature = "cross-client-vectors")]
impl SealedBundleFixture {
    pub fn close(self) {
        close_epoch_handles(&[self.wasm_epoch_handle, self.uniffi_opened_epoch_handle]);
        close_identity_handles(&[self.wasm_identity_handle]);
        close_account_handles(&[self.wasm_account_handle]);
    }
}

#[cfg(feature = "cross-client-vectors")]
pub fn wasm_sealed_bundle_opened_by_uniffi_fixture(epoch_id: u32) -> SealedBundleFixture {
    let wrapped_account_key = wrapped_account_key();
    let wasm_account = unlock_wasm_account(wrapped_account_key);
    let wasm_identity = mosaic_wasm::create_identity_handle(wasm_account);
    assert_ok(wasm_identity.code, "wasm create bundle sharer identity");
    let wasm_epoch = mosaic_wasm::create_epoch_key_handle(wasm_account, epoch_id);
    assert_ok(wasm_epoch.code, "wasm create bundle epoch");

    let recipient_seed = fixed_recipient_identity_seed();
    let recipient = mosaic_uniffi::derive_identity_from_raw_seed(
        recipient_seed.to_vec(),
        b"recipient-public-key-probe".to_vec(),
    );
    assert_ok(recipient.code, "uniffi derive recipient identity");

    let sealed = mosaic_wasm::seal_bundle_with_epoch_handle(
        wasm_identity.handle,
        wasm_epoch.handle,
        recipient.signing_pubkey.clone(),
        ALBUM_ID.to_owned(),
    );
    assert_ok(sealed.code, "wasm seal epoch bundle");
    assert_eq!(sealed.sharer_pubkey, wasm_identity.signing_pubkey);

    let opened = mosaic_uniffi::verify_and_open_bundle_with_recipient_seed(
        recipient_seed.to_vec(),
        sealed.sealed,
        sealed.signature,
        sealed.sharer_pubkey,
        wasm_identity.signing_pubkey.clone(),
        ALBUM_ID.to_owned(),
        epoch_id,
        false,
    );
    assert_ok(opened.code, "uniffi open wasm sealed bundle");

    SealedBundleFixture {
        wasm_account_handle: wasm_account,
        wasm_identity_handle: wasm_identity.handle,
        wasm_epoch_handle: wasm_epoch.handle,
        uniffi_opened_epoch_handle: opened.epoch_handle_id,
        opened_epoch_id: opened.epoch_id,
        opened_album_id: opened.album_id,
        recipient_pubkey: recipient.signing_pubkey,
        opened_recipient_pubkey: opened.recipient_pubkey,
        sign_public_key: opened.sign_public_key,
        wasm_sign_public_key: wasm_epoch.sign_public_key,
    }
}

#[cfg(feature = "cross-client-vectors")]
pub fn streaming_round_trip_case(name: &str, plaintext: Vec<u8>, chunk_sizes: &[usize]) {
    let wrapped_account_key = wrapped_account_key();
    let wasm_account = unlock_wasm_account(wrapped_account_key.clone());
    let uniffi_account = unlock_uniffi_account(wrapped_account_key);
    let wasm_epoch = mosaic_wasm::create_epoch_key_handle(wasm_account, 121);
    assert_ok(wasm_epoch.code, "wasm create streaming parity epoch");
    let uniffi_epoch = mosaic_uniffi::open_epoch_key_handle(
        wasm_epoch.wrapped_epoch_seed.clone(),
        uniffi_account,
        121,
    );
    assert_ok(uniffi_epoch.code, "uniffi open streaming parity epoch");

    let mut wasm_encryptor = mosaic_wasm::StreamingShardEncryptor::new(
        wasm_epoch.handle,
        ShardTier::Original.to_byte(),
        Some(must(
            u32::try_from(chunk_sizes.len()),
            "chunk count fits u32",
        )),
    );
    let mut offset = 0;
    let mut wasm_frames = Vec::new();
    for (index, size) in chunk_sizes.iter().copied().enumerate() {
        let frame =
            wasm_encryptor.encrypt_frame_for_tests(plaintext[offset..offset + size].to_vec());
        assert_ok(frame.code, name);
        assert_eq!(
            frame.frame_index,
            must(u32::try_from(index), "frame index fits u32")
        );
        wasm_frames.push(frame.bytes);
        offset += size;
    }
    assert_eq!(offset, plaintext.len(), "{name}");
    let wasm_envelope = wasm_encryptor.finalize_for_tests();
    assert_ok(wasm_envelope.code, name);

    let uniffi_decryptor =
        match mosaic_uniffi::StreamingDecryptor::new(uniffi_epoch.handle, wasm_envelope.bytes) {
            Ok(value) => value,
            Err(error) => panic!("{name}: uniffi decryptor should open wasm envelope: {error:?}"),
        };
    let mut decrypted = Vec::new();
    for frame in wasm_frames {
        let bytes = match uniffi_decryptor.decrypt_frame(frame) {
            Ok(bytes) => bytes,
            Err(error) => panic!("{name}: uniffi should decrypt wasm frame: {error:?}"),
        };
        decrypted.extend_from_slice(&bytes);
    }
    if let Err(error) = uniffi_decryptor.finalize() {
        panic!("{name}: uniffi decryptor should finalize: {error:?}");
    }
    assert_eq!(decrypted, plaintext, "{name}");

    let uniffi_encryptor = match mosaic_uniffi::StreamingEncryptor::new(
        uniffi_epoch.handle,
        ShardTier::Original.to_byte(),
        Some(must(
            u32::try_from(chunk_sizes.len()),
            "chunk count fits u32",
        )),
    ) {
        Ok(value) => value,
        Err(error) => panic!("{name}: uniffi encryptor should initialize: {error:?}"),
    };
    let mut offset = 0;
    let mut uniffi_frames = Vec::new();
    for (index, size) in chunk_sizes.iter().copied().enumerate() {
        let frame = match uniffi_encryptor.encrypt_frame(plaintext[offset..offset + size].to_vec())
        {
            Ok(frame) => frame,
            Err(error) => panic!("{name}: uniffi should encrypt frame: {error:?}"),
        };
        assert_eq!(
            frame.frame_index,
            must(u32::try_from(index), "frame index fits u32")
        );
        uniffi_frames.push(frame.bytes);
        offset += size;
    }
    let uniffi_envelope = match uniffi_encryptor.finalize() {
        Ok(bytes) => bytes,
        Err(error) => panic!("{name}: uniffi should finalize envelope: {error:?}"),
    };
    let mut wasm_decryptor =
        mosaic_wasm::StreamingShardDecryptor::new(wasm_epoch.handle, uniffi_envelope);
    let mut wasm_decrypted = Vec::new();
    for frame in uniffi_frames {
        let result = wasm_decryptor.decrypt_frame_for_tests(frame);
        assert_ok(result.code, name);
        wasm_decrypted.extend_from_slice(&result.plaintext);
    }
    let finalized = wasm_decryptor.finalize_for_tests();
    assert_ok(finalized.code, name);
    assert_eq!(finalized.bytes, Vec::<u8>::new(), "{name}");
    assert_eq!(wasm_decrypted, plaintext, "{name}");

    close_epoch_handles(&[wasm_epoch.handle, uniffi_epoch.handle]);
    close_account_handles(&[wasm_account, uniffi_account]);
}

pub fn close_identity_handles(handles: &[u64]) {
    for handle in handles {
        let wasm_code = mosaic_wasm::close_identity_handle(*handle);
        if wasm_code != ClientErrorCode::Ok.as_u16()
            && wasm_code != ClientErrorCode::IdentityHandleNotFound.as_u16()
        {
            panic!("unexpected wasm close identity code: {wasm_code}");
        }
        let uniffi_code = mosaic_uniffi::close_identity_handle(*handle);
        if uniffi_code != ClientErrorCode::Ok.as_u16()
            && uniffi_code != ClientErrorCode::IdentityHandleNotFound.as_u16()
        {
            panic!("unexpected uniffi close identity code: {uniffi_code}");
        }
    }
}

pub fn assert_ok(code: u16, context: &str) {
    assert_eq!(code, ClientErrorCode::Ok.as_u16(), "{context}");
}

pub fn assert_ok_u32(code: u32, context: &str) {
    assert_eq!(code, u32::from(ClientErrorCode::Ok.as_u16()), "{context}");
}
