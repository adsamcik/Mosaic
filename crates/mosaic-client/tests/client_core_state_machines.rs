use std::fmt::Debug;

use mosaic_client::{
    AlbumSyncEffect, AlbumSyncEvent, AlbumSyncPhase, AlbumSyncRequest, AlbumSyncSnapshot,
    ClientErrorCode, UploadJobEffect, UploadJobEvent, UploadJobPhase, UploadJobRequest,
    UploadJobSnapshot, advance_album_sync, advance_upload_job, new_album_sync, new_upload_job,
};

const JOB_ID: &str = "job-band2-001";
const ALBUM_ID: &str = "album-band2-001";
const LOCAL_ASSET_ID: &str = "asset-local-band2-001";
const REMOTE_ASSET_ID: &str = "asset-remote-band2-001";
const OTHER_ASSET_ID: &str = "asset-local-band2-other";
const OTHER_REMOTE_ASSET_ID: &str = "asset-remote-band2-other";
const EPOCH_ID: u64 = 42;
const ORIGINAL_TIER: u8 = 3;
const SHARD_ZERO_SHA256: &str =
    "sha256:0000000000000000000000000000000000000000000000000000000000000000";
const SHARD_ZERO_ID: &str = "shard-band2-000";
const UPLOAD_ZERO_ID: &str = "upload-band2-000";
const MANIFEST_ID: &str = "manifest-band2-001";
const RETRY_BUDGET: u32 = 2;
const RETRY_DELAY_MS: u64 = 1_500;
const CURSOR_ONE: &str = "sync-cursor-band2-001";

#[test]
fn upload_happy_path_emits_effects_and_persists_safe_fields() {
    let mut emitted_effects = Vec::new();
    let mut snapshot = new_upload_snapshot(upload_request(RETRY_BUDGET));

    assert_eq!(snapshot.phase, UploadJobPhase::Queued);
    assert_eq!(snapshot.job_id, JOB_ID);
    assert_eq!(snapshot.album_id, ALBUM_ID);
    assert_eq!(snapshot.local_asset_id, LOCAL_ASSET_ID);
    assert_eq!(snapshot.retry_budget, RETRY_BUDGET);
    assert_eq!(snapshot.retry_count, 0);
    assert_eq!(snapshot.completed_shard_count, 0);

    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::StartRequested,
        UploadJobPhase::AwaitingPreparedMedia,
        vec![prepare_media_effect()],
        &mut emitted_effects,
    );

    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::PreparedMedia {
            planned_shard_count: 1,
        },
        UploadJobPhase::AwaitingEpochHandle,
        vec![open_epoch_handle_effect()],
        &mut emitted_effects,
    );
    assert_eq!(snapshot.planned_shard_count, 1);
    assert_eq!(snapshot.completed_shard_count, 0);

    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::EpochHandleReady { epoch_id: EPOCH_ID },
        UploadJobPhase::EncryptingShard,
        vec![encrypt_shard_effect(0)],
        &mut emitted_effects,
    );
    assert_eq!(snapshot.epoch_id, Some(EPOCH_ID));
    assert_eq!(snapshot.current_shard_index, 0);

    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::ShardEncrypted {
            tier: ORIGINAL_TIER,
            index: 0,
            encrypted_sha256: SHARD_ZERO_SHA256.to_owned(),
            encrypted_size_bytes: 4_096,
        },
        UploadJobPhase::CreatingShardUpload,
        vec![create_shard_upload_effect(0, SHARD_ZERO_SHA256)],
        &mut emitted_effects,
    );

    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::ShardUploadCreated {
            tier: ORIGINAL_TIER,
            index: 0,
            upload_id: UPLOAD_ZERO_ID.to_owned(),
        },
        UploadJobPhase::UploadingShard,
        vec![upload_shard_effect(0, UPLOAD_ZERO_ID)],
        &mut emitted_effects,
    );

    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::ShardUploaded {
            tier: ORIGINAL_TIER,
            index: 0,
            shard_id: SHARD_ZERO_ID.to_owned(),
            encrypted_sha256: SHARD_ZERO_SHA256.to_owned(),
        },
        UploadJobPhase::CreatingManifest,
        vec![create_manifest_effect(1)],
        &mut emitted_effects,
    );
    assert_eq!(snapshot.completed_shard_count, 1);

    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::ManifestCreated {
            manifest_id: MANIFEST_ID.to_owned(),
            version: 7,
        },
        UploadJobPhase::AwaitingSyncConfirmation,
        vec![request_sync_confirmation_effect()],
        &mut emitted_effects,
    );
    assert_eq!(snapshot.manifest_id.as_deref(), Some(MANIFEST_ID));
    assert_eq!(snapshot.manifest_version, Some(7));

    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::SyncConfirmed {
            local_asset_id: LOCAL_ASSET_ID.to_owned(),
            remote_asset_id: REMOTE_ASSET_ID.to_owned(),
        },
        UploadJobPhase::Confirmed,
        Vec::new(),
        &mut emitted_effects,
    );
    assert_eq!(
        snapshot.confirmed_remote_asset_id.as_deref(),
        Some(REMOTE_ASSET_ID)
    );

    assert_eq!(
        emitted_effects,
        vec![
            prepare_media_effect(),
            open_epoch_handle_effect(),
            encrypt_shard_effect(0),
            create_shard_upload_effect(0, SHARD_ZERO_SHA256),
            upload_shard_effect(0, UPLOAD_ZERO_ID),
            create_manifest_effect(1),
            request_sync_confirmation_effect(),
        ]
    );
}

#[test]
fn upload_retry_records_metadata_returns_to_target_and_exhausts_budget() {
    let mut emitted_effects = Vec::new();
    let mut snapshot = upload_at_creating_shard_upload(RETRY_BUDGET, 1);

    snapshot = advance_upload_ok(
        &snapshot,
        retryable_upload_failure("create_shard_upload", "http_503"),
        UploadJobPhase::RetryWaiting,
        vec![schedule_upload_retry_effect(
            1,
            UploadJobPhase::CreatingShardUpload,
        )],
        &mut emitted_effects,
    );
    assert_eq!(snapshot.retry_count, 1);
    assert_eq!(
        snapshot.retry_target_phase,
        Some(UploadJobPhase::CreatingShardUpload)
    );
    assert_eq!(snapshot.last_error_code.as_deref(), Some("http_503"));
    assert_eq!(
        snapshot.last_error_stage.as_deref(),
        Some("create_shard_upload")
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
        retryable_upload_failure("create_shard_upload", "http_503"),
        UploadJobPhase::RetryWaiting,
        vec![schedule_upload_retry_effect(
            2,
            UploadJobPhase::CreatingShardUpload,
        )],
        &mut emitted_effects,
    );
    assert_eq!(snapshot.retry_count, RETRY_BUDGET);

    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::RetryTimerElapsed,
        UploadJobPhase::CreatingShardUpload,
        vec![create_shard_upload_effect(0, SHARD_ZERO_SHA256)],
        &mut emitted_effects,
    );

    snapshot = advance_upload_ok(
        &snapshot,
        retryable_upload_failure("create_shard_upload", "http_503"),
        UploadJobPhase::Failed,
        Vec::new(),
        &mut emitted_effects,
    );
    assert_eq!(snapshot.retry_count, RETRY_BUDGET);
    assert_eq!(snapshot.retry_target_phase, None);
    assert_eq!(snapshot.last_error_code.as_deref(), Some("http_503"));
    assert_eq!(
        snapshot.last_error_stage.as_deref(),
        Some("create_shard_upload")
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
    assert_eq!(cancelled.completed_shard_count, 0);
    assert_eq!(cancelled.manifest_id, None);

    let manifest_snapshot = upload_at_creating_manifest(RETRY_BUDGET, 1);
    let cancel_unknown = advance_upload_without_collecting(
        &manifest_snapshot,
        UploadJobEvent::CancelRequested,
        UploadJobPhase::ManifestCommitUnknown,
        vec![recover_manifest_by_sync_effect()],
    );
    assert_eq!(
        cancel_unknown.last_error_stage.as_deref(),
        Some("manifest_commit")
    );

    let outcome_unknown = advance_upload_without_collecting(
        &manifest_snapshot,
        UploadJobEvent::ManifestOutcomeUnknown {
            error_code: "transport_unknown".to_owned(),
        },
        UploadJobPhase::ManifestCommitUnknown,
        vec![recover_manifest_by_sync_effect()],
    );
    assert_eq!(
        outcome_unknown.last_error_code.as_deref(),
        Some("transport_unknown")
    );
}

#[test]
fn upload_idempotency_skips_completed_shards_and_manifest_recovery_matches_local_asset() {
    let mut emitted_effects = Vec::new();
    let mut snapshot = upload_at_uploading_shard(RETRY_BUDGET, 2, 0, UPLOAD_ZERO_ID);

    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::ShardUploaded {
            tier: ORIGINAL_TIER,
            index: 0,
            shard_id: SHARD_ZERO_ID.to_owned(),
            encrypted_sha256: SHARD_ZERO_SHA256.to_owned(),
        },
        UploadJobPhase::EncryptingShard,
        vec![encrypt_shard_effect(1)],
        &mut emitted_effects,
    );
    assert_eq!(snapshot.completed_shard_count, 1);
    assert_eq!(snapshot.current_shard_index, 1);

    let resumed = advance_upload_without_collecting(
        &snapshot,
        UploadJobEvent::ResumeRequested,
        UploadJobPhase::EncryptingShard,
        vec![encrypt_shard_effect(1)],
    );
    assert_eq!(resumed.completed_shard_count, 1);
    assert_eq!(resumed.current_shard_index, 1);

    assert!(
        emitted_effects.iter().all(|effect| !matches!(
            effect,
            UploadJobEffect::EncryptShard { index: 0, .. }
                | UploadJobEffect::CreateShardUpload { index: 0, .. }
                | UploadJobEffect::UploadShard { index: 0, .. }
        )),
        "completed shard 0 must not be re-requested: {emitted_effects:?}"
    );

    let manifest_snapshot = upload_at_creating_manifest(RETRY_BUDGET, 1);
    let unknown = advance_upload_without_collecting(
        &manifest_snapshot,
        UploadJobEvent::ManifestOutcomeUnknown {
            error_code: "transport_unknown".to_owned(),
        },
        UploadJobPhase::ManifestCommitUnknown,
        vec![recover_manifest_by_sync_effect()],
    );

    let still_unknown = advance_upload_without_collecting(
        &unknown,
        UploadJobEvent::SyncConfirmed {
            local_asset_id: OTHER_ASSET_ID.to_owned(),
            remote_asset_id: OTHER_REMOTE_ASSET_ID.to_owned(),
        },
        UploadJobPhase::ManifestCommitUnknown,
        Vec::new(),
    );
    assert_eq!(still_unknown.confirmed_remote_asset_id, None);

    let confirmed = advance_upload_without_collecting(
        &still_unknown,
        UploadJobEvent::SyncConfirmed {
            local_asset_id: LOCAL_ASSET_ID.to_owned(),
            remote_asset_id: REMOTE_ASSET_ID.to_owned(),
        },
        UploadJobPhase::Confirmed,
        Vec::new(),
    );
    assert_eq!(
        confirmed.confirmed_remote_asset_id.as_deref(),
        Some(REMOTE_ASSET_ID)
    );
}

#[test]
fn sync_coordinator_dedupes_active_start_and_reruns_once() {
    let mut snapshot = new_album_sync_snapshot(sync_request(RETRY_BUDGET));
    assert_eq!(snapshot.phase, AlbumSyncPhase::Idle);
    assert!(!snapshot.rerun_requested);

    snapshot = advance_album_ok(
        &snapshot,
        AlbumSyncEvent::StartRequested,
        AlbumSyncPhase::FetchingPage,
        vec![fetch_page_effect(None)],
    );

    snapshot = advance_album_ok(
        &snapshot,
        AlbumSyncEvent::StartRequested,
        AlbumSyncPhase::FetchingPage,
        Vec::new(),
    );
    assert!(snapshot.rerun_requested);

    snapshot = advance_album_ok(
        &snapshot,
        AlbumSyncEvent::StartRequested,
        AlbumSyncPhase::FetchingPage,
        Vec::new(),
    );
    assert!(snapshot.rerun_requested);

    snapshot = advance_album_ok(
        &snapshot,
        AlbumSyncEvent::PageFetched {
            requested_cursor: None,
            next_cursor: Some(CURSOR_ONE.to_owned()),
            item_count: 2,
            has_more: true,
        },
        AlbumSyncPhase::ApplyingPage,
        vec![apply_page_effect(Some(CURSOR_ONE.to_owned()), 2, true)],
    );

    snapshot = advance_album_ok(
        &snapshot,
        AlbumSyncEvent::PageApplied {
            applied_cursor: Some(CURSOR_ONE.to_owned()),
        },
        AlbumSyncPhase::FetchingPage,
        vec![fetch_page_effect(Some(CURSOR_ONE.to_owned()))],
    );

    snapshot = advance_album_ok(
        &snapshot,
        AlbumSyncEvent::PageFetched {
            requested_cursor: Some(CURSOR_ONE.to_owned()),
            next_cursor: None,
            item_count: 1,
            has_more: false,
        },
        AlbumSyncPhase::ApplyingPage,
        vec![apply_page_effect(None, 1, false)],
    );

    snapshot = advance_album_ok(
        &snapshot,
        AlbumSyncEvent::PageApplied {
            applied_cursor: None,
        },
        AlbumSyncPhase::FetchingPage,
        vec![fetch_page_effect(None)],
    );
    assert!(!snapshot.rerun_requested);

    snapshot = advance_album_ok(
        &snapshot,
        AlbumSyncEvent::PageFetched {
            requested_cursor: None,
            next_cursor: None,
            item_count: 0,
            has_more: false,
        },
        AlbumSyncPhase::ApplyingPage,
        vec![apply_page_effect(None, 0, false)],
    );

    snapshot = advance_album_ok(
        &snapshot,
        AlbumSyncEvent::PageApplied {
            applied_cursor: None,
        },
        AlbumSyncPhase::Completed,
        Vec::new(),
    );
    assert!(!snapshot.rerun_requested);
}

#[test]
fn sync_coordinator_rejects_non_advancing_pages_with_stable_error() {
    let snapshot = advance_album_ok(
        &new_album_sync_snapshot(sync_request(RETRY_BUDGET)),
        AlbumSyncEvent::StartRequested,
        AlbumSyncPhase::FetchingPage,
        vec![fetch_page_effect(None)],
    );

    let fetching_second_page = advance_album_ok(
        &advance_album_ok(
            &snapshot,
            AlbumSyncEvent::PageFetched {
                requested_cursor: None,
                next_cursor: Some(CURSOR_ONE.to_owned()),
                item_count: 5,
                has_more: true,
            },
            AlbumSyncPhase::ApplyingPage,
            vec![apply_page_effect(Some(CURSOR_ONE.to_owned()), 5, true)],
        ),
        AlbumSyncEvent::PageApplied {
            applied_cursor: Some(CURSOR_ONE.to_owned()),
        },
        AlbumSyncPhase::FetchingPage,
        vec![fetch_page_effect(Some(CURSOR_ONE.to_owned()))],
    );

    let error = match advance_album_sync(
        &fetching_second_page,
        AlbumSyncEvent::PageFetched {
            requested_cursor: Some(CURSOR_ONE.to_owned()),
            next_cursor: Some(CURSOR_ONE.to_owned()),
            item_count: 5,
            has_more: true,
        },
    ) {
        Ok(transition) => panic!("non-advancing sync page should fail: {transition:?}"),
        Err(error) => error,
    };

    assert_eq!(error.code, ClientErrorCode::SyncPageDidNotAdvance);
}

#[test]
fn upload_and_sync_snapshot_debug_output_is_privacy_safe() {
    let queued_upload = new_upload_snapshot(upload_request(RETRY_BUDGET));
    let retrying_upload = advance_upload_without_collecting(
        &upload_at_creating_shard_upload(RETRY_BUDGET, 1),
        retryable_upload_failure("create_shard_upload", "http_503"),
        UploadJobPhase::RetryWaiting,
        vec![schedule_upload_retry_effect(
            1,
            UploadJobPhase::CreatingShardUpload,
        )],
    );
    let manifest_unknown = advance_upload_without_collecting(
        &upload_at_creating_manifest(RETRY_BUDGET, 1),
        UploadJobEvent::ManifestOutcomeUnknown {
            error_code: "transport_unknown".to_owned(),
        },
        UploadJobPhase::ManifestCommitUnknown,
        vec![recover_manifest_by_sync_effect()],
    );
    let active_sync = advance_album_ok(
        &advance_album_ok(
            &new_album_sync_snapshot(sync_request(RETRY_BUDGET)),
            AlbumSyncEvent::StartRequested,
            AlbumSyncPhase::FetchingPage,
            vec![fetch_page_effect(None)],
        ),
        AlbumSyncEvent::StartRequested,
        AlbumSyncPhase::FetchingPage,
        Vec::new(),
    );

    assert_privacy_safe_debug(&queued_upload);
    assert_privacy_safe_debug(&retrying_upload);
    assert_privacy_safe_debug(&manifest_unknown);
    assert_privacy_safe_debug(&active_sync);
}

fn upload_request(retry_budget: u32) -> UploadJobRequest {
    UploadJobRequest {
        job_id: JOB_ID.to_owned(),
        album_id: ALBUM_ID.to_owned(),
        local_asset_id: LOCAL_ASSET_ID.to_owned(),
        retry_budget,
    }
}

fn sync_request(retry_budget: u32) -> AlbumSyncRequest {
    AlbumSyncRequest {
        album_id: ALBUM_ID.to_owned(),
        initial_cursor: None,
        retry_budget,
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
        UploadJobEvent::PreparedMedia {
            planned_shard_count,
        },
        UploadJobPhase::AwaitingEpochHandle,
        vec![open_epoch_handle_effect()],
        &mut emitted_effects,
    );
    let snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::EpochHandleReady { epoch_id: EPOCH_ID },
        UploadJobPhase::EncryptingShard,
        vec![encrypt_shard_effect(0)],
        &mut emitted_effects,
    );
    advance_upload_ok(
        &snapshot,
        UploadJobEvent::ShardEncrypted {
            tier: ORIGINAL_TIER,
            index: 0,
            encrypted_sha256: SHARD_ZERO_SHA256.to_owned(),
            encrypted_size_bytes: 4_096,
        },
        UploadJobPhase::CreatingShardUpload,
        vec![create_shard_upload_effect(0, SHARD_ZERO_SHA256)],
        &mut emitted_effects,
    )
}

fn upload_at_uploading_shard(
    retry_budget: u32,
    planned_shard_count: u32,
    shard_index: u32,
    upload_id: &str,
) -> UploadJobSnapshot {
    let mut emitted_effects = Vec::new();
    let snapshot = upload_at_creating_shard_upload(retry_budget, planned_shard_count);
    advance_upload_ok(
        &snapshot,
        UploadJobEvent::ShardUploadCreated {
            tier: ORIGINAL_TIER,
            index: shard_index,
            upload_id: upload_id.to_owned(),
        },
        UploadJobPhase::UploadingShard,
        vec![upload_shard_effect(shard_index, upload_id)],
        &mut emitted_effects,
    )
}

fn upload_at_creating_manifest(retry_budget: u32, planned_shard_count: u32) -> UploadJobSnapshot {
    let mut emitted_effects = Vec::new();
    let snapshot = upload_at_uploading_shard(retry_budget, planned_shard_count, 0, UPLOAD_ZERO_ID);
    advance_upload_ok(
        &snapshot,
        UploadJobEvent::ShardUploaded {
            tier: ORIGINAL_TIER,
            index: 0,
            shard_id: SHARD_ZERO_ID.to_owned(),
            encrypted_sha256: SHARD_ZERO_SHA256.to_owned(),
        },
        UploadJobPhase::CreatingManifest,
        vec![create_manifest_effect(1)],
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

fn retryable_upload_failure(stage: &str, code: &str) -> UploadJobEvent {
    UploadJobEvent::RetryableFailure {
        stage: stage.to_owned(),
        code: code.to_owned(),
        retry_after_ms: RETRY_DELAY_MS,
    }
}

fn prepare_media_effect() -> UploadJobEffect {
    UploadJobEffect::PrepareMedia {
        job_id: JOB_ID.to_owned(),
        album_id: ALBUM_ID.to_owned(),
        local_asset_id: LOCAL_ASSET_ID.to_owned(),
    }
}

fn open_epoch_handle_effect() -> UploadJobEffect {
    UploadJobEffect::OpenEpochHandle {
        job_id: JOB_ID.to_owned(),
        album_id: ALBUM_ID.to_owned(),
    }
}

fn encrypt_shard_effect(index: u32) -> UploadJobEffect {
    UploadJobEffect::EncryptShard {
        job_id: JOB_ID.to_owned(),
        epoch_id: EPOCH_ID,
        tier: ORIGINAL_TIER,
        index,
    }
}

fn create_shard_upload_effect(index: u32, encrypted_sha256: &str) -> UploadJobEffect {
    UploadJobEffect::CreateShardUpload {
        job_id: JOB_ID.to_owned(),
        tier: ORIGINAL_TIER,
        index,
        encrypted_sha256: encrypted_sha256.to_owned(),
    }
}

fn upload_shard_effect(index: u32, upload_id: &str) -> UploadJobEffect {
    UploadJobEffect::UploadShard {
        job_id: JOB_ID.to_owned(),
        tier: ORIGINAL_TIER,
        index,
        upload_id: upload_id.to_owned(),
    }
}

fn create_manifest_effect(completed_shard_count: u32) -> UploadJobEffect {
    UploadJobEffect::CreateManifest {
        job_id: JOB_ID.to_owned(),
        album_id: ALBUM_ID.to_owned(),
        local_asset_id: LOCAL_ASSET_ID.to_owned(),
        completed_shard_count,
    }
}

fn request_sync_confirmation_effect() -> UploadJobEffect {
    UploadJobEffect::RequestSyncConfirmation {
        album_id: ALBUM_ID.to_owned(),
        local_asset_id: LOCAL_ASSET_ID.to_owned(),
    }
}

fn schedule_upload_retry_effect(retry_count: u32, target_phase: UploadJobPhase) -> UploadJobEffect {
    UploadJobEffect::ScheduleRetry {
        job_id: JOB_ID.to_owned(),
        retry_count,
        target_phase,
        after_ms: RETRY_DELAY_MS,
    }
}

fn recover_manifest_by_sync_effect() -> UploadJobEffect {
    UploadJobEffect::RecoverManifestBySync {
        album_id: ALBUM_ID.to_owned(),
        local_asset_id: LOCAL_ASSET_ID.to_owned(),
    }
}

fn fetch_page_effect(cursor: Option<String>) -> AlbumSyncEffect {
    AlbumSyncEffect::FetchPage {
        album_id: ALBUM_ID.to_owned(),
        cursor,
    }
}

fn apply_page_effect(
    next_cursor: Option<String>,
    item_count: u32,
    has_more: bool,
) -> AlbumSyncEffect {
    AlbumSyncEffect::ApplyPage {
        album_id: ALBUM_ID.to_owned(),
        next_cursor,
        item_count,
        has_more,
    }
}

fn assert_privacy_safe_debug<T: Debug>(snapshot: &T) {
    const FORBIDDEN_TERMS: [&str; 11] = [
        "password",
        "private",
        "secret",
        "plaintext",
        "filename",
        "file_uri",
        "picker_uri",
        "exif",
        "gps",
        "camera",
        "device",
    ];

    let debug_text = format!("{snapshot:?}");
    let lowered = debug_text.to_ascii_lowercase();
    for term in FORBIDDEN_TERMS {
        assert!(
            !lowered.contains(term),
            "snapshot debug text contains forbidden term `{term}`: {debug_text}"
        );
    }
}
