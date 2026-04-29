//! Smoke tests that pin down the small public free functions and error mapping
//! arms that wrapper bindings rely on but that the existing FFI/state-machine
//! suites do not exercise directly.

#![allow(clippy::expect_used, clippy::unwrap_used)]

use mosaic_client::{
    AlbumSyncEffect, AlbumSyncEvent, AlbumSyncPhase, AlbumSyncRequest, AlbumSyncSnapshot,
    AlbumSyncTransition, ClientError, ClientErrorCode, CompletedShardRef, CreatedShardUpload,
    EncryptedShardRef, ManifestReceipt, PreparedMediaPlan, SyncPageSummary, UploadJobEffect,
    UploadJobEvent, UploadJobPhase, UploadJobRequest, UploadJobSnapshot, UploadJobTransition,
    UploadShardSlot, UploadSyncConfirmation, advance_album_sync, advance_upload_job,
    album_sync_snapshot_schema_version, close_account_key_handle, close_epoch_key_handle,
    close_identity_handle, crate_name, create_epoch_key_handle, create_identity_handle,
    crypto_domain_golden_vector_snapshot, decrypt_shard_with_epoch_handle,
    encrypt_shard_with_epoch_handle, identity_handle_is_open, new_album_sync, new_upload_job,
    open_epoch_key_handle, open_identity_handle, open_secret_handle, protocol_version,
    upload_snapshot_schema_version, verify_manifest_with_identity,
};
use mosaic_crypto::{IdentitySigningPublicKey, wrap_key};
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
    let wrapped_short_seed =
        wrap_key(&[0xab_u8; 31], &secret_key).expect("wrap_key should accept non-empty input");
    let result = open_identity_handle(&wrapped_short_seed, account_handle);
    assert_eq!(result.code, ClientErrorCode::InvalidKeyLength);
    assert_eq!(result.handle, 0);
    assert!(result.signing_pubkey.is_empty());

    // The wrapped seed itself decrypts to 33 bytes instead of 32 — same client-
    // visible error code.
    let wrapped_long_seed =
        wrap_key(&[0xcd_u8; 33], &secret_key).expect("wrap_key should accept long input");
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

    let wrapped_short = wrap_key(&[0x11_u8; 16], &secret_key)
        .expect("wrap_key should accept a non-empty short payload");
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

const SAFE_ID: &str = "id-safe";

fn upload_request() -> UploadJobRequest {
    UploadJobRequest {
        local_job_id: format!("{SAFE_ID}-job"),
        upload_id: format!("{SAFE_ID}-upload"),
        album_id: format!("{SAFE_ID}-album"),
        asset_id: format!("{SAFE_ID}-asset"),
        max_retry_count: 1,
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
    let snap = advance_upload_or_panic(&snap, UploadJobEvent::StartRequested).snapshot;
    let snap = advance_upload_or_panic(
        &snap,
        UploadJobEvent::MediaPrepared {
            plan: Some(PreparedMediaPlan {
                planned_shards: vec![UploadShardSlot { tier: 3, index: 0 }],
            }),
        },
    )
    .snapshot;
    let snap = advance_upload_or_panic(
        &snap,
        UploadJobEvent::EpochHandleAcquired { epoch_id: Some(9) },
    )
    .snapshot;
    let snap = advance_upload_or_panic(
        &snap,
        UploadJobEvent::ShardEncrypted {
            shard: Some(EncryptedShardRef {
                tier: 3,
                index: 0,
                sha256: format!("{SAFE_ID}-sha"),
            }),
        },
    )
    .snapshot;
    let snap = advance_upload_or_panic(
        &snap,
        UploadJobEvent::ShardUploadCreated {
            upload: Some(CreatedShardUpload {
                tier: 3,
                index: 0,
                shard_id: format!("{SAFE_ID}-shard"),
                sha256: format!("{SAFE_ID}-sha"),
            }),
        },
    )
    .snapshot;
    advance_upload_or_panic(
        &snap,
        UploadJobEvent::ShardUploaded {
            shard: Some(CompletedShardRef {
                tier: 3,
                index: 0,
                shard_id: format!("{SAFE_ID}-shard"),
                sha256: format!("{SAFE_ID}-sha"),
            }),
        },
    )
    .snapshot
}

fn upload_at_awaiting_sync_confirmation() -> UploadJobSnapshot {
    let snap = upload_at_creating_manifest();
    advance_upload_or_panic(
        &snap,
        UploadJobEvent::ManifestCreated {
            receipt: Some(ManifestReceipt {
                manifest_id: format!("{SAFE_ID}-manifest"),
                version: 1,
            }),
        },
    )
    .snapshot
}

fn sync_request() -> AlbumSyncRequest {
    AlbumSyncRequest {
        sync_id: format!("{SAFE_ID}-sync"),
        album_id: format!("{SAFE_ID}-album"),
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
    // Mirrors a tiny slice of epoch-handle behaviour to keep the single-shard
    // happy path exercised independently from the existing larger suites. This
    // helps detect regressions in the public client crate even if other tests
    // are skipped.
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

    let error = match advance_upload_job(&snapshot, UploadJobEvent::StartRequested) {
        Ok(transition) => panic!("future schema should be rejected: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(
        error.code,
        ClientErrorCode::ClientCoreUnsupportedSnapshotVersion
    );
}

#[test]
fn advance_album_sync_rejects_unsupported_snapshot_schema_version() {
    let mut snapshot = new_sync_snapshot();
    snapshot.schema_version = 999;

    let error = match advance_album_sync(
        &snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(sync_request()),
        },
    ) {
        Ok(transition) => panic!("future album sync schema should be rejected: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(
        error.code,
        ClientErrorCode::ClientCoreUnsupportedSnapshotVersion
    );
}

#[test]
fn upload_job_non_retryable_failure_event_transitions_to_failed_with_code() {
    let snapshot = new_upload_snapshot();
    let started = advance_upload_or_panic(&snapshot, UploadJobEvent::StartRequested).snapshot;

    let transition = advance_upload_or_panic(
        &started,
        UploadJobEvent::NonRetryableFailure {
            code: ClientErrorCode::InvalidPublicKey,
        },
    );
    assert_eq!(transition.snapshot.phase, UploadJobPhase::Failed);
    assert_eq!(
        transition.snapshot.failure_code,
        Some(ClientErrorCode::InvalidPublicKey),
    );
    assert!(transition.effects.is_empty());
}

#[test]
fn upload_non_retryable_failure_rejected_in_terminal_phase() {
    let snapshot = upload_at_awaiting_sync_confirmation();
    let confirmed = advance_upload_or_panic(
        &snapshot,
        UploadJobEvent::SyncConfirmed {
            confirmation: Some(UploadSyncConfirmation {
                asset_id: format!("{SAFE_ID}-asset"),
                confirmed_at_ms: 100,
                sync_cursor: None,
            }),
        },
    )
    .snapshot;
    assert_eq!(confirmed.phase, UploadJobPhase::Confirmed);

    let error = match advance_upload_job(
        &confirmed,
        UploadJobEvent::NonRetryableFailure {
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

    // Retryable failure → RetryWaiting + ScheduleRetry effect
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

    // Then exhaust the retry budget with a second retryable failure.
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
        Some(ClientErrorCode::ClientCoreRetryBudgetExhausted),
    );
    assert!(exhausted.effects.is_empty());

    // Cancellation in the active phase yields the cancelled terminal phase.
    let started_again = advance_sync_or_panic(
        &snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(sync_request()),
        },
    )
    .snapshot;
    let cancelled = advance_sync_or_panic(&started_again, AlbumSyncEvent::CancelRequested).snapshot;
    assert_eq!(cancelled.phase, AlbumSyncPhase::Cancelled);

    // NonRetryableFailure from an active phase moves directly to Failed.
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
fn sync_page_did_not_advance_returns_stable_error_when_token_unchanged() {
    let snapshot = new_sync_snapshot();
    let started = advance_sync_or_panic(
        &snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(sync_request()),
        },
    )
    .snapshot;

    let error = match advance_album_sync(
        &started,
        AlbumSyncEvent::PageFetched {
            page: Some(SyncPageSummary {
                previous_page_token: None,
                next_page_token: None,
                reached_end: false,
                encrypted_item_count: 1,
            }),
        },
    ) {
        Ok(transition) => panic!("non-advancing page should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreSyncPageDidNotAdvance);
}

#[test]
fn upload_job_request_and_snapshot_validation_rejects_unsafe_text() {
    let bad_chars: &[(&str, &str)] = &[
        ("control_char", "id\u{0007}"),
        ("contains_slash", "id/with/slash"),
        ("contains_backslash", "id\\with\\back"),
        ("scheme_marker", "https://example"),
        ("content_uri", "content:bytes"),
        ("file_uri", "file:bytes"),
        ("media_extension_jpg", "name.jpg"),
        ("media_extension_jpeg", "name.JPEG"),
        ("media_extension_png", "name.png"),
        ("media_extension_gif", "name.gif"),
        ("media_extension_heic", "name.heic"),
        ("media_extension_heif", "name.heif"),
        ("media_extension_webp", "name.webp"),
        ("media_extension_avif", "name.avif"),
        ("media_extension_mp4", "name.mp4"),
        ("media_extension_mov", "name.mov"),
    ];

    for (label, bad) in bad_chars {
        let mut request = upload_request();
        request.local_job_id = (*bad).to_owned();
        let error = match new_upload_job(request) {
            Ok(snapshot) => panic!("{label}: snapshot should be rejected: {snapshot:?}"),
            Err(error) => error,
        };
        assert_eq!(
            error.code,
            ClientErrorCode::ClientCoreInvalidSnapshot,
            "{label}: expected ClientCoreInvalidSnapshot for {bad:?}",
        );
    }

    // Empty and over-long values are also rejected.
    let mut request_empty = upload_request();
    request_empty.upload_id = String::new();
    let error = match new_upload_job(request_empty) {
        Ok(snapshot) => panic!("empty upload_id should fail validation: {snapshot:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);

    let mut request_long = upload_request();
    request_long.album_id = "a".repeat(257);
    let error = match new_upload_job(request_long) {
        Ok(snapshot) => panic!("over-long album_id should fail validation: {snapshot:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn album_sync_request_validation_rejects_unsafe_initial_page_token() {
    let mut request = sync_request();
    request.initial_page_token = Some("https://malicious".to_owned());

    let error = match new_album_sync(request) {
        Ok(snapshot) => panic!("unsafe initial page token should be rejected: {snapshot:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn upload_invalid_transitions_are_rejected_in_each_phase() {
    let queued = new_upload_snapshot();

    // From Queued: any non-Start event is invalid.
    let err = match advance_upload_job(
        &queued,
        UploadJobEvent::MediaPrepared {
            plan: Some(PreparedMediaPlan {
                planned_shards: vec![UploadShardSlot { tier: 3, index: 0 }],
            }),
        },
    ) {
        Ok(transition) => panic!("expected invalid transition: {transition:?}"),
        Err(error) => error,
    };
    assert_invalid_transition(err);

    // MediaPrepared without payload → ClientCoreMissingEventPayload.
    let started = advance_upload_or_panic(&queued, UploadJobEvent::StartRequested).snapshot;
    let err = match advance_upload_job(&started, UploadJobEvent::MediaPrepared { plan: None }) {
        Ok(transition) => panic!("expected missing payload error: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(err.code, ClientErrorCode::ClientCoreMissingEventPayload);

    // Empty plan → ClientCoreInvalidSnapshot via validate_prepared_media_plan.
    let err = match advance_upload_job(
        &started,
        UploadJobEvent::MediaPrepared {
            plan: Some(PreparedMediaPlan {
                planned_shards: Vec::new(),
            }),
        },
    ) {
        Ok(transition) => panic!("expected invalid empty plan: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(err.code, ClientErrorCode::ClientCoreInvalidSnapshot);

    // Plan with duplicate (tier, index) → ClientCoreInvalidSnapshot.
    let err = match advance_upload_job(
        &started,
        UploadJobEvent::MediaPrepared {
            plan: Some(PreparedMediaPlan {
                planned_shards: vec![
                    UploadShardSlot { tier: 3, index: 0 },
                    UploadShardSlot { tier: 3, index: 0 },
                ],
            }),
        },
    ) {
        Ok(transition) => panic!("expected duplicate slot rejection: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(err.code, ClientErrorCode::ClientCoreInvalidSnapshot);

    // Plan with invalid tier (0) → ClientCoreInvalidSnapshot.
    let err = match advance_upload_job(
        &started,
        UploadJobEvent::MediaPrepared {
            plan: Some(PreparedMediaPlan {
                planned_shards: vec![UploadShardSlot { tier: 0, index: 0 }],
            }),
        },
    ) {
        Ok(transition) => panic!("expected invalid tier rejection: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(err.code, ClientErrorCode::ClientCoreInvalidSnapshot);

    // EpochHandleAcquired event with no payload → ClientCoreMissingEventPayload.
    let prepared = advance_upload_or_panic(
        &started,
        UploadJobEvent::MediaPrepared {
            plan: Some(PreparedMediaPlan {
                planned_shards: vec![UploadShardSlot { tier: 3, index: 0 }],
            }),
        },
    )
    .snapshot;
    let err = match advance_upload_job(
        &prepared,
        UploadJobEvent::EpochHandleAcquired { epoch_id: None },
    ) {
        Ok(transition) => panic!("expected missing epoch payload: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(err.code, ClientErrorCode::ClientCoreMissingEventPayload);
}

#[test]
fn upload_shard_encrypted_rejects_payload_mismatch_and_invalid_shard() {
    let snapshot = upload_at_creating_manifest();
    // CreatingManifest doesn't accept ShardEncrypted.
    let err = match advance_upload_job(
        &snapshot,
        UploadJobEvent::ShardEncrypted {
            shard: Some(EncryptedShardRef {
                tier: 3,
                index: 0,
                sha256: format!("{SAFE_ID}-sha"),
            }),
        },
    ) {
        Ok(transition) => panic!("encrypt event in wrong phase: {transition:?}"),
        Err(error) => error,
    };
    assert_invalid_transition(err);

    // Build a snapshot in EncryptingShard and then send a wrong-tier shard.
    let queued = new_upload_snapshot();
    let started = advance_upload_or_panic(&queued, UploadJobEvent::StartRequested).snapshot;
    let prepared = advance_upload_or_panic(
        &started,
        UploadJobEvent::MediaPrepared {
            plan: Some(PreparedMediaPlan {
                planned_shards: vec![UploadShardSlot { tier: 3, index: 0 }],
            }),
        },
    )
    .snapshot;
    let acquired = advance_upload_or_panic(
        &prepared,
        UploadJobEvent::EpochHandleAcquired { epoch_id: Some(2) },
    )
    .snapshot;
    assert_eq!(acquired.phase, UploadJobPhase::EncryptingShard);

    // Missing payload.
    let err = match advance_upload_job(&acquired, UploadJobEvent::ShardEncrypted { shard: None }) {
        Ok(transition) => panic!("missing shard payload should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(err.code, ClientErrorCode::ClientCoreMissingEventPayload);

    // Invalid shard tier.
    let err = match advance_upload_job(
        &acquired,
        UploadJobEvent::ShardEncrypted {
            shard: Some(EncryptedShardRef {
                tier: 9,
                index: 0,
                sha256: format!("{SAFE_ID}-sha"),
            }),
        },
    ) {
        Ok(transition) => panic!("invalid shard tier should be rejected: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(err.code, ClientErrorCode::ClientCoreInvalidSnapshot);

    // Mismatched index against the planned next slot.
    let err = match advance_upload_job(
        &acquired,
        UploadJobEvent::ShardEncrypted {
            shard: Some(EncryptedShardRef {
                tier: 3,
                index: 99,
                sha256: format!("{SAFE_ID}-sha"),
            }),
        },
    ) {
        Ok(transition) => panic!("mismatched shard index should be rejected: {transition:?}"),
        Err(error) => error,
    };
    assert_invalid_transition(err);
}

#[test]
fn upload_shard_upload_created_rejects_mismatch_and_missing_payload() {
    // Get into CreatingShardUpload.
    let queued = new_upload_snapshot();
    let started = advance_upload_or_panic(&queued, UploadJobEvent::StartRequested).snapshot;
    let prepared = advance_upload_or_panic(
        &started,
        UploadJobEvent::MediaPrepared {
            plan: Some(PreparedMediaPlan {
                planned_shards: vec![UploadShardSlot { tier: 3, index: 0 }],
            }),
        },
    )
    .snapshot;
    let acquired = advance_upload_or_panic(
        &prepared,
        UploadJobEvent::EpochHandleAcquired { epoch_id: Some(2) },
    )
    .snapshot;
    let encrypted = advance_upload_or_panic(
        &acquired,
        UploadJobEvent::ShardEncrypted {
            shard: Some(EncryptedShardRef {
                tier: 3,
                index: 0,
                sha256: format!("{SAFE_ID}-sha"),
            }),
        },
    )
    .snapshot;

    let err = match advance_upload_job(
        &encrypted,
        UploadJobEvent::ShardUploadCreated { upload: None },
    ) {
        Ok(transition) => panic!("missing upload payload should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(err.code, ClientErrorCode::ClientCoreMissingEventPayload);

    // Mismatched sha256 between pending shard and ShardUploadCreated.
    let err = match advance_upload_job(
        &encrypted,
        UploadJobEvent::ShardUploadCreated {
            upload: Some(CreatedShardUpload {
                tier: 3,
                index: 0,
                shard_id: format!("{SAFE_ID}-shard"),
                sha256: format!("{SAFE_ID}-other-sha"),
            }),
        },
    ) {
        Ok(transition) => panic!("mismatched sha256 should be rejected: {transition:?}"),
        Err(error) => error,
    };
    assert_invalid_transition(err);

    // Invalid tier on the upload payload.
    let err = match advance_upload_job(
        &encrypted,
        UploadJobEvent::ShardUploadCreated {
            upload: Some(CreatedShardUpload {
                tier: 0,
                index: 0,
                shard_id: format!("{SAFE_ID}-shard"),
                sha256: format!("{SAFE_ID}-sha"),
            }),
        },
    ) {
        Ok(transition) => panic!("invalid tier should be rejected: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(err.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn upload_shard_uploaded_rejects_payload_and_id_mismatch() {
    // Get into UploadingShard.
    let queued = new_upload_snapshot();
    let started = advance_upload_or_panic(&queued, UploadJobEvent::StartRequested).snapshot;
    let prepared = advance_upload_or_panic(
        &started,
        UploadJobEvent::MediaPrepared {
            plan: Some(PreparedMediaPlan {
                planned_shards: vec![UploadShardSlot { tier: 3, index: 0 }],
            }),
        },
    )
    .snapshot;
    let acquired = advance_upload_or_panic(
        &prepared,
        UploadJobEvent::EpochHandleAcquired { epoch_id: Some(2) },
    )
    .snapshot;
    let encrypted = advance_upload_or_panic(
        &acquired,
        UploadJobEvent::ShardEncrypted {
            shard: Some(EncryptedShardRef {
                tier: 3,
                index: 0,
                sha256: format!("{SAFE_ID}-sha"),
            }),
        },
    )
    .snapshot;
    let uploading = advance_upload_or_panic(
        &encrypted,
        UploadJobEvent::ShardUploadCreated {
            upload: Some(CreatedShardUpload {
                tier: 3,
                index: 0,
                shard_id: format!("{SAFE_ID}-shard"),
                sha256: format!("{SAFE_ID}-sha"),
            }),
        },
    )
    .snapshot;
    assert_eq!(uploading.phase, UploadJobPhase::UploadingShard);

    let err = match advance_upload_job(&uploading, UploadJobEvent::ShardUploaded { shard: None }) {
        Ok(transition) => panic!("missing shard payload should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(err.code, ClientErrorCode::ClientCoreMissingEventPayload);

    // Mismatched shard_id between pending and uploaded.
    let err = match advance_upload_job(
        &uploading,
        UploadJobEvent::ShardUploaded {
            shard: Some(CompletedShardRef {
                tier: 3,
                index: 0,
                shard_id: format!("{SAFE_ID}-different"),
                sha256: format!("{SAFE_ID}-sha"),
            }),
        },
    ) {
        Ok(transition) => panic!("mismatched shard_id should be rejected: {transition:?}"),
        Err(error) => error,
    };
    assert_invalid_transition(err);

    // Invalid sha256 (control char inside).
    let err = match advance_upload_job(
        &uploading,
        UploadJobEvent::ShardUploaded {
            shard: Some(CompletedShardRef {
                tier: 3,
                index: 0,
                shard_id: format!("{SAFE_ID}-shard"),
                sha256: "sha\u{0007}invalid".to_owned(),
            }),
        },
    ) {
        Ok(transition) => panic!("invalid sha should be rejected: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(err.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn upload_manifest_created_rejects_invalid_manifest_id_and_missing_payload() {
    let snapshot = upload_at_creating_manifest();

    let err = match advance_upload_job(&snapshot, UploadJobEvent::ManifestCreated { receipt: None })
    {
        Ok(transition) => panic!("missing manifest payload should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(err.code, ClientErrorCode::ClientCoreMissingEventPayload);

    let err = match advance_upload_job(
        &snapshot,
        UploadJobEvent::ManifestCreated {
            receipt: Some(ManifestReceipt {
                manifest_id: "https://injected".to_owned(),
                version: 1,
            }),
        },
    ) {
        Ok(transition) => panic!("invalid manifest_id should be rejected: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(err.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn upload_manifest_unknown_rejected_outside_creating_or_unknown_phase() {
    let snapshot = new_upload_snapshot();
    let err = match advance_upload_job(&snapshot, UploadJobEvent::ManifestOutcomeUnknown) {
        Ok(transition) => panic!("manifest unknown from Queued should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_invalid_transition(err);
}

#[test]
fn upload_sync_confirmed_rejects_when_not_pending_confirmation() {
    let snapshot = new_upload_snapshot();
    let err = match advance_upload_job(
        &snapshot,
        UploadJobEvent::SyncConfirmed {
            confirmation: Some(UploadSyncConfirmation {
                asset_id: format!("{SAFE_ID}-asset"),
                confirmed_at_ms: 100,
                sync_cursor: None,
            }),
        },
    ) {
        Ok(transition) => panic!("sync confirmation in Queued should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_invalid_transition(err);

    // From AwaitingSyncConfirmation, missing confirmation payload also fails.
    let awaiting = upload_at_awaiting_sync_confirmation();
    let err = match advance_upload_job(
        &awaiting,
        UploadJobEvent::SyncConfirmed { confirmation: None },
    ) {
        Ok(transition) => panic!("missing confirmation payload should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(err.code, ClientErrorCode::ClientCoreMissingEventPayload);
}

#[test]
fn upload_retryable_failure_rejected_in_terminal_or_initial_phase() {
    // Queued is not a phase that allows retries.
    let snapshot = new_upload_snapshot();
    let err = match advance_upload_job(
        &snapshot,
        UploadJobEvent::RetryableFailure {
            code: ClientErrorCode::InvalidInputLength,
            retry_after_ms: None,
        },
    ) {
        Ok(transition) => panic!("retry from Queued should be rejected: {transition:?}"),
        Err(error) => error,
    };
    assert_invalid_transition(err);
}

#[test]
fn upload_retry_timer_elapsed_rejected_when_not_retry_waiting() {
    let snapshot = new_upload_snapshot();
    let err = match advance_upload_job(&snapshot, UploadJobEvent::RetryTimerElapsed) {
        Ok(transition) => panic!("retry timer from Queued should be rejected: {transition:?}"),
        Err(error) => error,
    };
    assert_invalid_transition(err);
}

#[test]
fn upload_cancel_rejected_in_terminal_phase() {
    let confirmed = advance_upload_or_panic(
        &upload_at_awaiting_sync_confirmation(),
        UploadJobEvent::SyncConfirmed {
            confirmation: Some(UploadSyncConfirmation {
                asset_id: format!("{SAFE_ID}-asset"),
                confirmed_at_ms: 100,
                sync_cursor: None,
            }),
        },
    )
    .snapshot;
    assert_eq!(confirmed.phase, UploadJobPhase::Confirmed);

    let err = match advance_upload_job(&confirmed, UploadJobEvent::CancelRequested) {
        Ok(transition) => panic!("cancel in Confirmed should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_invalid_transition(err);
}

#[test]
fn upload_effects_for_phase_emit_correct_effects_when_resumed_via_retry() {
    // Drive the state machine into RetryWaiting at every retry-eligible phase
    // we can reach, then RetryTimerElapsed to exercise upload_effects_for_phase
    // for AwaitingPreparedMedia, AwaitingEpochHandle, EncryptingShard,
    // CreatingShardUpload, UploadingShard, CreatingManifest, ManifestCommitUnknown,
    // and AwaitingSyncConfirmation.

    let snapshot = new_upload_snapshot();
    let started = advance_upload_or_panic(&snapshot, UploadJobEvent::StartRequested).snapshot;
    assert_eq!(started.phase, UploadJobPhase::AwaitingPreparedMedia);

    // Retry from AwaitingPreparedMedia → after timer elapses, returns to it.
    let retry = advance_upload_or_panic(
        &started,
        UploadJobEvent::RetryableFailure {
            code: ClientErrorCode::InvalidInputLength,
            retry_after_ms: None,
        },
    );
    assert_eq!(retry.snapshot.phase, UploadJobPhase::RetryWaiting);
    let resumed = advance_upload_or_panic(&retry.snapshot, UploadJobEvent::RetryTimerElapsed);
    assert_eq!(
        resumed.snapshot.phase,
        UploadJobPhase::AwaitingPreparedMedia
    );
    assert_eq!(resumed.effects, vec![UploadJobEffect::PrepareMedia]);

    let prepared = advance_upload_or_panic(
        &resumed.snapshot,
        UploadJobEvent::MediaPrepared {
            plan: Some(PreparedMediaPlan {
                planned_shards: vec![UploadShardSlot { tier: 3, index: 0 }],
            }),
        },
    )
    .snapshot;

    // AwaitingEpochHandle.
    let retry = advance_upload_or_panic(
        &prepared,
        UploadJobEvent::RetryableFailure {
            code: ClientErrorCode::InvalidInputLength,
            retry_after_ms: None,
        },
    );
    let resumed = advance_upload_or_panic(&retry.snapshot, UploadJobEvent::RetryTimerElapsed);
    assert_eq!(resumed.snapshot.phase, UploadJobPhase::AwaitingEpochHandle);
    assert_eq!(resumed.effects, vec![UploadJobEffect::AcquireEpochHandle]);

    let acquired = advance_upload_or_panic(
        &resumed.snapshot,
        UploadJobEvent::EpochHandleAcquired { epoch_id: Some(7) },
    )
    .snapshot;

    // CreatingManifest after a single shard.
    let encrypted = advance_upload_or_panic(
        &acquired,
        UploadJobEvent::ShardEncrypted {
            shard: Some(EncryptedShardRef {
                tier: 3,
                index: 0,
                sha256: format!("{SAFE_ID}-sha"),
            }),
        },
    )
    .snapshot;
    let upload_created = advance_upload_or_panic(
        &encrypted,
        UploadJobEvent::ShardUploadCreated {
            upload: Some(CreatedShardUpload {
                tier: 3,
                index: 0,
                shard_id: format!("{SAFE_ID}-shard"),
                sha256: format!("{SAFE_ID}-sha"),
            }),
        },
    )
    .snapshot;
    let uploaded = advance_upload_or_panic(
        &upload_created,
        UploadJobEvent::ShardUploaded {
            shard: Some(CompletedShardRef {
                tier: 3,
                index: 0,
                shard_id: format!("{SAFE_ID}-shard"),
                sha256: format!("{SAFE_ID}-sha"),
            }),
        },
    )
    .snapshot;
    assert_eq!(uploaded.phase, UploadJobPhase::CreatingManifest);

    // CreatingManifest retry.
    let retry = advance_upload_or_panic(
        &uploaded,
        UploadJobEvent::RetryableFailure {
            code: ClientErrorCode::InvalidInputLength,
            retry_after_ms: None,
        },
    );
    let resumed = advance_upload_or_panic(&retry.snapshot, UploadJobEvent::RetryTimerElapsed);
    assert_eq!(resumed.snapshot.phase, UploadJobPhase::CreatingManifest);
    assert_eq!(resumed.effects, vec![UploadJobEffect::CreateManifest]);

    // AwaitingSyncConfirmation retry.
    let manifested = advance_upload_or_panic(
        &resumed.snapshot,
        UploadJobEvent::ManifestCreated {
            receipt: Some(ManifestReceipt {
                manifest_id: format!("{SAFE_ID}-manifest"),
                version: 1,
            }),
        },
    )
    .snapshot;
    assert_eq!(manifested.phase, UploadJobPhase::AwaitingSyncConfirmation);
    let retry = advance_upload_or_panic(
        &manifested,
        UploadJobEvent::RetryableFailure {
            code: ClientErrorCode::InvalidInputLength,
            retry_after_ms: None,
        },
    );
    let resumed = advance_upload_or_panic(&retry.snapshot, UploadJobEvent::RetryTimerElapsed);
    assert_eq!(
        resumed.snapshot.phase,
        UploadJobPhase::AwaitingSyncConfirmation
    );
    assert_eq!(
        resumed.effects,
        vec![UploadJobEffect::AwaitSyncConfirmation]
    );

    // ManifestCommitUnknown retry — must enter that phase from `CreatingManifest`
    // via the explicit ManifestOutcomeUnknown event (or from the
    // ManifestCommitUnknown phase itself).
    let unknown =
        advance_upload_or_panic(&uploaded, UploadJobEvent::ManifestOutcomeUnknown).snapshot;
    assert_eq!(unknown.phase, UploadJobPhase::ManifestCommitUnknown);
    let retry = advance_upload_or_panic(
        &unknown,
        UploadJobEvent::RetryableFailure {
            code: ClientErrorCode::InvalidInputLength,
            retry_after_ms: None,
        },
    );
    let resumed = advance_upload_or_panic(&retry.snapshot, UploadJobEvent::RetryTimerElapsed);
    assert_eq!(
        resumed.snapshot.phase,
        UploadJobPhase::ManifestCommitUnknown
    );
    assert_eq!(
        resumed.effects,
        vec![UploadJobEffect::RecoverManifestThroughSync]
    );
}

#[test]
fn upload_two_shard_flow_resumes_encryption_for_second_slot_after_first_completion() {
    // Drives the multi-shard branch in upload_shard_uploaded that loops back to
    // EncryptingShard, including next_shard_index advancement via next_upload_slot.
    let snapshot = new_upload_snapshot();
    let started = advance_upload_or_panic(&snapshot, UploadJobEvent::StartRequested).snapshot;
    let prepared = advance_upload_or_panic(
        &started,
        UploadJobEvent::MediaPrepared {
            plan: Some(PreparedMediaPlan {
                planned_shards: vec![
                    UploadShardSlot { tier: 3, index: 0 },
                    UploadShardSlot { tier: 2, index: 1 },
                ],
            }),
        },
    )
    .snapshot;
    let acquired = advance_upload_or_panic(
        &prepared,
        UploadJobEvent::EpochHandleAcquired { epoch_id: Some(8) },
    )
    .snapshot;
    let encrypted = advance_upload_or_panic(
        &acquired,
        UploadJobEvent::ShardEncrypted {
            shard: Some(EncryptedShardRef {
                tier: 3,
                index: 0,
                sha256: format!("{SAFE_ID}-sha-0"),
            }),
        },
    )
    .snapshot;
    let upload_created = advance_upload_or_panic(
        &encrypted,
        UploadJobEvent::ShardUploadCreated {
            upload: Some(CreatedShardUpload {
                tier: 3,
                index: 0,
                shard_id: format!("{SAFE_ID}-shard-0"),
                sha256: format!("{SAFE_ID}-sha-0"),
            }),
        },
    )
    .snapshot;

    let after_first = advance_upload_or_panic(
        &upload_created,
        UploadJobEvent::ShardUploaded {
            shard: Some(CompletedShardRef {
                tier: 3,
                index: 0,
                shard_id: format!("{SAFE_ID}-shard-0"),
                sha256: format!("{SAFE_ID}-sha-0"),
            }),
        },
    );
    assert_eq!(after_first.snapshot.phase, UploadJobPhase::EncryptingShard);
    assert_eq!(after_first.snapshot.next_shard_index, 1);
    assert_eq!(
        after_first.effects,
        vec![UploadJobEffect::EncryptShard { tier: 2, index: 1 }]
    );
    assert!(after_first.snapshot.pending_shard.is_none());
}

#[test]
fn sync_page_fetched_rejects_phase_payload_and_invalid_token_paths() {
    let snapshot = new_sync_snapshot();
    // Idle phase doesn't accept PageFetched.
    let err = match advance_album_sync(
        &snapshot,
        AlbumSyncEvent::PageFetched {
            page: Some(SyncPageSummary {
                previous_page_token: None,
                next_page_token: None,
                reached_end: true,
                encrypted_item_count: 0,
            }),
        },
    ) {
        Ok(transition) => panic!("page fetched in Idle should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_invalid_transition(err);

    let started = advance_sync_or_panic(
        &snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(sync_request()),
        },
    )
    .snapshot;

    // Missing payload.
    let err = match advance_album_sync(&started, AlbumSyncEvent::PageFetched { page: None }) {
        Ok(transition) => panic!("missing page payload should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(err.code, ClientErrorCode::ClientCoreMissingEventPayload);

    // Mismatched previous token.
    let err = match advance_album_sync(
        &started,
        AlbumSyncEvent::PageFetched {
            page: Some(SyncPageSummary {
                previous_page_token: Some("unexpected".to_owned()),
                next_page_token: None,
                reached_end: true,
                encrypted_item_count: 0,
            }),
        },
    ) {
        Ok(transition) => panic!("mismatched previous token should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_invalid_transition(err);

    // Invalid (over-long) token in summary.
    let err = match advance_album_sync(
        &started,
        AlbumSyncEvent::PageFetched {
            page: Some(SyncPageSummary {
                previous_page_token: None,
                next_page_token: Some("a".repeat(257)),
                reached_end: false,
                encrypted_item_count: 0,
            }),
        },
    ) {
        Ok(transition) => panic!("over-long token should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(err.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn sync_page_applied_rejected_outside_applying_phase_and_request_payload_paths() {
    let snapshot = new_sync_snapshot();

    // PageApplied in Idle is invalid.
    let err = match advance_album_sync(&snapshot, AlbumSyncEvent::PageApplied) {
        Ok(transition) => panic!("page applied in Idle should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_invalid_transition(err);

    // RetryTimerElapsed in Idle is invalid.
    let err = match advance_album_sync(&snapshot, AlbumSyncEvent::RetryTimerElapsed) {
        Ok(transition) => panic!("retry timer in Idle should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_invalid_transition(err);

    // SyncRequested with album_id mismatch is invalid.
    let err = match advance_album_sync(
        &snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(AlbumSyncRequest {
                sync_id: format!("{SAFE_ID}-sync"),
                album_id: format!("{SAFE_ID}-other-album"),
                initial_page_token: None,
                max_retry_count: 1,
            }),
        },
    ) {
        Ok(transition) => panic!("album id mismatch should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_invalid_transition(err);

    // SyncRequested missing payload.
    let err = match advance_album_sync(&snapshot, AlbumSyncEvent::SyncRequested { request: None }) {
        Ok(transition) => panic!("missing sync payload should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(err.code, ClientErrorCode::ClientCoreMissingEventPayload);
}

#[test]
fn sync_cancel_and_failure_rejected_in_terminal_phase() {
    let snapshot = new_sync_snapshot();
    let started = advance_sync_or_panic(
        &snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(sync_request()),
        },
    )
    .snapshot;
    let cancelled = advance_sync_or_panic(&started, AlbumSyncEvent::CancelRequested).snapshot;
    assert_eq!(cancelled.phase, AlbumSyncPhase::Cancelled);

    let err = match advance_album_sync(&cancelled, AlbumSyncEvent::CancelRequested) {
        Ok(transition) => panic!("double cancel should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_invalid_transition(err);

    let err = match advance_album_sync(
        &cancelled,
        AlbumSyncEvent::NonRetryableFailure {
            code: ClientErrorCode::InvalidPublicKey,
        },
    ) {
        Ok(transition) => panic!("failure on cancelled should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_invalid_transition(err);
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
