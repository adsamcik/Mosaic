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
fn multi_epoch_photo_and_tier_one_plan_are_rejected() {
    let multi = DownloadPlanBuilder::new()
        .with_photo(input(
            1,
            "a.jpg",
            vec![
                shard(1, 7, ShardTier::Original, 1),
                shard(2, 8, ShardTier::Original, 1),
            ],
        ))
        .build();
    assert_eq!(
        multi,
        Err(DownloadPlanError::MultiEpochPhoto {
            photo_id: photo_id(1),
            epochs: vec![7, 8]
        })
    );
    let tier = DownloadPlanBuilder::new()
        .with_photo(input(
            1,
            "a.jpg",
            vec![shard(1, 7, ShardTier::Thumbnail, 1)],
        ))
        .build();
    assert_eq!(
        tier,
        Err(DownloadPlanError::DisallowedTier {
            photo_id: photo_id(1),
            tier: ShardTier::Thumbnail
        })
    );
}

#[test]
fn zero_shard_photo_rejected_and_empty_plan_valid() {
    let empty_photo = DownloadPlanBuilder::new()
        .with_photo(input(1, "a.jpg", Vec::new()))
        .build();
    assert_eq!(
        empty_photo,
        Err(DownloadPlanError::PhotoHasNoShards {
            photo_id: photo_id(1)
        })
    );
    assert!(DownloadPlanBuilder::new().build().unwrap().is_empty());
}

#[test]
fn filename_normalization_rules_are_canonical() {
    let id = PhotoId::new("abcdef012345");
    assert_eq!(
        sanitize_download_filename("bad<>:\"/\\|?*\u{1f}name.jpg", &id),
        "bad__________name.jpg"
    );
    assert_eq!(sanitize_download_filename("trailing. ", &id), "trailing");
    assert_eq!(sanitize_download_filename("NUL.JPG", &id), "NUL_.JPG");
    assert_eq!(sanitize_download_filename("<>. ", &id), "__");
    assert_eq!(sanitize_download_filename("   ", &id), "photo-abcdef01.jpg");
}

#[test]
fn filename_collisions_receive_deterministic_suffixes() {
    let plan = DownloadPlanBuilder::new()
        .with_photo(input(
            1,
            "same.jpg",
            vec![shard(1, 7, ShardTier::Original, 1)],
        ))
        .with_photo(input(
            2,
            "same.jpg",
            vec![shard(2, 7, ShardTier::Original, 1)],
        ))
        .with_photo(input(
            3,
            "same.jpg",
            vec![shard(3, 7, ShardTier::Original, 1)],
        ))
        .build()
        .unwrap();
    assert_eq!(plan.entries[0].filename, "same.jpg");
    assert_eq!(plan.entries[1].filename, "same (2).jpg");
    assert_eq!(plan.entries[2].filename, "same (3).jpg");
}

#[test]
fn future_schema_version_and_torn_snapshot_are_detected() {
    let mut snap = snapshot(DownloadJobState::Running, plan_one());
    snap.schema_version = CURRENT_DOWNLOAD_SNAPSHOT_SCHEMA_VERSION + 1;
    assert!(matches!(
        snap.to_canonical_cbor(),
        Err(DownloadSnapshotError::SchemaTooNew { .. })
    ));
    let mut snap = snapshot(DownloadJobState::Running, plan_one());
    snap.photos[0].bytes_written = 10;
    let repaired = repair_snapshot_for_resume(&snap, &[(photo_id(1), 1)]).unwrap();
    assert_eq!(repaired.torn_photos, vec![photo_id(1)]);
}
