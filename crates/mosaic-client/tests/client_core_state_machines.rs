use std::fmt::Debug;

use mosaic_client::{
    AlbumSyncEffect, AlbumSyncEvent, AlbumSyncPhase, AlbumSyncRequest, AlbumSyncSnapshot,
    ClientError, ClientErrorCode, CompletedShardRef, CreatedShardUpload, EncryptedShardRef,
    ManifestReceipt, PreparedMediaPlan, SyncPageSummary, UploadJobEffect, UploadJobEvent,
    UploadJobPhase, UploadJobRequest, UploadJobSnapshot, UploadShardSlot, UploadSyncConfirmation,
    advance_album_sync, advance_upload_job, new_album_sync, new_upload_job,
};

const LOCAL_JOB_ID: &str = "job-band2-001";
const UPLOAD_ID: &str = "upload-band2-001";
const ALBUM_ID: &str = "album-band2-001";
const ASSET_ID: &str = "asset-band2-001";
const OTHER_ASSET_ID: &str = "asset-band2-other";
const SYNC_ID: &str = "sync-band2-001";
const EPOCH_ID: u32 = 42;
const ORIGINAL_TIER: u8 = 3;
const SHARD_ZERO_SHA256: &str =
    "sha256:0000000000000000000000000000000000000000000000000000000000000000";
const SHARD_ZERO_ID: &str = "shard-band2-000";
const MANIFEST_ID: &str = "manifest-band2-001";
const RETRY_BUDGET: u32 = 2;
const RETRY_DELAY_MS: u64 = 1_500;
const CURSOR_ONE: &str = "sync-cursor-band2-001";

#[test]
fn upload_happy_path_emits_effects_and_persists_safe_fields() {
    let mut emitted_effects = Vec::new();
    let mut snapshot = new_upload_snapshot(upload_request(RETRY_BUDGET));

    assert_eq!(snapshot.phase, UploadJobPhase::Queued);
    assert_eq!(snapshot.local_job_id, LOCAL_JOB_ID);
    assert_eq!(snapshot.upload_id, UPLOAD_ID);
    assert_eq!(snapshot.album_id, ALBUM_ID);
    assert_eq!(snapshot.asset_id, ASSET_ID);
    assert_eq!(snapshot.retry.max_attempts, RETRY_BUDGET);
    assert_eq!(snapshot.retry.attempt_count, 0);
    assert!(snapshot.completed_shards.is_empty());

    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::StartRequested,
        UploadJobPhase::AwaitingPreparedMedia,
        vec![prepare_media_effect()],
        &mut emitted_effects,
    );

    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::MediaPrepared {
            plan: Some(PreparedMediaPlan {
                planned_shards: vec![slot(ORIGINAL_TIER, 0)],
            }),
        },
        UploadJobPhase::AwaitingEpochHandle,
        vec![acquire_epoch_handle_effect()],
        &mut emitted_effects,
    );
    assert_eq!(snapshot.planned_shard_count, 1);
    assert!(snapshot.completed_shards.is_empty());

    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::EpochHandleAcquired {
            epoch_id: Some(EPOCH_ID),
        },
        UploadJobPhase::EncryptingShard,
        vec![encrypt_shard_effect(0)],
        &mut emitted_effects,
    );
    assert_eq!(snapshot.epoch_id, Some(EPOCH_ID));
    assert_eq!(snapshot.next_shard_index, 0);

    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::ShardEncrypted {
            shard: Some(encrypted_shard(0, SHARD_ZERO_SHA256)),
        },
        UploadJobPhase::CreatingShardUpload,
        vec![create_shard_upload_effect(0, SHARD_ZERO_SHA256)],
        &mut emitted_effects,
    );

    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::ShardUploadCreated {
            upload: Some(created_shard_upload(0, SHARD_ZERO_ID, SHARD_ZERO_SHA256)),
        },
        UploadJobPhase::UploadingShard,
        vec![upload_shard_effect(0, SHARD_ZERO_ID, SHARD_ZERO_SHA256)],
        &mut emitted_effects,
    );

    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::ShardUploaded {
            shard: Some(completed_shard(0, SHARD_ZERO_ID, SHARD_ZERO_SHA256)),
        },
        UploadJobPhase::CreatingManifest,
        vec![create_manifest_effect()],
        &mut emitted_effects,
    );
    assert_eq!(snapshot.completed_shards.len(), 1);

    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::ManifestCreated {
            receipt: Some(ManifestReceipt {
                manifest_id: MANIFEST_ID.to_owned(),
                version: 7,
            }),
        },
        UploadJobPhase::AwaitingSyncConfirmation,
        vec![await_sync_confirmation_effect()],
        &mut emitted_effects,
    );
    assert_eq!(
        snapshot.manifest_receipt,
        Some(ManifestReceipt {
            manifest_id: MANIFEST_ID.to_owned(),
            version: 7,
        })
    );

    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::SyncConfirmed {
            confirmation: Some(sync_confirmation(ASSET_ID)),
        },
        UploadJobPhase::Confirmed,
        Vec::new(),
        &mut emitted_effects,
    );
    assert_eq!(
        snapshot.confirmation_metadata,
        Some(sync_confirmation(ASSET_ID))
    );

    assert_eq!(
        emitted_effects,
        vec![
            prepare_media_effect(),
            acquire_epoch_handle_effect(),
            encrypt_shard_effect(0),
            create_shard_upload_effect(0, SHARD_ZERO_SHA256),
            upload_shard_effect(0, SHARD_ZERO_ID, SHARD_ZERO_SHA256),
            create_manifest_effect(),
            await_sync_confirmation_effect(),
        ]
    );
}

#[test]
fn upload_retry_records_metadata_returns_to_target_and_exhausts_budget() {
    let mut emitted_effects = Vec::new();
    let mut snapshot = upload_at_creating_shard_upload(RETRY_BUDGET, 1);

    snapshot = advance_upload_ok(
        &snapshot,
        retryable_upload_failure(),
        UploadJobPhase::RetryWaiting,
        vec![schedule_upload_retry_effect(
            1,
            UploadJobPhase::CreatingShardUpload,
        )],
        &mut emitted_effects,
    );
    assert_eq!(snapshot.retry.attempt_count, 1);
    assert_eq!(
        snapshot.retry.retry_target_phase,
        Some(UploadJobPhase::CreatingShardUpload)
    );
    assert_eq!(
        snapshot.retry.last_error_code,
        Some(ClientErrorCode::InvalidInputLength)
    );
    assert_eq!(
        snapshot.retry.last_error_stage,
        Some(UploadJobPhase::CreatingShardUpload)
    );

    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::RetryTimerElapsed,
        UploadJobPhase::CreatingShardUpload,
        vec![create_shard_upload_effect(0, SHARD_ZERO_SHA256)],
        &mut emitted_effects,
    );

    snapshot = advance_upload_ok(
        &snapshot,
        retryable_upload_failure(),
        UploadJobPhase::RetryWaiting,
        vec![schedule_upload_retry_effect(
            2,
            UploadJobPhase::CreatingShardUpload,
        )],
        &mut emitted_effects,
    );
    assert_eq!(snapshot.retry.attempt_count, RETRY_BUDGET);

    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::RetryTimerElapsed,
        UploadJobPhase::CreatingShardUpload,
        vec![create_shard_upload_effect(0, SHARD_ZERO_SHA256)],
        &mut emitted_effects,
    );

    snapshot = advance_upload_ok(
        &snapshot,
        retryable_upload_failure(),
        UploadJobPhase::Failed,
        Vec::new(),
        &mut emitted_effects,
    );
    assert_eq!(snapshot.retry.attempt_count, RETRY_BUDGET);
    assert_eq!(
        snapshot.failure_code,
        Some(ClientErrorCode::ClientCoreRetryBudgetExhausted)
    );

    assert_eq!(
        emitted_effects
            .iter()
            .filter(|effect| matches!(effect, UploadJobEffect::ScheduleRetry { .. }))
            .count(),
        RETRY_BUDGET as usize
    );
}

#[test]
fn upload_cancellation_before_work_and_manifest_uncertainty_recover_through_sync() {
    let mut emitted_effects = Vec::new();
    let mut snapshot = new_upload_snapshot(upload_request(RETRY_BUDGET));

    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::StartRequested,
        UploadJobPhase::AwaitingPreparedMedia,
        vec![prepare_media_effect()],
        &mut emitted_effects,
    );

    let cancelled = advance_upload_ok(
        &snapshot,
        UploadJobEvent::CancelRequested,
        UploadJobPhase::Cancelled,
        Vec::new(),
        &mut emitted_effects,
    );
    assert!(cancelled.completed_shards.is_empty());
    assert_eq!(cancelled.manifest_receipt, None);

    let manifest_snapshot = upload_at_creating_manifest(RETRY_BUDGET, 1);
    let cancel_unknown = advance_upload_without_collecting(
        &manifest_snapshot,
        UploadJobEvent::CancelRequested,
        UploadJobPhase::ManifestCommitUnknown,
        vec![recover_manifest_through_sync_effect()],
    );
    assert_eq!(
        cancel_unknown.failure_code,
        Some(ClientErrorCode::ClientCoreManifestOutcomeUnknown)
    );

    let outcome_unknown = advance_upload_without_collecting(
        &manifest_snapshot,
        UploadJobEvent::ManifestOutcomeUnknown,
        UploadJobPhase::ManifestCommitUnknown,
        vec![recover_manifest_through_sync_effect()],
    );
    assert_eq!(
        outcome_unknown.failure_code,
        Some(ClientErrorCode::ClientCoreManifestOutcomeUnknown)
    );

    let mismatch = match advance_upload_job(
        &outcome_unknown,
        UploadJobEvent::SyncConfirmed {
            confirmation: Some(sync_confirmation(OTHER_ASSET_ID)),
        },
    ) {
        Ok(transition) => panic!("mismatched confirmation should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_redacted_error(mismatch, ClientErrorCode::ClientCoreInvalidTransition);

    let confirmed = advance_upload_without_collecting(
        &outcome_unknown,
        UploadJobEvent::SyncConfirmed {
            confirmation: Some(sync_confirmation(ASSET_ID)),
        },
        UploadJobPhase::Confirmed,
        Vec::new(),
    );
    assert_eq!(
        confirmed.confirmation_metadata,
        Some(sync_confirmation(ASSET_ID))
    );
}

#[test]
fn upload_idempotency_rejects_reprocessing_completed_shards() {
    let mut emitted_effects = Vec::new();
    let mut snapshot = upload_at_uploading_shard(RETRY_BUDGET, 2, 0, SHARD_ZERO_ID);

    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::ShardUploaded {
            shard: Some(completed_shard(0, SHARD_ZERO_ID, SHARD_ZERO_SHA256)),
        },
        UploadJobPhase::EncryptingShard,
        vec![encrypt_shard_effect(1)],
        &mut emitted_effects,
    );
    assert_eq!(snapshot.completed_shards.len(), 1);
    assert_eq!(snapshot.next_shard_index, 1);

    let duplicate = match advance_upload_job(
        &snapshot,
        UploadJobEvent::ShardEncrypted {
            shard: Some(encrypted_shard(0, SHARD_ZERO_SHA256)),
        },
    ) {
        Ok(transition) => panic!("completed shard should not be reprocessed: {transition:?}"),
        Err(error) => error,
    };
    assert_redacted_error(duplicate, ClientErrorCode::ClientCoreInvalidTransition);
}

#[test]
fn sync_coordinator_dedupes_active_start_and_reruns_once() {
    let mut snapshot = new_album_sync_snapshot(sync_request(RETRY_BUDGET));
    assert_eq!(snapshot.phase, AlbumSyncPhase::Idle);
    assert!(!snapshot.rerun_requested);

    snapshot = advance_album_ok(
        &snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(sync_request(RETRY_BUDGET)),
        },
        AlbumSyncPhase::FetchingPage,
        vec![fetch_page_effect(None)],
    );

    snapshot = advance_album_ok(
        &snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(sync_request(RETRY_BUDGET)),
        },
        AlbumSyncPhase::FetchingPage,
        Vec::new(),
    );
    assert!(snapshot.rerun_requested);

    snapshot = advance_album_ok(
        &snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(sync_request(RETRY_BUDGET)),
        },
        AlbumSyncPhase::FetchingPage,
        Vec::new(),
    );
    assert!(snapshot.rerun_requested);

    snapshot = advance_album_ok(
        &snapshot,
        AlbumSyncEvent::PageFetched {
            page: Some(SyncPageSummary {
                previous_page_token: None,
                next_page_token: None,
                reached_end: true,
                encrypted_item_count: 2,
            }),
        },
        AlbumSyncPhase::ApplyingPage,
        vec![apply_page_effect(2)],
    );

    snapshot = advance_album_ok(
        &snapshot,
        AlbumSyncEvent::PageApplied,
        AlbumSyncPhase::FetchingPage,
        vec![fetch_page_effect(None)],
    );
    assert!(!snapshot.rerun_requested);
    assert_eq!(snapshot.completed_cycle_count, 1);

    snapshot = advance_album_ok(
        &snapshot,
        AlbumSyncEvent::PageFetched {
            page: Some(SyncPageSummary {
                previous_page_token: None,
                next_page_token: None,
                reached_end: true,
                encrypted_item_count: 0,
            }),
        },
        AlbumSyncPhase::ApplyingPage,
        vec![apply_page_effect(0)],
    );

    snapshot = advance_album_ok(
        &snapshot,
        AlbumSyncEvent::PageApplied,
        AlbumSyncPhase::Completed,
        Vec::new(),
    );
    assert!(!snapshot.rerun_requested);
    assert_eq!(snapshot.completed_cycle_count, 2);
}

#[test]
fn sync_coordinator_rejects_non_advancing_pages_with_stable_error() {
    let snapshot = advance_album_ok(
        &new_album_sync_snapshot(sync_request(RETRY_BUDGET)),
        AlbumSyncEvent::SyncRequested {
            request: Some(sync_request(RETRY_BUDGET)),
        },
        AlbumSyncPhase::FetchingPage,
        vec![fetch_page_effect(None)],
    );

    let fetching_second_page = advance_album_ok(
        &advance_album_ok(
            &snapshot,
            AlbumSyncEvent::PageFetched {
                page: Some(SyncPageSummary {
                    previous_page_token: None,
                    next_page_token: Some(CURSOR_ONE.to_owned()),
                    reached_end: false,
                    encrypted_item_count: 5,
                }),
            },
            AlbumSyncPhase::ApplyingPage,
            vec![apply_page_effect(5)],
        ),
        AlbumSyncEvent::PageApplied,
        AlbumSyncPhase::FetchingPage,
        vec![fetch_page_effect(Some(CURSOR_ONE.to_owned()))],
    );

    let error = match advance_album_sync(
        &fetching_second_page,
        AlbumSyncEvent::PageFetched {
            page: Some(SyncPageSummary {
                previous_page_token: Some(CURSOR_ONE.to_owned()),
                next_page_token: Some(CURSOR_ONE.to_owned()),
                reached_end: false,
                encrypted_item_count: 5,
            }),
        },
    ) {
        Ok(transition) => panic!("non-advancing sync page should fail: {transition:?}"),
        Err(error) => error,
    };

    assert_redacted_error(error, ClientErrorCode::ClientCoreSyncPageDidNotAdvance);
}

#[test]
fn upload_and_sync_snapshot_debug_output_is_privacy_safe() {
    let queued_upload = new_upload_snapshot(upload_request(RETRY_BUDGET));
    let retrying_upload = advance_upload_without_collecting(
        &upload_at_creating_shard_upload(RETRY_BUDGET, 1),
        retryable_upload_failure(),
        UploadJobPhase::RetryWaiting,
        vec![schedule_upload_retry_effect(
            1,
            UploadJobPhase::CreatingShardUpload,
        )],
    );
    let manifest_unknown = advance_upload_without_collecting(
        &upload_at_creating_manifest(RETRY_BUDGET, 1),
        UploadJobEvent::ManifestOutcomeUnknown,
        UploadJobPhase::ManifestCommitUnknown,
        vec![recover_manifest_through_sync_effect()],
    );
    let active_sync = advance_album_ok(
        &advance_album_ok(
            &new_album_sync_snapshot(sync_request(RETRY_BUDGET)),
            AlbumSyncEvent::SyncRequested {
                request: Some(sync_request(RETRY_BUDGET)),
            },
            AlbumSyncPhase::FetchingPage,
            vec![fetch_page_effect(None)],
        ),
        AlbumSyncEvent::SyncRequested {
            request: Some(sync_request(RETRY_BUDGET)),
        },
        AlbumSyncPhase::FetchingPage,
        Vec::new(),
    );

    assert_privacy_safe_debug(&queued_upload);
    assert_privacy_safe_debug(&retrying_upload);
    assert_privacy_safe_debug(&manifest_unknown);
    assert_privacy_safe_debug(&active_sync);

    let error = match new_upload_job(UploadJobRequest {
        local_job_id: "content://picker/IMG_0001.jpg".to_owned(),
        ..upload_request(RETRY_BUDGET)
    }) {
        Ok(snapshot) => panic!("raw picker URI should be rejected: {snapshot:?}"),
        Err(error) => error,
    };
    assert_redacted_error(error, ClientErrorCode::ClientCoreInvalidSnapshot);
}

fn upload_request(retry_budget: u32) -> UploadJobRequest {
    UploadJobRequest {
        local_job_id: LOCAL_JOB_ID.to_owned(),
        upload_id: UPLOAD_ID.to_owned(),
        album_id: ALBUM_ID.to_owned(),
        asset_id: ASSET_ID.to_owned(),
        max_retry_count: retry_budget,
    }
}

fn sync_request(retry_budget: u32) -> AlbumSyncRequest {
    AlbumSyncRequest {
        sync_id: SYNC_ID.to_owned(),
        album_id: ALBUM_ID.to_owned(),
        initial_page_token: None,
        max_retry_count: retry_budget,
    }
}

fn new_upload_snapshot(request: UploadJobRequest) -> UploadJobSnapshot {
    match new_upload_job(request) {
        Ok(snapshot) => snapshot,
        Err(error) => panic!("upload job should initialize: {error:?}"),
    }
}

fn new_album_sync_snapshot(request: AlbumSyncRequest) -> AlbumSyncSnapshot {
    match new_album_sync(request) {
        Ok(snapshot) => snapshot,
        Err(error) => panic!("album sync should initialize: {error:?}"),
    }
}

fn upload_at_creating_shard_upload(
    retry_budget: u32,
    planned_shard_count: u32,
) -> UploadJobSnapshot {
    let mut emitted_effects = Vec::new();
    let snapshot = new_upload_snapshot(upload_request(retry_budget));
    let snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::StartRequested,
        UploadJobPhase::AwaitingPreparedMedia,
        vec![prepare_media_effect()],
        &mut emitted_effects,
    );
    let snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::MediaPrepared {
            plan: Some(media_plan(planned_shard_count)),
        },
        UploadJobPhase::AwaitingEpochHandle,
        vec![acquire_epoch_handle_effect()],
        &mut emitted_effects,
    );
    let snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::EpochHandleAcquired {
            epoch_id: Some(EPOCH_ID),
        },
        UploadJobPhase::EncryptingShard,
        vec![encrypt_shard_effect(0)],
        &mut emitted_effects,
    );
    advance_upload_ok(
        &snapshot,
        UploadJobEvent::ShardEncrypted {
            shard: Some(encrypted_shard(0, SHARD_ZERO_SHA256)),
        },
        UploadJobPhase::CreatingShardUpload,
        vec![create_shard_upload_effect(0, SHARD_ZERO_SHA256)],
        &mut emitted_effects,
    )
}

fn upload_at_uploading_shard(
    retry_budget: u32,
    planned_shard_count: u32,
    index: u32,
    shard_id: &str,
) -> UploadJobSnapshot {
    let mut emitted_effects = Vec::new();
    let snapshot = upload_at_creating_shard_upload(retry_budget, planned_shard_count);
    advance_upload_ok(
        &snapshot,
        UploadJobEvent::ShardUploadCreated {
            upload: Some(created_shard_upload(index, shard_id, SHARD_ZERO_SHA256)),
        },
        UploadJobPhase::UploadingShard,
        vec![upload_shard_effect(index, shard_id, SHARD_ZERO_SHA256)],
        &mut emitted_effects,
    )
}

fn upload_at_creating_manifest(retry_budget: u32, planned_shard_count: u32) -> UploadJobSnapshot {
    let mut emitted_effects = Vec::new();
    let snapshot = upload_at_uploading_shard(retry_budget, planned_shard_count, 0, SHARD_ZERO_ID);
    advance_upload_ok(
        &snapshot,
        UploadJobEvent::ShardUploaded {
            shard: Some(completed_shard(0, SHARD_ZERO_ID, SHARD_ZERO_SHA256)),
        },
        UploadJobPhase::CreatingManifest,
        vec![create_manifest_effect()],
        &mut emitted_effects,
    )
}

fn advance_upload_without_collecting(
    snapshot: &UploadJobSnapshot,
    event: UploadJobEvent,
    expected_phase: UploadJobPhase,
    expected_effects: Vec<UploadJobEffect>,
) -> UploadJobSnapshot {
    let mut emitted_effects = Vec::new();
    advance_upload_ok(
        snapshot,
        event,
        expected_phase,
        expected_effects,
        &mut emitted_effects,
    )
}

fn advance_upload_ok(
    snapshot: &UploadJobSnapshot,
    event: UploadJobEvent,
    expected_phase: UploadJobPhase,
    expected_effects: Vec<UploadJobEffect>,
    emitted_effects: &mut Vec<UploadJobEffect>,
) -> UploadJobSnapshot {
    let transition = match advance_upload_job(snapshot, event) {
        Ok(transition) => transition,
        Err(error) => panic!("upload transition should succeed: {error:?}"),
    };

    assert_eq!(transition.snapshot.phase, expected_phase);
    assert_eq!(transition.effects, expected_effects);
    emitted_effects.extend(transition.effects);
    transition.snapshot
}

fn advance_album_ok(
    snapshot: &AlbumSyncSnapshot,
    event: AlbumSyncEvent,
    expected_phase: AlbumSyncPhase,
    expected_effects: Vec<AlbumSyncEffect>,
) -> AlbumSyncSnapshot {
    let transition = match advance_album_sync(snapshot, event) {
        Ok(transition) => transition,
        Err(error) => panic!("album sync transition should succeed: {error:?}"),
    };

    assert_eq!(transition.snapshot.phase, expected_phase);
    assert_eq!(transition.effects, expected_effects);
    transition.snapshot
}

fn media_plan(planned_shard_count: u32) -> PreparedMediaPlan {
    PreparedMediaPlan {
        planned_shards: (0..planned_shard_count)
            .map(|index| slot(ORIGINAL_TIER, index))
            .collect(),
    }
}

fn retryable_upload_failure() -> UploadJobEvent {
    UploadJobEvent::RetryableFailure {
        code: ClientErrorCode::InvalidInputLength,
        retry_after_ms: Some(RETRY_DELAY_MS),
    }
}

fn prepare_media_effect() -> UploadJobEffect {
    UploadJobEffect::PrepareMedia
}

fn acquire_epoch_handle_effect() -> UploadJobEffect {
    UploadJobEffect::AcquireEpochHandle
}

fn encrypt_shard_effect(index: u32) -> UploadJobEffect {
    UploadJobEffect::EncryptShard {
        tier: ORIGINAL_TIER,
        index,
    }
}

fn create_shard_upload_effect(index: u32, sha256: &str) -> UploadJobEffect {
    UploadJobEffect::CreateShardUpload {
        tier: ORIGINAL_TIER,
        index,
        sha256: sha256.to_owned(),
    }
}

fn upload_shard_effect(index: u32, shard_id: &str, sha256: &str) -> UploadJobEffect {
    UploadJobEffect::UploadShard {
        tier: ORIGINAL_TIER,
        index,
        shard_id: shard_id.to_owned(),
        sha256: sha256.to_owned(),
    }
}

fn create_manifest_effect() -> UploadJobEffect {
    UploadJobEffect::CreateManifest
}

fn await_sync_confirmation_effect() -> UploadJobEffect {
    UploadJobEffect::AwaitSyncConfirmation
}

fn schedule_upload_retry_effect(attempt: u32, target_phase: UploadJobPhase) -> UploadJobEffect {
    UploadJobEffect::ScheduleRetry {
        attempt,
        retry_after_ms: RETRY_DELAY_MS,
        target_phase,
    }
}

fn recover_manifest_through_sync_effect() -> UploadJobEffect {
    UploadJobEffect::RecoverManifestThroughSync
}

fn fetch_page_effect(page_token: Option<String>) -> AlbumSyncEffect {
    AlbumSyncEffect::FetchPage { page_token }
}

fn apply_page_effect(encrypted_item_count: u32) -> AlbumSyncEffect {
    AlbumSyncEffect::ApplyPage {
        encrypted_item_count,
    }
}

fn slot(tier: u8, index: u32) -> UploadShardSlot {
    UploadShardSlot { tier, index }
}

fn encrypted_shard(index: u32, sha256: &str) -> EncryptedShardRef {
    EncryptedShardRef {
        tier: ORIGINAL_TIER,
        index,
        sha256: sha256.to_owned(),
    }
}

fn created_shard_upload(index: u32, shard_id: &str, sha256: &str) -> CreatedShardUpload {
    CreatedShardUpload {
        tier: ORIGINAL_TIER,
        index,
        shard_id: shard_id.to_owned(),
        sha256: sha256.to_owned(),
    }
}

fn completed_shard(index: u32, shard_id: &str, sha256: &str) -> CompletedShardRef {
    CompletedShardRef {
        tier: ORIGINAL_TIER,
        index,
        shard_id: shard_id.to_owned(),
        sha256: sha256.to_owned(),
    }
}

fn sync_confirmation(asset_id: &str) -> UploadSyncConfirmation {
    UploadSyncConfirmation {
        asset_id: asset_id.to_owned(),
        confirmed_at_ms: 1_700_000_000,
        sync_cursor: Some(CURSOR_ONE.to_owned()),
    }
}

fn assert_redacted_error(error: ClientError, code: ClientErrorCode) {
    assert_eq!(error.code, code);
    for forbidden in [
        "content://",
        "file://",
        "IMG_0001",
        ".jpg",
        OTHER_ASSET_ID,
        ALBUM_ID,
        ASSET_ID,
    ] {
        assert!(
            !error.message.contains(forbidden),
            "error message leaked forbidden payload marker {forbidden}: {error:?}"
        );
    }
}

fn assert_privacy_safe_debug<T: Debug>(snapshot: &T) {
    let debug_text = format!("{snapshot:?}");
    let lowered = debug_text.to_ascii_lowercase();
    for term in [
        "content://",
        "file://",
        "password",
        "private",
        "secret",
        "plaintext",
        "filename",
        "picker_uri",
        "exif",
        "gps",
        "camera",
        "device",
    ] {
        assert!(
            !lowered.contains(term),
            "snapshot debug text contains forbidden term `{term}`: {debug_text}"
        );
    }
}
