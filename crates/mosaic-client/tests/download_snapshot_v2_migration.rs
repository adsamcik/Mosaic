#![allow(clippy::expect_used, clippy::unwrap_used)]
//! Snapshot v1 -> v2 migration round-trip coverage.

use ciborium::value::{Integer, Value};
use mosaic_client::Uuid;
use mosaic_client::download::scope::legacy_scope_for;
use mosaic_client::download::snapshot::{
    CURRENT_DOWNLOAD_SNAPSHOT_SCHEMA_VERSION, DOWNLOAD_SNAPSHOT_SCHEMA_VERSION_V1,
    DOWNLOAD_SNAPSHOT_SCHEMA_VERSION_V3, download_job_snapshot_keys,
};
use mosaic_client::download::*;

fn uuid(seed: u8) -> Uuid {
    let mut bytes = [seed; 16];
    bytes[6] = 0x70 | (seed & 0x0f);
    bytes[8] = 0x80 | (seed & 0x3f);
    Uuid::from_bytes(bytes)
}
fn job_id(seed: u8) -> JobId {
    JobId::from_bytes(*uuid(seed).as_bytes())
}

fn kv(key: u32, value: Value) -> (Value, Value) {
    (Value::Integer(Integer::from(key)), value)
}
fn uint<T: Into<u64>>(value: T) -> Value {
    Value::Integer(Integer::from(value.into()))
}

/// Build a synthetic v1 CBOR snapshot body with the legacy 9-key shape and
/// no `scope_key`. The downloader's decoder must accept it and synthesize
/// a `legacy:<job-id-hex>` scope key.
fn synthesize_v1_body(job: JobId, album: Uuid) -> Vec<u8> {
    let value = Value::Map(vec![
        kv(
            download_job_snapshot_keys::SCHEMA_VERSION,
            uint(DOWNLOAD_SNAPSHOT_SCHEMA_VERSION_V1),
        ),
        kv(
            download_job_snapshot_keys::JOB_ID,
            Value::Bytes(job.as_bytes().to_vec()),
        ),
        kv(
            download_job_snapshot_keys::ALBUM_ID,
            Value::Bytes(album.as_bytes().to_vec()),
        ),
        kv(download_job_snapshot_keys::CREATED_AT_MS, uint(100_u64)),
        kv(
            download_job_snapshot_keys::LAST_UPDATED_AT_MS,
            uint(200_u64),
        ),
        kv(
            download_job_snapshot_keys::STATE,
            Value::Map(vec![kv(0, uint(0_u8))]),
        ),
        kv(download_job_snapshot_keys::PLAN, Value::Array(Vec::new())),
        kv(download_job_snapshot_keys::PHOTOS, Value::Array(Vec::new())),
        kv(
            download_job_snapshot_keys::FAILURE_LOG,
            Value::Array(Vec::new()),
        ),
        kv(download_job_snapshot_keys::LEASE_TOKEN, Value::Null),
    ]);
    let mut out = Vec::new();
    ciborium::ser::into_writer(&value, &mut out).expect("encode v1");
    out
}

#[test]
fn current_schema_version_is_v3() {
    assert_eq!(
        CURRENT_DOWNLOAD_SNAPSHOT_SCHEMA_VERSION,
        DOWNLOAD_SNAPSHOT_SCHEMA_VERSION_V3
    );
}

#[test]
fn v1_snapshot_loads_and_synthesizes_legacy_scope() {
    let job = job_id(1);
    let album = uuid(2);
    let bytes = synthesize_v1_body(job, album);
    let snapshot = DownloadJobSnapshot::from_canonical_cbor(&bytes).expect("v1 decodes");
    assert_eq!(snapshot.schema_version, DOWNLOAD_SNAPSHOT_SCHEMA_VERSION_V3);
    assert_eq!(snapshot.scope_key, legacy_scope_for(&job));
    assert!(snapshot.scope_key.starts_with("legacy:"));
}

#[test]
fn v1_then_reencode_yields_current_with_scope_key() {
    let job = job_id(3);
    let album = uuid(4);
    let v1_bytes = synthesize_v1_body(job, album);
    let snapshot = DownloadJobSnapshot::from_canonical_cbor(&v1_bytes).expect("v1 decodes");
    let cur_bytes = snapshot.to_canonical_cbor().expect("current encodes");
    let reloaded = DownloadJobSnapshot::from_canonical_cbor(&cur_bytes).expect("current decodes");
    assert_eq!(reloaded.schema_version, DOWNLOAD_SNAPSHOT_SCHEMA_VERSION_V3);
    assert_eq!(reloaded.scope_key, legacy_scope_for(&job));
}

#[test]
fn v2_snapshot_round_trips_scope_key() {
    let snapshot = DownloadJobSnapshot {
        schema_version: CURRENT_DOWNLOAD_SNAPSHOT_SCHEMA_VERSION,
        job_id: job_id(5),
        album_id: uuid(6),
        created_at_ms: 1,
        last_updated_at_ms: 2,
        state: DownloadJobState::Idle,
        plan: DownloadPlan {
            entries: Vec::new(),
        },
        photos: Vec::new(),
        failure_log: Vec::new(),
        lease_token: None,
        scope_key: String::from("auth:abcdef0123456789abcdef0123456789"),
        schedule: None,
    };
    let bytes = snapshot.to_canonical_cbor().expect("encode v2");
    let reloaded = DownloadJobSnapshot::from_canonical_cbor(&bytes).expect("decode v2");
    assert_eq!(reloaded, snapshot);
}

#[test]
fn v1_with_extra_key_is_rejected() {
    // A v1 body cannot also contain key 10; that would be a schema violation.
    let job = job_id(7);
    let album = uuid(8);
    let value = Value::Map(vec![
        kv(
            download_job_snapshot_keys::SCHEMA_VERSION,
            uint(DOWNLOAD_SNAPSHOT_SCHEMA_VERSION_V1),
        ),
        kv(
            download_job_snapshot_keys::JOB_ID,
            Value::Bytes(job.as_bytes().to_vec()),
        ),
        kv(
            download_job_snapshot_keys::ALBUM_ID,
            Value::Bytes(album.as_bytes().to_vec()),
        ),
        kv(download_job_snapshot_keys::CREATED_AT_MS, uint(100_u64)),
        kv(
            download_job_snapshot_keys::LAST_UPDATED_AT_MS,
            uint(200_u64),
        ),
        kv(
            download_job_snapshot_keys::STATE,
            Value::Map(vec![kv(0, uint(0_u8))]),
        ),
        kv(download_job_snapshot_keys::PLAN, Value::Array(Vec::new())),
        kv(download_job_snapshot_keys::PHOTOS, Value::Array(Vec::new())),
        kv(
            download_job_snapshot_keys::FAILURE_LOG,
            Value::Array(Vec::new()),
        ),
        kv(download_job_snapshot_keys::LEASE_TOKEN, Value::Null),
        kv(
            download_job_snapshot_keys::SCOPE_KEY,
            Value::Text(String::from("auth:x")),
        ),
    ]);
    let mut bytes = Vec::new();
    ciborium::ser::into_writer(&value, &mut bytes).expect("encode");
    assert!(DownloadJobSnapshot::from_canonical_cbor(&bytes).is_err());
}
