#![allow(clippy::expect_used)]

use mosaic_client::{
    AlbumSyncEvent, AlbumSyncPhase, AlbumSyncRetryMetadata, AlbumSyncSnapshot, ClientErrorCode,
    SyncPageSummary, UploadJobEvent, UploadJobPhase, UploadJobRequest, UploadJobSnapshot,
    UploadShardRef, Uuid, advance_album_sync, advance_upload_job,
    album_sync_snapshot_schema_version, new_upload_job, upload_snapshot_schema_version,
};

fn uuid(seed: u8) -> Uuid {
    let mut bytes = [seed; 16];
    bytes[6] = 0x70 | (seed & 0x0f);
    bytes[8] = 0x80 | (seed & 0x3f);
    Uuid::from_bytes(bytes)
}

fn shard(tier: u8, index: u32) -> UploadShardRef {
    UploadShardRef {
        tier,
        shard_index: index,
        shard_id: uuid(30 + tier + index as u8),
        sha256: [0x60 + tier + index as u8; 32],
        content_length: 2048 + u64::from(index),
        envelope_version: 3,
        uploaded: false,
    }
}

fn upload_request() -> UploadJobRequest {
    UploadJobRequest {
        job_id: uuid(1),
        album_id: uuid(2),
        asset_id: uuid(3),
        idempotency_key: uuid(4),
        max_retry_count: 2,
    }
}

fn upload_snapshot(phase: UploadJobPhase, tiered_shards: Vec<UploadShardRef>) -> UploadJobSnapshot {
    UploadJobSnapshot {
        schema_version: upload_snapshot_schema_version(),
        job_id: uuid(1),
        album_id: uuid(2),
        phase,
        retry_count: 0,
        max_retry_count: 2,
        next_retry_not_before_ms: None,
        idempotency_key: uuid(4),
        tiered_shards,
        shard_set_hash: Some([0x99; 32]),
        snapshot_revision: 0,
        last_acknowledged_effect_id: None,
        last_applied_event_id: None,
        failure_code: None,
    }
}

fn sync_retry_default(max_attempts: u32) -> AlbumSyncRetryMetadata {
    AlbumSyncRetryMetadata {
        attempt_count: 0,
        max_attempts,
        retry_after_ms: None,
        last_error_code: None,
        last_error_stage: None,
        retry_target_phase: None,
    }
}

fn sync_snapshot(phase: AlbumSyncPhase) -> AlbumSyncSnapshot {
    AlbumSyncSnapshot {
        schema_version: album_sync_snapshot_schema_version(),
        sync_id: "id-craft-sync".to_owned(),
        album_id: "id-craft-album".to_owned(),
        phase,
        initial_page_token: None,
        next_page_token: None,
        current_page: None,
        rerun_requested: false,
        completed_cycle_count: 0,
        retry: sync_retry_default(2),
        failure_code: None,
    }
}

#[test]
fn start_upload_rejected_outside_queued_phase() {
    let snapshot = upload_snapshot(UploadJobPhase::AwaitingPreparedMedia, Vec::new());
    let error = advance_upload_job(
        &snapshot,
        UploadJobEvent::StartRequested {
            effect_id: uuid(10),
        },
    )
    .expect_err("StartRequested outside Queued should fail");
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidTransition);
}

#[test]
fn upload_epoch_handle_acquired_with_no_shards_returns_invalid_snapshot() {
    let snapshot = upload_snapshot(UploadJobPhase::AwaitingEpochHandle, Vec::new());
    let error = advance_upload_job(
        &snapshot,
        UploadJobEvent::EpochHandleAcquired {
            effect_id: uuid(11),
        },
    )
    .expect_err("missing shards should fail");
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn upload_shard_encrypted_rejects_wrong_phase_and_immutable_swap() {
    let planned = shard(3, 0);
    let snapshot = upload_snapshot(UploadJobPhase::Queued, vec![planned.clone()]);
    let error = advance_upload_job(
        &snapshot,
        UploadJobEvent::ShardEncrypted {
            effect_id: uuid(12),
            shard: planned.clone(),
        },
    )
    .expect_err("wrong phase should fail");
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidTransition);

    let mut swapped = planned;
    swapped.sha256 = [0x77; 32];
    let snapshot = upload_snapshot(UploadJobPhase::EncryptingShard, vec![shard(3, 0)]);
    let error = advance_upload_job(
        &snapshot,
        UploadJobEvent::ShardEncrypted {
            effect_id: uuid(13),
            shard: swapped,
        },
    )
    .expect_err("sha swap should fail");
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidTransition);
}

#[test]
fn upload_shard_uploaded_rejects_zero_length_and_all_zero_hash() {
    let mut invalid = shard(3, 0);
    invalid.content_length = 0;
    let snapshot = upload_snapshot(UploadJobPhase::UploadingShard, vec![shard(3, 0)]);
    let error = advance_upload_job(
        &snapshot,
        UploadJobEvent::ShardUploaded {
            effect_id: uuid(14),
            shard: invalid,
        },
    )
    .expect_err("zero content length should fail");
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);

    let mut invalid = shard(3, 0);
    invalid.sha256 = [0; 32];
    let error = advance_upload_job(
        &snapshot,
        UploadJobEvent::ShardUploaded {
            effect_id: uuid(15),
            shard: invalid,
        },
    )
    .expect_err("all-zero sha should fail");
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn upload_retry_timer_requires_retry_waiting_and_valid_target() {
    let snapshot = upload_snapshot(UploadJobPhase::CreatingManifest, vec![shard(3, 0)]);
    let error = advance_upload_job(
        &snapshot,
        UploadJobEvent::RetryTimerElapsed {
            effect_id: uuid(16),
            target_phase: UploadJobPhase::CreatingManifest,
        },
    )
    .expect_err("timer outside retry waiting should fail");
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidTransition);

    let mut retry = upload_snapshot(UploadJobPhase::RetryWaiting, vec![shard(3, 0)]);
    retry.next_retry_not_before_ms = Some(2_000);
    let error = advance_upload_job(
        &retry,
        UploadJobEvent::RetryTimerElapsed {
            effect_id: uuid(17),
            target_phase: UploadJobPhase::Confirmed,
        },
    )
    .expect_err("terminal retry target should fail");
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidTransition);
}

#[test]
fn new_upload_job_rejects_invalid_retry_bound() {
    let error = new_upload_job(UploadJobRequest {
        max_retry_count: u8::MAX,
        ..upload_request()
    })
    .expect_err("retry bound should fail");
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn album_sync_retry_timer_without_target_returns_invalid_snapshot() {
    let snapshot = sync_snapshot(AlbumSyncPhase::RetryWaiting);
    let error = advance_album_sync(&snapshot, AlbumSyncEvent::RetryTimerElapsed)
        .expect_err("missing target should fail");
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn album_sync_page_applied_without_current_page_returns_invalid_snapshot() {
    let snapshot = sync_snapshot(AlbumSyncPhase::ApplyingPage);
    let error = advance_album_sync(&snapshot, AlbumSyncEvent::PageApplied)
        .expect_err("missing current page should fail");
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn album_sync_retry_budget_exhaustion_preserves_legacy_coverage() {
    let mut snapshot = sync_snapshot(AlbumSyncPhase::FetchingPage);
    snapshot.retry.attempt_count = 2;
    snapshot.retry.max_attempts = 2;
    let transition = advance_album_sync(
        &snapshot,
        AlbumSyncEvent::RetryableFailure {
            code: ClientErrorCode::InvalidInputLength,
            retry_after_ms: None,
        },
    )
    .expect("budget exhaustion transition succeeds");
    assert_eq!(transition.snapshot.phase, AlbumSyncPhase::Failed);
    assert_eq!(
        transition.snapshot.failure_code,
        Some(ClientErrorCode::ClientCoreRetryBudgetExhausted)
    );
    assert!(transition.effects.is_empty());
}

#[test]
fn album_sync_page_application_with_rerun_fetches_initial_page() {
    let mut snapshot = sync_snapshot(AlbumSyncPhase::ApplyingPage);
    snapshot.initial_page_token = Some("initial".to_owned());
    snapshot.current_page = Some(SyncPageSummary {
        previous_page_token: None,
        next_page_token: None,
        reached_end: true,
        encrypted_item_count: 1,
    });
    snapshot.rerun_requested = true;
    let transition = advance_album_sync(&snapshot, AlbumSyncEvent::PageApplied)
        .expect("rerun transition succeeds");
    assert_eq!(transition.snapshot.phase, AlbumSyncPhase::FetchingPage);
    assert_eq!(
        transition.snapshot.next_page_token,
        Some("initial".to_owned())
    );
}
