#![allow(clippy::expect_used, clippy::unwrap_used)]

use mosaic_client::{
    CleanupStagingReason, ClientErrorCode, ManifestRecoveryOutcome, UploadJobEffect,
    UploadJobEvent, UploadJobPhase, UploadJobSnapshot, UploadShardRef, Uuid, advance_upload_job,
    next_retry_delay_ms, snapshot_schema,
};

fn uuid(seed: u8) -> Uuid {
    let mut bytes = [seed; 16];
    bytes[6] = 0x70 | (seed & 0x0f);
    bytes[8] = 0x80 | (seed & 0x3f);
    Uuid::from_bytes(bytes)
}

fn shard(index: u32) -> UploadShardRef {
    UploadShardRef {
        tier: 3,
        shard_index: index,
        shard_id: uuid(20 + index as u8),
        sha256: [0xa0 | (index as u8); 32],
        content_length: 1_234 + u64::from(index),
        envelope_version: 3,
        uploaded: false,
    }
}

fn snapshot(phase: UploadJobPhase) -> UploadJobSnapshot {
    UploadJobSnapshot {
        schema_version: snapshot_schema::SNAPSHOT_SCHEMA_VERSION_V1,
        job_id: uuid(1),
        album_id: uuid(2),
        phase,
        retry_count: 0,
        max_retry_count: 3,
        next_retry_not_before_ms: None,
        idempotency_key: uuid(3),
        tiered_shards: vec![shard(0)],
        shard_set_hash: Some([9; 32]),
        snapshot_revision: 0,
        last_acknowledged_effect_id: None,
        last_applied_event_id: None,
        failure_code: None,
    }
}

#[test]
fn phase_encoding_lock_integration() {
    assert_eq!(
        UploadJobPhase::Queued.to_u8(),
        snapshot_schema::upload_job_phase_codes::QUEUED
    );
    assert_eq!(UploadJobPhase::Cancelled.to_u8(), 11);
    assert_eq!(
        UploadJobPhase::try_from_u8(12),
        Some(UploadJobPhase::Failed)
    );
    assert_eq!(UploadJobPhase::try_from_u8(13), None);
}

#[test]
fn snapshot_cbor_canonical_golden_vector() {
    let mut snap = snapshot(UploadJobPhase::Queued);
    snap.snapshot_revision = 42;
    snap.last_acknowledged_effect_id = Some(uuid(4));
    let bytes = snap.to_canonical_cbor();
    let expected: Vec<u8> = vec![
        0xae, 0x00, 0x01, 0x01, 0x50, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x71, 0x01, 0x81, 0x01,
        0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x02, 0x50, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x72,
        0x02, 0x82, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x03, 0x00, 0x04, 0x00, 0x05, 0x03,
        0x06, 0xf6, 0x07, 0x50, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x73, 0x03, 0x83, 0x03, 0x03,
        0x03, 0x03, 0x03, 0x03, 0x03, 0x08, 0x81, 0xa7, 0x00, 0x03, 0x01, 0x00, 0x02, 0x50, 0x14,
        0x14, 0x14, 0x14, 0x14, 0x14, 0x74, 0x14, 0x94, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14, 0x14,
        0x03, 0x58, 0x20, 0xa0, 0xa0, 0xa0, 0xa0, 0xa0, 0xa0, 0xa0, 0xa0, 0xa0, 0xa0, 0xa0, 0xa0,
        0xa0, 0xa0, 0xa0, 0xa0, 0xa0, 0xa0, 0xa0, 0xa0, 0xa0, 0xa0, 0xa0, 0xa0, 0xa0, 0xa0, 0xa0,
        0xa0, 0xa0, 0xa0, 0xa0, 0xa0, 0x04, 0x19, 0x04, 0xd2, 0x05, 0x03, 0x06, 0xf4, 0x09, 0x58,
        0x20, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9,
        9, 9, 9, 9, 0x0a, 0x18, 0x2a, 0x0b, 0x50, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x74, 0x04,
        0x84, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0c, 0xf6, 0x0d, 0xf6,
    ];
    assert_eq!(bytes, expected);
    assert_eq!(
        UploadJobSnapshot::from_canonical_cbor(&bytes),
        Ok(snap.clone())
    );
    assert_eq!(
        snapshot_schema::upgrade_upload_job_snapshot(&bytes),
        Ok(snap)
    );
}

#[test]
fn snapshot_cbor_extended_golden_vector_covers_retry_none_and_c2_c3_bytes() {
    let mut snap = snapshot(UploadJobPhase::RetryWaiting);
    snap.retry_count = 64;
    snap.max_retry_count = 64;
    snap.next_retry_not_before_ms = Some(1_700_000_123);
    snap.last_acknowledged_effect_id = None;
    snap.shard_set_hash = None;
    snap.tiered_shards = vec![
        UploadShardRef {
            tier: 1,
            shard_index: 0,
            shard_id: uuid(0xc2),
            sha256: [0xc2; 32],
            content_length: 1,
            envelope_version: 3,
            uploaded: false,
        },
        UploadShardRef {
            tier: 2,
            shard_index: 0,
            shard_id: uuid(0xc3),
            sha256: [0xc3; 32],
            content_length: 2,
            envelope_version: 3,
            uploaded: true,
        },
        UploadShardRef {
            tier: 3,
            shard_index: 0,
            shard_id: uuid(0x35),
            sha256: [0x35; 32],
            content_length: 3,
            envelope_version: 4,
            uploaded: false,
        },
    ];

    let bytes = snap.to_canonical_cbor();
    assert!(bytes.contains(&0xc2));
    assert!(bytes.contains(&0xc3));
    assert_eq!(UploadJobSnapshot::from_canonical_cbor(&bytes), Ok(snap));
}

#[test]
fn snapshot_cbor_rejects_tags_text_extra_keys_and_noncanonical_shapes() {
    let mut tagged = snapshot(UploadJobPhase::Queued).to_canonical_cbor();
    tagged[2] = 0xc0;
    assert!(UploadJobSnapshot::from_canonical_cbor(&tagged).is_err());

    let mut extra_key = snapshot(UploadJobPhase::Queued).to_canonical_cbor();
    extra_key[0] = 0xad;
    extra_key.push(0x0c);
    extra_key.push(0x00);
    assert!(UploadJobSnapshot::from_canonical_cbor(&extra_key).is_err());

    let text_value = vec![0xa1, 0x00, 0x61, b'x'];
    assert!(UploadJobSnapshot::from_canonical_cbor(&text_value).is_err());
}

#[test]
fn backoff_law_table() {
    assert_eq!(next_retry_delay_ms(500, 0, None), 1_000);
    assert_eq!(next_retry_delay_ms(1_000, 3, None), 8_000);
    assert_eq!(next_retry_delay_ms(1_000, 3, Some(90_000)), 90_000);
    assert_eq!(next_retry_delay_ms(1_000, 0, Some(10_000)), 10_000);
    assert_eq!(next_retry_delay_ms(60_000, 10, None), 300_000);
}

#[test]
fn manifest_unknown_recovery_decision_table() {
    let unknown = advance_upload_job(
        snapshot(UploadJobPhase::CreatingManifest),
        UploadJobEvent::ManifestOutcomeUnknown {
            effect_id: uuid(30),
            asset_id: uuid(4),
            since_metadata_version: 12,
        },
    )
    .unwrap()
    .next_snapshot;

    let confirmed = advance_upload_job(
        unknown.clone(),
        UploadJobEvent::ManifestRecoveryResolved {
            effect_id: uuid(31),
            outcome: ManifestRecoveryOutcome::Match,
            now_ms: 10_000,
            base_backoff_ms: 1_000,
            server_retry_after_ms: None,
        },
    )
    .unwrap();
    assert_eq!(confirmed.next_snapshot.phase, UploadJobPhase::Confirmed);
    assert_eq!(confirmed.next_snapshot.failure_code, None);

    let conflict = advance_upload_job(
        unknown.clone(),
        UploadJobEvent::ManifestRecoveryResolved {
            effect_id: uuid(32),
            outcome: ManifestRecoveryOutcome::ShardSetConflict,
            now_ms: 10_000,
            base_backoff_ms: 1_000,
            server_retry_after_ms: None,
        },
    )
    .unwrap();
    assert_eq!(conflict.next_snapshot.phase, UploadJobPhase::Failed);
    assert_eq!(
        conflict.next_snapshot.failure_code,
        Some(ClientErrorCode::ManifestSetConflict)
    );
    assert!(matches!(
        conflict.effects[0],
        UploadJobEffect::CleanupStaging {
            reason: CleanupStagingReason::Failed,
            ..
        }
    ));

    let retry = advance_upload_job(
        unknown.clone(),
        UploadJobEvent::ManifestRecoveryResolved {
            effect_id: uuid(33),
            outcome: ManifestRecoveryOutcome::NotFoundTimedOut,
            now_ms: 10_000,
            base_backoff_ms: 1_000,
            server_retry_after_ms: None,
        },
    )
    .unwrap();
    assert_eq!(retry.next_snapshot.phase, UploadJobPhase::RetryWaiting);
    assert!(matches!(
        retry.effects[0],
        UploadJobEffect::ScheduleRetry {
            not_before_ms: 11_000,
            ..
        }
    ));

    let expired = advance_upload_job(
        unknown,
        UploadJobEvent::ManifestRecoveryResolved {
            effect_id: uuid(34),
            outcome: ManifestRecoveryOutcome::IdempotencyExpired,
            now_ms: 10_000,
            base_backoff_ms: 1_000,
            server_retry_after_ms: None,
        },
    )
    .unwrap();
    assert_eq!(expired.next_snapshot.phase, UploadJobPhase::Failed);
    assert_eq!(
        expired.next_snapshot.failure_code,
        Some(ClientErrorCode::IdempotencyExpired)
    );
}

#[test]
fn retry_timer_elapsed_rejects_terminal_target_phase() {
    for target_phase in [
        UploadJobPhase::Confirmed,
        UploadJobPhase::Cancelled,
        UploadJobPhase::Failed,
    ] {
        let error = advance_upload_job(
            snapshot(UploadJobPhase::RetryWaiting),
            UploadJobEvent::RetryTimerElapsed {
                effect_id: uuid(39),
                target_phase,
            },
        )
        .unwrap_err();
        assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidTransition);
    }
}

#[test]
fn non_retryable_failure_persists_failure_code() {
    let transition = advance_upload_job(
        snapshot(UploadJobPhase::CreatingManifest),
        UploadJobEvent::NonRetryableFailure {
            effect_id: uuid(52),
            code: ClientErrorCode::AuthenticationFailed,
        },
    )
    .unwrap();

    assert_eq!(transition.next_snapshot.phase, UploadJobPhase::Failed);
    assert_eq!(
        transition.next_snapshot.failure_code,
        Some(ClientErrorCode::AuthenticationFailed)
    );
}

#[test]
fn adr011_deletion_mid_upload_cancels_and_cleans_staging() {
    for phase in [
        UploadJobPhase::EncryptingShard,
        UploadJobPhase::UploadingShard,
        UploadJobPhase::CreatingManifest,
        UploadJobPhase::ManifestCommitUnknown,
        UploadJobPhase::AwaitingSyncConfirmation,
    ] {
        let transition = advance_upload_job(
            snapshot(phase),
            UploadJobEvent::AlbumDeleted {
                effect_id: uuid(40),
            },
        )
        .unwrap();
        assert_eq!(transition.next_snapshot.phase, UploadJobPhase::Cancelled);
        assert_eq!(
            transition.effects,
            vec![UploadJobEffect::CleanupStaging {
                effect_id: uuid(40),
                reason: CleanupStagingReason::AlbumDeleted
            }]
        );
    }
}

#[test]
fn effect_idempotency_deterministic_replay_and_revision_increment() {
    let snap = snapshot(UploadJobPhase::CreatingManifest);
    let event = UploadJobEvent::ManifestOutcomeUnknown {
        effect_id: uuid(50),
        asset_id: uuid(4),
        since_metadata_version: 12,
    };
    let a = advance_upload_job(snap.clone(), event.clone()).unwrap();
    let b = advance_upload_job(snap, event).unwrap();
    assert_eq!(a.effects, b.effects);
    assert_eq!(a.next_snapshot.last_applied_event_id, Some(uuid(50)));
    assert_eq!(a.next_snapshot.last_acknowledged_effect_id, None);
    assert_eq!(a.next_snapshot.snapshot_revision, 1);

    let replay = advance_upload_job(
        a.next_snapshot.clone(),
        UploadJobEvent::ManifestOutcomeUnknown {
            effect_id: uuid(50),
            asset_id: uuid(4),
            since_metadata_version: 12,
        },
    )
    .unwrap();
    assert_eq!(replay.next_snapshot, a.next_snapshot);
    assert!(replay.effects.is_empty());
}
