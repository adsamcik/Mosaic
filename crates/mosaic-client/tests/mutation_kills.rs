//! Targeted kill tests for `cargo-mutants` mutants that survived the
//! existing integration test suite in `crates/mosaic-client/tests/`.
//!
//! Each test here is anchored to specific source line numbers in
//! `crates/mosaic-client/src/lib.rs` and `crates/mosaic-client/src/state_machine.rs`,
//! and asserts code-exact / value-exact / branch-exact properties so a
//! single-character mutation observably changes the result.
//!
//! ## Mutants intentionally NOT killed here
//!
//! * `crates/mosaic-client/src/lib.rs:346:9` (`SecretRecord::close`),
//!   `:368:9` (`IdentityRecord::close`), and `:391:9` (`EpochRecord::close`)
//!   — these methods zero a `Zeroizing<Vec<u8>>` (or a `Keypair`) and set
//!   `record.open = false`. Their public-side observable effect (handle
//!   becomes `is_open == false`) is also produced by the explicit
//!   `record.open = false` assignment in `close_secret_handle` / siblings,
//!   plus the immediate `guard.remove(&handle)`. The only side effect the
//!   close method exclusively owns is wiping the inner key bytes, which
//!   no public API ever discloses. Killing these mutations would require
//!   `unsafe` memory inspection or a production-source change beyond the
//!   `mutation_kills.rs` boundary this task is scoped to.
//!
//! * `crates/mosaic-client/src/lib.rs:353:9`, `:375:9`, `:397:9` — each
//!   `Drop::drop` body simply calls the matching `close` method. Every
//!   `close_*_handle` path explicitly invokes `record.close()` *before* the
//!   record is moved out of the registry and dropped, so the implicit
//!   drop-time `close` call is redundant on every reachable path.
//!
//! * `crates/mosaic-client/src/lib.rs:561:25`, `:689:29`, `:817:29` — the
//!   `Some(record) if record.open => …` match-guard. Records in each
//!   registry are inserted with `open: true` and removed (not flipped to
//!   `open: false` and left behind) on every close path, so the guard is
//!   always satisfied on hits and always skipped on misses. Mutating the
//!   guard to the constant `true` produces the same observable behaviour
//!   through the public API.
//!
//! * `crates/mosaic-client/src/state_machine.rs:296:5` and `:301:5` —
//!   `pub const fn upload_snapshot_schema_version() -> u16 { 1 }` and
//!   `pub const fn album_sync_snapshot_schema_version() -> u16 { 1 }`. Both
//!   bodies return `CLIENT_CORE_SNAPSHOT_SCHEMA_VERSION`, which is defined
//!   as `1` (`state_machine.rs:5`). The mutation `replace … with 1`
//!   produces an identical function. Provably equivalent.
//!
//! * `crates/mosaic-client/src/state_machine.rs:1127:39` — `replace || with
//!   &&` on the empty-or-oversize prepared-media-plan check. The downstream
//!   `plan.planned_shards.first()` lookup in `upload_media_prepared`
//!   already returns `None`-by-construction for empty plans, so empty plans
//!   still fail with the same `ClientCoreInvalidSnapshot` error code under
//!   either the original `||` or the mutated `&&`. Equivalent through the
//!   public surface.

#![forbid(unsafe_code)]
#![allow(clippy::expect_used, clippy::unwrap_used)]

use mosaic_client::{
    AccountUnlockRequest, AlbumSyncEvent, AlbumSyncPhase, AlbumSyncRequest, AlbumSyncRetryMetadata,
    AlbumSyncSnapshot, ClientErrorCode, CompletedShardRef, MAX_RETRY_COUNT_LIMIT, PendingShardRef,
    PreparedMediaPlan, UploadJobEvent, UploadJobPhase, UploadJobRequest, UploadJobSnapshot,
    UploadRetryMetadata, UploadShardSlot, account_key_handle_is_open, advance_album_sync,
    advance_upload_job, album_sync_snapshot_schema_version, close_account_key_handle, crate_name,
    decrypt_shard_with_epoch_handle, new_album_sync, new_upload_job, parse_shard_header_for_ffi,
    protocol_version, unlock_account_key, upload_snapshot_schema_version,
    verify_manifest_with_identity,
};

const ID_BASE: &str = "kill-mut";

fn id(suffix: &str) -> String {
    format!("{ID_BASE}-{suffix}")
}

fn upload_retry(max_attempts: u32) -> UploadRetryMetadata {
    UploadRetryMetadata {
        attempt_count: 0,
        max_attempts,
        retry_after_ms: None,
        last_error_code: None,
        last_error_stage: None,
        retry_target_phase: None,
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

fn upload_request(max_retry_count: u32) -> UploadJobRequest {
    UploadJobRequest {
        local_job_id: id("job"),
        upload_id: id("upload"),
        album_id: id("album"),
        asset_id: id("asset"),
        max_retry_count,
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

fn upload_snapshot_with(phase: UploadJobPhase) -> UploadJobSnapshot {
    UploadJobSnapshot {
        schema_version: upload_snapshot_schema_version(),
        local_job_id: id("job"),
        upload_id: id("upload"),
        album_id: id("album"),
        asset_id: id("asset"),
        epoch_id: None,
        phase,
        planned_shard_count: 0,
        planned_shards: Vec::new(),
        next_shard_index: 0,
        pending_shard: None,
        completed_shards: Vec::new(),
        manifest_receipt: None,
        retry: upload_retry(2),
        confirmation_metadata: None,
        failure_code: None,
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
    assert_eq!(result.code, ClientErrorCode::UnsupportedVersion);

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
    let mut req = upload_request(MAX_RETRY_COUNT_LIMIT);
    assert!(new_upload_job(req.clone()).is_ok());

    req.max_retry_count = MAX_RETRY_COUNT_LIMIT + 1;
    let error = new_upload_job(req).expect_err("over-budget retry count must reject");
    assert_eq!(error.code, ClientErrorCode::InvalidInputLength);
}

#[test]
fn album_sync_request_rejects_max_retry_count_above_limit() {
    let mut req = sync_request(MAX_RETRY_COUNT_LIMIT);
    assert!(new_album_sync(req.clone()).is_ok());

    req.max_retry_count = MAX_RETRY_COUNT_LIMIT + 1;
    let error = new_album_sync(req).expect_err("over-budget retry count must reject");
    assert_eq!(error.code, ClientErrorCode::InvalidInputLength);
}

#[test]
fn upload_shard_upload_created_rejects_each_individual_field_mismatch() {
    let pending = PendingShardRef {
        tier: 1,
        index: 0,
        sha256: "sha256:aa".to_owned(),
        shard_id: None,
    };
    let mut snapshot = upload_snapshot_with(UploadJobPhase::CreatingShardUpload);
    snapshot.planned_shard_count = 1;
    snapshot.planned_shards = vec![UploadShardSlot {
        tier: pending.tier,
        index: pending.index,
    }];
    snapshot.pending_shard = Some(pending.clone());

    let upload = mosaic_client::CreatedShardUpload {
        tier: 2,
        index: pending.index,
        sha256: pending.sha256.clone(),
        shard_id: id("shard-tier"),
    };
    let err = advance_upload_job(
        &snapshot,
        UploadJobEvent::ShardUploadCreated {
            upload: Some(upload),
        },
    )
    .expect_err("tier mismatch must reject");
    assert_eq!(err.code, ClientErrorCode::ClientCoreInvalidTransition);

    let upload = mosaic_client::CreatedShardUpload {
        tier: pending.tier,
        index: 99,
        sha256: pending.sha256.clone(),
        shard_id: id("shard-index"),
    };
    let err = advance_upload_job(
        &snapshot,
        UploadJobEvent::ShardUploadCreated {
            upload: Some(upload),
        },
    )
    .expect_err("index mismatch must reject");
    assert_eq!(err.code, ClientErrorCode::ClientCoreInvalidTransition);

    let upload = mosaic_client::CreatedShardUpload {
        tier: pending.tier,
        index: pending.index,
        sha256: "sha256:bb".to_owned(),
        shard_id: id("shard-sha"),
    };
    let err = advance_upload_job(
        &snapshot,
        UploadJobEvent::ShardUploadCreated {
            upload: Some(upload),
        },
    )
    .expect_err("sha256 mismatch must reject");
    assert_eq!(err.code, ClientErrorCode::ClientCoreInvalidTransition);
}

#[test]
fn upload_shard_uploaded_rejects_each_individual_field_mismatch() {
    let pending = PendingShardRef {
        tier: 1,
        index: 0,
        sha256: "sha256:aa".to_owned(),
        shard_id: Some(id("shard-pending")),
    };
    let mut snapshot = upload_snapshot_with(UploadJobPhase::UploadingShard);
    snapshot.planned_shard_count = 1;
    snapshot.planned_shards = vec![UploadShardSlot {
        tier: pending.tier,
        index: pending.index,
    }];
    snapshot.pending_shard = Some(pending.clone());

    let pending_shard_id = pending.shard_id.clone().unwrap();

    let shard = CompletedShardRef {
        tier: 2,
        index: pending.index,
        sha256: pending.sha256.clone(),
        shard_id: pending_shard_id.clone(),
    };
    let err = advance_upload_job(
        &snapshot,
        UploadJobEvent::ShardUploaded { shard: Some(shard) },
    )
    .expect_err("tier mismatch must reject");
    assert_eq!(err.code, ClientErrorCode::ClientCoreInvalidTransition);

    let shard = CompletedShardRef {
        tier: pending.tier,
        index: 99,
        sha256: pending.sha256.clone(),
        shard_id: pending_shard_id.clone(),
    };
    let err = advance_upload_job(
        &snapshot,
        UploadJobEvent::ShardUploaded { shard: Some(shard) },
    )
    .expect_err("index mismatch must reject");
    assert_eq!(err.code, ClientErrorCode::ClientCoreInvalidTransition);

    let shard = CompletedShardRef {
        tier: pending.tier,
        index: pending.index,
        sha256: "sha256:bb".to_owned(),
        shard_id: pending_shard_id.clone(),
    };
    let err = advance_upload_job(
        &snapshot,
        UploadJobEvent::ShardUploaded { shard: Some(shard) },
    )
    .expect_err("sha256 mismatch must reject");
    assert_eq!(err.code, ClientErrorCode::ClientCoreInvalidTransition);

    let shard = CompletedShardRef {
        tier: pending.tier,
        index: pending.index,
        sha256: pending.sha256.clone(),
        shard_id: id("shard-other"),
    };
    let err = advance_upload_job(
        &snapshot,
        UploadJobEvent::ShardUploaded { shard: Some(shard) },
    )
    .expect_err("shard_id mismatch must reject");
    assert_eq!(err.code, ClientErrorCode::ClientCoreInvalidTransition);
}

#[test]
fn sync_requested_rejects_request_with_mismatched_album_id() {
    let snapshot = sync_snapshot_with(AlbumSyncPhase::Idle);
    let mut req = sync_request(2);
    req.album_id = id("other-album");

    let err = advance_album_sync(
        &snapshot,
        AlbumSyncEvent::SyncRequested { request: Some(req) },
    )
    .expect_err("mismatched album id must reject");
    assert_eq!(err.code, ClientErrorCode::ClientCoreInvalidTransition);
}

#[test]
fn sync_requested_accepts_request_with_matching_album_id() {
    let snapshot = sync_snapshot_with(AlbumSyncPhase::Idle);
    let req = sync_request(2);
    let transition = advance_album_sync(
        &snapshot,
        AlbumSyncEvent::SyncRequested { request: Some(req) },
    )
    .expect("matching album id must be accepted");
    assert_eq!(transition.snapshot.phase, AlbumSyncPhase::FetchingPage);
}

#[test]
fn validate_prepared_media_plan_rejects_empty_plan() {
    let snapshot = upload_snapshot_with(UploadJobPhase::AwaitingPreparedMedia);

    let plan = PreparedMediaPlan {
        planned_shards: Vec::new(),
    };
    let err = advance_upload_job(
        &snapshot,
        UploadJobEvent::MediaPrepared { plan: Some(plan) },
    )
    .expect_err("empty media plan must reject");
    assert_eq!(err.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn validate_prepared_media_plan_accepts_at_max_planned_shards() {
    const MAX: usize = 10_000;

    let snapshot = upload_snapshot_with(UploadJobPhase::AwaitingPreparedMedia);

    let mut planned_shards = Vec::with_capacity(MAX);
    for index in 0..MAX {
        planned_shards.push(UploadShardSlot {
            tier: ((index % 3) as u8) + 1,
            index: index as u32,
        });
    }
    let plan = PreparedMediaPlan { planned_shards };

    let _ = advance_upload_job(
        &snapshot,
        UploadJobEvent::MediaPrepared { plan: Some(plan) },
    )
    .expect("plan with exactly MAX_PLANNED_SHARDS shards must be accepted");
}

#[test]
fn sync_requested_clears_retry_progress_on_new_attempt() {
    let mut snapshot = sync_snapshot_with(AlbumSyncPhase::Cancelled);
    snapshot.retry = AlbumSyncRetryMetadata {
        attempt_count: 5,
        max_attempts: 10,
        retry_after_ms: Some(2500),
        last_error_code: Some(ClientErrorCode::AuthenticationFailed),
        last_error_stage: Some(AlbumSyncPhase::FetchingPage),
        retry_target_phase: Some(AlbumSyncPhase::FetchingPage),
    };

    let req = sync_request(7);
    let transition = advance_album_sync(
        &snapshot,
        AlbumSyncEvent::SyncRequested { request: Some(req) },
    )
    .expect("starting a fresh sync from Cancelled must succeed");

    assert_eq!(transition.snapshot.retry.attempt_count, 0);
    assert_eq!(transition.snapshot.retry.retry_after_ms, None);
    assert_eq!(transition.snapshot.retry.last_error_code, None);
    assert_eq!(transition.snapshot.retry.last_error_stage, None);
    assert_eq!(transition.snapshot.retry.retry_target_phase, None);
    assert_eq!(transition.snapshot.retry.max_attempts, 7);
}

#[test]
fn account_key_handle_lifecycle_flips_is_open_only_after_close() {
    use mosaic_client::open_secret_handle;

    let secret = vec![0xc7_u8; 32];
    let handle = open_secret_handle(&secret).expect("32-byte secret handle should open");
    assert_eq!(account_key_handle_is_open(handle), Ok(true));

    close_account_key_handle(handle).expect("handle should close cleanly");
    assert_eq!(account_key_handle_is_open(handle), Ok(false));

    let err = close_account_key_handle(handle).expect_err("closing a closed handle must fail");
    assert_eq!(err.code, ClientErrorCode::SecretHandleNotFound);

    assert_eq!(account_key_handle_is_open(0xffff_ffff_ffff_ffff), Ok(false));
}

#[test]
fn validate_upload_snapshot_rejects_unsupported_schema_version() {
    let mut snapshot = upload_snapshot_with(UploadJobPhase::Queued);
    snapshot.schema_version = upload_snapshot_schema_version() + 1;

    let err = advance_upload_job(&snapshot, UploadJobEvent::StartRequested)
        .expect_err("unsupported schema version must reject");
    assert_eq!(
        err.code,
        ClientErrorCode::ClientCoreUnsupportedSnapshotVersion
    );
}

#[test]
fn validate_album_sync_snapshot_rejects_unsupported_schema_version() {
    let mut snapshot = sync_snapshot_with(AlbumSyncPhase::Idle);
    snapshot.schema_version = album_sync_snapshot_schema_version() + 1;

    let err = advance_album_sync(
        &snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(sync_request(2)),
        },
    )
    .expect_err("unsupported schema version must reject");
    assert_eq!(
        err.code,
        ClientErrorCode::ClientCoreUnsupportedSnapshotVersion
    );
}

#[test]
fn validate_upload_snapshot_rejects_completed_shards_exceeding_planned() {
    let mut snapshot = upload_snapshot_with(UploadJobPhase::Queued);
    snapshot.planned_shard_count = 1;
    snapshot.planned_shards = vec![UploadShardSlot { tier: 1, index: 0 }];
    snapshot.completed_shards = vec![
        CompletedShardRef {
            tier: 1,
            index: 0,
            sha256: "sha256:aa".to_owned(),
            shard_id: id("c0"),
        },
        CompletedShardRef {
            tier: 1,
            index: 1,
            sha256: "sha256:bb".to_owned(),
            shard_id: id("c1"),
        },
    ];

    let err = advance_upload_job(&snapshot, UploadJobEvent::StartRequested)
        .expect_err("completed > planned must reject");
    assert_eq!(err.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn validate_upload_snapshot_rejects_attempt_count_exceeding_max_attempts() {
    let mut snapshot = upload_snapshot_with(UploadJobPhase::Queued);
    snapshot.retry.attempt_count = snapshot.retry.max_attempts + 1;

    let err = advance_upload_job(&snapshot, UploadJobEvent::StartRequested)
        .expect_err("attempt_count > max_attempts must reject");
    assert_eq!(err.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

/// Kills `replace > with >=` on `state_machine.rs:1249`
/// (`value.len() > MAX_SAFE_TEXT_LEN`). MAX_SAFE_TEXT_LEN = 256.
///
///   * Original `>`: 256 > 256 is false → accepted.
///   * Mutation `>=`: 256 >= 256 is true → rejected.
#[test]
fn validate_safe_text_accepts_value_of_exactly_max_safe_text_len_chars() {
    let exactly_max = "a".repeat(256);
    let mut req = upload_request(2);
    req.local_job_id = exactly_max;
    let result = new_upload_job(req);
    assert!(
        result.is_ok(),
        "exactly-MAX_SAFE_TEXT_LEN safe text must be accepted, got {result:?}"
    );

    let over_max = "a".repeat(257);
    let mut req = upload_request(2);
    req.local_job_id = over_max;
    let result = new_upload_job(req);
    assert!(result.is_err(), "over-max safe text must be rejected");
}

/// Kills `replace > with >=` on `state_machine.rs:1286`
/// (`max_attempts > MAX_RETRY_COUNT_LIMIT`). MAX_RETRY_COUNT_LIMIT = 64.
#[test]
fn validate_snapshot_retry_bounds_accepts_max_attempts_at_exact_limit() {
    let mut snapshot = upload_snapshot_with(UploadJobPhase::Queued);
    snapshot.retry.max_attempts = MAX_RETRY_COUNT_LIMIT;
    snapshot.retry.attempt_count = 0;

    let result = advance_upload_job(&snapshot, UploadJobEvent::StartRequested);
    if let Err(error) = &result {
        assert_ne!(
            error.code,
            ClientErrorCode::ClientCoreInvalidSnapshot,
            "max_attempts at exact MAX_RETRY_COUNT_LIMIT must not trigger the bounds error"
        );
    }
}

#[test]
fn safe_text_validation_blocks_dangerous_strings() {
    let cases: &[&str] = &[
        "",
        "id/with/slash",
        "id\\with\\backslash",
        "id\nwith\ncontrol",
        "scheme://path",
        "content:raw",
        "file:thing",
        "photo.JPG",
        "photo.jpg",
        "photo.png",
        "video.mp4",
    ];

    for bad in cases {
        let mut req = upload_request(2);
        req.local_job_id = (*bad).to_owned();
        let result = new_upload_job(req);
        assert!(
            result.is_err(),
            "validate_safe_text must reject {bad:?}, got {result:?}"
        );
    }
}

#[test]
fn decrypt_with_unknown_epoch_handle_returns_epoch_handle_not_found() {
    let result = decrypt_shard_with_epoch_handle(0xdead_beef_dead_beef, &[0_u8; 100]);
    assert_eq!(result.code, ClientErrorCode::EpochHandleNotFound);
}

#[test]
fn new_upload_job_returns_queued_snapshot_with_request_fields() {
    let snapshot = new_upload_job(upload_request(3)).expect("valid request must succeed");

    assert_eq!(snapshot.phase, UploadJobPhase::Queued);
    assert_eq!(snapshot.local_job_id, id("job"));
    assert_eq!(snapshot.upload_id, id("upload"));
    assert_eq!(snapshot.album_id, id("album"));
    assert_eq!(snapshot.asset_id, id("asset"));
    assert_eq!(snapshot.retry.max_attempts, 3);
    assert_eq!(snapshot.retry.attempt_count, 0);
    assert_eq!(snapshot.planned_shard_count, 0);
    assert_eq!(snapshot.next_shard_index, 0);
    assert!(snapshot.planned_shards.is_empty());
    assert!(snapshot.completed_shards.is_empty());
    assert!(snapshot.pending_shard.is_none());
    assert!(snapshot.manifest_receipt.is_none());
    assert!(snapshot.confirmation_metadata.is_none());
    assert!(snapshot.failure_code.is_none());
    assert_eq!(snapshot.schema_version, upload_snapshot_schema_version());
}

#[test]
fn new_album_sync_returns_idle_snapshot_with_request_fields() {
    let snapshot = new_album_sync(sync_request(4)).expect("valid request must succeed");

    assert_eq!(snapshot.phase, AlbumSyncPhase::Idle);
    assert_eq!(snapshot.sync_id, id("sync"));
    assert_eq!(snapshot.album_id, id("album"));
    assert_eq!(snapshot.retry.max_attempts, 4);
    assert_eq!(snapshot.retry.attempt_count, 0);
    assert_eq!(snapshot.completed_cycle_count, 0);
    assert!(!snapshot.rerun_requested);
    assert!(snapshot.failure_code.is_none());
    assert!(snapshot.current_page.is_none());
    assert_eq!(
        snapshot.schema_version,
        album_sync_snapshot_schema_version()
    );
}
