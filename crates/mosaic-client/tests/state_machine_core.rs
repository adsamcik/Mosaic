#![allow(clippy::expect_used, clippy::unwrap_used)]

use mosaic_client::{
    AlbumSyncEffect, AlbumSyncEvent, AlbumSyncPhase, AlbumSyncRequest, ClientError,
    ClientErrorCode, SyncPageSummary, UploadJobEffect, UploadJobEvent, UploadJobPhase,
    UploadJobRequest, UploadJobSnapshot, UploadShardRef, Uuid, advance_album_sync,
    advance_upload_job, new_album_sync, new_upload_job, snapshot_schema,
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
        shard_id: uuid(20 + index as u8 + tier),
        sha256: [0x40 + tier + index as u8; 32],
        content_length: 1024 + u64::from(index),
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
        max_retry_count: 3,
    }
}

fn new_upload() -> UploadJobSnapshot {
    new_upload_job(upload_request()).expect("upload job should initialize")
}

fn advance_upload(
    snapshot: &UploadJobSnapshot,
    event: UploadJobEvent,
) -> mosaic_client::UploadJobTransition {
    advance_upload_job(snapshot, event).expect("upload transition should succeed")
}

fn upload_ready_to_create_manifest() -> UploadJobSnapshot {
    let snapshot = new_upload();
    let snapshot = advance_upload(
        &snapshot,
        UploadJobEvent::StartRequested {
            effect_id: uuid(10),
        },
    )
    .next_snapshot;
    let shards = vec![shard(1, 0), shard(2, 0), shard(3, 0)];
    let snapshot = advance_upload(
        &snapshot,
        UploadJobEvent::MediaPrepared {
            effect_id: uuid(11),
            tiered_shards: shards,
            shard_set_hash: Some([0x55; 32]),
        },
    )
    .next_snapshot;
    let mut snapshot = advance_upload(
        &snapshot,
        UploadJobEvent::EpochHandleAcquired {
            effect_id: uuid(12),
        },
    )
    .next_snapshot;
    for (n, effect) in [(13, 1), (16, 2), (19, 3)] {
        let current = shard(effect, 0);
        snapshot = advance_upload(
            &snapshot,
            UploadJobEvent::ShardEncrypted {
                effect_id: uuid(n),
                shard: current.clone(),
            },
        )
        .next_snapshot;
        snapshot = advance_upload(
            &snapshot,
            UploadJobEvent::ShardUploadCreated {
                effect_id: uuid(n + 1),
                shard: current.clone(),
            },
        )
        .next_snapshot;
        snapshot = advance_upload(
            &snapshot,
            UploadJobEvent::ShardUploaded {
                effect_id: uuid(n + 2),
                shard: current,
            },
        )
        .next_snapshot;
    }
    snapshot
}

#[test]
fn upload_job_progresses_through_happy_path_until_sync_confirmation() {
    let snapshot = new_upload();
    assert_eq!(
        snapshot.schema_version,
        snapshot_schema::SNAPSHOT_SCHEMA_VERSION_V1
    );
    assert_eq!(snapshot.phase, UploadJobPhase::Queued);

    let transition = advance_upload(
        &snapshot,
        UploadJobEvent::StartRequested {
            effect_id: uuid(10),
        },
    );
    assert_eq!(
        transition.next_snapshot.phase,
        UploadJobPhase::AwaitingPreparedMedia
    );
    assert_eq!(
        transition.effects,
        vec![UploadJobEffect::PrepareMedia {
            effect_id: uuid(10)
        }]
    );

    let shards = vec![shard(1, 0), shard(2, 0), shard(3, 0)];
    let transition = advance_upload(
        &transition.next_snapshot,
        UploadJobEvent::MediaPrepared {
            effect_id: uuid(11),
            tiered_shards: shards.clone(),
            shard_set_hash: Some([0x55; 32]),
        },
    );
    assert_eq!(
        transition.next_snapshot.phase,
        UploadJobPhase::AwaitingEpochHandle
    );
    assert_eq!(transition.next_snapshot.tiered_shards, shards);
    assert_eq!(
        transition.effects,
        vec![UploadJobEffect::AcquireEpochHandle {
            effect_id: uuid(11)
        }]
    );

    let transition = advance_upload(
        &transition.next_snapshot,
        UploadJobEvent::EpochHandleAcquired {
            effect_id: uuid(12),
        },
    );
    assert_eq!(
        transition.next_snapshot.phase,
        UploadJobPhase::EncryptingShard
    );
    assert_eq!(
        transition.effects,
        vec![UploadJobEffect::EncryptShard {
            effect_id: uuid(12),
            tier: 1,
            shard_index: 0
        }]
    );

    let final_shard = shard(1, 0);
    let transition = advance_upload(
        &transition.next_snapshot,
        UploadJobEvent::ShardEncrypted {
            effect_id: uuid(13),
            shard: final_shard.clone(),
        },
    );
    assert_eq!(
        transition.next_snapshot.phase,
        UploadJobPhase::CreatingShardUpload
    );
    assert_eq!(
        transition.effects,
        vec![UploadJobEffect::CreateShardUpload {
            effect_id: uuid(13),
            shard: final_shard.clone()
        }]
    );

    let transition = advance_upload(
        &transition.next_snapshot,
        UploadJobEvent::ShardUploadCreated {
            effect_id: uuid(14),
            shard: final_shard.clone(),
        },
    );
    assert_eq!(
        transition.next_snapshot.phase,
        UploadJobPhase::UploadingShard
    );
    assert_eq!(
        transition.effects,
        vec![UploadJobEffect::UploadShard {
            effect_id: uuid(14),
            shard: final_shard.clone()
        }]
    );

    let transition = advance_upload(
        &transition.next_snapshot,
        UploadJobEvent::ShardUploaded {
            effect_id: uuid(15),
            shard: final_shard,
        },
    );
    assert_eq!(
        transition.next_snapshot.phase,
        UploadJobPhase::EncryptingShard
    );
    assert_eq!(
        transition.effects,
        vec![UploadJobEffect::EncryptShard {
            effect_id: uuid(15),
            tier: 2,
            shard_index: 0
        }]
    );

    let mut manifest = transition.next_snapshot;
    for (n, tier) in [(16, 2), (19, 3)] {
        let current = shard(tier, 0);
        manifest = advance_upload(
            &manifest,
            UploadJobEvent::ShardEncrypted {
                effect_id: uuid(n),
                shard: current.clone(),
            },
        )
        .next_snapshot;
        manifest = advance_upload(
            &manifest,
            UploadJobEvent::ShardUploadCreated {
                effect_id: uuid(n + 1),
                shard: current.clone(),
            },
        )
        .next_snapshot;
        manifest = advance_upload(
            &manifest,
            UploadJobEvent::ShardUploaded {
                effect_id: uuid(n + 2),
                shard: current,
            },
        )
        .next_snapshot;
    }
    assert_eq!(manifest.phase, UploadJobPhase::CreatingManifest);
    assert!(manifest.tiered_shards.iter().all(|shard| shard.uploaded));

    let transition = advance_upload(
        &manifest,
        UploadJobEvent::ManifestCreated {
            effect_id: uuid(22),
        },
    );
    assert_eq!(
        transition.next_snapshot.phase,
        UploadJobPhase::AwaitingSyncConfirmation
    );
    assert_eq!(
        transition.effects,
        vec![UploadJobEffect::AwaitSyncConfirmation {
            effect_id: uuid(22)
        }]
    );

    let transition = advance_upload(
        &transition.next_snapshot,
        UploadJobEvent::SyncConfirmed {
            effect_id: uuid(23),
        },
    );
    assert_eq!(transition.next_snapshot.phase, UploadJobPhase::Confirmed);
    assert!(transition.effects.is_empty());
}

#[test]
fn upload_retry_waits_then_returns_to_event_target_and_exhausts_budget() {
    let snapshot = advance_upload(
        &new_upload(),
        UploadJobEvent::StartRequested {
            effect_id: uuid(30),
        },
    )
    .next_snapshot;
    let retry = advance_upload(
        &snapshot,
        UploadJobEvent::RetryableFailure {
            effect_id: uuid(31),
            code: ClientErrorCode::InvalidInputLength,
            now_ms: 1_000,
            base_backoff_ms: 1_000,
            server_retry_after_ms: Some(2_500),
        },
    );
    assert_eq!(retry.next_snapshot.phase, UploadJobPhase::RetryWaiting);
    assert_eq!(retry.next_snapshot.retry_count, 1);
    assert_eq!(
        retry.effects,
        vec![UploadJobEffect::ScheduleRetry {
            effect_id: uuid(31),
            attempt: 0,
            not_before_ms: 3_500,
            target_phase: UploadJobPhase::AwaitingPreparedMedia,
        }]
    );

    let resumed = advance_upload(
        &retry.next_snapshot,
        UploadJobEvent::RetryTimerElapsed {
            effect_id: uuid(32),
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
            effect_id: uuid(32)
        }]
    );

    let prepared = advance_upload(
        &resumed.next_snapshot,
        UploadJobEvent::MediaPrepared {
            effect_id: uuid(33),
            tiered_shards: vec![shard(3, 0)],
            shard_set_hash: None,
        },
    )
    .next_snapshot;
    assert_eq!(prepared.retry_count, 0);
}

#[test]
fn upload_manifest_unknown_recovers_through_sync_confirmation() {
    let snapshot = upload_ready_to_create_manifest();
    let transition = advance_upload(
        &snapshot,
        UploadJobEvent::ManifestOutcomeUnknown {
            effect_id: uuid(40),
            asset_id: uuid(3),
            since_metadata_version: 7,
        },
    );
    assert_eq!(
        transition.next_snapshot.phase,
        UploadJobPhase::ManifestCommitUnknown
    );
    assert_eq!(
        transition.effects,
        vec![UploadJobEffect::RecoverManifestThroughSync {
            effect_id: uuid(40),
            asset_id: uuid(3),
            since_metadata_version: 7,
            shard_set_hash: Some([0x55; 32]),
        }]
    );

    let transition = advance_upload(
        &transition.next_snapshot,
        UploadJobEvent::SyncConfirmed {
            effect_id: uuid(41),
        },
    );
    assert_eq!(transition.next_snapshot.phase, UploadJobPhase::Confirmed);
    assert!(transition.effects.is_empty());
}

#[test]
fn snapshots_and_errors_do_not_expose_obvious_forbidden_payloads() {
    let snapshot = advance_upload(
        &new_upload(),
        UploadJobEvent::StartRequested {
            effect_id: uuid(50),
        },
    )
    .next_snapshot;
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
            "snapshot debug leaked forbidden marker {forbidden}"
        );
    }

    let error = match new_upload_job(UploadJobRequest {
        job_id: Uuid::from_bytes([0; 16]),
        ..upload_request()
    }) {
        Ok(value) => panic!("invalid UUID should be rejected: {value:?}"),
        Err(error) => error,
    };
    assert_redacted_error(error, ClientErrorCode::ClientCoreInvalidSnapshot);
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
}

fn sync_request() -> AlbumSyncRequest {
    AlbumSyncRequest {
        sync_id: "sync-1".to_owned(),
        album_id: "album-1".to_owned(),
        initial_page_token: None,
        max_retry_count: 3,
    }
}

fn new_sync(request: AlbumSyncRequest) -> mosaic_client::AlbumSyncSnapshot {
    new_album_sync(request).expect("album sync should initialize")
}

fn advance_sync(
    snapshot: &mosaic_client::AlbumSyncSnapshot,
    event: AlbumSyncEvent,
) -> mosaic_client::AlbumSyncTransition {
    advance_album_sync(snapshot, event).expect("sync transition should succeed")
}

fn assert_redacted_error(error: ClientError, code: ClientErrorCode) {
    assert_eq!(error.code, code);
    for forbidden in ["content://", "IMG_0001", ".jpg", "asset-other", "album-1"] {
        assert!(
            !error.message.contains(forbidden),
            "error message leaked forbidden marker {forbidden}"
        );
    }
}
