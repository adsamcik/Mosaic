#![allow(dead_code, clippy::expect_used, clippy::unwrap_used)]

use mosaic_client::Uuid;
use mosaic_client::download::*;
use mosaic_domain::ShardTier;

fn uuid(seed: u8) -> Uuid {
    let mut bytes = [seed; 16];
    bytes[6] = 0x70 | (seed & 0x0f);
    bytes[8] = 0x80 | (seed & 0x3f);
    Uuid::from_bytes(bytes)
}
fn job_id(seed: u8) -> JobId {
    JobId::from_bytes(*uuid(seed).as_bytes())
}
fn photo_id(seed: u8) -> PhotoId {
    PhotoId::new(format!("photo-{seed:02}"))
}
fn shard(seed: u8, epoch_id: u32, tier: ShardTier, size: u64) -> DownloadShardInput {
    DownloadShardInput {
        shard_id: ShardId::from_bytes([seed; 16]),
        epoch_id,
        tier,
        expected_hash: [seed; 32],
        declared_size: size,
    }
}
fn input(seed: u8, filename: &str, shards: Vec<DownloadShardInput>) -> DownloadPlanInput {
    DownloadPlanInput {
        photo_id: photo_id(seed),
        filename: filename.to_owned(),
        shards,
    }
}
fn plan_one() -> DownloadPlan {
    DownloadPlanBuilder::new()
        .with_photo(input(
            1,
            "one.jpg",
            vec![shard(10, 7, ShardTier::Original, 12)],
        ))
        .build()
        .unwrap()
}
fn snapshot(state: DownloadJobState, plan: DownloadPlan) -> DownloadJobSnapshot {
    let photos = plan
        .entries
        .iter()
        .map(|entry| PhotoState {
            photo_id: entry.photo_id.clone(),
            status: PhotoStatus::Pending,
            bytes_written: 0,
            last_attempt_at_ms: None,
            retry_count: 0,
        })
        .collect();
    DownloadJobSnapshot {
        schema_version: CURRENT_DOWNLOAD_SNAPSHOT_SCHEMA_VERSION,
        job_id: job_id(1),
        album_id: uuid(2),
        created_at_ms: 100,
        last_updated_at_ms: 200,
        state,
        plan,
        photos,
        failure_log: Vec::new(),
        lease_token: None,
        scope_key: String::from("auth:00000000000000000000000000000000"),
        schedule: None,
    }
}

#[test]
fn zero_photo_album_happy_path_is_noop_success() {
    let start = DownloadJobEvent::StartRequested {
        job_id: job_id(1),
        album_id: uuid(2),
    };
    let mut state = apply(&DownloadJobState::Idle, &start).unwrap();
    assert_eq!(state, DownloadJobState::Preparing);
    state = apply(&state, &DownloadJobEvent::PlanReady).unwrap();
    assert_eq!(state, DownloadJobState::Running);
    state = apply(&state, &DownloadJobEvent::AllPhotosDone).unwrap();
    assert_eq!(state, DownloadJobState::Finalizing);
    state = apply(&state, &DownloadJobEvent::FinalizationDone).unwrap();
    assert_eq!(state, DownloadJobState::Done);
}

#[test]
fn one_photo_album_and_one_shard_happy_path() {
    let plan = plan_one();
    assert_eq!(plan.entries.len(), 1);
    assert_eq!(plan.entries[0].shard_ids.len(), 1);
    let mut snap = snapshot(DownloadJobState::Running, plan);
    snap.photos[0].status = PhotoStatus::InFlight;
    assert!(
        mosaic_client::download::state::photo_status_persists_snapshot(
            &PhotoStatus::Pending,
            &snap.photos[0].status
        )
    );
    snap.photos[0].status = PhotoStatus::Done;
    snap.photos[0].bytes_written = 12;
    assert_eq!(
        apply(&snap.state, &DownloadJobEvent::AllPhotosDone).unwrap(),
        DownloadJobState::Finalizing
    );
}

#[test]
fn access_revoked_and_authorization_changed_are_terminal_no_retry_errors() {
    let errored = apply(
        &DownloadJobState::Running,
        &DownloadJobEvent::ErrorEncountered {
            reason: DownloadErrorCode::AccessRevoked,
        },
    )
    .unwrap();
    assert_eq!(
        errored,
        DownloadJobState::Errored {
            reason: DownloadErrorCode::AccessRevoked
        }
    );
    assert!(apply(&errored, &DownloadJobEvent::ResumeRequested).is_err());
    let snap = snapshot(errored.clone(), plan_one());
    let bytes = encode_snapshot_bytes(&prepare_snapshot_bytes(&snap).unwrap()).unwrap();
    assert_eq!(
        upgrade_download_snapshot(&bytes).unwrap(),
        DownloadSnapshotDecode::Verified(snap)
    );
    assert!(!DownloadErrorCode::AccessRevoked.is_retryable());
    assert!(!DownloadErrorCode::AuthorizationChanged.is_retryable());
}

#[test]
fn finalizing_cancel_semantics_and_terminal_idempotence() {
    assert_eq!(
        apply(
            &DownloadJobState::Finalizing,
            &DownloadJobEvent::CancelRequested { soft: true }
        )
        .unwrap(),
        DownloadJobState::Cancelled { soft: true }
    );
    assert_eq!(
        apply(
            &DownloadJobState::Finalizing,
            &DownloadJobEvent::CancelRequested { soft: false }
        )
        .unwrap(),
        DownloadJobState::Cancelled { soft: false }
    );
    assert!(
        apply(
            &DownloadJobState::Cancelled { soft: false },
            &DownloadJobEvent::CancelRequested { soft: true }
        )
        .is_err()
    );
    assert_eq!(
        apply(
            &DownloadJobState::Done,
            &DownloadJobEvent::CancelRequested { soft: true }
        )
        .unwrap(),
        DownloadJobState::Done
    );
    assert_eq!(
        apply(
            &DownloadJobState::Cancelled { soft: true },
            &DownloadJobEvent::CancelRequested { soft: false }
        )
        .unwrap(),
        DownloadJobState::Cancelled { soft: false }
    );
}

#[test]
fn replay_exercises_full_positive_transition_table() {
    assert_eq!(
        apply(
            &DownloadJobState::Running,
            &DownloadJobEvent::PauseRequested
        )
        .unwrap(),
        DownloadJobState::Paused
    );
    assert_eq!(
        apply(
            &DownloadJobState::Paused,
            &DownloadJobEvent::ResumeRequested
        )
        .unwrap(),
        DownloadJobState::Running
    );
    assert_eq!(
        apply(
            &DownloadJobState::Preparing,
            &DownloadJobEvent::ErrorEncountered {
                reason: DownloadErrorCode::Quota
            }
        )
        .unwrap(),
        DownloadJobState::Errored {
            reason: DownloadErrorCode::Quota
        }
    );
}
