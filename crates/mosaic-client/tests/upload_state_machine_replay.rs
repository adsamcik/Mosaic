#![allow(clippy::expect_used, clippy::unwrap_used)]

use mosaic_client::{
    UploadJobEvent, UploadJobPhase, UploadJobSnapshot, UploadShardRef, Uuid, advance_upload_job,
    snapshot_schema,
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
        shard_id: uuid(60 + index as u8),
        sha256: [0xb0 | (index as u8); 32],
        content_length: 10,
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
        shard_set_hash: Some([7; 32]),
        snapshot_revision: 7,
        last_acknowledged_effect_id: None,
        last_applied_event_id: None,
        failure_code: None,
    }
}

#[test]
fn crash_replay_vectors_for_ack_drop_boundaries() {
    let encrypted = advance_upload_job(
        snapshot(UploadJobPhase::EncryptingShard),
        UploadJobEvent::ShardEncrypted {
            effect_id: uuid(70),
            shard: shard(0),
        },
    )
    .unwrap();
    assert_eq!(
        encrypted.next_snapshot.phase,
        UploadJobPhase::CreatingShardUpload
    );
    assert_eq!(encrypted.next_snapshot.snapshot_revision, 8);
    assert_idempotent_replay(
        &encrypted.next_snapshot,
        UploadJobEvent::ShardEncrypted {
            effect_id: uuid(70),
            shard: shard(0),
        },
    );

    let created = advance_upload_job(
        snapshot(UploadJobPhase::CreatingShardUpload),
        UploadJobEvent::ShardUploadCreated {
            effect_id: uuid(71),
            shard: shard(0),
        },
    )
    .unwrap();
    assert_eq!(created.next_snapshot.phase, UploadJobPhase::UploadingShard);
    assert_idempotent_replay(
        &created.next_snapshot,
        UploadJobEvent::ShardUploadCreated {
            effect_id: uuid(71),
            shard: shard(0),
        },
    );

    let manifest_unknown = advance_upload_job(
        snapshot(UploadJobPhase::CreatingManifest),
        UploadJobEvent::ManifestOutcomeUnknown {
            effect_id: uuid(72),
            asset_id: uuid(4),
            since_metadata_version: 99,
        },
    )
    .unwrap();
    assert_eq!(
        manifest_unknown.next_snapshot.phase,
        UploadJobPhase::ManifestCommitUnknown
    );
    assert_idempotent_replay(
        &manifest_unknown.next_snapshot,
        UploadJobEvent::ManifestOutcomeUnknown {
            effect_id: uuid(72),
            asset_id: uuid(4),
            since_metadata_version: 99,
        },
    );
}

#[test]
fn native_round_trip_byte_equality_golden_serialization() {
    let bytes = snapshot(UploadJobPhase::CreatingManifest).to_canonical_cbor();
    let upgraded = snapshot_schema::upgrade_upload_job_snapshot(&bytes).unwrap();
    assert_eq!(upgraded.to_canonical_cbor(), bytes);
}

#[test]
fn effect_ack_does_not_poison_event_replay_dedup() {
    let event = UploadJobEvent::ShardEncrypted {
        effect_id: uuid(70),
        shard: shard(0),
    };
    let applied =
        advance_upload_job(snapshot(UploadJobPhase::EncryptingShard), event.clone()).unwrap();

    let acknowledged = advance_upload_job(
        applied.next_snapshot.clone(),
        UploadJobEvent::EffectAck {
            effect_id: uuid(71),
        },
    )
    .unwrap();
    assert_eq!(
        acknowledged.next_snapshot.last_applied_event_id,
        Some(uuid(70))
    );
    assert_eq!(
        acknowledged.next_snapshot.last_acknowledged_effect_id,
        Some(uuid(71))
    );

    let replay = advance_upload_job(acknowledged.next_snapshot.clone(), event).unwrap();
    assert_eq!(replay.next_snapshot, acknowledged.next_snapshot);
    assert!(replay.effects.is_empty());
}

fn assert_idempotent_replay(snapshot: &UploadJobSnapshot, event: UploadJobEvent) {
    let bytes = snapshot.to_canonical_cbor();
    let decoded = UploadJobSnapshot::from_canonical_cbor(&bytes).unwrap();
    let replay = advance_upload_job(decoded, event).unwrap();
    assert_eq!(replay.next_snapshot, *snapshot);
    assert!(replay.effects.is_empty());
}
