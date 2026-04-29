use mosaic_client::ClientErrorCode;
use mosaic_crypto::{KdfProfile, MAX_KDF_MEMORY_KIB, derive_account_key};
use mosaic_domain::{ShardEnvelopeHeader, ShardTier};
use mosaic_uniffi::{
    AccountUnlockRequest, ClientCoreAlbumSyncEffect, ClientCoreAlbumSyncEvent,
    ClientCoreAlbumSyncRequest, ClientCoreAlbumSyncResult, ClientCoreAlbumSyncSnapshot,
    ClientCoreAlbumSyncTransition, ClientCoreAlbumSyncTransitionResult, ClientCoreManifestReceipt,
    ClientCoreUploadJobEffect, ClientCoreUploadJobEvent, ClientCoreUploadJobRequest,
    ClientCoreUploadJobResult, ClientCoreUploadJobSnapshot, ClientCoreUploadJobTransition,
    ClientCoreUploadJobTransitionResult, ClientCoreUploadShardRef, account_key_handle_is_open,
    advance_album_sync, advance_upload_job, android_progress_probe,
    canonical_media_metadata_sidecar_bytes, canonical_metadata_sidecar_bytes,
    client_core_state_machine_snapshot, close_account_key_handle, close_epoch_key_handle,
    close_identity_handle, create_epoch_key_handle, create_identity_handle,
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
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

#[test]
fn uniffi_facade_exposes_stable_ffi_spike_surface() {
    assert_eq!(
        uniffi_api_snapshot(),
        "mosaic-uniffi ffi-spike:v8 protocol_version()->String parse_envelope_header(bytes)->HeaderResult progress(total,cancel_after)->ProgressResult account(unlock/status/close) identity(create/open/close/pubkeys/sign) epoch(create/open/status/close/encrypt/decrypt) metadata(canonical/encrypt,media-canonical/media-encrypt) media(inspect/plan) vectors(crypto-domain)->CryptoDomainGoldenVectorSnapshot client-core(state-machine-snapshot,upload-init/upload-advance,sync-init/sync-advance)"
    );
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
    let upload_snapshot = ClientCoreUploadJobSnapshot {
        schema_version: 1,
        job_id: "job-local-123".to_owned(),
        album_id: "album-local-456".to_owned(),
        asset_id: "asset-local-789".to_owned(),
        epoch_id: 7,
        phase: "AwaitingSyncConfirmation".to_owned(),
        active_tier: 2,
        active_shard_index: 3,
        completed_shards: vec![ClientCoreUploadShardRef {
            tier: 2,
            shard_index: 3,
            shard_id: "shard-ref-3".to_owned(),
            sha256: "sha256-safe-digest".to_owned(),
            uploaded: true,
        }],
        has_manifest_receipt: true,
        manifest_receipt: ClientCoreManifestReceipt {
            manifest_id: "manifest-safe-id".to_owned(),
            manifest_version: 4,
        },
        retry_count: 1,
        max_retry_count: 5,
        next_retry_unix_ms: 1_700_000_000_000,
        last_error_code: 0,
        last_error_stage: String::new(),
        sync_confirmed: false,
        updated_at_unix_ms: 1_700_000_000_001,
    };
    let upload_transition = ClientCoreUploadJobTransition {
        snapshot: upload_snapshot.clone(),
        effects: vec![ClientCoreUploadJobEffect {
            kind: "CreateManifest".to_owned(),
            tier: 0,
            shard_index: 0,
        }],
    };
    let upload_event = ClientCoreUploadJobEvent {
        kind: "ShardUploaded".to_owned(),
        epoch_id: 7,
        tier: 2,
        shard_index: 3,
        shard_id: "shard-ref-3".to_owned(),
        sha256: "sha256-safe-digest".to_owned(),
        manifest_id: String::new(),
        manifest_version: 0,
        observed_asset_id: String::new(),
        retry_after_unix_ms: 0,
        error_code: 0,
    };
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
        observed_asset_ids: vec!["asset-local-789".to_owned()],
        retry_after_unix_ms: 0,
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
fn uniffi_upload_epoch_event_preserves_epoch_id_independently_of_shard_index() {
    let initial = ClientCoreUploadJobSnapshot {
        schema_version: 1,
        job_id: "job-epoch-regression".to_owned(),
        album_id: "album-epoch-regression".to_owned(),
        asset_id: "asset-epoch-regression".to_owned(),
        epoch_id: 0,
        phase: "AwaitingEpochHandle".to_owned(),
        active_tier: 3,
        active_shard_index: 0,
        completed_shards: Vec::new(),
        has_manifest_receipt: false,
        manifest_receipt: ClientCoreManifestReceipt {
            manifest_id: String::new(),
            manifest_version: 0,
        },
        retry_count: 0,
        max_retry_count: 5,
        next_retry_unix_ms: 0,
        last_error_code: 0,
        last_error_stage: String::new(),
        sync_confirmed: false,
        updated_at_unix_ms: 1_700_000_010_000,
    };

    let epoch_ready = advance_upload_job(initial, upload_event("EpochHandleAcquired", 42, 0, 0));

    assert_eq!(epoch_ready.code, 0);
    assert_eq!(epoch_ready.transition.snapshot.epoch_id, 42);
    assert_eq!(epoch_ready.transition.snapshot.active_shard_index, 0);
    assert_eq!(epoch_ready.transition.snapshot.max_retry_count, 5);
}

#[test]
fn uniffi_upload_retry_budget_survives_snapshot_round_trip() {
    let retrying = ClientCoreUploadJobSnapshot {
        schema_version: 1,
        job_id: "job-retry-regression".to_owned(),
        album_id: "album-retry-regression".to_owned(),
        asset_id: "asset-retry-regression".to_owned(),
        epoch_id: 42,
        phase: "RetryWaiting".to_owned(),
        active_tier: 3,
        active_shard_index: 0,
        completed_shards: vec![ClientCoreUploadShardRef {
            tier: 3,
            shard_index: 0,
            shard_id: String::new(),
            sha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
                .to_owned(),
            uploaded: false,
        }],
        has_manifest_receipt: false,
        manifest_receipt: ClientCoreManifestReceipt {
            manifest_id: String::new(),
            manifest_version: 0,
        },
        retry_count: 1,
        max_retry_count: 5,
        next_retry_unix_ms: 1_700_000_020_000,
        last_error_code: ClientErrorCode::InvalidInputLength.as_u16(),
        last_error_stage: "CreatingShardUpload".to_owned(),
        sync_confirmed: false,
        updated_at_unix_ms: 1_700_000_020_000,
    };

    let resumed = advance_upload_job(retrying, upload_event("RetryTimerElapsed", 0, 0, 0));
    assert_eq!(resumed.code, 0);
    assert_eq!(resumed.transition.snapshot.retry_count, 1);
    assert_eq!(resumed.transition.snapshot.max_retry_count, 5);
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
    assert_eq!(result.transition.snapshot.schema_version, 0);
    assert!(result.transition.snapshot.phase.is_empty());
    assert!(result.transition.effects.is_empty());
}

#[test]
fn uniffi_advance_upload_job_rejects_unknown_last_error_code() {
    let mut snapshot = retry_waiting_upload_snapshot();
    snapshot.last_error_code = 4242;

    let result = advance_upload_job(snapshot, upload_event("RetryTimerElapsed", 0, 0, 0));

    assert_eq!(
        result.code,
        ClientErrorCode::ClientCoreInvalidSnapshot.as_u16()
    );
    assert_eq!(result.transition.snapshot.schema_version, 0);
}

#[test]
fn uniffi_advance_upload_job_rejects_unknown_last_error_stage() {
    let mut snapshot = retry_waiting_upload_snapshot();
    snapshot.last_error_stage = "NotAStage".to_owned();

    let result = advance_upload_job(snapshot, upload_event("RetryTimerElapsed", 0, 0, 0));

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

    let result = canonical_metadata_sidecar_bytes(
        [0x11; 16].to_vec(),
        [0x22; 16].to_vec(),
        7,
        encoded,
    );

    assert_eq!(result.code, ClientErrorCode::InvalidInputLength.as_u16());
    assert!(result.bytes.is_empty());
}

#[test]
fn uniffi_metadata_sidecar_accepts_field_value_at_cap() {
    let cap: usize = 64 * 1024;
    let mut encoded = Vec::with_capacity(6 + cap);
    encoded.extend_from_slice(&4_u16.to_le_bytes());
    let cap_u32 = match u32::try_from(cap) {
        Ok(value) => value,
        Err(error) => panic!("cap should fit u32: {error:?}"),
    };
    encoded.extend_from_slice(&cap_u32.to_le_bytes());
    encoded.extend(std::iter::repeat_n(0_u8, cap));

    let result = canonical_metadata_sidecar_bytes(
        [0x11; 16].to_vec(),
        [0x22; 16].to_vec(),
        7,
        encoded,
    );

    assert_eq!(result.code, 0);
    assert!(result.bytes.starts_with(b"Mosaic_Metadata_v1"));
}

fn retry_waiting_upload_snapshot() -> ClientCoreUploadJobSnapshot {
    ClientCoreUploadJobSnapshot {
        schema_version: 1,
        job_id: "job-validation".to_owned(),
        album_id: "album-validation".to_owned(),
        asset_id: "asset-validation".to_owned(),
        epoch_id: 42,
        phase: "RetryWaiting".to_owned(),
        active_tier: 3,
        active_shard_index: 0,
        completed_shards: vec![ClientCoreUploadShardRef {
            tier: 3,
            shard_index: 0,
            shard_id: String::new(),
            sha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
                .to_owned(),
            uploaded: false,
        }],
        has_manifest_receipt: false,
        manifest_receipt: ClientCoreManifestReceipt {
            manifest_id: String::new(),
            manifest_version: 0,
        },
        retry_count: 1,
        max_retry_count: 5,
        next_retry_unix_ms: 1_700_000_020_000,
        last_error_code: ClientErrorCode::InvalidInputLength.as_u16(),
        last_error_stage: "CreatingShardUpload".to_owned(),
        sync_confirmed: false,
        updated_at_unix_ms: 1_700_000_020_000,
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
    epoch_id: u32,
    shard_index: u32,
    error_code: u16,
) -> ClientCoreUploadJobEvent {
    ClientCoreUploadJobEvent {
        kind: kind.to_owned(),
        epoch_id,
        tier: 3,
        shard_index,
        shard_id: String::new(),
        sha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
            .to_owned(),
        manifest_id: String::new(),
        manifest_version: 0,
        observed_asset_id: String::new(),
        retry_after_unix_ms: 0,
        error_code,
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
        kdf_memory_kib: 64 * 1024,
        kdf_iterations: 3,
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
        kdf_iterations: 3,
        kdf_parallelism: 1,
    }
}

fn wrapped_account_key() -> Vec<u8> {
    let profile = match KdfProfile::new(64 * 1024, 3, 1) {
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
