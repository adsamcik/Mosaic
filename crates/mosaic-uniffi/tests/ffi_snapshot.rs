use mosaic_client::ClientErrorCode;
use mosaic_crypto::{
    KdfProfile, MAX_KDF_MEMORY_KIB, MIN_KDF_ITERATIONS, MIN_KDF_MEMORY_KIB, derive_account_key,
};
use mosaic_domain::{ShardEnvelopeHeader, ShardTier};
use mosaic_uniffi::{
    AccountUnlockRequest, ClientCoreAlbumSyncEffect, ClientCoreAlbumSyncEvent,
    ClientCoreAlbumSyncRequest, ClientCoreAlbumSyncResult, ClientCoreAlbumSyncSnapshot,
    ClientCoreAlbumSyncTransition, ClientCoreAlbumSyncTransitionResult, ClientCoreUploadJobEffect,
    ClientCoreUploadJobEvent, ClientCoreUploadJobRequest, ClientCoreUploadJobResult,
    ClientCoreUploadJobSnapshot, ClientCoreUploadJobTransition,
    ClientCoreUploadJobTransitionResult, ClientCoreUploadShardRef, account_key_handle_is_open,
    advance_album_sync, advance_upload_job, android_progress_probe,
    canonical_media_metadata_sidecar_bytes, canonical_metadata_sidecar_bytes,
    canonical_tier_layout, client_core_state_machine_snapshot, close_account_key_handle,
    close_epoch_key_handle, close_identity_handle, create_epoch_key_handle, create_identity_handle,
    crypto_domain_golden_vector_snapshot, decrypt_shard_with_epoch_handle,
    encrypt_media_metadata_sidecar_with_epoch_handle, encrypt_metadata_sidecar_with_epoch_handle,
    encrypt_shard_with_epoch_handle, epoch_key_handle_is_open, identity_encryption_pubkey,
    identity_signing_pubkey, init_album_sync, init_upload_job, inspect_media_image,
    open_epoch_key_handle, open_identity_handle, parse_envelope_header, plan_media_tier_layout,
    protocol_version, sign_manifest_with_identity, uniffi_api_snapshot, unlock_account_key,
};
use zeroize::Zeroizing;

const PASSWORD: &[u8] = b"correct horse battery staple";
const WRONG_PASSWORD: &[u8] = b"wrong horse battery staple";
const USER_SALT: [u8; 16] = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
];
const ACCOUNT_SALT: [u8; 16] = [
    0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff,
];
const MAX_PROGRESS_EVENTS: u32 = 10_000;
const JOB_ID: &str = "018f0000-0000-7000-8000-000000000001";
const ALBUM_ID: &str = "018f0000-0000-7000-8000-000000000002";
const ASSET_ID: &str = "018f0000-0000-7000-8000-000000000003";
const IDEMPOTENCY_KEY: &str = "018f0000-0000-7000-8000-000000000004";
const EFFECT_ID: &str = "018f0000-0000-7000-8000-000000000005";
const SHARD_ID: &str = "018f0000-0000-7000-8000-000000000006";

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

/// Documentation-only smoke check for the historical API changelog string.
/// The authoritative API-shape lock is `tests/api_shape_lock.rs`.
#[test]
fn uniffi_api_snapshot_documents_ffi_spike_surface() {
    let snapshot = uniffi_api_snapshot();
    for expected in [
        "mosaic-uniffi ffi-spike:v10",
        "protocol_version()->String",
        "epoch(create/open/status/close/encrypt/decrypt/legacy-raw-key-decrypt)",
        "cross-client-vectors",
    ] {
        assert!(
            snapshot.contains(expected),
            "documentation changelog should mention {expected}: {snapshot}"
        );
    }
}

/// Late-v1 protocol freeze lock: the version label `ffi-spike:v10` is part of
/// the frozen surface. Bumping it requires an ADR, regenerated bindings, and
/// migration vectors per SPEC-LateV1ProtocolFreeze §"Versioning and freeze
/// gate rules" → "Rust FFI DTOs".
#[test]
fn uniffi_api_snapshot_version_label_is_frozen_at_v10() {
    let snapshot = uniffi_api_snapshot();
    assert!(
        snapshot.starts_with("mosaic-uniffi ffi-spike:v10 "),
        "uniffi_api_snapshot() must begin with `mosaic-uniffi ffi-spike:v10 ` — \
         API surface change requires bumping the version label, adding a migration \
         vector, and updating SPEC-LateV1ProtocolFreeze §Frozen now. Got: {snapshot}"
    );
}

#[test]
fn canonical_tier_layout_matches_rust_media_constants() {
    let layout = canonical_tier_layout();

    assert_eq!(layout.code, ClientErrorCode::Ok.as_u16());
    assert_eq!(layout.thumbnail.tier, ShardTier::Thumbnail.to_byte());
    assert_eq!(
        layout.thumbnail.width,
        mosaic_media::THUMBNAIL_MAX_DIMENSION
    );
    assert_eq!(
        layout.thumbnail.height,
        mosaic_media::THUMBNAIL_MAX_DIMENSION
    );
    assert_eq!(layout.preview.tier, ShardTier::Preview.to_byte());
    assert_eq!(layout.preview.width, mosaic_media::PREVIEW_MAX_DIMENSION);
    assert_eq!(layout.preview.height, mosaic_media::PREVIEW_MAX_DIMENSION);
    assert_eq!(layout.original.tier, ShardTier::Original.to_byte());
    assert_eq!(layout.original.width, mosaic_media::ORIGINAL_MAX_DIMENSION);
    assert_eq!(layout.original.height, mosaic_media::ORIGINAL_MAX_DIMENSION);
}

#[test]
fn uniffi_facade_exposes_client_core_state_machine_surface() {
    let surface = client_core_state_machine_snapshot();

    for expected in [
        "client-core-state-machines:v1",
        "init_upload_job",
        "advance_upload_job",
        "init_album_sync",
        "advance_album_sync",
        "ClientCoreUploadJobRequest",
        "ClientCoreUploadJobSnapshot",
        "ClientCoreUploadJobEvent",
        "ClientCoreUploadJobTransition",
        "ClientCoreAlbumSyncRequest",
        "ClientCoreAlbumSyncSnapshot",
        "ClientCoreAlbumSyncEvent",
        "ClientCoreAlbumSyncTransition",
    ] {
        assert!(
            surface.contains(expected),
            "client-core surface should mention {expected}: {surface}"
        );
    }

    assert_forbidden_client_core_snapshot_terms_absent(&surface);
    assert_forbidden_client_core_snapshot_terms_absent(uniffi_api_snapshot());

    let _init_upload: fn(ClientCoreUploadJobRequest) -> ClientCoreUploadJobResult = init_upload_job;
    let _advance_upload: fn(
        ClientCoreUploadJobSnapshot,
        ClientCoreUploadJobEvent,
    ) -> ClientCoreUploadJobTransitionResult = advance_upload_job;
    let _init_sync: fn(ClientCoreAlbumSyncRequest) -> ClientCoreAlbumSyncResult = init_album_sync;
    let _advance_sync: fn(
        ClientCoreAlbumSyncSnapshot,
        ClientCoreAlbumSyncEvent,
    ) -> ClientCoreAlbumSyncTransitionResult = advance_album_sync;
}

#[test]
fn uniffi_client_core_dtos_keep_persisted_records_privacy_safe() {
    let upload_snapshot = upload_snapshot("AwaitingSyncConfirmation");
    let upload_transition = ClientCoreUploadJobTransition {
        next_snapshot: upload_snapshot.clone(),
        effects: vec![upload_effect("CreateManifest")],
    };
    let upload_event = upload_event("ShardUploaded", 0, 3, 0);
    let sync_snapshot = ClientCoreAlbumSyncSnapshot {
        schema_version: 1,
        album_id: "album-local-456".to_owned(),
        phase: "FetchingPage".to_owned(),
        active_cursor: "cursor-safe".to_owned(),
        pending_cursor: String::new(),
        rerun_requested: false,
        retry_count: 0,
        max_retry_count: 4,
        next_retry_unix_ms: 0,
        last_error_code: 0,
        last_error_stage: String::new(),
        updated_at_unix_ms: 1_700_000_000_002,
    };
    let sync_transition = ClientCoreAlbumSyncTransition {
        snapshot: sync_snapshot.clone(),
        effects: vec![ClientCoreAlbumSyncEffect {
            kind: "FetchPage".to_owned(),
            cursor: "cursor-safe".to_owned(),
        }],
    };
    let sync_event = ClientCoreAlbumSyncEvent {
        kind: "PageApplied".to_owned(),
        fetched_cursor: "cursor-safe".to_owned(),
        next_cursor: "cursor-next".to_owned(),
        applied_count: 2,
        observed_asset_ids: vec![ASSET_ID.to_owned()],
        retry_after_unix_ms: 0,
        has_error_code: false,
        error_code: 0,
    };

    for rendered in [
        format!("{upload_snapshot:?}"),
        format!("{upload_transition:?}"),
        format!("{upload_event:?}"),
        format!("{sync_snapshot:?}"),
        format!("{sync_transition:?}"),
        format!("{sync_event:?}"),
    ] {
        assert_forbidden_client_core_snapshot_terms_absent(&rendered);
    }
}

#[test]
fn uniffi_upload_epoch_event_preserves_shard_cursor_independently_of_effect_id() {
    let initial = upload_snapshot("AwaitingEpochHandle");

    let epoch_ready = advance_upload_job(initial, upload_event("EpochHandleAcquired", 0, 0, 0));

    assert_eq!(epoch_ready.code, 0);
    assert_eq!(
        epoch_ready.transition.next_snapshot.phase,
        "EncryptingShard"
    );
    assert_eq!(epoch_ready.transition.next_snapshot.max_retry_count, 5);
}

#[test]
fn uniffi_upload_retry_budget_survives_snapshot_round_trip() {
    let retrying = retry_waiting_upload_snapshot();

    let resumed = advance_upload_job(retrying, upload_event("RetryTimerElapsed", 0, 0, 0));
    assert_eq!(resumed.code, 0);
    assert_eq!(resumed.transition.next_snapshot.retry_count, 1);
    assert_eq!(resumed.transition.next_snapshot.max_retry_count, 5);
}

#[test]
fn uniffi_init_upload_job_rejects_non_v7_uuid_string() {
    let result = init_upload_job(ClientCoreUploadJobRequest {
        job_id: "00000000-0000-4000-8000-000000000000".to_owned(),
        album_id: ALBUM_ID.to_owned(),
        asset_id: ASSET_ID.to_owned(),
        idempotency_key: IDEMPOTENCY_KEY.to_owned(),
        max_retry_count: 5,
    });

    assert_eq!(
        result.code,
        ClientErrorCode::ClientCoreInvalidSnapshot.as_u16()
    );
}

#[test]
fn uniffi_advance_upload_job_rejects_unknown_phase_string() {
    let mut snapshot = retry_waiting_upload_snapshot();
    snapshot.phase = "DefinitelyNotAPhase".to_owned();

    let result = advance_upload_job(snapshot, upload_event("RetryTimerElapsed", 0, 0, 0));

    assert_eq!(
        result.code,
        ClientErrorCode::ClientCoreInvalidSnapshot.as_u16()
    );
    assert_eq!(result.transition.next_snapshot.schema_version, 0);
    assert!(result.transition.next_snapshot.phase.is_empty());
    assert!(result.transition.effects.is_empty());
}

#[test]
fn uniffi_advance_upload_job_rejects_invalid_last_effect_id() {
    let mut snapshot = retry_waiting_upload_snapshot();
    snapshot.last_applied_event_id = "not-a-uuid".to_owned();

    let result = advance_upload_job(snapshot, upload_event("RetryTimerElapsed", 0, 0, 0));

    assert_eq!(
        result.code,
        ClientErrorCode::ClientCoreInvalidSnapshot.as_u16()
    );
    assert_eq!(result.transition.next_snapshot.schema_version, 0);
}

#[test]
fn uniffi_advance_upload_job_rejects_unknown_retry_target_phase() {
    let snapshot = retry_waiting_upload_snapshot();
    let mut event = upload_event("RetryTimerElapsed", 0, 0, 0);
    event.target_phase = "NotAStage".to_owned();

    let result = advance_upload_job(snapshot, event);

    assert_eq!(
        result.code,
        ClientErrorCode::ClientCoreInvalidSnapshot.as_u16()
    );
}

#[test]
fn uniffi_advance_upload_job_rejects_oversized_schema_version() {
    let mut snapshot = retry_waiting_upload_snapshot();
    snapshot.schema_version = u32::from(u16::MAX) + 1;

    let result = advance_upload_job(snapshot, upload_event("RetryTimerElapsed", 0, 0, 0));

    assert_eq!(
        result.code,
        ClientErrorCode::ClientCoreInvalidSnapshot.as_u16()
    );
}

#[test]
fn uniffi_advance_upload_job_rejects_unknown_event_error_code() {
    let snapshot = retry_waiting_upload_snapshot();
    let event = upload_event("RetryableFailure", 0, 0, 4242);

    let result = advance_upload_job(snapshot, event);

    assert_eq!(
        result.code,
        ClientErrorCode::ClientCoreInvalidSnapshot.as_u16()
    );
    assert!(result.transition.effects.is_empty());
}

#[test]
fn uniffi_advance_upload_job_rejects_unknown_event_error_code_on_non_retryable() {
    let snapshot = retry_waiting_upload_snapshot();
    let event = upload_event("NonRetryableFailure", 0, 0, 4242);

    let result = advance_upload_job(snapshot, event);

    assert_eq!(
        result.code,
        ClientErrorCode::ClientCoreInvalidSnapshot.as_u16()
    );
}

#[test]
fn uniffi_advance_album_sync_accepts_valid_snapshot_and_event() {
    let snapshot = retry_waiting_album_sync_snapshot();
    let event = album_sync_event("RetryTimerElapsed", 0);

    let result = advance_album_sync(snapshot, event);

    assert_eq!(result.code, 0);
    assert_eq!(
        result.transition.snapshot.album_id,
        "album-album-sync-regression"
    );
}

#[test]
fn uniffi_advance_album_sync_rejects_unknown_phase_string() {
    let mut snapshot = retry_waiting_album_sync_snapshot();
    snapshot.phase = "BogusPhase".to_owned();

    let result = advance_album_sync(snapshot, album_sync_event("RetryTimerElapsed", 0));

    assert_eq!(
        result.code,
        ClientErrorCode::ClientCoreInvalidSnapshot.as_u16()
    );
    assert!(result.transition.snapshot.album_id.is_empty());
}

#[test]
fn uniffi_advance_album_sync_rejects_unknown_last_error_code() {
    let mut snapshot = retry_waiting_album_sync_snapshot();
    snapshot.last_error_code = 4242;

    let result = advance_album_sync(snapshot, album_sync_event("RetryTimerElapsed", 0));

    assert_eq!(
        result.code,
        ClientErrorCode::ClientCoreInvalidSnapshot.as_u16()
    );
}

#[test]
fn uniffi_advance_album_sync_rejects_unknown_event_error_code() {
    let snapshot = retry_waiting_album_sync_snapshot();
    let event = album_sync_event("RetryableFailure", 4242);

    let result = advance_album_sync(snapshot, event);

    assert_eq!(
        result.code,
        ClientErrorCode::ClientCoreInvalidSnapshot.as_u16()
    );
}

#[test]
fn uniffi_metadata_sidecar_rejects_oversized_field_value_length() {
    // Encoded layout: tag:u16le | value_len:u32le | value
    // We declare an oversized value_len header without supplying the payload bytes;
    // the cap must trigger before any usize cast or downstream allocation.
    let oversized_len: u32 = (64 * 1024) + 1;
    let mut encoded = Vec::with_capacity(6);
    encoded.extend_from_slice(&1_u16.to_le_bytes());
    encoded.extend_from_slice(&oversized_len.to_le_bytes());

    let result =
        canonical_metadata_sidecar_bytes([0x11; 16].to_vec(), [0x22; 16].to_vec(), 7, encoded);

    assert_eq!(result.code, ClientErrorCode::InvalidInputLength.as_u16());
    assert!(result.bytes.is_empty());
}

#[test]
fn uniffi_metadata_sidecar_accepts_field_value_at_cap() {
    // After R-M5.2.2 tightened MAX_SIDECAR_TOTAL_BYTES from 1.5 MB to 64 KiB,
    // the largest legal value-len is cap - header(59) - tlv_overhead(6) = 65_471.
    let cap: usize = 65_471;
    let mut encoded = Vec::with_capacity(6 + cap);
    encoded.extend_from_slice(&4_u16.to_le_bytes());
    let cap_u32 = match u32::try_from(cap) {
        Ok(value) => value,
        Err(error) => panic!("cap should fit u32: {error:?}"),
    };
    encoded.extend_from_slice(&cap_u32.to_le_bytes());
    encoded.extend(std::iter::repeat_n(0_u8, cap));

    let result =
        canonical_metadata_sidecar_bytes([0x11; 16].to_vec(), [0x22; 16].to_vec(), 7, encoded);

    assert_eq!(result.code, 0);
    assert!(result.bytes.starts_with(b"Mosaic_Metadata_v1"));
}

fn upload_snapshot(phase: &str) -> ClientCoreUploadJobSnapshot {
    ClientCoreUploadJobSnapshot {
        schema_version: 1,
        job_id: JOB_ID.to_owned(),
        album_id: ALBUM_ID.to_owned(),
        phase: phase.to_owned(),
        retry_count: 0,
        max_retry_count: 5,
        next_retry_not_before_ms: 0,
        has_next_retry_not_before_ms: false,
        idempotency_key: IDEMPOTENCY_KEY.to_owned(),
        tiered_shards: vec![upload_shard(false)],
        shard_set_hash: vec![0x22; 32],
        snapshot_revision: 0,
        last_effect_id: String::new(),
        last_acknowledged_effect_id: String::new(),
        last_applied_event_id: String::new(),
        failure_code: 0,
    }
}

fn retry_waiting_upload_snapshot() -> ClientCoreUploadJobSnapshot {
    ClientCoreUploadJobSnapshot {
        phase: "RetryWaiting".to_owned(),
        retry_count: 1,
        next_retry_not_before_ms: 1_700_000_020_000,
        has_next_retry_not_before_ms: true,
        last_effect_id: EFFECT_ID.to_owned(),
        last_applied_event_id: EFFECT_ID.to_owned(),
        ..upload_snapshot("RetryWaiting")
    }
}

fn upload_shard(uploaded: bool) -> ClientCoreUploadShardRef {
    ClientCoreUploadShardRef {
        tier: 3,
        shard_index: 0,
        shard_id: SHARD_ID.to_owned(),
        sha256: vec![0x11; 32],
        content_length: 1024,
        envelope_version: 3,
        uploaded,
    }
}

fn upload_effect(kind: &str) -> ClientCoreUploadJobEffect {
    ClientCoreUploadJobEffect {
        kind: kind.to_owned(),
        effect_id: EFFECT_ID.to_owned(),
        tier: 0,
        shard_index: 0,
        shard_id: String::new(),
        sha256: Vec::new(),
        content_length: 0,
        envelope_version: 0,
        attempt: 0,
        not_before_ms: 0,
        target_phase: String::new(),
        reason: String::new(),
        asset_id: String::new(),
        since_metadata_version: 0,
        idempotency_key: String::new(),
        shard_set_hash: Vec::new(),
    }
}

fn retry_waiting_album_sync_snapshot() -> ClientCoreAlbumSyncSnapshot {
    ClientCoreAlbumSyncSnapshot {
        schema_version: 1,
        album_id: "album-album-sync-regression".to_owned(),
        phase: "RetryWaiting".to_owned(),
        active_cursor: "cursor-validation".to_owned(),
        pending_cursor: String::new(),
        rerun_requested: false,
        retry_count: 1,
        max_retry_count: 5,
        next_retry_unix_ms: 1_700_000_020_000,
        last_error_code: ClientErrorCode::InvalidInputLength.as_u16(),
        last_error_stage: "FetchingPage".to_owned(),
        updated_at_unix_ms: 1_700_000_020_000,
    }
}

fn album_sync_event(kind: &str, error_code: u16) -> ClientCoreAlbumSyncEvent {
    ClientCoreAlbumSyncEvent {
        kind: kind.to_owned(),
        fetched_cursor: String::new(),
        next_cursor: String::new(),
        applied_count: 0,
        observed_asset_ids: Vec::new(),
        retry_after_unix_ms: 0,
        has_error_code: error_code != 0,
        error_code,
    }
}

#[test]
fn uniffi_facade_exports_protocol_version_for_android_bridge_probe() {
    assert_eq!(protocol_version(), "mosaic-v1");
}

#[test]
fn uniffi_identity_facade_returns_stable_error_codes() {
    let create_result = create_identity_handle(u64::MAX);
    assert_eq!(create_result.code, 400);
    assert_eq!(create_result.handle, 0);
    assert!(create_result.signing_pubkey.is_empty());

    let pubkey_result = identity_signing_pubkey(u64::MAX);
    assert_eq!(pubkey_result.code, 401);
    assert!(pubkey_result.bytes.is_empty());

    assert_eq!(close_identity_handle(u64::MAX), 401);
}

#[test]
fn uniffi_account_unlock_facade_returns_stable_codes_and_opaque_handles() {
    let wrapped_account_key = wrapped_account_key();

    let wrong_password_result = unlock_account_key(
        WRONG_PASSWORD.to_vec(),
        unlock_request(wrapped_account_key.clone()),
    );
    assert_eq!(wrong_password_result.code, 205);
    assert_eq!(wrong_password_result.handle, 0);

    let result = unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped_account_key));
    assert_eq!(result.code, 0);
    assert_ne!(result.handle, 0);

    let status = account_key_handle_is_open(result.handle);
    assert_eq!(status.code, 0);
    assert!(status.is_open);

    assert_eq!(close_account_key_handle(result.handle), 0);

    let status = account_key_handle_is_open(result.handle);
    assert_eq!(status.code, 0);
    assert!(!status.is_open);

    assert_eq!(close_account_key_handle(result.handle), 400);
}

#[test]
fn uniffi_epoch_facade_encrypts_decrypts_and_returns_stable_error_codes() {
    let account_result =
        unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped_account_key()));
    assert_eq!(account_result.code, 0);
    assert_ne!(account_result.handle, 0);

    let missing_account = create_epoch_key_handle(u64::MAX, 1);
    assert_eq!(missing_account.code, 400);
    assert_eq!(missing_account.handle, 0);
    assert!(missing_account.wrapped_epoch_seed.is_empty());

    let create_result = create_epoch_key_handle(account_result.handle, 11);
    assert_eq!(create_result.code, 0);
    assert_ne!(create_result.handle, 0);
    assert_eq!(create_result.epoch_id, 11);
    assert_eq!(create_result.wrapped_epoch_seed.len(), 24 + 32 + 16);

    let status = epoch_key_handle_is_open(create_result.handle);
    assert_eq!(status.code, 0);
    assert!(status.is_open);

    let encrypted = encrypt_shard_with_epoch_handle(
        create_result.handle,
        b"ffi-local media bytes".to_vec(),
        4,
        1,
    );
    assert_eq!(encrypted.code, 0);
    assert!(!encrypted.envelope_bytes.is_empty());
    assert!(!encrypted.sha256.is_empty());

    let decrypted = decrypt_shard_with_epoch_handle(create_result.handle, encrypted.envelope_bytes);
    assert_eq!(decrypted.code, 0);
    assert_eq!(decrypted.plaintext, b"ffi-local media bytes");

    let invalid_tier = encrypt_shard_with_epoch_handle(create_result.handle, Vec::new(), 4, 9);
    assert_eq!(invalid_tier.code, 103);
    assert!(invalid_tier.envelope_bytes.is_empty());
    assert!(invalid_tier.sha256.is_empty());

    assert_eq!(close_epoch_key_handle(create_result.handle), 0);

    let status = epoch_key_handle_is_open(create_result.handle);
    assert_eq!(status.code, 0);
    assert!(!status.is_open);

    let open_result = open_epoch_key_handle(
        create_result.wrapped_epoch_seed,
        account_result.handle,
        create_result.epoch_id,
    );
    assert_eq!(open_result.code, 0);
    assert_ne!(open_result.handle, 0);
    assert!(open_result.wrapped_epoch_seed.is_empty());

    assert_eq!(close_epoch_key_handle(open_result.handle), 0);
    assert_eq!(close_epoch_key_handle(open_result.handle), 403);
    assert_eq!(close_account_key_handle(account_result.handle), 0);
}

#[test]
fn uniffi_facade_maps_header_results_without_secret_outputs() {
    let header = ShardEnvelopeHeader::new(21, 22, [9; 24], ShardTier::Original).to_bytes();

    let result = parse_envelope_header(header.to_vec());

    assert_eq!(result.code, 0);
    assert_eq!(result.epoch_id, 21);
    assert_eq!(result.shard_index, 22);
    assert_eq!(result.tier, 3);
    assert_eq!(result.nonce, vec![9; 24]);
}

#[test]
fn uniffi_facade_returns_crypto_domain_golden_vectors_without_secret_outputs() {
    let native = mosaic_client::crypto_domain_golden_vector_snapshot();
    let result = crypto_domain_golden_vector_snapshot();

    assert_eq!(result.code, native.code.as_u16());
    assert_eq!(result.envelope_header, native.envelope_header);
    assert_eq!(result.envelope_epoch_id, native.envelope_epoch_id);
    assert_eq!(result.envelope_shard_index, native.envelope_shard_index);
    assert_eq!(result.envelope_tier, native.envelope_tier);
    assert_eq!(result.envelope_nonce, native.envelope_nonce);
    assert_eq!(result.manifest_transcript, native.manifest_transcript);
    assert_eq!(result.identity_message, native.identity_message);
    assert_eq!(
        result.identity_signing_pubkey,
        native.identity_signing_pubkey
    );
    assert_eq!(
        result.identity_encryption_pubkey,
        native.identity_encryption_pubkey
    );
    assert_eq!(result.identity_signature, native.identity_signature);
    assert!(result.identity_message.is_empty());
    assert_eq!(result.identity_signing_pubkey.len(), 32);
    assert_eq!(result.identity_encryption_pubkey.len(), 32);
    assert_eq!(result.identity_signature.len(), 64);
}

#[test]
fn uniffi_facade_encrypts_canonical_metadata_sidecar_with_epoch_handle() {
    let account_result =
        unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped_account_key()));
    assert_eq!(account_result.code, 0);

    let epoch_result = create_epoch_key_handle(account_result.handle, 42);
    assert_eq!(epoch_result.code, 0);

    let sidecar = canonical_metadata_sidecar_bytes(
        [0x11; 16].to_vec(),
        [0x22; 16].to_vec(),
        epoch_result.epoch_id,
        encoded_metadata_fields(&[(1, &[6, 0]), (4, b"image/jpeg")]),
    );
    assert_eq!(sidecar.code, 0);
    assert!(sidecar.bytes.starts_with(b"Mosaic_Metadata_v1"));

    let encrypted = encrypt_metadata_sidecar_with_epoch_handle(
        epoch_result.handle,
        [0x11; 16].to_vec(),
        [0x22; 16].to_vec(),
        epoch_result.epoch_id,
        encoded_metadata_fields(&[(1, &[6, 0]), (4, b"image/jpeg")]),
        0,
    );
    assert_eq!(encrypted.code, 0);
    assert!(!encrypted.envelope_bytes.is_empty());
    assert!(!encrypted.sha256.is_empty());

    let decrypted = decrypt_shard_with_epoch_handle(epoch_result.handle, encrypted.envelope_bytes);
    assert_eq!(decrypted.code, 0);
    assert!(decrypted.plaintext.starts_with(b"Mosaic_Metadata_v1"));

    let second_encrypted = encrypt_metadata_sidecar_with_epoch_handle(
        epoch_result.handle,
        [0x11; 16].to_vec(),
        [0x22; 16].to_vec(),
        epoch_result.epoch_id,
        encoded_metadata_fields(&[(3, &[1, 0, 0, 0, 2, 0, 0, 0])]),
        7,
    );
    assert_eq!(second_encrypted.code, 0);
    let header = parse_envelope_header(second_encrypted.envelope_bytes[..64].to_vec());
    assert_eq!(header.code, 0);
    assert_eq!(header.epoch_id, 42);
    assert_eq!(header.shard_index, 7);
    assert_eq!(header.tier, 1);

    let invalid = encrypt_metadata_sidecar_with_epoch_handle(
        epoch_result.handle,
        [0x11; 15].to_vec(),
        [0x22; 16].to_vec(),
        epoch_result.epoch_id,
        Vec::new(),
        0,
    );
    assert_eq!(invalid.code, ClientErrorCode::InvalidInputLength.as_u16());
    assert!(invalid.envelope_bytes.is_empty());

    assert_eq!(close_epoch_key_handle(epoch_result.handle), 0);
    assert_eq!(close_account_key_handle(account_result.handle), 0);
}

#[test]
fn uniffi_facade_exposes_media_inspection_and_tier_planning_for_android_bridge() {
    let image = png_bytes(4032, 3024);

    let metadata = inspect_media_image(image);

    assert_eq!(metadata.code, 0);
    assert_eq!(metadata.format, "png");
    assert_eq!(metadata.mime_type, "image/png");
    assert_eq!(metadata.width, 4032);
    assert_eq!(metadata.height, 3024);
    assert_eq!(metadata.orientation, 1);

    let layout = plan_media_tier_layout(metadata.width, metadata.height);
    assert_eq!(layout.code, 0);
    assert_eq!(layout.thumbnail.tier, 1);
    assert_eq!(layout.thumbnail.width, 256);
    assert_eq!(layout.thumbnail.height, 192);
    assert_eq!(layout.preview.tier, 2);
    assert_eq!(layout.preview.width, 1024);
    assert_eq!(layout.preview.height, 768);
    assert_eq!(layout.original.tier, 3);
    assert_eq!(layout.original.width, 4032);
    assert_eq!(layout.original.height, 3024);

    let unsupported = inspect_media_image(b"not an image".to_vec());
    assert_eq!(
        unsupported.code,
        ClientErrorCode::UnsupportedMediaFormat.as_u16()
    );
    assert_eq!(unsupported.format, "");
    assert_eq!(unsupported.width, 0);

    let invalid_layout = plan_media_tier_layout(0, 3024);
    assert_eq!(
        invalid_layout.code,
        ClientErrorCode::InvalidMediaDimensions.as_u16()
    );
    assert_eq!(invalid_layout.original.width, 0);
}

#[test]
fn uniffi_facade_builds_and_encrypts_media_metadata_sidecar_from_inspected_media() {
    let media = png_bytes(1920, 1080);
    let canonical = canonical_media_metadata_sidecar_bytes(
        [0x11; 16].to_vec(),
        [0x22; 16].to_vec(),
        42,
        media.clone(),
    );
    assert_eq!(canonical.code, 0);
    assert!(canonical.bytes.starts_with(b"Mosaic_Metadata_v1"));
    assert!(
        canonical
            .bytes
            .windows(9)
            .any(|window| window == b"image/png")
    );

    let mut dimension_field = Vec::new();
    dimension_field.extend_from_slice(&1920_u32.to_le_bytes());
    dimension_field.extend_from_slice(&1080_u32.to_le_bytes());
    assert!(
        canonical
            .bytes
            .windows(dimension_field.len())
            .any(|window| window == dimension_field.as_slice())
    );
    assert!(
        !canonical
            .bytes
            .windows(PNG_SIGNATURE.len())
            .any(|window| window == PNG_SIGNATURE)
    );

    let account_result =
        unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped_account_key()));
    assert_eq!(account_result.code, 0);
    let epoch_result = create_epoch_key_handle(account_result.handle, 42);
    assert_eq!(epoch_result.code, 0);

    let encrypted = encrypt_media_metadata_sidecar_with_epoch_handle(
        epoch_result.handle,
        [0x11; 16].to_vec(),
        [0x22; 16].to_vec(),
        epoch_result.epoch_id,
        media,
        3,
    );
    assert_eq!(encrypted.code, 0);
    assert!(!encrypted.envelope_bytes.is_empty());
    assert!(!encrypted.sha256.is_empty());

    let decrypted = decrypt_shard_with_epoch_handle(epoch_result.handle, encrypted.envelope_bytes);
    assert_eq!(decrypted.code, 0);
    assert_eq!(decrypted.plaintext, canonical.bytes);

    let invalid_media = canonical_media_metadata_sidecar_bytes(
        [0x11; 16].to_vec(),
        [0x22; 16].to_vec(),
        42,
        b"not an image".to_vec(),
    );
    assert_eq!(
        invalid_media.code,
        ClientErrorCode::UnsupportedMediaFormat.as_u16()
    );
    assert!(invalid_media.bytes.is_empty());

    assert_eq!(close_epoch_key_handle(epoch_result.handle), 0);
    assert_eq!(close_account_key_handle(account_result.handle), 0);
}

#[test]
fn uniffi_facade_returns_progress_events_with_stable_error_code() {
    let result = android_progress_probe(3, Some(1));

    assert_eq!(result.code, 300);
    assert_eq!(result.events.len(), 1);
    assert_eq!(result.events[0].completed_steps, 1);
}

#[test]
fn uniffi_facade_rejects_unbounded_progress_event_requests() {
    let result = android_progress_probe(u32::MAX, None);

    assert_eq!(result.code, 202);
    assert!(result.events.is_empty());
}

#[test]
fn uniffi_facade_propagates_progress_boundary_and_zero_steps() {
    let boundary_error = android_progress_probe(MAX_PROGRESS_EVENTS + 1, None);
    assert_eq!(boundary_error.code, 202);
    assert!(boundary_error.events.is_empty());

    let zero_steps = android_progress_probe(0, None);
    assert_eq!(zero_steps.code, 0);
    assert!(zero_steps.events.is_empty());
}

#[test]
fn uniffi_error_paths_return_zero_handles_and_empty_sensitive_outputs() {
    let invalid_salt = unlock_account_key(
        PASSWORD.to_vec(),
        unlock_request_with(
            vec![0_u8; 24 + 16 + 1],
            vec![0_u8; 15],
            ACCOUNT_SALT.to_vec(),
            64 * 1024,
        ),
    );
    assert_eq!(
        invalid_salt.code,
        ClientErrorCode::InvalidSaltLength.as_u16()
    );
    assert_eq!(invalid_salt.handle, 0);

    let costly_profile = unlock_account_key(
        PASSWORD.to_vec(),
        unlock_request_with(
            vec![0_u8; 24 + 16 + 1],
            USER_SALT.to_vec(),
            ACCOUNT_SALT.to_vec(),
            MAX_KDF_MEMORY_KIB + 1,
        ),
    );
    assert_eq!(
        costly_profile.code,
        ClientErrorCode::KdfProfileTooCostly.as_u16()
    );
    assert_eq!(costly_profile.handle, 0);

    let short_wrapped_key = unlock_account_key(
        PASSWORD.to_vec(),
        unlock_request_with(
            vec![0_u8; 24 + 16],
            USER_SALT.to_vec(),
            ACCOUNT_SALT.to_vec(),
            64 * 1024,
        ),
    );
    assert_eq!(
        short_wrapped_key.code,
        ClientErrorCode::WrappedKeyTooShort.as_u16()
    );
    assert_eq!(short_wrapped_key.handle, 0);

    let missing_identity = create_identity_handle(0);
    assert_eq!(
        missing_identity.code,
        ClientErrorCode::SecretHandleNotFound.as_u16()
    );
    assert_eq!(missing_identity.handle, 0);
    assert!(missing_identity.signing_pubkey.is_empty());
    assert!(missing_identity.encryption_pubkey.is_empty());
    assert!(missing_identity.wrapped_seed.is_empty());

    let missing_open_identity = open_identity_handle(Vec::new(), 0);
    assert_eq!(
        missing_open_identity.code,
        ClientErrorCode::SecretHandleNotFound.as_u16()
    );
    assert_eq!(missing_open_identity.handle, 0);
    assert!(missing_open_identity.signing_pubkey.is_empty());
    assert!(missing_open_identity.encryption_pubkey.is_empty());
    assert!(missing_open_identity.wrapped_seed.is_empty());

    let missing_signing_pubkey = identity_signing_pubkey(0);
    assert_eq!(
        missing_signing_pubkey.code,
        ClientErrorCode::IdentityHandleNotFound.as_u16()
    );
    assert!(missing_signing_pubkey.bytes.is_empty());

    let missing_encryption_pubkey = identity_encryption_pubkey(0);
    assert_eq!(
        missing_encryption_pubkey.code,
        ClientErrorCode::IdentityHandleNotFound.as_u16()
    );
    assert!(missing_encryption_pubkey.bytes.is_empty());

    let missing_signature = sign_manifest_with_identity(0, b"manifest transcript".to_vec());
    assert_eq!(
        missing_signature.code,
        ClientErrorCode::IdentityHandleNotFound.as_u16()
    );
    assert!(missing_signature.bytes.is_empty());

    let missing_epoch = create_epoch_key_handle(0, 99);
    assert_eq!(
        missing_epoch.code,
        ClientErrorCode::SecretHandleNotFound.as_u16()
    );
    assert_eq!(missing_epoch.handle, 0);
    assert_eq!(missing_epoch.epoch_id, 0);
    assert!(missing_epoch.wrapped_epoch_seed.is_empty());

    let missing_open_epoch = open_epoch_key_handle(Vec::new(), 0, 99);
    assert_eq!(
        missing_open_epoch.code,
        ClientErrorCode::SecretHandleNotFound.as_u16()
    );
    assert_eq!(missing_open_epoch.handle, 0);
    assert_eq!(missing_open_epoch.epoch_id, 0);
    assert!(missing_open_epoch.wrapped_epoch_seed.is_empty());

    let missing_encrypt = encrypt_shard_with_epoch_handle(0, b"plaintext".to_vec(), 1, 1);
    assert_eq!(
        missing_encrypt.code,
        ClientErrorCode::EpochHandleNotFound.as_u16()
    );
    assert!(missing_encrypt.envelope_bytes.is_empty());
    assert!(missing_encrypt.sha256.is_empty());

    let missing_decrypt = decrypt_shard_with_epoch_handle(0, b"not parsed first".to_vec());
    assert_eq!(
        missing_decrypt.code,
        ClientErrorCode::EpochHandleNotFound.as_u16()
    );
    assert!(missing_decrypt.plaintext.is_empty());
}

fn upload_event(
    kind: &str,
    _epoch_id: u32,
    shard_index: u32,
    error_code: u16,
) -> ClientCoreUploadJobEvent {
    ClientCoreUploadJobEvent {
        kind: kind.to_owned(),
        effect_id: EFFECT_ID.to_owned(),
        tier: 3,
        shard_index,
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

fn assert_forbidden_client_core_snapshot_terms_absent(rendered: &str) {
    for forbidden in [
        "password",
        "private_key",
        "plaintext",
        "file_uri",
        "picker_uri",
        "filename",
    ] {
        assert!(
            !rendered.to_lowercase().contains(forbidden),
            "client-core snapshot/API surface must not expose forbidden term {forbidden}: {rendered}"
        );
    }
}

fn unlock_request(wrapped_account_key: Vec<u8>) -> AccountUnlockRequest {
    AccountUnlockRequest {
        user_salt: USER_SALT.to_vec(),
        account_salt: ACCOUNT_SALT.to_vec(),
        wrapped_account_key,
        kdf_memory_kib: MIN_KDF_MEMORY_KIB,
        kdf_iterations: MIN_KDF_ITERATIONS,
        kdf_parallelism: 1,
    }
}

fn unlock_request_with(
    wrapped_account_key: Vec<u8>,
    user_salt: Vec<u8>,
    account_salt: Vec<u8>,
    kdf_memory_kib: u32,
) -> AccountUnlockRequest {
    AccountUnlockRequest {
        user_salt,
        account_salt,
        wrapped_account_key,
        kdf_memory_kib,
        kdf_iterations: MIN_KDF_ITERATIONS,
        kdf_parallelism: 1,
    }
}

fn wrapped_account_key() -> Vec<u8> {
    let profile = match KdfProfile::new(MIN_KDF_MEMORY_KIB, MIN_KDF_ITERATIONS, 1) {
        Ok(value) => value,
        Err(error) => panic!("minimum Mosaic profile should be valid: {error:?}"),
    };
    let material = match derive_account_key(
        Zeroizing::new(PASSWORD.to_vec()),
        &USER_SALT,
        &ACCOUNT_SALT,
        profile,
    ) {
        Ok(value) => value,
        Err(error) => panic!("account key should derive: {error:?}"),
    };
    material.wrapped_account_key
}

fn encoded_metadata_fields(fields: &[(u16, &[u8])]) -> Vec<u8> {
    let mut encoded = Vec::new();
    for (tag, value) in fields {
        encoded.extend_from_slice(&tag.to_le_bytes());
        encoded.extend_from_slice(&(value.len() as u32).to_le_bytes());
        encoded.extend_from_slice(value);
    }
    encoded
}

fn png_bytes(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = PNG_SIGNATURE.to_vec();
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    bytes.extend_from_slice(&(ihdr.len() as u32).to_be_bytes());
    bytes.extend_from_slice(b"IHDR");
    bytes.extend_from_slice(&ihdr);
    bytes.extend_from_slice(&[0, 0, 0, 0]);
    bytes
}

// =============================================================================
// Download orchestrator UniFFI round-trip tests (Phase 4 / commit a4337db).
//
// These tests exercise the download bindings end-to-end through the UniFFI
// surface and assert byte-identity round-trips and snapshot validation
// behavior. They intentionally do not call into mosaic-wasm; the canonical
// CBOR byte format is locked across wrappers via
// `tests/parser_equivalence.rs::duplicated_download_codec_helpers_are_source_equivalent`.
// =============================================================================

mod download_round_trip {
    use mosaic_client::ClientErrorCode;
    use mosaic_domain::ShardTier;
    use mosaic_uniffi::{
        DownloadInitInput, DownloadPlanEntryInput, DownloadPlanInput, DownloadPlanShardInput,
        apply_download_event, build_download_plan, commit_download_snapshot, init_download_job,
        load_download_snapshot, verify_download_snapshot,
    };

    const JOB_ID: [u8; 16] = [0x1a; 16];
    const ALBUM_ID: [u8; 16] = [0x2b; 16];
    const SHARD_ID: [u8; 16] = [0x3c; 16];
    const EXPECTED_HASH: [u8; 32] = [0x4d; 32];

    fn sample_plan_input() -> DownloadPlanInput {
        DownloadPlanInput {
            album_id: ALBUM_ID.to_vec(),
            entries: vec![DownloadPlanEntryInput {
                photo_id: "photo-001".to_owned(),
                filename: "vacation.jpg".to_owned(),
                shards: vec![DownloadPlanShardInput {
                    shard_id: SHARD_ID.to_vec(),
                    epoch_id: 7,
                    tier: ShardTier::Original.to_byte(),
                    expected_hash: EXPECTED_HASH.to_vec(),
                    declared_size: 4096,
                }],
            }],
        }
    }

    fn sample_init_input(plan_cbor: Vec<u8>) -> DownloadInitInput {
        DownloadInitInput {
            job_id: JOB_ID.to_vec(),
            album_id: ALBUM_ID.to_vec(),
            plan_cbor,
            now_ms: 1_700_000_000_000,
        }
    }

    #[test]
    fn build_plan_then_init_commit_verify_load_round_trips_byte_identically() {
        let plan = build_download_plan(sample_plan_input());
        assert_eq!(plan.code, ClientErrorCode::Ok.as_u16());
        assert!(plan.error_detail.is_none());
        assert!(!plan.plan_cbor.is_empty());

        let init = init_download_job(sample_init_input(plan.plan_cbor.clone()));
        assert_eq!(init.code, ClientErrorCode::Ok.as_u16());
        assert_eq!(init.checksum.len(), 32);
        assert!(!init.body.is_empty());

        // commit_download_snapshot re-encodes the canonical body and recomputes
        // the checksum. For a freshly-prepared snapshot the bytes must match.
        let commit = commit_download_snapshot(init.body.clone());
        assert_eq!(commit.code, ClientErrorCode::Ok.as_u16());
        assert_eq!(commit.body, init.body);
        assert_eq!(commit.checksum, init.checksum);

        // verify_download_snapshot returns valid=true for matching checksum,
        // valid=false for mismatched, and never branches on the raw bytes.
        let verify = verify_download_snapshot(init.body.clone(), init.checksum.clone());
        assert_eq!(verify.code, ClientErrorCode::Ok.as_u16());
        assert!(verify.valid);

        let mut bad_checksum = init.checksum.clone();
        bad_checksum[0] ^= 0xff;
        let verify_bad = verify_download_snapshot(init.body.clone(), bad_checksum);
        assert_eq!(verify_bad.code, ClientErrorCode::Ok.as_u16());
        assert!(!verify_bad.valid);

        // load_download_snapshot validates the checksum, decodes, and returns a
        // canonical re-encoding equal to the input body.
        let loaded = load_download_snapshot(init.body.clone(), init.checksum.clone());
        assert_eq!(loaded.code, ClientErrorCode::Ok.as_u16());
        assert_eq!(loaded.snapshot_cbor, init.body);
        assert_eq!(
            loaded.schema_version_loaded,
            mosaic_client::download::snapshot::CURRENT_DOWNLOAD_SNAPSHOT_SCHEMA_VERSION
        );
    }

    #[test]
    fn load_download_snapshot_rejects_corrupt_checksum() {
        let plan = build_download_plan(sample_plan_input());
        let init = init_download_job(sample_init_input(plan.plan_cbor));
        let mut bad_checksum = init.checksum.clone();
        bad_checksum[31] ^= 0x01;

        let loaded = load_download_snapshot(init.body, bad_checksum);
        assert_eq!(
            loaded.code,
            ClientErrorCode::DownloadSnapshotChecksumMismatch.as_u16()
        );
        assert!(loaded.snapshot_cbor.is_empty());
        assert_eq!(loaded.schema_version_loaded, 0);
    }

    #[test]
    fn load_download_snapshot_rejects_short_checksum() {
        let plan = build_download_plan(sample_plan_input());
        let init = init_download_job(sample_init_input(plan.plan_cbor));

        let loaded = load_download_snapshot(init.body, vec![0_u8; 16]);
        assert_eq!(
            loaded.code,
            ClientErrorCode::DownloadSnapshotCorrupt.as_u16()
        );
    }

    #[test]
    fn verify_download_snapshot_rejects_short_checksum_without_panicking() {
        let plan = build_download_plan(sample_plan_input());
        let init = init_download_job(sample_init_input(plan.plan_cbor));

        let verify = verify_download_snapshot(init.body, vec![0_u8; 16]);
        assert_eq!(verify.code, ClientErrorCode::Ok.as_u16());
        assert!(!verify.valid);
    }

    #[test]
    fn build_download_plan_rejects_non_original_tier_with_disallowed_tier_detail() {
        let mut input = sample_plan_input();
        input.entries[0].shards[0].tier = ShardTier::Thumbnail.to_byte();

        let plan = build_download_plan(input);
        assert_eq!(plan.code, ClientErrorCode::DownloadInvalidPlan.as_u16());
        let detail = plan.error_detail.unwrap_or_default();
        assert!(
            detail.starts_with("DisallowedTier:"),
            "expected DisallowedTier detail, got {detail:?}"
        );
        assert!(plan.plan_cbor.is_empty());
    }

    #[test]
    fn build_download_plan_rejects_multi_epoch_photo() {
        let mut input = sample_plan_input();
        input.entries[0].shards.push(DownloadPlanShardInput {
            shard_id: vec![0x77_u8; 16],
            epoch_id: 99,
            tier: ShardTier::Original.to_byte(),
            expected_hash: vec![0x88_u8; 32],
            declared_size: 1,
        });

        let plan = build_download_plan(input);
        assert_eq!(plan.code, ClientErrorCode::DownloadInvalidPlan.as_u16());
        let detail = plan.error_detail.unwrap_or_default();
        assert!(
            detail.starts_with("MultiEpochPhoto:"),
            "expected MultiEpochPhoto detail, got {detail:?}"
        );
    }

    #[test]
    fn build_download_plan_rejects_unknown_tier_byte() {
        let mut input = sample_plan_input();
        input.entries[0].shards[0].tier = 99;

        let plan = build_download_plan(input);
        assert_eq!(plan.code, ClientErrorCode::DownloadInvalidPlan.as_u16());
        assert!(plan.plan_cbor.is_empty());
    }

    #[test]
    fn build_download_plan_rejects_short_shard_id() {
        let mut input = sample_plan_input();
        input.entries[0].shards[0].shard_id = vec![0_u8; 8];

        let plan = build_download_plan(input);
        assert_eq!(plan.code, ClientErrorCode::InvalidInputLength.as_u16());
    }

    #[test]
    fn build_download_plan_rejects_short_expected_hash() {
        let mut input = sample_plan_input();
        input.entries[0].shards[0].expected_hash = vec![0_u8; 16];

        let plan = build_download_plan(input);
        assert_eq!(plan.code, ClientErrorCode::InvalidInputLength.as_u16());
    }

    #[test]
    fn build_download_plan_normalizes_filenames_for_windows_reserved_names() {
        let mut input = sample_plan_input();
        input.entries[0].filename = "CON.JPG".to_owned();
        let plan = build_download_plan(input);
        assert_eq!(plan.code, ClientErrorCode::Ok.as_u16());
        // Decode the plan CBOR and confirm filename was disambiguated.
        let value: ciborium::value::Value =
            match ciborium::de::from_reader::<ciborium::value::Value, _>(std::io::Cursor::new(&plan.plan_cbor)) {
                Ok(value) => value,
                Err(_) => panic!("plan_cbor must be valid CBOR"),
            };
        let entries = match &value {
            ciborium::value::Value::Array(items) => items,
            _ => panic!("plan_cbor must be a CBOR array"),
        };
        let fields = match &entries[0] {
            ciborium::value::Value::Map(fields) => fields,
            _ => panic!("plan entry must be a CBOR map"),
        };
        let filename = fields
            .iter()
            .find_map(|(k, v)| {
                let key = k.as_integer().and_then(|i| u32::try_from(i).ok())?;
                if key == 5 {
                    match v {
                        ciborium::value::Value::Text(text) => Some(text.clone()),
                        _ => None,
                    }
                } else {
                    None
                }
            })
            .unwrap_or_else(|| panic!("plan entry must have a filename field"));
        assert_ne!(filename, "CON.JPG", "Windows-reserved name must be disambiguated");
        assert!(filename.to_uppercase().starts_with("CON_"));
    }

    #[test]
    fn init_download_job_rejects_short_job_id() {
        let plan = build_download_plan(sample_plan_input());
        let init = init_download_job(DownloadInitInput {
            job_id: vec![0_u8; 8],
            album_id: ALBUM_ID.to_vec(),
            plan_cbor: plan.plan_cbor,
            now_ms: 0,
        });
        assert_eq!(init.code, ClientErrorCode::InvalidInputLength.as_u16());
    }

    #[test]
    fn init_download_job_rejects_corrupt_plan_cbor() {
        let init = init_download_job(DownloadInitInput {
            job_id: JOB_ID.to_vec(),
            album_id: ALBUM_ID.to_vec(),
            plan_cbor: vec![0xff_u8, 0x00, 0x42],
            now_ms: 0,
        });
        assert_eq!(
            init.code,
            ClientErrorCode::DownloadSnapshotCorrupt.as_u16()
        );
        assert!(init.body.is_empty());
        assert!(init.checksum.is_empty());
    }

    #[test]
    fn apply_download_event_idle_to_preparing_round_trip() {
        // Encode the Idle state and a StartRequested event using ciborium with
        // the same canonical layout the wrappers use, then assert the new
        // state CBOR is a valid `Preparing` encoding.
        use ciborium::value::{Integer, Value};
        let idle_state = Value::Map(vec![(
            Value::Integer(Integer::from(0_u32)),
            Value::Integer(Integer::from(0_u32)),
        )]);
        let mut idle_bytes = Vec::new();
        ciborium::ser::into_writer(&idle_state, &mut idle_bytes).unwrap_or_else(|_| {
            panic!("ciborium serialization of canonical Idle state must succeed")
        });

        let start_event = Value::Map(vec![
            (
                Value::Integer(Integer::from(0_u32)),
                Value::Integer(Integer::from(0_u32)),
            ),
            (
                Value::Integer(Integer::from(1_u32)),
                Value::Bytes(JOB_ID.to_vec()),
            ),
            (
                Value::Integer(Integer::from(2_u32)),
                Value::Bytes(ALBUM_ID.to_vec()),
            ),
        ]);
        let mut event_bytes = Vec::new();
        ciborium::ser::into_writer(&start_event, &mut event_bytes).unwrap_or_else(|_| {
            panic!("ciborium serialization of canonical StartRequested event must succeed")
        });

        let result = apply_download_event(idle_bytes, event_bytes);
        assert_eq!(result.code, ClientErrorCode::Ok.as_u16());
        assert!(!result.new_state_cbor.is_empty());

        // Decode the result and confirm the state code is PREPARING (=1).
        let decoded: Value =
            match ciborium::de::from_reader::<Value, _>(std::io::Cursor::new(&result.new_state_cbor)) {
                Ok(value) => value,
                Err(_) => panic!("new_state_cbor must be valid CBOR"),
            };
        let entries = match decoded {
            Value::Map(entries) => entries,
            _ => panic!("state must be a CBOR map"),
        };
        let code = entries
            .into_iter()
            .find_map(|(k, v)| {
                k.as_integer()
                    .and_then(|i| u32::try_from(i).ok())
                    .filter(|key| *key == 0)
                    .and_then(|_| v.as_integer())
                    .and_then(|i| u8::try_from(i).ok())
            })
            .unwrap_or_else(|| panic!("state map must have key 0"));
        assert_eq!(code, 1, "Idle + StartRequested must transition to Preparing (=1)");
    }

    #[test]
    fn apply_download_event_rejects_illegal_transition() {
        use ciborium::value::{Integer, Value};
        // Done state (=5) + ResumeRequested event (=3) is illegal.
        let done_state = Value::Map(vec![(
            Value::Integer(Integer::from(0_u32)),
            Value::Integer(Integer::from(5_u32)),
        )]);
        let mut state_bytes = Vec::new();
        if ciborium::ser::into_writer(&done_state, &mut state_bytes).is_err() {
            panic!("encode state");
        }

        let resume_event = Value::Map(vec![(
            Value::Integer(Integer::from(0_u32)),
            Value::Integer(Integer::from(3_u32)),
        )]);
        let mut event_bytes = Vec::new();
        if ciborium::ser::into_writer(&resume_event, &mut event_bytes).is_err() {
            panic!("encode event");
        }

        let result = apply_download_event(state_bytes, event_bytes);
        assert_eq!(
            result.code,
            ClientErrorCode::DownloadIllegalTransition.as_u16()
        );
        assert!(result.new_state_cbor.is_empty());
    }
}
