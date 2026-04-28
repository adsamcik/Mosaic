use mosaic_client::{
    AlbumSyncEffect, AlbumSyncEvent, AlbumSyncPhase, AlbumSyncRequest, ClientError,
    ClientErrorCode, CompletedShardRef, CreatedShardUpload, EncryptedShardRef, ManifestReceipt,
    PreparedMediaPlan, SyncPageSummary, UploadJobEffect, UploadJobEvent, UploadJobPhase,
    UploadJobRequest, UploadShardSlot, UploadSyncConfirmation, advance_album_sync,
    advance_upload_job, new_album_sync, new_upload_job,
};

#[test]
fn upload_job_progresses_through_happy_path_until_sync_confirmation() {
    let mut snapshot = new_upload(upload_request());
    assert_eq!(snapshot.schema_version, 1);
    assert_eq!(snapshot.phase, UploadJobPhase::Queued);

    let transition = advance_upload(&snapshot, UploadJobEvent::StartRequested);
    assert_eq!(
        transition.snapshot.phase,
        UploadJobPhase::AwaitingPreparedMedia
    );
    assert_eq!(transition.effects, vec![UploadJobEffect::PrepareMedia]);
    snapshot = transition.snapshot;

    let transition = advance_upload(
        &snapshot,
        UploadJobEvent::MediaPrepared {
            plan: Some(PreparedMediaPlan {
                planned_shards: vec![slot(3, 0), slot(3, 1)],
            }),
        },
    );
    assert_eq!(
        transition.snapshot.phase,
        UploadJobPhase::AwaitingEpochHandle
    );
    assert_eq!(
        transition.effects,
        vec![UploadJobEffect::AcquireEpochHandle]
    );
    snapshot = transition.snapshot;

    let transition = advance_upload(
        &snapshot,
        UploadJobEvent::EpochHandleAcquired { epoch_id: Some(42) },
    );
    assert_eq!(transition.snapshot.phase, UploadJobPhase::EncryptingShard);
    assert_eq!(transition.snapshot.epoch_id, Some(42));
    assert_eq!(
        transition.effects,
        vec![UploadJobEffect::EncryptShard { tier: 3, index: 0 }]
    );
    snapshot = transition.snapshot;

    snapshot = encrypt_create_and_upload_shard(snapshot, 3, 0, "sha256-0", "shard-0");
    assert_eq!(snapshot.phase, UploadJobPhase::EncryptingShard);
    assert_eq!(snapshot.next_shard_index, 1);

    let transition = advance_upload(
        &snapshot,
        UploadJobEvent::ShardEncrypted {
            shard: Some(EncryptedShardRef {
                tier: 3,
                index: 1,
                sha256: "sha256-1".to_owned(),
            }),
        },
    );
    assert_eq!(
        transition.snapshot.phase,
        UploadJobPhase::CreatingShardUpload
    );
    assert_eq!(
        transition.effects,
        vec![UploadJobEffect::CreateShardUpload {
            tier: 3,
            index: 1,
            sha256: "sha256-1".to_owned()
        }]
    );
    snapshot = transition.snapshot;

    let transition = advance_upload(
        &snapshot,
        UploadJobEvent::ShardUploadCreated {
            upload: Some(CreatedShardUpload {
                tier: 3,
                index: 1,
                shard_id: "shard-1".to_owned(),
                sha256: "sha256-1".to_owned(),
            }),
        },
    );
    assert_eq!(transition.snapshot.phase, UploadJobPhase::UploadingShard);
    assert_eq!(
        transition.effects,
        vec![UploadJobEffect::UploadShard {
            tier: 3,
            index: 1,
            shard_id: "shard-1".to_owned(),
            sha256: "sha256-1".to_owned()
        }]
    );
    snapshot = transition.snapshot;

    let transition = advance_upload(
        &snapshot,
        UploadJobEvent::ShardUploaded {
            shard: Some(completed(3, 1, "shard-1", "sha256-1")),
        },
    );
    assert_eq!(transition.snapshot.phase, UploadJobPhase::CreatingManifest);
    assert_eq!(transition.snapshot.completed_shards.len(), 2);
    assert_eq!(transition.effects, vec![UploadJobEffect::CreateManifest]);
    snapshot = transition.snapshot;

    let transition = advance_upload(
        &snapshot,
        UploadJobEvent::ManifestCreated {
            receipt: Some(ManifestReceipt {
                manifest_id: "manifest-1".to_owned(),
                version: 7,
            }),
        },
    );
    assert_eq!(
        transition.snapshot.phase,
        UploadJobPhase::AwaitingSyncConfirmation
    );
    assert_eq!(
        transition.effects,
        vec![UploadJobEffect::AwaitSyncConfirmation]
    );
    snapshot = transition.snapshot;

    let transition = advance_upload(
        &snapshot,
        UploadJobEvent::SyncConfirmed {
            confirmation: Some(UploadSyncConfirmation {
                asset_id: "asset-1".to_owned(),
                confirmed_at_ms: 1_700_000_000,
                sync_cursor: Some("cursor-1".to_owned()),
            }),
        },
    );
    assert_eq!(transition.snapshot.phase, UploadJobPhase::Confirmed);
    assert_eq!(
        transition.snapshot.confirmation_metadata,
        Some(UploadSyncConfirmation {
            asset_id: "asset-1".to_owned(),
            confirmed_at_ms: 1_700_000_000,
            sync_cursor: Some("cursor-1".to_owned()),
        })
    );
    assert!(transition.effects.is_empty());
}

#[test]
fn upload_retry_waits_then_returns_to_recorded_target_and_exhausts_budget() {
    let mut snapshot = new_upload(UploadJobRequest {
        max_retry_count: 1,
        ..upload_request()
    });
    snapshot = advance_upload(&snapshot, UploadJobEvent::StartRequested).snapshot;

    let transition = advance_upload(
        &snapshot,
        UploadJobEvent::RetryableFailure {
            code: ClientErrorCode::InvalidInputLength,
            retry_after_ms: Some(250),
        },
    );
    assert_eq!(transition.snapshot.phase, UploadJobPhase::RetryWaiting);
    assert_eq!(transition.snapshot.retry.attempt_count, 1);
    assert_eq!(
        transition.effects,
        vec![UploadJobEffect::ScheduleRetry {
            attempt: 1,
            retry_after_ms: 250,
            target_phase: UploadJobPhase::AwaitingPreparedMedia
        }]
    );
    snapshot = transition.snapshot;

    let transition = advance_upload(&snapshot, UploadJobEvent::RetryTimerElapsed);
    assert_eq!(
        transition.snapshot.phase,
        UploadJobPhase::AwaitingPreparedMedia
    );
    assert_eq!(transition.effects, vec![UploadJobEffect::PrepareMedia]);
    snapshot = transition.snapshot;

    let transition = advance_upload(
        &snapshot,
        UploadJobEvent::MediaPrepared {
            plan: Some(PreparedMediaPlan {
                planned_shards: vec![slot(3, 0)],
            }),
        },
    );
    assert_eq!(
        transition.snapshot.phase,
        UploadJobPhase::AwaitingEpochHandle
    );
    assert_eq!(transition.snapshot.retry.attempt_count, 0);
    snapshot = transition.snapshot;

    let transition = advance_upload(
        &snapshot,
        UploadJobEvent::RetryableFailure {
            code: ClientErrorCode::InvalidInputLength,
            retry_after_ms: Some(250),
        },
    );
    assert_eq!(transition.snapshot.phase, UploadJobPhase::RetryWaiting);
    assert_eq!(transition.snapshot.retry.attempt_count, 1);
    snapshot = advance_upload(&transition.snapshot, UploadJobEvent::RetryTimerElapsed).snapshot;

    let transition = advance_upload(
        &snapshot,
        UploadJobEvent::RetryableFailure {
            code: ClientErrorCode::InvalidInputLength,
            retry_after_ms: Some(250),
        },
    );
    assert_eq!(transition.snapshot.phase, UploadJobPhase::Failed);
    assert_eq!(
        transition.snapshot.failure_code,
        Some(ClientErrorCode::ClientCoreRetryBudgetExhausted)
    );
    assert!(transition.effects.is_empty());
}

#[test]
fn upload_cancel_before_manifest_finalize_moves_to_cancelled() {
    let snapshot = advance_upload(
        &new_upload(upload_request()),
        UploadJobEvent::StartRequested,
    )
    .snapshot;

    let transition = advance_upload(&snapshot, UploadJobEvent::CancelRequested);

    assert_eq!(transition.snapshot.phase, UploadJobPhase::Cancelled);
    assert!(transition.effects.is_empty());
}

#[test]
fn upload_manifest_unknown_recovers_through_sync_confirmation() {
    let snapshot = upload_ready_to_create_manifest();

    let transition = advance_upload(&snapshot, UploadJobEvent::ManifestOutcomeUnknown);
    assert_eq!(
        transition.snapshot.phase,
        UploadJobPhase::ManifestCommitUnknown
    );
    assert_eq!(
        transition.snapshot.failure_code,
        Some(ClientErrorCode::ClientCoreManifestOutcomeUnknown)
    );
    assert_eq!(
        transition.effects,
        vec![UploadJobEffect::RecoverManifestThroughSync]
    );
    let snapshot = transition.snapshot;

    let mismatched = match advance_upload_job(
        &snapshot,
        UploadJobEvent::SyncConfirmed {
            confirmation: Some(UploadSyncConfirmation {
                asset_id: "asset-other".to_owned(),
                confirmed_at_ms: 1_700_000_000,
                sync_cursor: None,
            }),
        },
    ) {
        Ok(value) => panic!("mismatched sync confirmation should fail: {value:?}"),
        Err(error) => error,
    };
    assert_redacted_error(mismatched, ClientErrorCode::ClientCoreInvalidTransition);

    let transition = advance_upload(
        &snapshot,
        UploadJobEvent::SyncConfirmed {
            confirmation: Some(UploadSyncConfirmation {
                asset_id: "asset-1".to_owned(),
                confirmed_at_ms: 1_700_000_000,
                sync_cursor: None,
            }),
        },
    );
    assert_eq!(transition.snapshot.phase, UploadJobPhase::Confirmed);
    assert!(transition.effects.is_empty());
}

#[test]
fn album_sync_dedupes_same_album_request_and_runs_one_follow_up_cycle() {
    let mut snapshot = new_sync(sync_request());
    assert_eq!(snapshot.phase, AlbumSyncPhase::Idle);

    let transition = advance_sync(
        &snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(sync_request()),
        },
    );
    assert_eq!(transition.snapshot.phase, AlbumSyncPhase::FetchingPage);
    assert_eq!(
        transition.effects,
        vec![AlbumSyncEffect::FetchPage { page_token: None }]
    );
    snapshot = transition.snapshot;

    let transition = advance_sync(
        &snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(sync_request()),
        },
    );
    assert_eq!(transition.snapshot.phase, AlbumSyncPhase::FetchingPage);
    assert!(transition.snapshot.rerun_requested);
    assert!(transition.effects.is_empty());
    snapshot = transition.snapshot;

    let transition = advance_sync(
        &snapshot,
        AlbumSyncEvent::PageFetched {
            page: Some(SyncPageSummary {
                previous_page_token: None,
                next_page_token: None,
                reached_end: true,
                encrypted_item_count: 3,
            }),
        },
    );
    assert_eq!(transition.snapshot.phase, AlbumSyncPhase::ApplyingPage);
    assert_eq!(
        transition.effects,
        vec![AlbumSyncEffect::ApplyPage {
            encrypted_item_count: 3
        }]
    );
    snapshot = transition.snapshot;

    let transition = advance_sync(&snapshot, AlbumSyncEvent::PageApplied);
    assert_eq!(transition.snapshot.phase, AlbumSyncPhase::FetchingPage);
    assert!(!transition.snapshot.rerun_requested);
    assert_eq!(
        transition.effects,
        vec![AlbumSyncEffect::FetchPage { page_token: None }]
    );
    snapshot = transition.snapshot;

    let transition = advance_sync(
        &snapshot,
        AlbumSyncEvent::PageFetched {
            page: Some(SyncPageSummary {
                previous_page_token: None,
                next_page_token: None,
                reached_end: true,
                encrypted_item_count: 0,
            }),
        },
    );
    snapshot = transition.snapshot;
    let transition = advance_sync(&snapshot, AlbumSyncEvent::PageApplied);
    assert_eq!(transition.snapshot.phase, AlbumSyncPhase::Completed);
    assert!(transition.effects.is_empty());
}

#[test]
fn snapshots_and_errors_do_not_expose_obvious_forbidden_payloads() {
    let mut snapshot = new_upload(upload_request());
    snapshot = advance_upload(&snapshot, UploadJobEvent::StartRequested).snapshot;
    snapshot = advance_upload(
        &snapshot,
        UploadJobEvent::MediaPrepared {
            plan: Some(PreparedMediaPlan {
                planned_shards: vec![slot(3, 0)],
            }),
        },
    )
    .snapshot;

    let debug = format!("{snapshot:?}");
    for forbidden in [
        "content://",
        "file://",
        "C:\\",
        "IMG_0001",
        ".jpg",
        "password",
        "secret",
        "plaintext",
    ] {
        assert!(
            !debug.contains(forbidden),
            "snapshot debug leaked forbidden payload marker {forbidden}"
        );
    }

    let error = match new_upload_job(UploadJobRequest {
        local_job_id: "content://picker/IMG_0001.jpg".to_owned(),
        ..upload_request()
    }) {
        Ok(value) => panic!("raw picker URI should be rejected: {value:?}"),
        Err(error) => error,
    };
    assert_redacted_error(error, ClientErrorCode::ClientCoreInvalidSnapshot);
}

fn upload_ready_to_create_manifest() -> mosaic_client::UploadJobSnapshot {
    let mut snapshot = new_upload(upload_request());
    snapshot = advance_upload(&snapshot, UploadJobEvent::StartRequested).snapshot;
    snapshot = advance_upload(
        &snapshot,
        UploadJobEvent::MediaPrepared {
            plan: Some(PreparedMediaPlan {
                planned_shards: vec![slot(3, 0)],
            }),
        },
    )
    .snapshot;
    snapshot = advance_upload(
        &snapshot,
        UploadJobEvent::EpochHandleAcquired { epoch_id: Some(42) },
    )
    .snapshot;
    encrypt_create_and_upload_shard(snapshot, 3, 0, "sha256-0", "shard-0")
}

fn encrypt_create_and_upload_shard(
    mut snapshot: mosaic_client::UploadJobSnapshot,
    tier: u8,
    index: u32,
    sha256: &str,
    shard_id: &str,
) -> mosaic_client::UploadJobSnapshot {
    snapshot = advance_upload(
        &snapshot,
        UploadJobEvent::ShardEncrypted {
            shard: Some(EncryptedShardRef {
                tier,
                index,
                sha256: sha256.to_owned(),
            }),
        },
    )
    .snapshot;
    snapshot = advance_upload(
        &snapshot,
        UploadJobEvent::ShardUploadCreated {
            upload: Some(CreatedShardUpload {
                tier,
                index,
                shard_id: shard_id.to_owned(),
                sha256: sha256.to_owned(),
            }),
        },
    )
    .snapshot;
    advance_upload(
        &snapshot,
        UploadJobEvent::ShardUploaded {
            shard: Some(completed(tier, index, shard_id, sha256)),
        },
    )
    .snapshot
}

fn upload_request() -> UploadJobRequest {
    UploadJobRequest {
        local_job_id: "job-1".to_owned(),
        upload_id: "upload-1".to_owned(),
        album_id: "album-1".to_owned(),
        asset_id: "asset-1".to_owned(),
        max_retry_count: 3,
    }
}

fn sync_request() -> AlbumSyncRequest {
    AlbumSyncRequest {
        sync_id: "sync-1".to_owned(),
        album_id: "album-1".to_owned(),
        initial_page_token: None,
        max_retry_count: 3,
    }
}

fn new_upload(request: UploadJobRequest) -> mosaic_client::UploadJobSnapshot {
    match new_upload_job(request) {
        Ok(value) => value,
        Err(error) => panic!("upload job should initialize: {error:?}"),
    }
}

fn new_sync(request: AlbumSyncRequest) -> mosaic_client::AlbumSyncSnapshot {
    match new_album_sync(request) {
        Ok(value) => value,
        Err(error) => panic!("album sync should initialize: {error:?}"),
    }
}

fn advance_upload(
    snapshot: &mosaic_client::UploadJobSnapshot,
    event: UploadJobEvent,
) -> mosaic_client::UploadJobTransition {
    match advance_upload_job(snapshot, event) {
        Ok(value) => value,
        Err(error) => panic!("upload transition should succeed: {error:?}"),
    }
}

fn advance_sync(
    snapshot: &mosaic_client::AlbumSyncSnapshot,
    event: AlbumSyncEvent,
) -> mosaic_client::AlbumSyncTransition {
    match advance_album_sync(snapshot, event) {
        Ok(value) => value,
        Err(error) => panic!("sync transition should succeed: {error:?}"),
    }
}

fn slot(tier: u8, index: u32) -> UploadShardSlot {
    UploadShardSlot { tier, index }
}

fn completed(tier: u8, index: u32, shard_id: &str, sha256: &str) -> CompletedShardRef {
    CompletedShardRef {
        tier,
        index,
        shard_id: shard_id.to_owned(),
        sha256: sha256.to_owned(),
    }
}

fn assert_redacted_error(error: ClientError, code: ClientErrorCode) {
    assert_eq!(error.code, code);
    for forbidden in ["content://", "IMG_0001", ".jpg", "asset-other", "album-1"] {
        assert!(
            !error.message.contains(forbidden),
            "error message leaked forbidden payload marker {forbidden}"
        );
    }
}
