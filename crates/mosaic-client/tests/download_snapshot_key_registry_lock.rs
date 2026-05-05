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
fn one_photo_plan(size: u64) -> DownloadPlan {
    DownloadPlanBuilder::new()
        .with_photo(DownloadPlanInput {
            photo_id: photo_id(1),
            filename: "one.jpg".to_owned(),
            shards: vec![shard(10, 7, ShardTier::Original, size)],
        })
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
    }
}
#[test]
fn download_snapshot_key_registry_matches_expected() {
    assert_eq!(
        download_job_snapshot_keys::KNOWN_DOWNLOAD_JOB_KEYS,
        &[
            ("SCHEMA_VERSION", 0),
            ("JOB_ID", 1),
            ("ALBUM_ID", 2),
            ("CREATED_AT_MS", 3),
            ("LAST_UPDATED_AT_MS", 4),
            ("STATE", 5),
            ("PLAN", 6),
            ("PHOTOS", 7),
            ("FAILURE_LOG", 8),
            ("LEASE_TOKEN", 9),
            ("SCOPE_KEY", 10),
        ]
    );
}

#[test]
fn lease_token_reserved_and_phase_one_writes_none() {
    let snap = snapshot(DownloadJobState::Idle, DownloadPlan::default());
    assert_eq!(snap.lease_token, None);
    assert!(snap.to_canonical_cbor().is_ok());
}
