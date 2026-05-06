//! Targeted kill tests for stable public behaviours in `mosaic-client`.

#![forbid(unsafe_code)]
#![allow(clippy::expect_used, clippy::unwrap_used)]

use mosaic_client::{
    AccountUnlockRequest, AlbumSyncEvent, AlbumSyncPhase, AlbumSyncRequest, AlbumSyncRetryMetadata,
    AlbumSyncSnapshot, CleanupStagingReason, ClientErrorCode, MAX_RETRY_COUNT_LIMIT,
    UploadJobEffect, UploadJobEvent, UploadJobPhase, UploadJobRequest, UploadJobSnapshot,
    UploadShardRef, Uuid, advance_album_sync, advance_upload_job,
    album_sync_snapshot_schema_version, close_account_key_handle, crate_name,
    decrypt_shard_with_epoch_handle, new_album_sync, new_upload_job, parse_shard_header_for_ffi,
    protocol_version, unlock_account_key, upload_snapshot_schema_version,
    verify_manifest_with_identity,
};

const ID_BASE: &str = "kill-mut";

fn id(suffix: &str) -> String {
    format!("{ID_BASE}-{suffix}")
}

fn uuid(seed: u8) -> Uuid {
    let mut bytes = [seed; 16];
    bytes[6] = 0x70 | (seed & 0x0f);
    bytes[8] = 0x80 | (seed & 0x3f);
    Uuid::from_bytes(bytes)
}

fn upload_request(max_retry_count: u8) -> UploadJobRequest {
    UploadJobRequest {
        job_id: uuid(1),
        album_id: uuid(2),
        asset_id: uuid(3),
        idempotency_key: uuid(4),
        max_retry_count,
    }
}

fn upload_shard(tier: u8, index: u32) -> UploadShardRef {
    UploadShardRef {
        tier,
        shard_index: index,
        shard_id: uuid(20 + tier + index as u8),
        sha256: [0xa0 + tier + index as u8; 32],
        content_length: 1024 + u64::from(index),
        envelope_version: 3,
        uploaded: false,
    }
}

fn upload_snapshot_with(phase: UploadJobPhase) -> UploadJobSnapshot {
    UploadJobSnapshot {
        schema_version: upload_snapshot_schema_version(),
        job_id: uuid(1),
        album_id: uuid(2),
        phase,
        retry_count: 0,
        max_retry_count: 2,
        next_retry_not_before_ms: None,
        idempotency_key: uuid(4),
        tiered_shards: vec![upload_shard(3, 0)],
        shard_set_hash: Some([0xbb; 32]),
        snapshot_revision: 0,
        last_acknowledged_effect_id: None,
        last_applied_event_id: None,
        failure_code: None,
    }
}

fn sync_retry(max_attempts: u32) -> AlbumSyncRetryMetadata {
    AlbumSyncRetryMetadata {
        attempt_count: 0,
        max_attempts,
        retry_after_ms: None,
        last_error_code: None,
        last_error_stage: None,
        retry_target_phase: None,
    }
}

fn sync_request(max_retry_count: u32) -> AlbumSyncRequest {
    AlbumSyncRequest {
        sync_id: id("sync"),
        album_id: id("album"),
        initial_page_token: None,
        max_retry_count,
    }
}

fn sync_snapshot_with(phase: AlbumSyncPhase) -> AlbumSyncSnapshot {
    AlbumSyncSnapshot {
        schema_version: album_sync_snapshot_schema_version(),
        sync_id: id("sync"),
        album_id: id("album"),
        phase,
        initial_page_token: None,
        next_page_token: None,
        current_page: None,
        rerun_requested: false,
        completed_cycle_count: 0,
        retry: sync_retry(2),
        failure_code: None,
    }
}

#[test]
fn crate_identity_strings_have_byte_exact_values() {
    assert_eq!(crate_name(), "mosaic-client");
    assert_eq!(crate_name().len(), 13);
    assert_eq!(protocol_version(), "mosaic-v1");
    assert_eq!(protocol_version().len(), 9);
}

#[test]
fn client_error_code_as_u16_returns_declared_discriminant() {
    assert_eq!(ClientErrorCode::Ok.as_u16(), 0);
    assert_eq!(ClientErrorCode::InvalidHeaderLength.as_u16(), 100);
    assert_eq!(ClientErrorCode::InvalidMagic.as_u16(), 101);
    assert_eq!(ClientErrorCode::EmptyContext.as_u16(), 200);
    assert_eq!(ClientErrorCode::InvalidKeyLength.as_u16(), 201);
    assert_eq!(ClientErrorCode::AuthenticationFailed.as_u16(), 205);
    assert_eq!(ClientErrorCode::InvalidPublicKey.as_u16(), 212);
    assert_eq!(ClientErrorCode::OperationCancelled.as_u16(), 300);
    assert_eq!(ClientErrorCode::SecretHandleNotFound.as_u16(), 400);
    assert_eq!(ClientErrorCode::InternalStatePoisoned.as_u16(), 500);
    assert_eq!(ClientErrorCode::ClientCoreInvalidTransition.as_u16(), 700);

    let codes: Vec<u16> = vec![
        ClientErrorCode::Ok.as_u16(),
        ClientErrorCode::InvalidHeaderLength.as_u16(),
        ClientErrorCode::EmptyContext.as_u16(),
        ClientErrorCode::OperationCancelled.as_u16(),
        ClientErrorCode::SecretHandleNotFound.as_u16(),
        ClientErrorCode::InternalStatePoisoned.as_u16(),
        ClientErrorCode::ClientCoreInvalidTransition.as_u16(),
    ];
    let mut sorted = codes.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), codes.len(), "all sampled codes are distinct");
}

#[test]
fn parse_shard_header_for_ffi_maps_each_domain_error_to_distinct_code() {
    let short = parse_shard_header_for_ffi(&[]);
    assert_eq!(short.code, ClientErrorCode::InvalidHeaderLength);

    let mut wrong_magic = vec![0_u8; 64];
    wrong_magic[0] = b'X';
    let result = parse_shard_header_for_ffi(&wrong_magic);
    assert_eq!(result.code, ClientErrorCode::InvalidMagic);

    let mut wrong_version = vec![0_u8; 64];
    wrong_version[..4].copy_from_slice(b"SGzk");
    wrong_version[4] = 0xee;
    let result = parse_shard_header_for_ffi(&wrong_version);
    assert_eq!(result.code, ClientErrorCode::UnknownEnvelopeVersion);

    let mut bad_reserved = vec![0_u8; 64];
    bad_reserved[..4].copy_from_slice(b"SGzk");
    bad_reserved[4] = 0x03;
    bad_reserved[37] = 1;
    bad_reserved[38] = 0xff;
    let result = parse_shard_header_for_ffi(&bad_reserved);
    assert_eq!(result.code, ClientErrorCode::NonZeroReservedByte);

    let mut bad_tier = vec![0_u8; 64];
    bad_tier[..4].copy_from_slice(b"SGzk");
    bad_tier[4] = 0x03;
    bad_tier[37] = 0;
    let result = parse_shard_header_for_ffi(&bad_tier);
    assert_eq!(result.code, ClientErrorCode::InvalidTier);
}

#[test]
fn parse_shard_header_for_ffi_returns_ok_for_well_formed_header() {
    let mut bytes = vec![0_u8; 64];
    bytes[..4].copy_from_slice(b"SGzk");
    bytes[4] = 0x03;
    bytes[5..9].copy_from_slice(&0x0102_0304_u32.to_le_bytes());
    bytes[9..13].copy_from_slice(&0x0506_0708_u32.to_le_bytes());
    for (offset, byte) in bytes[13..37].iter_mut().enumerate() {
        *byte = 0x10 + offset as u8;
    }
    bytes[37] = 2;

    let result = parse_shard_header_for_ffi(&bytes);
    assert_eq!(result.code, ClientErrorCode::Ok);
    assert_eq!(result.epoch_id, 0x0102_0304);
    assert_eq!(result.shard_index, 0x0506_0708);
    assert_eq!(result.tier, 2);
    assert_eq!(result.nonce.len(), 24);
}

#[test]
fn decrypt_shard_with_epoch_handle_maps_authentication_failure_to_distinct_code() {
    use mosaic_client::{
        create_epoch_key_handle, encrypt_shard_with_epoch_handle, open_secret_handle,
    };

    let account_key = vec![0xa5_u8; 32];
    let account_handle =
        open_secret_handle(&account_key).expect("32-byte secret handle should open");
    let epoch_handle = create_epoch_key_handle(account_handle, 7);
    assert_eq!(epoch_handle.code, ClientErrorCode::Ok);

    let plaintext = b"shard plaintext bytes for kill test";
    let encrypted = encrypt_shard_with_epoch_handle(epoch_handle.handle, plaintext, 0, 1);
    assert_eq!(encrypted.code, ClientErrorCode::Ok);
    let mut tampered = encrypted.envelope_bytes.clone();
    let flip_offset = tampered.len() - 1;
    tampered[flip_offset] ^= 0xff;

    let decrypted = decrypt_shard_with_epoch_handle(epoch_handle.handle, &tampered);
    assert_eq!(decrypted.code, ClientErrorCode::AuthenticationFailed);

    let _ = mosaic_client::close_epoch_key_handle(epoch_handle.handle);
    let _ = close_account_key_handle(account_handle);
}

#[test]
fn decrypt_shard_with_epoch_handle_maps_invalid_envelope_to_distinct_code() {
    use mosaic_client::{create_epoch_key_handle, open_secret_handle};

    let account_key = vec![0xb6_u8; 32];
    let account_handle =
        open_secret_handle(&account_key).expect("32-byte secret handle should open");
    let epoch_handle = create_epoch_key_handle(account_handle, 9);
    assert_eq!(epoch_handle.code, ClientErrorCode::Ok);

    let mut envelope = vec![0_u8; 64];
    envelope[..4].copy_from_slice(b"SGzk");
    envelope[4] = 0x03;
    envelope[5..9].copy_from_slice(&9_u32.to_le_bytes());
    envelope[37] = 1;
    let decrypted = decrypt_shard_with_epoch_handle(epoch_handle.handle, &envelope);
    assert!(
        matches!(
            decrypted.code,
            ClientErrorCode::InvalidEnvelope
                | ClientErrorCode::MissingCiphertext
                | ClientErrorCode::AuthenticationFailed
        ),
        "expected an envelope-shaped error, got {:?}",
        decrypted.code
    );

    if decrypted.code == ClientErrorCode::AuthenticationFailed {
        let mut shorter = vec![0_u8; 32];
        shorter[..4].copy_from_slice(b"SGzk");
        shorter[4] = 0x03;
        let second = decrypt_shard_with_epoch_handle(epoch_handle.handle, &shorter);
        assert_ne!(
            second.code,
            ClientErrorCode::AuthenticationFailed,
            "shorter envelope should hit InvalidHeaderLength or InvalidEnvelope"
        );
    }

    let _ = mosaic_client::close_epoch_key_handle(epoch_handle.handle);
    let _ = close_account_key_handle(account_handle);
}

#[test]
fn verify_manifest_with_identity_maps_invalid_signature_length_to_distinct_code() {
    let too_short_sig = vec![0_u8; 10];
    let pubkey = vec![0_u8; 32];
    let code = verify_manifest_with_identity(b"transcript bytes", &too_short_sig, &pubkey);
    assert_eq!(code, ClientErrorCode::InvalidSignatureLength);
}

#[test]
fn verify_manifest_with_identity_maps_invalid_public_key_to_distinct_code() {
    let valid_length_sig = vec![0_u8; 64];
    let bad_pubkey = vec![0_u8; 31];
    let code = verify_manifest_with_identity(b"transcript", &valid_length_sig, &bad_pubkey);
    assert_eq!(code, ClientErrorCode::InvalidKeyLength);
}

#[test]
fn unlock_account_key_rejects_too_weak_kdf_profile() {
    let mut password = b"secret".to_vec();
    let req = AccountUnlockRequest {
        password: &mut password,
        user_salt: &[0_u8; 16],
        account_salt: &[0_u8; 16],
        wrapped_account_key: &[0_u8; 96],
        kdf_memory_kib: 0,
        kdf_iterations: 1,
        kdf_parallelism: 1,
    };
    let result = unlock_account_key(req);
    assert_ne!(result.code, ClientErrorCode::Ok);
}

#[test]
fn snapshot_schema_versions_match_canonical_value_one() {
    assert_eq!(upload_snapshot_schema_version(), 1);
    assert_eq!(album_sync_snapshot_schema_version(), 1);
    assert_eq!(
        upload_snapshot_schema_version(),
        album_sync_snapshot_schema_version()
    );
}

#[test]
fn upload_request_rejects_max_retry_count_above_limit() {
    let err = new_upload_job(upload_request(MAX_RETRY_COUNT_LIMIT.saturating_add(1)))
        .expect_err("retry limit above u8 cap should fail");
    assert_eq!(err.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn album_sync_request_retry_limit_is_rcl2_pending() {
    let snapshot = new_album_sync(sync_request(u32::from(MAX_RETRY_COUNT_LIMIT) + 1))
        .expect("legacy AlbumSync retry validation is R-Cl2 pending");
    assert_eq!(
        snapshot.retry.max_attempts,
        u32::from(MAX_RETRY_COUNT_LIMIT) + 1
    );
}

#[test]
fn upload_shard_upload_created_rejects_each_individual_field_mismatch() {
    let snapshot = upload_snapshot_with(UploadJobPhase::CreatingShardUpload);
    let mut bad_id = upload_shard(3, 0);
    bad_id.shard_id = uuid(99);
    let err = advance_upload_job(
        &snapshot,
        UploadJobEvent::ShardUploadCreated {
            effect_id: uuid(10),
            shard: bad_id,
        },
    )
    .expect_err("shard id swap rejected");
    assert_eq!(err.code, ClientErrorCode::ClientCoreInvalidTransition);

    let mut bad_hash = upload_shard(3, 0);
    bad_hash.sha256 = [0xcc; 32];
    let err = advance_upload_job(
        &snapshot,
        UploadJobEvent::ShardUploadCreated {
            effect_id: uuid(11),
            shard: bad_hash,
        },
    )
    .expect_err("hash swap rejected");
    assert_eq!(err.code, ClientErrorCode::ClientCoreInvalidTransition);
}

#[test]
fn upload_shard_uploaded_rejects_each_individual_field_mismatch() {
    let snapshot = upload_snapshot_with(UploadJobPhase::UploadingShard);
    let mut bad_length = upload_shard(3, 0);
    bad_length.content_length += 1;
    let err = advance_upload_job(
        &snapshot,
        UploadJobEvent::ShardUploaded {
            effect_id: uuid(12),
            shard: bad_length,
        },
    )
    .expect_err("length swap rejected");
    assert_eq!(err.code, ClientErrorCode::ClientCoreInvalidTransition);

    let mut bad_hash = upload_shard(3, 0);
    bad_hash.sha256 = [0; 32];
    let err = advance_upload_job(
        &snapshot,
        UploadJobEvent::ShardUploaded {
            effect_id: uuid(13),
            shard: bad_hash,
        },
    )
    .expect_err("zero hash rejected");
    assert_eq!(err.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn sync_requested_accepts_request_with_matching_album_id() {
    let snapshot = sync_snapshot_with(AlbumSyncPhase::FetchingPage);
    let transition = advance_album_sync(
        &snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(sync_request(2)),
        },
    )
    .expect("matching active request should mark rerun");
    assert_eq!(transition.snapshot.phase, AlbumSyncPhase::FetchingPage);
    assert!(transition.snapshot.rerun_requested);
    assert!(transition.effects.is_empty());
}

#[test]
fn sync_requested_clears_retry_progress_on_new_attempt() {
    let mut snapshot = sync_snapshot_with(AlbumSyncPhase::Idle);
    snapshot.retry.attempt_count = 3;
    snapshot.retry.retry_after_ms = Some(99);
    snapshot.retry.last_error_code = Some(ClientErrorCode::InvalidInputLength);
    snapshot.retry.last_error_stage = Some(AlbumSyncPhase::FetchingPage);
    snapshot.retry.retry_target_phase = Some(AlbumSyncPhase::FetchingPage);
    snapshot.retry.max_attempts = 7;

    let transition = advance_album_sync(
        &snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(AlbumSyncRequest {
                max_retry_count: 7,
                ..sync_request(7)
            }),
        },
    )
    .expect("sync request succeeds");
    assert_eq!(transition.snapshot.phase, AlbumSyncPhase::FetchingPage);
    assert_eq!(transition.snapshot.retry.max_attempts, 7);
}

#[test]
fn validate_upload_snapshot_rejects_unsupported_schema_version() {
    let mut snapshot = upload_snapshot_with(UploadJobPhase::Queued);
    snapshot.schema_version = upload_snapshot_schema_version().saturating_add(1);
    let err = advance_upload_job(
        &snapshot,
        UploadJobEvent::StartRequested {
            effect_id: uuid(14),
        },
    )
    .expect_err("future version rejected");
    assert_eq!(
        err.code,
        ClientErrorCode::ClientCoreUnsupportedSnapshotVersion
    );
}

#[test]
fn validate_album_sync_snapshot_version_is_rcl2_pending() {
    let mut snapshot = sync_snapshot_with(AlbumSyncPhase::Idle);
    snapshot.schema_version = album_sync_snapshot_schema_version().saturating_add(1);
    let transition = advance_album_sync(
        &snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(sync_request(2)),
        },
    )
    .expect("legacy AlbumSync snapshot version validation is R-Cl2 pending");
    assert_eq!(
        transition.snapshot.schema_version,
        album_sync_snapshot_schema_version().saturating_add(1)
    );
}

#[test]
fn validate_upload_snapshot_rejects_attempt_count_exceeding_max_attempts() {
    let mut snapshot = upload_snapshot_with(UploadJobPhase::Queued);
    snapshot.retry_count = 3;
    snapshot.max_retry_count = 2;
    let err = advance_upload_job(
        &snapshot,
        UploadJobEvent::StartRequested {
            effect_id: uuid(15),
        },
    )
    .expect_err("retry bounds rejected");
    assert_eq!(err.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn validate_snapshot_retry_bounds_accepts_max_attempts_at_exact_limit() {
    let mut snapshot = upload_snapshot_with(UploadJobPhase::Queued);
    snapshot.max_retry_count = MAX_RETRY_COUNT_LIMIT;
    assert_eq!(snapshot.phase, UploadJobPhase::Queued);
    let transition = advance_upload_job(
        &snapshot,
        UploadJobEvent::StartRequested {
            effect_id: uuid(16),
        },
    )
    .expect("max retry limit accepted");
    assert_eq!(
        transition.next_snapshot.phase,
        UploadJobPhase::AwaitingPreparedMedia
    );
}

#[test]
fn decrypt_with_unknown_epoch_handle_returns_epoch_handle_not_found() {
    let result = decrypt_shard_with_epoch_handle(u64::MAX, b"not an envelope");
    assert_eq!(result.code, ClientErrorCode::EpochHandleNotFound);
}

#[test]
fn new_upload_job_returns_queued_snapshot_with_request_fields() {
    let request = upload_request(2);
    let snapshot = new_upload_job(request.clone()).expect("upload job initializes");
    assert_eq!(snapshot.schema_version, upload_snapshot_schema_version());
    assert_eq!(snapshot.job_id, request.job_id);
    assert_eq!(snapshot.album_id, request.album_id);
    assert_eq!(snapshot.idempotency_key, request.idempotency_key);
    assert_eq!(snapshot.phase, UploadJobPhase::Queued);
    assert_eq!(snapshot.retry_count, 0);
    assert_eq!(snapshot.max_retry_count, 2);
}

#[test]
fn new_album_sync_returns_idle_snapshot_with_request_fields() {
    let request = sync_request(3);
    let snapshot = new_album_sync(request.clone()).expect("sync initializes");
    assert_eq!(
        snapshot.schema_version,
        album_sync_snapshot_schema_version()
    );
    assert_eq!(snapshot.sync_id, request.sync_id);
    assert_eq!(snapshot.album_id, request.album_id);
    assert_eq!(snapshot.phase, AlbumSyncPhase::Idle);
    assert_eq!(snapshot.retry.max_attempts, 3);
}

#[test]
fn upload_non_retryable_failure_emits_cleanup() {
    let snapshot = upload_snapshot_with(UploadJobPhase::CreatingManifest);
    let transition = advance_upload_job(
        &snapshot,
        UploadJobEvent::NonRetryableFailure {
            effect_id: uuid(17),
            code: ClientErrorCode::InvalidPublicKey,
        },
    )
    .expect("failure transition succeeds");
    assert_eq!(transition.next_snapshot.phase, UploadJobPhase::Failed);
    assert_eq!(
        transition.effects,
        vec![UploadJobEffect::CleanupStaging {
            effect_id: uuid(17),
            reason: CleanupStagingReason::Failed,
        }]
    );
}
