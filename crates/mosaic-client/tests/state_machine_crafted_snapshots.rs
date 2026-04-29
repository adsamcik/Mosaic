//! Drive every reachable defensive branch in `mosaic-client`'s state machine
//! by crafting snapshots whose internal fields violate the invariants that the
//! transition functions normally enforce.
//!
//! The snapshots are constructed directly (all fields are `pub`) so we can
//! reach lines that the public happy-path API never produces, while still
//! exercising the validation/effect-emission helpers through their public
//! entry points (`advance_upload_job` and `advance_album_sync`).

#![allow(clippy::expect_used, clippy::unwrap_used)]

use mosaic_client::{
    AlbumSyncEffect, AlbumSyncEvent, AlbumSyncPhase, AlbumSyncRequest, AlbumSyncRetryMetadata,
    AlbumSyncSnapshot, ClientErrorCode, CompletedShardRef, EncryptedShardRef,
    MAX_RETRY_COUNT_LIMIT, ManifestReceipt, PendingShardRef, SyncPageSummary, UploadJobEffect,
    UploadJobEvent, UploadJobPhase, UploadJobRequest, UploadJobSnapshot, UploadRetryMetadata,
    UploadShardSlot, UploadSyncConfirmation, advance_album_sync, advance_upload_job,
    album_sync_snapshot_schema_version, new_album_sync, new_upload_job,
    upload_snapshot_schema_version,
};

const ID_BASE: &str = "id-craft";

fn safe_id(suffix: &str) -> String {
    format!("{ID_BASE}-{suffix}")
}

fn upload_retry_default(max_attempts: u32) -> UploadRetryMetadata {
    UploadRetryMetadata {
        attempt_count: 0,
        max_attempts,
        retry_after_ms: None,
        last_error_code: None,
        last_error_stage: None,
        retry_target_phase: None,
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

fn upload_snapshot(
    phase: UploadJobPhase,
    planned_shards: Vec<UploadShardSlot>,
) -> UploadJobSnapshot {
    let planned_shard_count =
        u32::try_from(planned_shards.len()).expect("planned shard count fits in u32");
    UploadJobSnapshot {
        schema_version: upload_snapshot_schema_version(),
        local_job_id: safe_id("job"),
        upload_id: safe_id("upload"),
        album_id: safe_id("album"),
        asset_id: safe_id("asset"),
        epoch_id: None,
        phase,
        planned_shard_count,
        planned_shards,
        next_shard_index: 0,
        pending_shard: None,
        completed_shards: Vec::new(),
        manifest_receipt: None,
        retry: upload_retry_default(2),
        confirmation_metadata: None,
        failure_code: None,
    }
}

fn sync_snapshot(phase: AlbumSyncPhase) -> AlbumSyncSnapshot {
    AlbumSyncSnapshot {
        schema_version: album_sync_snapshot_schema_version(),
        sync_id: safe_id("sync"),
        album_id: safe_id("album"),
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
    let error = match advance_upload_job(&snapshot, UploadJobEvent::StartRequested) {
        Ok(transition) => panic!("StartRequested in non-Queued should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidTransition);
}

#[test]
fn upload_epoch_handle_acquired_rejected_outside_awaiting_epoch_phase() {
    let snapshot = upload_snapshot(UploadJobPhase::Queued, Vec::new());
    let error = match advance_upload_job(
        &snapshot,
        UploadJobEvent::EpochHandleAcquired { epoch_id: Some(1) },
    ) {
        Ok(transition) => panic!("epoch event in Queued should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidTransition);
}

#[test]
fn upload_epoch_handle_acquired_with_no_planned_shards_returns_invalid_snapshot() {
    // The phase is correct but the snapshot is internally inconsistent: there
    // are zero planned shards yet we are AwaitingEpochHandle. This drives
    // `upload_effects_for_phase(EncryptingShard)` → `next_upload_slot` → None.
    let snapshot = upload_snapshot(UploadJobPhase::AwaitingEpochHandle, Vec::new());
    let error = match advance_upload_job(
        &snapshot,
        UploadJobEvent::EpochHandleAcquired { epoch_id: Some(2) },
    ) {
        Ok(transition) => panic!("missing planned shards should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn upload_shard_encrypted_rejected_outside_encrypting_phase() {
    let snapshot = upload_snapshot(
        UploadJobPhase::Queued,
        vec![UploadShardSlot { tier: 3, index: 0 }],
    );
    let error = match advance_upload_job(
        &snapshot,
        UploadJobEvent::ShardEncrypted {
            shard: Some(EncryptedShardRef {
                tier: 3,
                index: 0,
                sha256: safe_id("sha"),
            }),
        },
    ) {
        Ok(transition) => panic!("encrypt event in Queued should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidTransition);
}

#[test]
fn upload_shard_encrypted_with_missing_planned_slot_returns_invalid_snapshot() {
    // EncryptingShard phase but planned shards are empty so `next_upload_slot`
    // returns None.
    let snapshot = upload_snapshot(UploadJobPhase::EncryptingShard, Vec::new());
    let error = match advance_upload_job(
        &snapshot,
        UploadJobEvent::ShardEncrypted {
            shard: Some(EncryptedShardRef {
                tier: 3,
                index: 0,
                sha256: safe_id("sha"),
            }),
        },
    ) {
        Ok(transition) => panic!("missing slot should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn upload_shard_upload_created_rejected_outside_creating_phase_and_missing_pending() {
    // Wrong phase (Queued).
    let snapshot = upload_snapshot(UploadJobPhase::Queued, Vec::new());
    let error = match advance_upload_job(
        &snapshot,
        UploadJobEvent::ShardUploadCreated {
            upload: Some(mosaic_client::CreatedShardUpload {
                tier: 3,
                index: 0,
                shard_id: safe_id("shard"),
                sha256: safe_id("sha"),
            }),
        },
    ) {
        Ok(transition) => panic!("upload created in Queued should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidTransition);

    // Correct phase but missing `pending_shard` causes invalid snapshot via
    // `require_pending_shard`.
    let snapshot = upload_snapshot(
        UploadJobPhase::CreatingShardUpload,
        vec![UploadShardSlot { tier: 3, index: 0 }],
    );
    let error = match advance_upload_job(
        &snapshot,
        UploadJobEvent::ShardUploadCreated {
            upload: Some(mosaic_client::CreatedShardUpload {
                tier: 3,
                index: 0,
                shard_id: safe_id("shard"),
                sha256: safe_id("sha"),
            }),
        },
    ) {
        Ok(transition) => panic!("missing pending_shard should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn upload_shard_uploaded_rejected_when_pending_lacks_shard_id_or_phase_mismatched() {
    // Wrong phase.
    let snapshot = upload_snapshot(UploadJobPhase::Queued, Vec::new());
    let error = match advance_upload_job(
        &snapshot,
        UploadJobEvent::ShardUploaded {
            shard: Some(CompletedShardRef {
                tier: 3,
                index: 0,
                shard_id: safe_id("shard"),
                sha256: safe_id("sha"),
            }),
        },
    ) {
        Ok(transition) => panic!("uploaded in Queued should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidTransition);

    // Correct phase but pending shard has no shard_id.
    let mut snapshot = upload_snapshot(
        UploadJobPhase::UploadingShard,
        vec![UploadShardSlot { tier: 3, index: 0 }],
    );
    snapshot.pending_shard = Some(PendingShardRef {
        tier: 3,
        index: 0,
        sha256: safe_id("sha"),
        shard_id: None,
    });
    let error = match advance_upload_job(
        &snapshot,
        UploadJobEvent::ShardUploaded {
            shard: Some(CompletedShardRef {
                tier: 3,
                index: 0,
                shard_id: safe_id("shard"),
                sha256: safe_id("sha"),
            }),
        },
    ) {
        Ok(transition) => panic!("missing shard_id should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn upload_shard_uploaded_completing_to_creating_manifest_when_no_more_planned() {
    // Single planned slot, after the shard is uploaded the snapshot must move
    // to CreatingManifest.
    let mut snapshot = upload_snapshot(
        UploadJobPhase::UploadingShard,
        vec![UploadShardSlot { tier: 3, index: 0 }],
    );
    snapshot.pending_shard = Some(PendingShardRef {
        tier: 3,
        index: 0,
        sha256: safe_id("sha"),
        shard_id: Some(safe_id("shard")),
    });
    let transition = advance_upload_job(
        &snapshot,
        UploadJobEvent::ShardUploaded {
            shard: Some(CompletedShardRef {
                tier: 3,
                index: 0,
                shard_id: safe_id("shard"),
                sha256: safe_id("sha"),
            }),
        },
    )
    .expect("upload transition should succeed");
    assert_eq!(transition.snapshot.phase, UploadJobPhase::CreatingManifest);
    assert_eq!(transition.effects, vec![UploadJobEffect::CreateManifest]);
}

#[test]
fn upload_manifest_created_rejected_outside_creating_manifest_phase() {
    let snapshot = upload_snapshot(UploadJobPhase::Queued, Vec::new());
    let error = match advance_upload_job(
        &snapshot,
        UploadJobEvent::ManifestCreated {
            receipt: Some(ManifestReceipt {
                manifest_id: safe_id("manifest"),
                version: 1,
            }),
        },
    ) {
        Ok(transition) => panic!("manifest created in Queued should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidTransition);
}

#[test]
fn upload_sync_confirmed_with_invalid_confirmation_payload_returns_invalid_snapshot() {
    let mut snapshot = upload_snapshot(UploadJobPhase::AwaitingSyncConfirmation, Vec::new());
    snapshot.manifest_receipt = Some(ManifestReceipt {
        manifest_id: safe_id("manifest"),
        version: 1,
    });
    let error = match advance_upload_job(
        &snapshot,
        UploadJobEvent::SyncConfirmed {
            confirmation: Some(UploadSyncConfirmation {
                asset_id: "name.jpg".to_owned(),
                confirmed_at_ms: 0,
                sync_cursor: None,
            }),
        },
    ) {
        Ok(transition) => panic!("invalid confirmation should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn upload_retry_timer_elapsed_with_no_target_phase_returns_invalid_snapshot() {
    // RetryWaiting phase but `retry_target_phase` is None.
    let snapshot = upload_snapshot(UploadJobPhase::RetryWaiting, Vec::new());
    let error = match advance_upload_job(&snapshot, UploadJobEvent::RetryTimerElapsed) {
        Ok(transition) => panic!("missing retry_target should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn upload_retry_timer_elapsed_to_encrypting_with_no_planned_slot_returns_invalid_snapshot() {
    // RetryWaiting → EncryptingShard but no planned shard exists, so
    // upload_effects_for_phase should fail.
    let mut snapshot = upload_snapshot(UploadJobPhase::RetryWaiting, Vec::new());
    snapshot.retry.retry_target_phase = Some(UploadJobPhase::EncryptingShard);
    let error = match advance_upload_job(&snapshot, UploadJobEvent::RetryTimerElapsed) {
        Ok(transition) => panic!("invalid resume target should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn upload_cancel_in_retry_with_manifest_target_recovers_through_sync() {
    // Drives the `upload_manifest_may_have_committed` branch where the retry
    // target is one of {CreatingManifest, ManifestCommitUnknown,
    // AwaitingSyncConfirmation} so cancelling moves to ManifestCommitUnknown.
    for target in [
        UploadJobPhase::CreatingManifest,
        UploadJobPhase::ManifestCommitUnknown,
        UploadJobPhase::AwaitingSyncConfirmation,
    ] {
        let mut snapshot = upload_snapshot(UploadJobPhase::RetryWaiting, Vec::new());
        snapshot.retry.retry_target_phase = Some(target);
        let transition = advance_upload_job(&snapshot, UploadJobEvent::CancelRequested)
            .expect("retry cancel with manifest target should succeed");
        assert_eq!(
            transition.snapshot.phase,
            UploadJobPhase::ManifestCommitUnknown,
            "target {target:?} should recover via sync"
        );
        assert_eq!(
            transition.effects,
            vec![UploadJobEffect::RecoverManifestThroughSync]
        );
    }
}

#[test]
fn upload_cancel_in_retry_targeting_non_manifest_phase_goes_to_cancelled() {
    // The other arm of upload_manifest_may_have_committed: a non-manifest
    // retry target → plain Cancelled phase.
    let mut snapshot = upload_snapshot(UploadJobPhase::RetryWaiting, Vec::new());
    snapshot.retry.retry_target_phase = Some(UploadJobPhase::EncryptingShard);
    let transition = advance_upload_job(&snapshot, UploadJobEvent::CancelRequested)
        .expect("retry cancel with non-manifest target should succeed");
    assert_eq!(transition.snapshot.phase, UploadJobPhase::Cancelled);
    assert!(transition.effects.is_empty());
}

#[test]
fn upload_cancel_in_retry_with_no_target_phase_goes_to_cancelled() {
    // upload_manifest_may_have_committed `RetryWaiting => retry_target_phase
    // .is_some_and(...)` falls through to the `false` branch when
    // retry_target_phase is None.
    let snapshot = upload_snapshot(UploadJobPhase::RetryWaiting, Vec::new());
    let transition = advance_upload_job(&snapshot, UploadJobEvent::CancelRequested)
        .expect("retry cancel with no target should succeed");
    assert_eq!(transition.snapshot.phase, UploadJobPhase::Cancelled);
    assert!(transition.effects.is_empty());
}

#[test]
fn sync_requested_rejects_invalid_request_text() {
    let snapshot = sync_snapshot(AlbumSyncPhase::Idle);
    let error = match advance_album_sync(
        &snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(AlbumSyncRequest {
                sync_id: "sync\u{0007}id".to_owned(),
                album_id: safe_id("album"),
                initial_page_token: None,
                max_retry_count: 1,
            }),
        },
    ) {
        Ok(transition) => panic!("invalid sync_id should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn sync_page_applied_with_no_current_page_returns_invalid_snapshot() {
    let snapshot = sync_snapshot(AlbumSyncPhase::ApplyingPage);
    // ApplyingPage with current_page=None — but validate_album_sync_snapshot
    // already rejects this. So this should fail at the validation step rather
    // than the transition step. Either way, the resulting error code is the
    // same ClientCoreInvalidSnapshot.
    let error = match advance_album_sync(&snapshot, AlbumSyncEvent::PageApplied) {
        Ok(transition) => panic!("ApplyingPage without current_page should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn sync_retry_timer_elapsed_with_no_target_returns_invalid_snapshot() {
    let snapshot = sync_snapshot(AlbumSyncPhase::RetryWaiting);
    let error = match advance_album_sync(&snapshot, AlbumSyncEvent::RetryTimerElapsed) {
        Ok(transition) => panic!("missing target_phase should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn sync_retry_timer_elapsed_resumes_to_target_phase_with_correct_effects() {
    // Resume to FetchingPage.
    let mut snapshot = sync_snapshot(AlbumSyncPhase::RetryWaiting);
    snapshot.retry.retry_target_phase = Some(AlbumSyncPhase::FetchingPage);
    snapshot.next_page_token = Some(safe_id("cursor"));
    let transition = advance_album_sync(&snapshot, AlbumSyncEvent::RetryTimerElapsed)
        .expect("resume to FetchingPage should succeed");
    assert_eq!(transition.snapshot.phase, AlbumSyncPhase::FetchingPage);
    assert_eq!(
        transition.effects,
        vec![AlbumSyncEffect::FetchPage {
            page_token: Some(safe_id("cursor"))
        }]
    );

    // Resume to ApplyingPage exercises the `current_page Some` arm of
    // sync_effects_for_phase.
    let mut snapshot = sync_snapshot(AlbumSyncPhase::RetryWaiting);
    snapshot.retry.retry_target_phase = Some(AlbumSyncPhase::ApplyingPage);
    snapshot.current_page = Some(SyncPageSummary {
        previous_page_token: None,
        next_page_token: None,
        reached_end: true,
        encrypted_item_count: 9,
    });
    let transition = advance_album_sync(&snapshot, AlbumSyncEvent::RetryTimerElapsed)
        .expect("resume to ApplyingPage should succeed");
    assert_eq!(transition.snapshot.phase, AlbumSyncPhase::ApplyingPage);
    assert_eq!(
        transition.effects,
        vec![AlbumSyncEffect::ApplyPage {
            encrypted_item_count: 9
        }]
    );
}

#[test]
fn sync_retry_timer_elapsed_to_applying_with_no_current_page_returns_invalid_snapshot() {
    // ApplyingPage target but no current_page set. This snapshot is internally
    // inconsistent (ApplyingPage requires current_page) so
    // `validate_album_sync_snapshot` would reject it, but we set the phase to
    // RetryWaiting so it slips past the schema check; the inner
    // `sync_effects_for_phase` call then encounters `current_page = None`.
    let mut snapshot = sync_snapshot(AlbumSyncPhase::RetryWaiting);
    snapshot.retry.retry_target_phase = Some(AlbumSyncPhase::ApplyingPage);
    let error = match advance_album_sync(&snapshot, AlbumSyncEvent::RetryTimerElapsed) {
        Ok(transition) => {
            panic!("ApplyingPage resume without current_page should fail: {transition:?}")
        }
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn sync_retry_timer_elapsed_to_invalid_target_phase_returns_invalid_transition() {
    // Some phases (Idle/Completed/Cancelled/Failed/RetryWaiting) are not
    // representable as resumption targets — sync_effects_for_phase rejects
    // them.
    let mut snapshot = sync_snapshot(AlbumSyncPhase::RetryWaiting);
    snapshot.retry.retry_target_phase = Some(AlbumSyncPhase::Idle);
    let error = match advance_album_sync(&snapshot, AlbumSyncEvent::RetryTimerElapsed) {
        Ok(transition) => panic!("resume to Idle should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidTransition);
}

#[test]
fn sync_retryable_failure_rejected_in_non_retry_eligible_phase() {
    let snapshot = sync_snapshot(AlbumSyncPhase::Idle);
    let error = match advance_album_sync(
        &snapshot,
        AlbumSyncEvent::RetryableFailure {
            code: ClientErrorCode::InvalidInputLength,
            retry_after_ms: None,
        },
    ) {
        Ok(transition) => panic!("retry from Idle should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidTransition);
}

#[test]
fn upload_snapshot_validation_rejects_planned_shard_count_mismatch() {
    let mut snapshot = upload_snapshot(
        UploadJobPhase::Queued,
        vec![UploadShardSlot { tier: 3, index: 0 }],
    );
    snapshot.planned_shard_count = 5; // does not match planned_shards.len()

    let error = match advance_upload_job(&snapshot, UploadJobEvent::StartRequested) {
        Ok(transition) => panic!("count mismatch should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn upload_snapshot_validation_rejects_completed_shards_with_invalid_text() {
    let mut snapshot = upload_snapshot(
        UploadJobPhase::CreatingManifest,
        vec![UploadShardSlot { tier: 3, index: 0 }],
    );
    snapshot.completed_shards = vec![CompletedShardRef {
        tier: 3,
        index: 0,
        shard_id: "shard\u{0007}".to_owned(),
        sha256: safe_id("sha"),
    }];
    let error = match advance_upload_job(
        &snapshot,
        UploadJobEvent::ManifestCreated {
            receipt: Some(ManifestReceipt {
                manifest_id: safe_id("manifest"),
                version: 1,
            }),
        },
    ) {
        Ok(transition) => panic!("invalid completed shard should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn upload_snapshot_validation_rejects_completed_shard_duplicates() {
    let mut snapshot = upload_snapshot(
        UploadJobPhase::CreatingManifest,
        vec![
            UploadShardSlot { tier: 3, index: 0 },
            UploadShardSlot { tier: 3, index: 1 },
        ],
    );
    snapshot.completed_shards = vec![
        CompletedShardRef {
            tier: 3,
            index: 0,
            shard_id: safe_id("shard-0"),
            sha256: safe_id("sha"),
        },
        CompletedShardRef {
            tier: 3,
            index: 0, // duplicate
            shard_id: safe_id("shard-1"),
            sha256: safe_id("sha"),
        },
    ];
    let error = match advance_upload_job(
        &snapshot,
        UploadJobEvent::ManifestCreated {
            receipt: Some(ManifestReceipt {
                manifest_id: safe_id("manifest"),
                version: 1,
            }),
        },
    ) {
        Ok(transition) => panic!("duplicate completed shard should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn upload_snapshot_validation_rejects_completed_more_than_planned() {
    let mut snapshot = upload_snapshot(
        UploadJobPhase::CreatingManifest,
        vec![UploadShardSlot { tier: 3, index: 0 }],
    );
    snapshot.completed_shards = vec![
        CompletedShardRef {
            tier: 3,
            index: 0,
            shard_id: safe_id("shard-0"),
            sha256: safe_id("sha"),
        },
        CompletedShardRef {
            tier: 3,
            index: 1,
            shard_id: safe_id("shard-1"),
            sha256: safe_id("sha"),
        },
    ];
    let error = match advance_upload_job(
        &snapshot,
        UploadJobEvent::ManifestCreated {
            receipt: Some(ManifestReceipt {
                manifest_id: safe_id("manifest"),
                version: 1,
            }),
        },
    ) {
        Ok(transition) => panic!("over-completion should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn upload_snapshot_validation_rejects_invalid_pending_shard_text() {
    let mut snapshot = upload_snapshot(
        UploadJobPhase::CreatingShardUpload,
        vec![UploadShardSlot { tier: 3, index: 0 }],
    );
    snapshot.pending_shard = Some(PendingShardRef {
        tier: 3,
        index: 0,
        sha256: "sha\u{0007}".to_owned(),
        shard_id: None,
    });
    let error = match advance_upload_job(
        &snapshot,
        UploadJobEvent::ShardUploadCreated {
            upload: Some(mosaic_client::CreatedShardUpload {
                tier: 3,
                index: 0,
                shard_id: safe_id("shard"),
                sha256: safe_id("sha"),
            }),
        },
    ) {
        Ok(transition) => panic!("invalid pending sha should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn upload_snapshot_validation_rejects_invalid_pending_shard_id() {
    let mut snapshot = upload_snapshot(
        UploadJobPhase::UploadingShard,
        vec![UploadShardSlot { tier: 3, index: 0 }],
    );
    snapshot.pending_shard = Some(PendingShardRef {
        tier: 3,
        index: 0,
        sha256: safe_id("sha"),
        shard_id: Some("https://shard".to_owned()),
    });
    let error = match advance_upload_job(
        &snapshot,
        UploadJobEvent::ShardUploaded {
            shard: Some(CompletedShardRef {
                tier: 3,
                index: 0,
                shard_id: safe_id("shard"),
                sha256: safe_id("sha"),
            }),
        },
    ) {
        Ok(transition) => panic!("invalid pending shard_id should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn upload_snapshot_validation_rejects_invalid_manifest_receipt() {
    let mut snapshot = upload_snapshot(UploadJobPhase::AwaitingSyncConfirmation, Vec::new());
    snapshot.manifest_receipt = Some(ManifestReceipt {
        manifest_id: "name.png".to_owned(),
        version: 1,
    });
    let error = match advance_upload_job(
        &snapshot,
        UploadJobEvent::SyncConfirmed {
            confirmation: Some(UploadSyncConfirmation {
                asset_id: safe_id("asset"),
                confirmed_at_ms: 0,
                sync_cursor: None,
            }),
        },
    ) {
        Ok(transition) => panic!("invalid manifest_id in snapshot should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn upload_snapshot_validation_rejects_confirmation_with_asset_mismatch() {
    let mut snapshot = upload_snapshot(UploadJobPhase::Confirmed, Vec::new());
    snapshot.confirmation_metadata = Some(UploadSyncConfirmation {
        asset_id: safe_id("other-asset"), // does not match snapshot.asset_id
        confirmed_at_ms: 0,
        sync_cursor: None,
    });
    // Send any event; the validate_upload_snapshot prelude rejects this
    // before any phase logic runs.
    let error = match advance_upload_job(&snapshot, UploadJobEvent::CancelRequested) {
        Ok(transition) => panic!("asset mismatch should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn album_sync_snapshot_validation_rejects_invalid_initial_token() {
    let mut snapshot = sync_snapshot(AlbumSyncPhase::Idle);
    snapshot.initial_page_token = Some("token\u{0007}".to_owned());
    let error = match advance_album_sync(
        &snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(AlbumSyncRequest {
                sync_id: safe_id("sync"),
                album_id: safe_id("album"),
                initial_page_token: None,
                max_retry_count: 1,
            }),
        },
    ) {
        Ok(transition) => panic!("invalid initial token should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn album_sync_snapshot_validation_rejects_invalid_next_token() {
    let mut snapshot = sync_snapshot(AlbumSyncPhase::FetchingPage);
    snapshot.next_page_token = Some("https://injected".to_owned());
    let error = match advance_album_sync(
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
        Ok(transition) => panic!("invalid next token should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn album_sync_snapshot_validation_rejects_invalid_current_page_tokens() {
    let mut snapshot = sync_snapshot(AlbumSyncPhase::ApplyingPage);
    snapshot.current_page = Some(SyncPageSummary {
        previous_page_token: Some("file:malicious".to_owned()),
        next_page_token: None,
        reached_end: true,
        encrypted_item_count: 0,
    });
    let error = match advance_album_sync(&snapshot, AlbumSyncEvent::PageApplied) {
        Ok(transition) => panic!("invalid prev token should fail: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn upload_failed_transition_via_event_in_active_phase() {
    // upload_failed_transition is hit from advance_upload_job's NonRetryableFailure
    // arm. Verify that the success path reaches Failed without retry budget interactions.
    let snapshot = upload_snapshot(UploadJobPhase::EncryptingShard, Vec::new());
    let transition = advance_upload_job(
        &snapshot,
        UploadJobEvent::NonRetryableFailure {
            code: ClientErrorCode::InvalidPublicKey,
        },
    )
    .expect("non-retryable failure in active phase should succeed");
    assert_eq!(transition.snapshot.phase, UploadJobPhase::Failed);
    assert_eq!(
        transition.snapshot.failure_code,
        Some(ClientErrorCode::InvalidPublicKey)
    );
}

// --- L3: max_retry_count cap validation ---------------------------------

fn upload_request_with_cap(cap: u32) -> UploadJobRequest {
    UploadJobRequest {
        local_job_id: safe_id("job"),
        upload_id: safe_id("upload"),
        album_id: safe_id("album"),
        asset_id: safe_id("asset"),
        max_retry_count: cap,
    }
}

fn album_sync_request_with_cap(cap: u32) -> AlbumSyncRequest {
    AlbumSyncRequest {
        sync_id: safe_id("sync"),
        album_id: safe_id("album"),
        initial_page_token: None,
        max_retry_count: cap,
    }
}

#[test]
fn upload_request_rejects_max_retry_count_above_limit() {
    let error = match new_upload_job(upload_request_with_cap(MAX_RETRY_COUNT_LIMIT + 1)) {
        Ok(snapshot) => panic!("oversized max_retry_count should fail: {snapshot:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::InvalidInputLength);
}

#[test]
fn upload_request_rejects_u32_max_retry_count() {
    let error = match new_upload_job(upload_request_with_cap(u32::MAX)) {
        Ok(snapshot) => panic!("u32::MAX max_retry_count should fail: {snapshot:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::InvalidInputLength);
}

#[test]
fn upload_request_accepts_max_retry_count_at_limit() {
    let snapshot = match new_upload_job(upload_request_with_cap(MAX_RETRY_COUNT_LIMIT)) {
        Ok(snapshot) => snapshot,
        Err(error) => panic!("cap at limit should succeed: {error:?}"),
    };
    assert_eq!(snapshot.retry.max_attempts, MAX_RETRY_COUNT_LIMIT);
}

#[test]
fn album_sync_request_rejects_max_retry_count_above_limit() {
    let error = match new_album_sync(album_sync_request_with_cap(MAX_RETRY_COUNT_LIMIT + 1)) {
        Ok(snapshot) => panic!("oversized max_retry_count should fail: {snapshot:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::InvalidInputLength);
}

#[test]
fn album_sync_request_rejects_u32_max_retry_count() {
    let error = match new_album_sync(album_sync_request_with_cap(u32::MAX)) {
        Ok(snapshot) => panic!("u32::MAX max_retry_count should fail: {snapshot:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::InvalidInputLength);
}

#[test]
fn upload_snapshot_rejects_oversized_max_attempts() {
    // Tampered snapshot: cap above MAX_RETRY_COUNT_LIMIT must be rejected
    // when the snapshot is replayed into advance_upload_job.
    let mut snapshot = upload_snapshot(UploadJobPhase::Queued, Vec::new());
    snapshot.retry.max_attempts = MAX_RETRY_COUNT_LIMIT + 1;
    let error = match advance_upload_job(&snapshot, UploadJobEvent::StartRequested) {
        Ok(transition) => panic!("oversized max_attempts should be rejected: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn upload_snapshot_rejects_u32_max_max_attempts() {
    let mut snapshot = upload_snapshot(UploadJobPhase::Queued, Vec::new());
    snapshot.retry.max_attempts = u32::MAX;
    let error = match advance_upload_job(&snapshot, UploadJobEvent::StartRequested) {
        Ok(transition) => panic!("u32::MAX max_attempts should be rejected: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn upload_snapshot_rejects_attempt_count_above_max_attempts() {
    let mut snapshot = upload_snapshot(UploadJobPhase::Queued, Vec::new());
    snapshot.retry.max_attempts = 4;
    snapshot.retry.attempt_count = 5;
    let error = match advance_upload_job(&snapshot, UploadJobEvent::StartRequested) {
        Ok(transition) => {
            panic!("attempt_count above max_attempts should be rejected: {transition:?}")
        }
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn album_sync_snapshot_rejects_oversized_max_attempts() {
    let mut snapshot = sync_snapshot(AlbumSyncPhase::Idle);
    snapshot.retry.max_attempts = MAX_RETRY_COUNT_LIMIT + 1;
    let error = match advance_album_sync(
        &snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(album_sync_request_with_cap(1)),
        },
    ) {
        Ok(transition) => panic!("oversized max_attempts should be rejected: {transition:?}"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn album_sync_snapshot_rejects_attempt_count_above_max_attempts() {
    let mut snapshot = sync_snapshot(AlbumSyncPhase::Idle);
    snapshot.retry.max_attempts = 4;
    snapshot.retry.attempt_count = 5;
    let error = match advance_album_sync(
        &snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(album_sync_request_with_cap(1)),
        },
    ) {
        Ok(transition) => {
            panic!("attempt_count above max_attempts should be rejected: {transition:?}")
        }
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidSnapshot);
}

#[test]
fn sync_requested_event_with_oversized_request_cap_is_rejected() {
    // Replay path: an in-progress AlbumSync receives a SyncRequested event
    // with a tampered request whose max_retry_count exceeds the cap.
    let snapshot = sync_snapshot(AlbumSyncPhase::Idle);
    let error = match advance_album_sync(
        &snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(album_sync_request_with_cap(MAX_RETRY_COUNT_LIMIT + 1)),
        },
    ) {
        Ok(transition) => {
            panic!("oversized request cap on SyncRequested should be rejected: {transition:?}")
        }
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::InvalidInputLength);
}
