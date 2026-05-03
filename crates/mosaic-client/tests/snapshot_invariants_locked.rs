use mosaic_client::{
    ClientErrorCode, UploadJobPhase, UploadJobSnapshot, UploadShardRef, Uuid, snapshot_schema,
};

fn uuid(seed: u8) -> Uuid {
    let mut bytes = [seed; 16];
    bytes[6] = 0x70 | (seed & 0x0f);
    bytes[8] = 0x80 | (seed & 0x3f);
    Uuid::from_bytes(bytes)
}

fn shard(index: u32, uploaded: bool) -> UploadShardRef {
    UploadShardRef {
        tier: 3,
        shard_index: index,
        shard_id: uuid(20 + index as u8),
        sha256: [0xa0 | (index as u8); 32],
        content_length: 1_234 + u64::from(index),
        envelope_version: 3,
        uploaded,
    }
}

fn snapshot(phase: UploadJobPhase, shards: Vec<UploadShardRef>) -> UploadJobSnapshot {
    UploadJobSnapshot {
        schema_version: snapshot_schema::SNAPSHOT_SCHEMA_VERSION_V1,
        job_id: uuid(1),
        album_id: uuid(2),
        phase,
        retry_count: 0,
        max_retry_count: 3,
        next_retry_not_before_ms: None,
        idempotency_key: uuid(3),
        tiered_shards: shards,
        shard_set_hash: Some([9; 32]),
        snapshot_revision: 0,
        last_acknowledged_effect_id: None,
        last_applied_event_id: None,
        failure_code: None,
    }
}

#[test]
fn decoded_confirmed_with_unuploaded_shards_rejected() {
    let bytes = snapshot(UploadJobPhase::Confirmed, vec![shard(0, false)]).to_canonical_cbor();
    assert!(UploadJobSnapshot::from_canonical_cbor(&bytes).is_err());
}

#[test]
fn decoded_failed_without_failure_code_rejected() {
    let bytes = snapshot(UploadJobPhase::Failed, vec![shard(0, true)]).to_canonical_cbor();
    assert!(UploadJobSnapshot::from_canonical_cbor(&bytes).is_err());
}

#[test]
fn decoded_creating_manifest_with_empty_shards_rejected() {
    let bytes = snapshot(UploadJobPhase::CreatingManifest, Vec::new()).to_canonical_cbor();
    assert!(UploadJobSnapshot::from_canonical_cbor(&bytes).is_err());
}

#[test]
fn decoded_queued_with_shards_rejected() {
    let bytes = snapshot(UploadJobPhase::Queued, vec![shard(0, false)]).to_canonical_cbor();
    assert!(UploadJobSnapshot::from_canonical_cbor(&bytes).is_err());
}

#[test]
fn decoded_failed_with_failure_code_and_uploaded_shards_accepted() {
    let mut snap = snapshot(UploadJobPhase::Failed, vec![shard(0, true)]);
    snap.failure_code = Some(ClientErrorCode::AuthenticationFailed);
    let bytes = snap.to_canonical_cbor();
    assert_eq!(UploadJobSnapshot::from_canonical_cbor(&bytes), Ok(snap));
}
