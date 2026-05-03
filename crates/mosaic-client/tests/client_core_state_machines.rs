#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::fmt::Debug;

use mosaic_client::{
    AlbumSyncEffect, AlbumSyncEvent, AlbumSyncPhase, AlbumSyncRequest, AlbumSyncSnapshot,
    CleanupStagingReason, ClientError, ClientErrorCode, ManifestRecoveryOutcome, SyncPageSummary,
    UploadJobEffect, UploadJobEvent, UploadJobPhase, UploadJobRequest, UploadJobSnapshot,
    UploadShardRef, Uuid, advance_album_sync, advance_upload_job, new_album_sync, new_upload_job,
};

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

fn shard(tier: u8, index: u32) -> UploadShardRef {
    UploadShardRef {
        tier,
        shard_index: index,
        shard_id: uuid(20 + tier + index as u8),
        sha256: [0x90 + tier + index as u8; 32],
        content_length: 4096 + u64::from(index),
        envelope_version: 3,
        uploaded: false,
    }
}

fn new_upload_snapshot(request: UploadJobRequest) -> UploadJobSnapshot {
    new_upload_job(request).expect("upload job should initialize")
}

fn advance_upload_ok(
    snapshot: &UploadJobSnapshot,
    event: UploadJobEvent,
    expected_phase: UploadJobPhase,
    expected_effects: Vec<UploadJobEffect>,
    emitted_effects: &mut Vec<UploadJobEffect>,
) -> UploadJobSnapshot {
    let transition = advance_upload_job(snapshot, event).expect("upload transition should succeed");
    assert_eq!(transition.next_snapshot.phase, expected_phase);
    assert_eq!(transition.effects, expected_effects);
    emitted_effects.extend(transition.effects.clone());
    transition.next_snapshot
}

#[test]
fn upload_happy_path_emits_effects_and_persists_safe_fields() {
    let mut emitted_effects = Vec::new();
    let mut snapshot = new_upload_snapshot(upload_request(3));
    assert_eq!(snapshot.phase, UploadJobPhase::Queued);
    assert_eq!(snapshot.job_id, uuid(1));
    assert_eq!(snapshot.album_id, uuid(2));
    assert_eq!(snapshot.idempotency_key, uuid(4));
    assert!(snapshot.tiered_shards.is_empty());

    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::StartRequested {
            effect_id: uuid(10),
        },
        UploadJobPhase::AwaitingPreparedMedia,
        vec![UploadJobEffect::PrepareMedia {
            effect_id: uuid(10),
        }],
        &mut emitted_effects,
    );

    let shards = vec![shard(1, 0), shard(2, 0), shard(3, 0)];
    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::MediaPrepared {
            effect_id: uuid(11),
            tiered_shards: shards.clone(),
            shard_set_hash: Some([0xaa; 32]),
        },
        UploadJobPhase::AwaitingEpochHandle,
        vec![UploadJobEffect::AcquireEpochHandle {
            effect_id: uuid(11),
        }],
        &mut emitted_effects,
    );
    assert_eq!(snapshot.tiered_shards, shards);

    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::EpochHandleAcquired {
            effect_id: uuid(12),
        },
        UploadJobPhase::EncryptingShard,
        vec![UploadJobEffect::EncryptShard {
            effect_id: uuid(12),
            tier: 1,
            shard_index: 0,
        }],
        &mut emitted_effects,
    );

    for (base, tier, next_effect) in [(13, 1, Some(2)), (16, 2, Some(3)), (19, 3, None)] {
        let current = shard(tier, 0);
        snapshot = advance_upload_ok(
            &snapshot,
            UploadJobEvent::ShardEncrypted {
                effect_id: uuid(base),
                shard: current.clone(),
            },
            UploadJobPhase::CreatingShardUpload,
            vec![UploadJobEffect::CreateShardUpload {
                effect_id: uuid(base),
                shard: current.clone(),
            }],
            &mut emitted_effects,
        );
        snapshot = advance_upload_ok(
            &snapshot,
            UploadJobEvent::ShardUploadCreated {
                effect_id: uuid(base + 1),
                shard: current.clone(),
            },
            UploadJobPhase::UploadingShard,
            vec![UploadJobEffect::UploadShard {
                effect_id: uuid(base + 1),
                shard: current.clone(),
            }],
            &mut emitted_effects,
        );
        let expected_phase = if next_effect.is_some() {
            UploadJobPhase::EncryptingShard
        } else {
            UploadJobPhase::CreatingManifest
        };
        let expected_effects = match next_effect {
            Some(next_tier) => vec![UploadJobEffect::EncryptShard {
                effect_id: uuid(base + 2),
                tier: next_tier,
                shard_index: 0,
            }],
            None => vec![UploadJobEffect::CreateManifest {
                effect_id: uuid(base + 2),
                idempotency_key: uuid(4),
                tiered_shards: {
                    let mut completed = vec![shard(1, 0), shard(2, 0), shard(3, 0)];
                    for item in &mut completed {
                        item.uploaded = true;
                    }
                    completed
                },
                shard_set_hash: Some([0xaa; 32]),
            }],
        };
        snapshot = advance_upload_ok(
            &snapshot,
            UploadJobEvent::ShardUploaded {
                effect_id: uuid(base + 2),
                shard: current,
            },
            expected_phase,
            expected_effects,
            &mut emitted_effects,
        );
    }
    assert!(snapshot.tiered_shards.iter().all(|shard| shard.uploaded));

    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::ManifestCreated {
            effect_id: uuid(22),
        },
        UploadJobPhase::AwaitingSyncConfirmation,
        vec![UploadJobEffect::AwaitSyncConfirmation {
            effect_id: uuid(22),
        }],
        &mut emitted_effects,
    );

    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::SyncConfirmed {
            effect_id: uuid(23),
        },
        UploadJobPhase::Confirmed,
        Vec::new(),
        &mut emitted_effects,
    );
    assert_eq!(snapshot.phase, UploadJobPhase::Confirmed);
    assert_eq!(emitted_effects.len(), 13);
}

#[test]
fn upload_retry_records_metadata_returns_to_target_and_exhausts_budget() {
    let mut emitted_effects = Vec::new();
    let mut snapshot = new_upload_snapshot(upload_request(1));
    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::StartRequested {
            effect_id: uuid(30),
        },
        UploadJobPhase::AwaitingPreparedMedia,
        vec![UploadJobEffect::PrepareMedia {
            effect_id: uuid(30),
        }],
        &mut emitted_effects,
    );

    let retry = advance_upload_ok(
        &snapshot,
        UploadJobEvent::RetryableFailure {
            effect_id: uuid(31),
            code: ClientErrorCode::InvalidInputLength,
            now_ms: 1_000,
            base_backoff_ms: 1_000,
            server_retry_after_ms: Some(2_000),
        },
        UploadJobPhase::RetryWaiting,
        vec![UploadJobEffect::ScheduleRetry {
            effect_id: uuid(31),
            attempt: 0,
            not_before_ms: 3_000,
            target_phase: UploadJobPhase::AwaitingPreparedMedia,
        }],
        &mut emitted_effects,
    );
    assert_eq!(retry.retry_count, 1);
    assert_eq!(retry.next_retry_not_before_ms, Some(3_000));

    snapshot = advance_upload_ok(
        &retry,
        UploadJobEvent::RetryTimerElapsed {
            effect_id: uuid(32),
            target_phase: UploadJobPhase::AwaitingPreparedMedia,
        },
        UploadJobPhase::AwaitingPreparedMedia,
        vec![UploadJobEffect::PrepareMedia {
            effect_id: uuid(32),
        }],
        &mut emitted_effects,
    );

    let exhausted = advance_upload_job(
        &snapshot,
        UploadJobEvent::RetryableFailure {
            effect_id: uuid(33),
            code: ClientErrorCode::InvalidInputLength,
            now_ms: 4_000,
            base_backoff_ms: 1_000,
            server_retry_after_ms: None,
        },
    )
    .expect("budget exhaustion is a valid transition");
    assert_eq!(exhausted.next_snapshot.phase, UploadJobPhase::Failed);
    assert!(matches!(
        exhausted.effects.first(),
        Some(UploadJobEffect::CleanupStaging {
            reason: CleanupStagingReason::Failed,
            ..
        })
    ));
}

#[test]
fn upload_cancellation_before_work_and_manifest_uncertainty_recover_through_sync() {
    let mut emitted_effects = Vec::new();
    let snapshot = new_upload_snapshot(upload_request(3));
    let started = advance_upload_ok(
        &snapshot,
        UploadJobEvent::StartRequested {
            effect_id: uuid(40),
        },
        UploadJobPhase::AwaitingPreparedMedia,
        vec![UploadJobEffect::PrepareMedia {
            effect_id: uuid(40),
        }],
        &mut emitted_effects,
    );
    let cancelled = advance_upload_ok(
        &started,
        UploadJobEvent::CancelRequested {
            effect_id: uuid(41),
        },
        UploadJobPhase::Cancelled,
        vec![UploadJobEffect::CleanupStaging {
            effect_id: uuid(41),
            reason: CleanupStagingReason::UserCancelled,
        }],
        &mut emitted_effects,
    );
    assert!(cancelled.tiered_shards.is_empty());

    let manifest_snapshot = upload_at_creating_manifest(3);
    let unknown = advance_upload_ok(
        &manifest_snapshot,
        UploadJobEvent::ManifestOutcomeUnknown {
            effect_id: uuid(42),
            asset_id: uuid(3),
            since_metadata_version: 12,
        },
        UploadJobPhase::ManifestCommitUnknown,
        vec![UploadJobEffect::RecoverManifestThroughSync {
            effect_id: uuid(42),
            asset_id: uuid(3),
            since_metadata_version: 12,
            shard_set_hash: Some([0xaa; 32]),
        }],
        &mut emitted_effects,
    );

    let resolved = advance_upload_job(
        &unknown,
        UploadJobEvent::ManifestRecoveryResolved {
            effect_id: uuid(43),
            outcome: ManifestRecoveryOutcome::Match,
            now_ms: 10_000,
            base_backoff_ms: 1_000,
            server_retry_after_ms: None,
        },
    )
    .expect("manifest recovery match succeeds");
    assert_eq!(resolved.next_snapshot.phase, UploadJobPhase::Confirmed);
}

fn upload_at_creating_manifest(max_retry_count: u8) -> UploadJobSnapshot {
    let mut emitted = Vec::new();
    let mut snapshot = new_upload_snapshot(upload_request(max_retry_count));
    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::StartRequested {
            effect_id: uuid(50),
        },
        UploadJobPhase::AwaitingPreparedMedia,
        vec![UploadJobEffect::PrepareMedia {
            effect_id: uuid(50),
        }],
        &mut emitted,
    );
    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::MediaPrepared {
            effect_id: uuid(51),
            tiered_shards: vec![shard(3, 0)],
            shard_set_hash: Some([0xaa; 32]),
        },
        UploadJobPhase::AwaitingEpochHandle,
        vec![UploadJobEffect::AcquireEpochHandle {
            effect_id: uuid(51),
        }],
        &mut emitted,
    );
    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::EpochHandleAcquired {
            effect_id: uuid(52),
        },
        UploadJobPhase::EncryptingShard,
        vec![UploadJobEffect::EncryptShard {
            effect_id: uuid(52),
            tier: 3,
            shard_index: 0,
        }],
        &mut emitted,
    );
    let current = shard(3, 0);
    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::ShardEncrypted {
            effect_id: uuid(53),
            shard: current.clone(),
        },
        UploadJobPhase::CreatingShardUpload,
        vec![UploadJobEffect::CreateShardUpload {
            effect_id: uuid(53),
            shard: current.clone(),
        }],
        &mut emitted,
    );
    snapshot = advance_upload_ok(
        &snapshot,
        UploadJobEvent::ShardUploadCreated {
            effect_id: uuid(54),
            shard: current.clone(),
        },
        UploadJobPhase::UploadingShard,
        vec![UploadJobEffect::UploadShard {
            effect_id: uuid(54),
            shard: current.clone(),
        }],
        &mut emitted,
    );
    advance_upload_ok(
        &snapshot,
        UploadJobEvent::ShardUploaded {
            effect_id: uuid(55),
            shard: current,
        },
        UploadJobPhase::CreatingManifest,
        vec![UploadJobEffect::CreateManifest {
            effect_id: uuid(55),
            idempotency_key: uuid(4),
            tiered_shards: {
                let mut done = vec![shard(3, 0)];
                done[0].uploaded = true;
                done
            },
            shard_set_hash: Some([0xaa; 32]),
        }],
        &mut emitted,
    )
}

#[test]
fn album_sync_fetch_apply_retry_and_rerun_flow_is_preserved() {
    let mut snapshot = new_sync(sync_request());
    assert_eq!(snapshot.phase, AlbumSyncPhase::Idle);
    snapshot = advance_sync(
        &snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(sync_request()),
        },
        AlbumSyncPhase::FetchingPage,
        vec![AlbumSyncEffect::FetchPage { page_token: None }],
    );
    let retry = advance_album_sync(
        &snapshot,
        AlbumSyncEvent::RetryableFailure {
            code: ClientErrorCode::InvalidInputLength,
            retry_after_ms: Some(1_500),
        },
    )
    .expect("retry succeeds");
    assert_eq!(retry.snapshot.phase, AlbumSyncPhase::RetryWaiting);
    assert_eq!(
        retry.effects,
        vec![AlbumSyncEffect::ScheduleRetry {
            attempt: 1,
            retry_after_ms: 1_500,
            target_phase: AlbumSyncPhase::FetchingPage
        }]
    );
    snapshot = advance_album_sync(&retry.snapshot, AlbumSyncEvent::RetryTimerElapsed)
        .expect("retry resumes")
        .snapshot;
    assert_eq!(snapshot.phase, AlbumSyncPhase::FetchingPage);
    snapshot = advance_sync(
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
        vec![AlbumSyncEffect::ApplyPage {
            encrypted_item_count: 2,
        }],
    );
    snapshot.rerun_requested = true;
    let rerun = advance_album_sync(&snapshot, AlbumSyncEvent::PageApplied).expect("rerun succeeds");
    assert_eq!(rerun.snapshot.phase, AlbumSyncPhase::FetchingPage);
}

fn sync_request() -> AlbumSyncRequest {
    AlbumSyncRequest {
        sync_id: "sync-band2-001".to_owned(),
        album_id: "album-band2-001".to_owned(),
        initial_page_token: None,
        max_retry_count: 2,
    }
}

fn new_sync(request: AlbumSyncRequest) -> AlbumSyncSnapshot {
    new_album_sync(request).expect("album sync should initialize")
}

fn advance_sync(
    snapshot: &AlbumSyncSnapshot,
    event: AlbumSyncEvent,
    expected_phase: AlbumSyncPhase,
    expected_effects: Vec<AlbumSyncEffect>,
) -> AlbumSyncSnapshot {
    let transition = advance_album_sync(snapshot, event).expect("sync transition should succeed");
    assert_eq!(transition.snapshot.phase, expected_phase);
    assert_eq!(transition.effects, expected_effects);
    transition.snapshot
}

fn assert_redacted_debug<T: Debug>(value: &T) {
    let debug = format!("{value:?}");
    for forbidden in ["content://", "file://", "password", "secret", "plaintext"] {
        assert!(
            !debug.contains(forbidden),
            "debug leaked {forbidden}: {debug}"
        );
    }
}

#[test]
fn debug_output_for_upload_types_is_redacted() {
    assert_redacted_debug(&new_upload_snapshot(upload_request(2)));
}

fn assert_redacted_error(error: ClientError, code: ClientErrorCode) {
    assert_eq!(error.code, code);
    for forbidden in ["content://", "IMG_0001", ".jpg", "asset", "album"] {
        assert!(
            !error.message.contains(forbidden),
            "error message leaked {forbidden}"
        );
    }
}

#[test]
fn invalid_upload_uuid_errors_are_redacted() {
    let error = new_upload_job(UploadJobRequest {
        job_id: Uuid::from_bytes([0; 16]),
        ..upload_request(2)
    })
    .expect_err("invalid uuid rejected");
    assert_redacted_error(error, ClientErrorCode::ClientCoreInvalidSnapshot);
}
