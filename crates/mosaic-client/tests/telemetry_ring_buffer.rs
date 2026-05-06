#![allow(clippy::expect_used, clippy::unwrap_used)]

use ciborium::value::{Integer, Value};
use mosaic_client::snapshot_schema::{SNAPSHOT_SCHEMA_VERSION_V1, upload_job_snapshot_keys};
use mosaic_client::telemetry::{TelemetryRingBuffer, counters};
use mosaic_client::{
    AlbumSyncEvent, AlbumSyncPhase, AlbumSyncRequest, ClientErrorCode, UploadJobEvent,
    UploadJobPhase, UploadJobSnapshot, Uuid, advance_album_sync_with_telemetry,
    advance_upload_job_with_telemetry, new_album_sync, new_upload_job,
};

fn uuid(seed: u8) -> Uuid {
    let mut bytes = [seed; 16];
    bytes[6] = 0x70 | (seed & 0x0f);
    bytes[8] = 0x80 | (seed & 0x3f);
    Uuid::from_bytes(bytes)
}

#[test]
fn ring_buffer_increments_known_counters() {
    let mut telemetry = TelemetryRingBuffer::new(4);

    telemetry.increment(counters::EFFECT_ACK_DEDUP_DROP);
    telemetry.increment(counters::EFFECT_ACK_DEDUP_DROP);
    telemetry.increment(counters::MANIFEST_COMMIT_UNKNOWN_RETRY_REJECTED);

    assert_eq!(
        telemetry.snapshot(),
        vec![
            (counters::EFFECT_ACK_DEDUP_DROP.to_owned(), 2),
            (
                counters::MANIFEST_COMMIT_UNKNOWN_RETRY_REJECTED.to_owned(),
                1,
            ),
        ]
    );
}

#[test]
fn ring_buffer_evicts_lru_at_capacity() {
    let mut telemetry = TelemetryRingBuffer::new(2);

    telemetry.increment(counters::EFFECT_ACK_DEDUP_DROP);
    telemetry.increment(counters::MANIFEST_COMMIT_UNKNOWN_RETRY_REJECTED);
    telemetry.increment(counters::EFFECT_ACK_DEDUP_DROP);
    telemetry.increment(counters::ALBUM_SYNC_EXHAUSTION_WITH_ORIGINATING_CODE);

    assert_eq!(
        telemetry.snapshot(),
        vec![
            (
                counters::ALBUM_SYNC_EXHAUSTION_WITH_ORIGINATING_CODE.to_owned(),
                1,
            ),
            (counters::EFFECT_ACK_DEDUP_DROP.to_owned(), 2),
        ]
    );
}

#[test]
fn ring_buffer_snapshot_is_deterministic() {
    let mut telemetry = TelemetryRingBuffer::new(4);
    telemetry.increment(counters::MANIFEST_COMMIT_UNKNOWN_RETRY_REJECTED);
    telemetry.increment(counters::EFFECT_ACK_DEDUP_DROP);
    telemetry.increment(counters::LEGACY_RETRY_WAITING_MANIFEST_COMMIT_UNKNOWN_MIGRATED);

    assert_eq!(telemetry.snapshot(), telemetry.snapshot());
    assert_eq!(
        telemetry.snapshot(),
        vec![
            (counters::EFFECT_ACK_DEDUP_DROP.to_owned(), 1),
            (
                counters::LEGACY_RETRY_WAITING_MANIFEST_COMMIT_UNKNOWN_MIGRATED.to_owned(),
                1,
            ),
            (
                counters::MANIFEST_COMMIT_UNKNOWN_RETRY_REJECTED.to_owned(),
                1,
            ),
        ]
    );
}

#[test]
fn ring_buffer_kill_switch_disables_increments() {
    let mut telemetry = TelemetryRingBuffer::new(4);
    telemetry.increment(counters::EFFECT_ACK_DEDUP_DROP);

    telemetry.set_enabled(false);
    telemetry.increment(counters::EFFECT_ACK_DEDUP_DROP);
    telemetry.increment(counters::MANIFEST_COMMIT_UNKNOWN_RETRY_REJECTED);

    assert!(!telemetry.is_enabled());
    assert!(telemetry.snapshot().is_empty());

    telemetry.set_enabled(true);
    telemetry.increment(counters::EFFECT_ACK_DEDUP_DROP);

    assert_eq!(
        telemetry.snapshot(),
        vec![(counters::EFFECT_ACK_DEDUP_DROP.to_owned(), 1)]
    );
}

#[test]
fn ring_buffer_reset_clears_counters() {
    let mut telemetry = TelemetryRingBuffer::new(4);
    telemetry.increment(counters::EFFECT_ACK_DEDUP_DROP);
    telemetry.increment(counters::MANIFEST_COMMIT_UNKNOWN_RETRY_REJECTED);

    telemetry.reset();

    assert!(telemetry.snapshot().is_empty());
}

#[test]
fn ring_buffer_diagnostic_payload_is_cbor() {
    let mut telemetry = TelemetryRingBuffer::new(4);
    telemetry.increment(counters::EFFECT_ACK_DEDUP_DROP);
    telemetry.increment(counters::EFFECT_ACK_DEDUP_DROP);

    let payload = telemetry.to_diagnostic_payload().unwrap();
    let decoded: Vec<(String, u64)> =
        ciborium::de::from_reader(std::io::Cursor::new(payload)).unwrap();

    assert_eq!(
        decoded,
        vec![(counters::EFFECT_ACK_DEDUP_DROP.to_owned(), 2)]
    );
}

#[test]
fn upload_effect_ack_dedup_increments_counter() {
    let effect_id = uuid(10);
    let mut snapshot = upload_snapshot(UploadJobPhase::Queued);
    snapshot.last_acknowledged_effect_id = Some(effect_id);
    let mut telemetry = TelemetryRingBuffer::new(4);

    let transition = advance_upload_job_with_telemetry(
        &snapshot,
        UploadJobEvent::EffectAck { effect_id },
        &mut telemetry,
    )
    .unwrap();

    assert_eq!(transition.next_snapshot.snapshot_revision, 0);
    assert_eq!(
        telemetry.snapshot(),
        vec![(counters::EFFECT_ACK_DEDUP_DROP.to_owned(), 1)]
    );
}

#[test]
fn manifest_commit_unknown_retryable_failure_increments_rejection_counter() {
    let snapshot = upload_snapshot(UploadJobPhase::ManifestCommitUnknown);
    let mut telemetry = TelemetryRingBuffer::new(4);

    let error = advance_upload_job_with_telemetry(
        &snapshot,
        UploadJobEvent::RetryableFailure {
            effect_id: uuid(11),
            code: ClientErrorCode::AuthenticationFailed,
            now_ms: 1_000,
            base_backoff_ms: 1_000,
            server_retry_after_ms: None,
        },
        &mut telemetry,
    )
    .unwrap_err();

    assert_eq!(error.code, ClientErrorCode::ClientCoreInvalidTransition);
    assert_eq!(
        telemetry.snapshot(),
        vec![(
            counters::MANIFEST_COMMIT_UNKNOWN_RETRY_REJECTED.to_owned(),
            1,
        )]
    );
}

#[test]
fn album_sync_exhaustion_with_originating_code_increments_counter() {
    let mut snapshot = new_album_sync(AlbumSyncRequest {
        sync_id: "sync-20".to_owned(),
        album_id: "album-21".to_owned(),
        initial_page_token: None,
        max_retry_count: 1,
    })
    .unwrap();
    snapshot.phase = AlbumSyncPhase::FetchingPage;
    snapshot.retry.attempt_count = 1;
    let mut telemetry = TelemetryRingBuffer::new(4);

    let transition = advance_album_sync_with_telemetry(
        &snapshot,
        AlbumSyncEvent::RetryableFailure {
            code: ClientErrorCode::AuthenticationFailed,
            retry_after_ms: None,
        },
        &mut telemetry,
    )
    .unwrap();

    assert_eq!(transition.snapshot.phase, AlbumSyncPhase::Failed);
    assert_eq!(
        telemetry.snapshot(),
        vec![(
            counters::ALBUM_SYNC_EXHAUSTION_WITH_ORIGINATING_CODE.to_owned(),
            1,
        )]
    );
}

#[test]
fn legacy_manifest_commit_unknown_migration_increments_counter() {
    let payload = legacy_retry_waiting_manifest_commit_unknown_snapshot();
    let mut telemetry = TelemetryRingBuffer::new(4);

    let snapshot =
        UploadJobSnapshot::from_canonical_cbor_with_telemetry(&payload, &mut telemetry).unwrap();

    assert_eq!(snapshot.phase, UploadJobPhase::ManifestCommitUnknown);
    assert_eq!(
        telemetry.snapshot(),
        vec![(
            counters::LEGACY_RETRY_WAITING_MANIFEST_COMMIT_UNKNOWN_MIGRATED.to_owned(),
            1,
        )]
    );
}

fn upload_snapshot(phase: UploadJobPhase) -> UploadJobSnapshot {
    let mut snapshot = new_upload_job(mosaic_client::UploadJobRequest {
        job_id: uuid(1),
        album_id: uuid(2),
        asset_id: uuid(3),
        idempotency_key: uuid(4),
        max_retry_count: 3,
    })
    .unwrap();
    snapshot.phase = phase;
    snapshot
}

fn legacy_retry_waiting_manifest_commit_unknown_snapshot() -> Vec<u8> {
    let entries = vec![
        kv(
            upload_job_snapshot_keys::SCHEMA_VERSION,
            uint(SNAPSHOT_SCHEMA_VERSION_V1),
        ),
        kv(
            upload_job_snapshot_keys::JOB_ID,
            Value::Bytes(uuid(1).as_bytes().to_vec()),
        ),
        kv(
            upload_job_snapshot_keys::ALBUM_ID,
            Value::Bytes(uuid(2).as_bytes().to_vec()),
        ),
        kv(
            upload_job_snapshot_keys::PHASE,
            uint(UploadJobPhase::RetryWaiting as u8),
        ),
        kv(upload_job_snapshot_keys::RETRY_COUNT, uint(1_u8)),
        kv(upload_job_snapshot_keys::MAX_RETRY_COUNT, uint(3_u8)),
        kv(
            upload_job_snapshot_keys::NEXT_RETRY_NOT_BEFORE_MS,
            Value::Null,
        ),
        kv(
            upload_job_snapshot_keys::IDEMPOTENCY_KEY,
            Value::Bytes(uuid(4).as_bytes().to_vec()),
        ),
        kv(
            upload_job_snapshot_keys::TIERED_SHARDS,
            Value::Array(vec![uploaded_shard_ref_value()]),
        ),
        kv(upload_job_snapshot_keys::SHARD_SET_HASH, Value::Null),
        kv(upload_job_snapshot_keys::SNAPSHOT_REVISION, uint(0_u8)),
        kv(
            upload_job_snapshot_keys::LAST_ACKNOWLEDGED_EFFECT_ID,
            Value::Null,
        ),
        kv(upload_job_snapshot_keys::LAST_APPLIED_EVENT_ID, Value::Null),
        kv(upload_job_snapshot_keys::FAILURE_CODE, Value::Null),
        kv(14, uint(UploadJobPhase::ManifestCommitUnknown as u8)),
    ];
    let value = Value::Map(entries);
    let mut bytes = Vec::new();
    ciborium::ser::into_writer(&value, &mut bytes).unwrap();
    bytes
}

fn kv(key: u32, value: Value) -> (Value, Value) {
    (uint(key), value)
}

fn uploaded_shard_ref_value() -> Value {
    Value::Map(vec![
        kv(0, uint(1_u8)),
        kv(1, uint(0_u8)),
        kv(2, Value::Bytes(uuid(30).as_bytes().to_vec())),
        kv(3, Value::Bytes([0x42; 32].to_vec())),
        kv(4, uint(1024_u16)),
        kv(5, uint(3_u8)),
        kv(6, Value::Bool(true)),
    ])
}

fn uint<T>(value: T) -> Value
where
    Integer: From<T>,
{
    Value::Integer(Integer::from(value))
}
