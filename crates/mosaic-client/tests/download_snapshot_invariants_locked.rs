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
fn snapshot_round_trip_checksum_and_legacy_decode_paths() {
    let snap = snapshot(DownloadJobState::Running, one_photo_plan(12));
    let prepared = prepare_snapshot_bytes(&snap).unwrap();
    let encoded = encode_snapshot_bytes(&prepared).unwrap();
    assert_eq!(
        upgrade_download_snapshot(&encoded).unwrap(),
        DownloadSnapshotDecode::Verified(snap.clone())
    );
    assert_eq!(
        upgrade_download_snapshot(&prepared.body).unwrap(),
        DownloadSnapshotDecode::LegacyWithoutChecksum(snap)
    );
}

#[test]
fn corrupt_checksum_and_truncated_body_are_typed_errors() {
    let snap = snapshot(DownloadJobState::Running, one_photo_plan(12));
    let mut prepared = prepare_snapshot_bytes(&snap).unwrap();
    prepared.checksum[0] ^= 1;
    let encoded = encode_snapshot_bytes(&prepared).unwrap();
    assert_eq!(
        upgrade_download_snapshot(&encoded),
        Err(DownloadSnapshotError::ChecksumMismatch)
    );
    let mut truncated = prepare_snapshot_bytes(&snap).unwrap().body;
    truncated.truncate(3);
    assert_eq!(
        DownloadJobSnapshot::from_canonical_cbor(&truncated),
        Err(DownloadSnapshotError::CborDecodeFailed)
    );
}

#[test]
fn bytes_written_cannot_exceed_plan_total_and_original_tier_is_locked() {
    let mut snap = snapshot(DownloadJobState::Running, one_photo_plan(5));
    snap.photos[0].bytes_written = 6;
    assert_eq!(
        snap.to_canonical_cbor(),
        Err(DownloadSnapshotError::SchemaCorrupt)
    );
    let mut snap = snapshot(DownloadJobState::Running, one_photo_plan(5));
    snap.plan.entries[0].tier = ShardTier::Preview;
    assert_eq!(
        snap.to_canonical_cbor(),
        Err(DownloadSnapshotError::SchemaCorrupt)
    );
}

#[test]
fn resume_repairs_longer_files_and_resets_torn_shorter_files() {
    let mut snap = snapshot(DownloadJobState::Running, one_photo_plan(20));
    snap.photos[0].bytes_written = 10;
    let longer = repair_snapshot_for_resume(&snap, &[(photo_id(1), 12)]).unwrap();
    assert_eq!(
        longer.truncations,
        vec![SnapshotTruncation {
            photo_id: photo_id(1),
            len: 10
        }]
    );
    let shorter = repair_snapshot_for_resume(&snap, &[(photo_id(1), 8)]).unwrap();
    assert_eq!(shorter.torn_photos, vec![photo_id(1)]);
    assert_eq!(shorter.snapshot.photos[0].status, PhotoStatus::Pending);
    assert_eq!(shorter.snapshot.photos[0].bytes_written, 0);
}

#[test]
fn zero_byte_original_is_valid_done_photo() {
    let mut snap = snapshot(DownloadJobState::Running, one_photo_plan(0));
    snap.photos[0].status = PhotoStatus::Done;
    snap.photos[0].bytes_written = 0;
    let bytes = snap.to_canonical_cbor().unwrap();
    assert_eq!(
        DownloadJobSnapshot::from_canonical_cbor(&bytes)
            .unwrap()
            .photos[0]
            .status,
        PhotoStatus::Done
    );
}
