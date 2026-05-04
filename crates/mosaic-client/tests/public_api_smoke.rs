//! Smoke tests that pin down the small public free functions and error mapping
//! arms that wrapper bindings rely on but that the existing FFI/state-machine
//! suites do not exercise directly.

#![allow(clippy::expect_used, clippy::unwrap_used)]

use mosaic_client::{
    AlbumSyncEffect, AlbumSyncEvent, AlbumSyncPhase, AlbumSyncRequest, AlbumSyncSnapshot,
    AlbumSyncTransition, CleanupStagingReason, ClientError, ClientErrorCode, SyncPageSummary,
    UploadJobEffect, UploadJobEvent, UploadJobPhase, UploadJobRequest, UploadJobSnapshot,
    UploadJobTransition, UploadShardRef, Uuid, advance_album_sync, advance_upload_job,
    album_sync_snapshot_schema_version, close_account_key_handle, close_epoch_key_handle,
    close_identity_handle, crate_name, create_epoch_key_handle, create_identity_handle,
    crypto_domain_golden_vector_snapshot, decrypt_shard_with_epoch_handle,
    encrypt_shard_with_epoch_handle, identity_handle_is_open, new_album_sync, new_upload_job,
    open_epoch_key_handle, open_identity_handle, open_secret_handle, protocol_version,
    upload_snapshot_schema_version, verify_manifest_with_identity,
};
use mosaic_crypto::{
    EPOCH_SEED_AAD, IDENTITY_SEED_AAD, IdentitySigningPublicKey, wrap_secret_with_aad,
};
use mosaic_domain::{ShardEnvelopeHeader, ShardTier};

const ACCOUNT_KEY: [u8; 32] = [
    0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f,
    0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f,
];

#[test]
fn crate_name_is_stable_for_ffi_diagnostics() {
    assert_eq!(crate_name(), "mosaic-client");
    // protocol_version is the public crypto-protocol identifier we agree with
    // mosaic-crypto on; pinning it here ensures the wrapper bindings observe a
    // stable string and that the function continues to round-trip the value.
    assert_eq!(protocol_version(), mosaic_crypto::protocol_version());
}

#[test]
fn snapshot_schema_versions_are_pinned_for_persistence_compatibility() {
    assert_eq!(upload_snapshot_schema_version(), 1);
    assert_eq!(album_sync_snapshot_schema_version(), 1);
}

#[test]
fn crypto_domain_golden_vector_snapshot_returns_canonical_public_fields() {
    let snapshot = crypto_domain_golden_vector_snapshot();

    assert_eq!(snapshot.code, ClientErrorCode::Ok);
    assert_eq!(snapshot.envelope_header.len(), 64);
    assert_eq!(snapshot.envelope_nonce.len(), 24);
    assert!(matches!(snapshot.envelope_tier, 1..=3));
    assert_eq!(snapshot.identity_signing_pubkey.len(), 32);
    assert_eq!(snapshot.identity_encryption_pubkey.len(), 32);
    assert_eq!(snapshot.identity_signature.len(), 64);
    assert!(!snapshot.envelope_header.iter().all(|byte| *byte == 0));
    assert!(!snapshot.manifest_transcript.is_empty());
    // `IDENTITY_MESSAGE` is intentionally an empty slice in `mosaic-crypto`'s
    // golden vectors. We assert that fact here to lock the snapshot's wire
    // shape so wrapper bindings can rely on it.
    assert!(snapshot.identity_message.is_empty());
}

#[test]
fn verify_manifest_with_identity_rejects_invalid_signature_and_pubkey_lengths() {
    let signing_pubkey = match IdentitySigningPublicKey::from_bytes(&[0_u8; 32]) {
        Ok(value) => value,
        Err(_) => {
            // The all-zero key is rejected as weak by Ed25519. Generate a real one
            // through the public API instead so we have a valid pubkey to use.
            let account_handle = open_secret_handle(&ACCOUNT_KEY)
                .expect("account key handle should open for verify smoke test");
            let identity = create_identity_handle(account_handle);
            assert_eq!(identity.code, ClientErrorCode::Ok);
            close_identity_handle(identity.handle)
                .expect("identity handle should close for verify smoke test");
            close_account_key_handle(account_handle)
                .expect("account handle should close for verify smoke test");
            match IdentitySigningPublicKey::from_bytes(&identity.signing_pubkey) {
                Ok(value) => value,
                Err(error) => panic!("public key should decode: {error:?}"),
            }
        }
    };

    let short_signature_code =
        verify_manifest_with_identity(b"transcript", &[0_u8; 5], signing_pubkey.as_bytes());
    assert_eq!(
        short_signature_code,
        ClientErrorCode::InvalidSignatureLength
    );

    let invalid_pubkey_code = verify_manifest_with_identity(b"transcript", &[0_u8; 64], &[0_u8; 7]);
    assert_eq!(invalid_pubkey_code, ClientErrorCode::InvalidKeyLength);

    let weak_pubkey_code = verify_manifest_with_identity(b"transcript", &[0_u8; 64], &[0_u8; 32]);
    assert_eq!(weak_pubkey_code, ClientErrorCode::InvalidPublicKey);

    let bogus_signature_code =
        verify_manifest_with_identity(b"transcript", &[1_u8; 64], signing_pubkey.as_bytes());
    assert_eq!(bogus_signature_code, ClientErrorCode::AuthenticationFailed);
}

#[test]
fn open_identity_handle_rejects_seed_decrypting_to_wrong_length() {
    let account_handle =
        open_secret_handle(&ACCOUNT_KEY).expect("account handle should open for malformed seed");
    let secret_key = mosaic_crypto::SecretKey::from_bytes(&mut ACCOUNT_KEY.to_vec())
        .expect("account key bytes should form a SecretKey");

    // Wrap a 31-byte payload — the unwrap path will succeed but the seed length
    // check inside `derive_identity_keypair` will reject the resulting bytes.
    let wrapped_short_seed = wrap_secret_with_aad(&[0xab_u8; 31], &secret_key, IDENTITY_SEED_AAD)
        .expect("wrap_secret_with_aad should accept non-empty input");
    let result = open_identity_handle(&wrapped_short_seed, account_handle);
    assert_eq!(result.code, ClientErrorCode::InvalidKeyLength);
    assert_eq!(result.handle, 0);
    assert!(result.signing_pubkey.is_empty());

    // The wrapped seed itself decrypts to 33 bytes instead of 32 — same client-
    // visible error code.
    let wrapped_long_seed = wrap_secret_with_aad(&[0xcd_u8; 33], &secret_key, IDENTITY_SEED_AAD)
        .expect("wrap_secret_with_aad should accept long input");
    let too_long = open_identity_handle(&wrapped_long_seed, account_handle);
    assert_eq!(too_long.code, ClientErrorCode::InvalidKeyLength);

    close_account_key_handle(account_handle).expect("account handle should close");
}

#[test]
fn open_epoch_key_handle_rejects_wrapped_seed_with_wrong_decoded_length() {
    let account_handle = open_secret_handle(&ACCOUNT_KEY)
        .expect("account handle should open for malformed epoch seed");
    let secret_key = mosaic_crypto::SecretKey::from_bytes(&mut ACCOUNT_KEY.to_vec())
        .expect("account key bytes should form a SecretKey");

    let wrapped_short = wrap_secret_with_aad(&[0x11_u8; 16], &secret_key, EPOCH_SEED_AAD)
        .expect("wrap_secret_with_aad should accept a non-empty short payload");
    let result = open_epoch_key_handle(&wrapped_short, account_handle, 7);
    assert_eq!(result.code, ClientErrorCode::InvalidKeyLength);
    assert_eq!(result.handle, 0);
    assert_eq!(result.epoch_id, 0);
    assert!(result.wrapped_epoch_seed.is_empty());

    close_account_key_handle(account_handle).expect("account handle should close");
}

#[test]
fn create_identity_handle_returns_unique_handles_and_independent_keypairs() {
    // Drive a sequence of public allocator calls so that `allocate_handle`'s
    // monotonic counter is repeatedly hit on the success branch and so that
    // `IdentityRecord::Drop` paths are exercised when we close them.
    let account_handle =
        open_secret_handle(&ACCOUNT_KEY).expect("account handle should open for identity batch");

    let mut handles = Vec::new();
    for _ in 0..6 {
        let result = create_identity_handle(account_handle);
        assert_eq!(result.code, ClientErrorCode::Ok);
        assert_ne!(result.handle, 0);
        assert_eq!(result.signing_pubkey.len(), 32);
        assert_eq!(result.encryption_pubkey.len(), 32);
        handles.push(result.handle);
    }

    handles.sort_unstable();
    handles.dedup();
    assert_eq!(handles.len(), 6, "every identity handle must be unique");

    for handle in handles {
        let is_open = identity_handle_is_open(handle).expect("identity handle status readable");
        assert!(is_open);
        close_identity_handle(handle).expect("identity handle should close");
    }

    close_account_key_handle(account_handle).expect("account handle should close");
}

// ---- Helpers shared by transition tests ----

const SAFE_ID: u8 = 0x21;

fn uuid(seed: u8) -> Uuid {
    let mut bytes = [seed; 16];
    bytes[6] = 0x70 | (seed & 0x0f);
    bytes[8] = 0x80 | (seed & 0x3f);
    Uuid::from_bytes(bytes)
}

fn upload_request() -> UploadJobRequest {
    UploadJobRequest {
        job_id: uuid(SAFE_ID),
        album_id: uuid(SAFE_ID + 1),
        asset_id: uuid(SAFE_ID + 2),
        idempotency_key: uuid(SAFE_ID + 3),
        max_retry_count: 1,
    }
}

fn upload_shard(tier: u8, index: u32) -> UploadShardRef {
    UploadShardRef {
        tier,
        shard_index: index,
        shard_id: uuid(0x40 + tier + index as u8),
        sha256: [0x80 + tier + index as u8; 32],
        content_length: 512 + u64::from(index),
        envelope_version: 3,
        uploaded: false,
    }
}

fn new_upload_snapshot() -> UploadJobSnapshot {
    new_upload_job(upload_request()).expect("upload job should initialize")
}

fn advance_upload_or_panic(
    snapshot: &UploadJobSnapshot,
    event: UploadJobEvent,
) -> UploadJobTransition {
    advance_upload_job(snapshot, event).expect("upload transition should succeed")
}

fn upload_at_creating_manifest() -> UploadJobSnapshot {
    let snap = new_upload_snapshot();
    let snap = advance_upload_or_panic(
        &snap,
        UploadJobEvent::StartRequested {
            effect_id: uuid(0x10),
        },
    )
    .next_snapshot;
    let snap = advance_upload_or_panic(
        &snap,
        UploadJobEvent::MediaPrepared {
            effect_id: uuid(0x11),
            tiered_shards: vec![upload_shard(3, 0)],
            shard_set_hash: Some([0x44; 32]),
        },
    )
    .next_snapshot;
    let snap = advance_upload_or_panic(
        &snap,
        UploadJobEvent::EpochHandleAcquired {
            effect_id: uuid(0x12),
        },
    )
    .next_snapshot;
    let shard = upload_shard(3, 0);
    let snap = advance_upload_or_panic(
        &snap,
        UploadJobEvent::ShardEncrypted {
            effect_id: uuid(0x13),
            shard: shard.clone(),
        },
    )
    .next_snapshot;
    let snap = advance_upload_or_panic(
        &snap,
        UploadJobEvent::ShardUploadCreated {
            effect_id: uuid(0x14),
            shard: shard.clone(),
        },
    )
    .next_snapshot;
    advance_upload_or_panic(
        &snap,
        UploadJobEvent::ShardUploaded {
            effect_id: uuid(0x15),
            shard,
        },
    )
    .next_snapshot
}

fn upload_at_awaiting_sync_confirmation() -> UploadJobSnapshot {
    let snap = upload_at_creating_manifest();
    advance_upload_or_panic(
        &snap,
        UploadJobEvent::ManifestCreated {
            effect_id: uuid(0x16),
        },
    )
    .next_snapshot
}

fn sync_request() -> AlbumSyncRequest {
    AlbumSyncRequest {
        sync_id: "id-safe-sync".to_owned(),
        album_id: "id-safe-album".to_owned(),
        initial_page_token: None,
        max_retry_count: 1,
    }
}

fn new_sync_snapshot() -> AlbumSyncSnapshot {
    new_album_sync(sync_request()).expect("album sync should initialize")
}

fn advance_sync_or_panic(
    snapshot: &AlbumSyncSnapshot,
    event: AlbumSyncEvent,
) -> AlbumSyncTransition {
    advance_album_sync(snapshot, event).expect("album sync transition should succeed")
}

fn assert_invalid_transition(error: ClientError) {
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidTransition);
}

// ---- end helpers ----

#[test]
fn upload_encrypt_decrypt_round_trip_succeeds_through_minimal_handles() {
    let account_handle = open_secret_handle(&ACCOUNT_KEY).expect("account handle opens");
    let epoch = create_epoch_key_handle(account_handle, 11);
    assert_eq!(epoch.code, ClientErrorCode::Ok);

    let encrypted = encrypt_shard_with_epoch_handle(epoch.handle, b"plaintext", 0, 1);
    assert_eq!(encrypted.code, ClientErrorCode::Ok);

    let header_bytes = &encrypted.envelope_bytes[..64];
    let header = ShardEnvelopeHeader::parse(header_bytes).expect("header parses");
    assert_eq!(header.tier(), ShardTier::Thumbnail);

    let decrypted = decrypt_shard_with_epoch_handle(epoch.handle, &encrypted.envelope_bytes);
    assert_eq!(decrypted.code, ClientErrorCode::Ok);
    assert_eq!(decrypted.plaintext, b"plaintext");

    close_epoch_key_handle(epoch.handle).expect("epoch handle closes");
    close_account_key_handle(account_handle).expect("account handle closes");
}

#[test]
fn advance_upload_job_rejects_unsupported_snapshot_schema_version() {
    let mut snapshot = new_upload_snapshot();
    snapshot.schema_version = 999;

    let error = match advance_upload_job(
        &snapshot,
        UploadJobEvent::StartRequested {
            effect_id: uuid(0x20),
        },
    ) {
        Ok(transition) => panic!("future schema should be rejected: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(
        error.code,
        ClientErrorCode::ClientCoreUnsupportedSnapshotVersion
    );
}

#[test]
fn advance_album_sync_legacy_snapshot_schema_version_is_passthrough_until_rcl2() {
    let mut snapshot = new_sync_snapshot();
    snapshot.schema_version = 999;

    let transition = advance_album_sync(
        &snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(sync_request()),
        },
    )
    .expect("legacy AlbumSync remains R-Cl2 passthrough");
    assert_eq!(transition.snapshot.schema_version, 999);
    assert_eq!(transition.snapshot.phase, AlbumSyncPhase::FetchingPage);
}

#[test]
fn upload_job_non_retryable_failure_event_transitions_to_failed_with_cleanup() {
    let snapshot = new_upload_snapshot();
    let started = advance_upload_or_panic(
        &snapshot,
        UploadJobEvent::StartRequested {
            effect_id: uuid(0x21),
        },
    )
    .next_snapshot;

    let transition = advance_upload_or_panic(
        &started,
        UploadJobEvent::NonRetryableFailure {
            effect_id: uuid(0x22),
            code: ClientErrorCode::InvalidPublicKey,
        },
    );
    assert_eq!(transition.next_snapshot.phase, UploadJobPhase::Failed);
    assert_eq!(
        transition.effects,
        vec![UploadJobEffect::CleanupStaging {
            effect_id: uuid(0x22),
            reason: CleanupStagingReason::Failed,
        }]
    );
}

#[test]
fn upload_non_retryable_failure_rejected_in_terminal_phase() {
    let snapshot = upload_at_awaiting_sync_confirmation();
    let confirmed = advance_upload_or_panic(
        &snapshot,
        UploadJobEvent::SyncConfirmed {
            effect_id: uuid(0x23),
        },
    )
    .next_snapshot;
    assert_eq!(confirmed.phase, UploadJobPhase::Confirmed);

    let error = match advance_upload_job(
        &confirmed,
        UploadJobEvent::NonRetryableFailure {
            effect_id: uuid(0x24),
            code: ClientErrorCode::InvalidPublicKey,
        },
    ) {
        Ok(transition) => panic!("terminal failure transition should be rejected: {transition:?}"),
        Err(error) => error,
    };
    assert_invalid_transition(error);
}

#[test]
fn album_sync_handles_retry_and_cancel_and_failure_events_explicitly() {
    let snapshot = new_sync_snapshot();
    let started = advance_sync_or_panic(
        &snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(sync_request()),
        },
    )
    .snapshot;
    assert_eq!(started.phase, AlbumSyncPhase::FetchingPage);

    let retry = advance_sync_or_panic(
        &started,
        AlbumSyncEvent::RetryableFailure {
            code: ClientErrorCode::InvalidInputLength,
            retry_after_ms: Some(2_500),
        },
    );
    assert_eq!(retry.snapshot.phase, AlbumSyncPhase::RetryWaiting);
    assert_eq!(retry.effects.len(), 1);
    let scheduled = match retry.effects.first() {
        Some(AlbumSyncEffect::ScheduleRetry {
            attempt,
            retry_after_ms,
            target_phase,
        }) => (*attempt, *retry_after_ms, *target_phase),
        other => panic!("expected ScheduleRetry effect, got {other:?}"),
    };
    assert_eq!(scheduled, (1, 2_500, AlbumSyncPhase::FetchingPage));

    let resumed = advance_sync_or_panic(&retry.snapshot, AlbumSyncEvent::RetryTimerElapsed);
    assert_eq!(resumed.snapshot.phase, AlbumSyncPhase::FetchingPage);

    let exhausted = advance_sync_or_panic(
        &resumed.snapshot,
        AlbumSyncEvent::RetryableFailure {
            code: ClientErrorCode::InvalidInputLength,
            retry_after_ms: None,
        },
    );
    assert_eq!(exhausted.snapshot.phase, AlbumSyncPhase::Failed);
    assert_eq!(
        exhausted.snapshot.failure_code,
        Some(ClientErrorCode::InvalidInputLength)
    );
    assert_eq!(
        exhausted.snapshot.retry.last_error_code,
        Some(ClientErrorCode::InvalidInputLength)
    );
    assert_eq!(
        exhausted.snapshot.retry.last_error_stage,
        Some(AlbumSyncPhase::FetchingPage)
    );
    assert!(exhausted.effects.is_empty());

    let started_again = advance_sync_or_panic(
        &snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(sync_request()),
        },
    )
    .snapshot;
    let cancelled = advance_sync_or_panic(&started_again, AlbumSyncEvent::CancelRequested).snapshot;
    assert_eq!(cancelled.phase, AlbumSyncPhase::Cancelled);

    let started_for_failure = advance_sync_or_panic(
        &snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(sync_request()),
        },
    )
    .snapshot;
    let failed = advance_sync_or_panic(
        &started_for_failure,
        AlbumSyncEvent::NonRetryableFailure {
            code: ClientErrorCode::InvalidPublicKey,
        },
    );
    assert_eq!(failed.snapshot.phase, AlbumSyncPhase::Failed);
    assert_eq!(
        failed.snapshot.failure_code,
        Some(ClientErrorCode::InvalidPublicKey)
    );
}

#[test]
fn album_sync_page_fetched_legacy_accepts_current_page_shape() {
    let snapshot = new_sync_snapshot();
    let started = advance_sync_or_panic(
        &snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(sync_request()),
        },
    )
    .snapshot;
    let transition = advance_album_sync(
        &started,
        AlbumSyncEvent::PageFetched {
            page: Some(SyncPageSummary {
                previous_page_token: None,
                next_page_token: None,
                reached_end: false,
                encrypted_item_count: 1,
            }),
        },
    )
    .expect("legacy AlbumSync accepts page payload");
    assert_eq!(transition.snapshot.phase, AlbumSyncPhase::ApplyingPage);
}

#[test]
fn upload_job_request_and_snapshot_validation_rejects_invalid_uuids_and_shards() {
    let error = match new_upload_job(UploadJobRequest {
        job_id: Uuid::from_bytes([0; 16]),
        ..upload_request()
    }) {
        Ok(snapshot) => panic!("invalid UUID should be rejected: {snapshot:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);

    let started = advance_upload_or_panic(
        &new_upload_snapshot(),
        UploadJobEvent::StartRequested {
            effect_id: uuid(0x25),
        },
    )
    .next_snapshot;
    let mut zero_hash = upload_shard(3, 0);
    zero_hash.sha256 = [0; 32];
    let error = match advance_upload_job(
        &started,
        UploadJobEvent::MediaPrepared {
            effect_id: uuid(0x26),
            tiered_shards: vec![zero_hash],
            shard_set_hash: None,
        },
    ) {
        Ok(snapshot) => panic!("invalid shard should be rejected: {snapshot:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn album_sync_request_token_validation_remains_rcl2_pending() {
    let mut request = sync_request();
    request.initial_page_token = Some("https://malicious".to_owned());

    let snapshot =
        new_album_sync(request).expect("legacy AlbumSync token validation is R-Cl2 pending");
    assert_eq!(
        snapshot.initial_page_token,
        Some("https://malicious".to_owned())
    );
}

#[test]
fn upload_invalid_transitions_are_rejected_in_each_phase() {
    let queued = new_upload_snapshot();
    let err = match advance_upload_job(
        &queued,
        UploadJobEvent::MediaPrepared {
            effect_id: uuid(0x27),
            tiered_shards: vec![upload_shard(3, 0)],
            shard_set_hash: None,
        },
    ) {
        Ok(transition) => panic!("expected invalid transition: {transition:?}"),
        Err(error) => error,
    };
    assert_invalid_transition(err);

    let started = advance_upload_or_panic(
        &queued,
        UploadJobEvent::StartRequested {
            effect_id: uuid(0x28),
        },
    )
    .next_snapshot;
    let err = match advance_upload_job(
        &started,
        UploadJobEvent::MediaPrepared {
            effect_id: uuid(0x29),
            tiered_shards: Vec::new(),
            shard_set_hash: None,
        },
    ) {
        Ok(transition) => panic!("expected empty plan rejection: {transition:?}"),
        Err(error) => error,
    };
    assert!(matches!(
        err.code,
        ClientErrorCode::ClientCoreInvalidSnapshot | ClientErrorCode::ClientCoreInvalidTransition
    ));
}

#[test]
fn upload_retry_timer_uses_event_target_phase() {
    let queued = new_upload_snapshot();
    let started = advance_upload_or_panic(
        &queued,
        UploadJobEvent::StartRequested {
            effect_id: uuid(0x30),
        },
    )
    .next_snapshot;
    let retry = advance_upload_or_panic(
        &started,
        UploadJobEvent::RetryableFailure {
            effect_id: uuid(0x31),
            code: ClientErrorCode::InvalidInputLength,
            now_ms: 1_000,
            base_backoff_ms: 1_000,
            server_retry_after_ms: None,
        },
    )
    .next_snapshot;
    let resumed = advance_upload_or_panic(
        &retry,
        UploadJobEvent::RetryTimerElapsed {
            effect_id: uuid(0x32),
            target_phase: UploadJobPhase::AwaitingPreparedMedia,
        },
    );
    assert_eq!(
        resumed.next_snapshot.phase,
        UploadJobPhase::AwaitingPreparedMedia
    );
    assert_eq!(
        resumed.effects,
        vec![UploadJobEffect::PrepareMedia {
            effect_id: uuid(0x32)
        }]
    );
}

#[test]
fn sync_page_with_short_circuit_rerun_resets_to_initial_token_on_completion() {
    // Drive a full FetchingPage → ApplyingPage → completed cycle where
    // rerun_requested is set; this exercises the branch that resets
    // next_page_token to initial_page_token for the next fetch cycle.
    let mut request = sync_request();
    request.initial_page_token = Some(format!("{SAFE_ID}-cursor"));
    let snapshot = new_album_sync(request.clone()).expect("album sync should initialize");
    let started = advance_sync_or_panic(
        &snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(request),
        },
    )
    .snapshot;
    let started = advance_sync_or_panic(
        &started,
        AlbumSyncEvent::SyncRequested {
            request: Some(AlbumSyncRequest {
                sync_id: format!("{SAFE_ID}-sync-2"),
                album_id: format!("{SAFE_ID}-album"),
                initial_page_token: Some(format!("{SAFE_ID}-cursor")),
                max_retry_count: 1,
            }),
        },
    )
    .snapshot;
    assert!(started.rerun_requested);

    let after_fetch = advance_sync_or_panic(
        &started,
        AlbumSyncEvent::PageFetched {
            page: Some(SyncPageSummary {
                previous_page_token: Some(format!("{SAFE_ID}-cursor")),
                next_page_token: None,
                reached_end: true,
                encrypted_item_count: 0,
            }),
        },
    )
    .snapshot;
    assert_eq!(after_fetch.phase, AlbumSyncPhase::ApplyingPage);

    let cycled = advance_sync_or_panic(&after_fetch, AlbumSyncEvent::PageApplied);
    assert_eq!(cycled.snapshot.phase, AlbumSyncPhase::FetchingPage);
    assert!(!cycled.snapshot.rerun_requested);
    // The fetch effect carries the initial token because rerun resets it.
    assert_eq!(
        cycled.effects,
        vec![AlbumSyncEffect::FetchPage {
            page_token: Some(format!("{SAFE_ID}-cursor"))
        }]
    );
}
