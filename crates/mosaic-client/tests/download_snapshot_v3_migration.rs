#![allow(clippy::expect_used, clippy::unwrap_used)]
//! Snapshot v2 -> v3 migration + v3 round-trip coverage for the optional
//! `schedule` field.

use ciborium::value::{Integer, Value};
use mosaic_client::Uuid;
use mosaic_client::download::*;
use mosaic_client::download::snapshot::{
    CURRENT_DOWNLOAD_SNAPSHOT_SCHEMA_VERSION, DOWNLOAD_SNAPSHOT_SCHEMA_VERSION_V2,
    DOWNLOAD_SNAPSHOT_SCHEMA_VERSION_V3, DownloadSchedule, download_job_snapshot_keys,
    download_schedule_keys, download_schedule_kind_codes,
};

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

fn synthesize_v2_body(job: JobId, album: Uuid) -> Vec<u8> {
    let value = Value::Map(vec![
        kv(download_job_snapshot_keys::SCHEMA_VERSION, uint(DOWNLOAD_SNAPSHOT_SCHEMA_VERSION_V2)),
        kv(download_job_snapshot_keys::JOB_ID, Value::Bytes(job.as_bytes().to_vec())),
        kv(download_job_snapshot_keys::ALBUM_ID, Value::Bytes(album.as_bytes().to_vec())),
        kv(download_job_snapshot_keys::CREATED_AT_MS, uint(100_u64)),
        kv(download_job_snapshot_keys::LAST_UPDATED_AT_MS, uint(200_u64)),
        kv(download_job_snapshot_keys::STATE, Value::Map(vec![kv(0, uint(0_u8))])),
        kv(download_job_snapshot_keys::PLAN, Value::Array(Vec::new())),
        kv(download_job_snapshot_keys::PHOTOS, Value::Array(Vec::new())),
        kv(download_job_snapshot_keys::FAILURE_LOG, Value::Array(Vec::new())),
        kv(download_job_snapshot_keys::LEASE_TOKEN, Value::Null),
        kv(download_job_snapshot_keys::SCOPE_KEY, Value::Text(String::from("auth:00000000000000000000000000000000"))),
    ]);
    let mut out = Vec::new();
    ciborium::ser::into_writer(&value, &mut out).expect("encode v2");
    out
}

fn make_snapshot(schedule: Option<DownloadSchedule>) -> DownloadJobSnapshot {
    DownloadJobSnapshot {
        schema_version: CURRENT_DOWNLOAD_SNAPSHOT_SCHEMA_VERSION,
        job_id: job_id(7),
        album_id: uuid(8),
        created_at_ms: 100,
        last_updated_at_ms: 200,
        state: DownloadJobState::Idle,
        plan: DownloadPlan { entries: Vec::new() },
        photos: Vec::new(),
        failure_log: Vec::new(),
        lease_token: None,
        scope_key: String::from("auth:00000000000000000000000000000000"),
        schedule,
    }
}

#[test]
fn v2_snapshot_loads_with_schedule_none() {
    let job = job_id(1);
    let album = uuid(2);
    let bytes = synthesize_v2_body(job, album);
    let snapshot = DownloadJobSnapshot::from_canonical_cbor(&bytes).expect("v2 decodes");
    assert_eq!(snapshot.schema_version, DOWNLOAD_SNAPSHOT_SCHEMA_VERSION_V3);
    assert_eq!(snapshot.schedule, None);
}

#[test]
fn v2_then_reencode_yields_v3_without_schedule_key() {
    // Round-trip: v2 input -> in-memory schedule=None -> re-encoded body
    // must be v3 but MUST NOT include key 11 (so empty-schedule jobs do not
    // bloat the snapshot).
    let job = job_id(3);
    let album = uuid(4);
    let v2 = synthesize_v2_body(job, album);
    let parsed = DownloadJobSnapshot::from_canonical_cbor(&v2).expect("v2 decodes");
    let re = parsed.to_canonical_cbor().expect("encode current");
    let value: Value = ciborium::de::from_reader(&re[..]).expect("cbor parse");
    let Value::Map(entries) = value else { panic!("expected map"); };
    let keys: Vec<u32> = entries
        .iter()
        .filter_map(|(k, _)| match k {
            Value::Integer(i) => u32::try_from(*i).ok(),
            _ => None,
        })
        .collect();
    assert!(!keys.contains(&download_job_snapshot_keys::SCHEDULE), "schedule key should be omitted when None");
    assert_eq!(keys.last().copied(), Some(download_job_snapshot_keys::SCOPE_KEY));
    let reloaded = DownloadJobSnapshot::from_canonical_cbor(&re).expect("v3 decodes");
    assert_eq!(reloaded.schedule, None);
    assert_eq!(reloaded.schema_version, DOWNLOAD_SNAPSHOT_SCHEMA_VERSION_V3);
}

#[test]
fn v3_round_trip_wifi_schedule() {
    let snapshot = make_snapshot(Some(DownloadSchedule::Wifi { max_delay_ms: Some(60_000) }));
    let bytes = snapshot.to_canonical_cbor().expect("encode");
    let reloaded = DownloadJobSnapshot::from_canonical_cbor(&bytes).expect("decode");
    assert_eq!(reloaded, snapshot);
}

#[test]
fn v3_round_trip_wifi_charging_schedule_no_max_delay() {
    let snapshot = make_snapshot(Some(DownloadSchedule::WifiCharging { max_delay_ms: None }));
    let bytes = snapshot.to_canonical_cbor().expect("encode");
    let reloaded = DownloadJobSnapshot::from_canonical_cbor(&bytes).expect("decode");
    assert_eq!(reloaded, snapshot);
}

#[test]
fn v3_round_trip_idle_schedule() {
    let snapshot = make_snapshot(Some(DownloadSchedule::Idle { max_delay_ms: Some(3_600_000) }));
    let bytes = snapshot.to_canonical_cbor().expect("encode");
    let reloaded = DownloadJobSnapshot::from_canonical_cbor(&bytes).expect("decode");
    assert_eq!(reloaded, snapshot);
}

#[test]
fn v3_round_trip_window_schedule() {
    let snapshot = make_snapshot(Some(DownloadSchedule::Window {
        start_hour: 22,
        end_hour: 6,
        max_delay_ms: Some(86_400_000),
    }));
    let bytes = snapshot.to_canonical_cbor().expect("encode");
    let reloaded = DownloadJobSnapshot::from_canonical_cbor(&bytes).expect("decode");
    assert_eq!(reloaded, snapshot);
}

#[test]
fn v3_window_schedule_keys_are_ascending() {
    // Spot-check the canonical key ordering on the wire.
    let snapshot = make_snapshot(Some(DownloadSchedule::Window {
        start_hour: 1,
        end_hour: 5,
        max_delay_ms: None,
    }));
    let bytes = snapshot.to_canonical_cbor().expect("encode");
    let value: Value = ciborium::de::from_reader(&bytes[..]).expect("cbor parse");
    let Value::Map(entries) = value else { panic!("expected map"); };
    let keys: Vec<u32> = entries
        .iter()
        .filter_map(|(k, _)| match k {
            Value::Integer(i) => u32::try_from(*i).ok(),
            _ => None,
        })
        .collect();
    let mut sorted = keys.clone();
    sorted.sort_unstable();
    assert_eq!(keys, sorted, "keys must be ascending");
    assert_eq!(keys.last().copied(), Some(download_job_snapshot_keys::SCHEDULE));
}

#[test]
fn v3_rejects_invalid_window_hours() {
    let bad = Value::Map(vec![
        kv(download_job_snapshot_keys::SCHEMA_VERSION, uint(DOWNLOAD_SNAPSHOT_SCHEMA_VERSION_V3)),
        kv(download_job_snapshot_keys::JOB_ID, Value::Bytes(job_id(9).as_bytes().to_vec())),
        kv(download_job_snapshot_keys::ALBUM_ID, Value::Bytes(uuid(10).as_bytes().to_vec())),
        kv(download_job_snapshot_keys::CREATED_AT_MS, uint(100_u64)),
        kv(download_job_snapshot_keys::LAST_UPDATED_AT_MS, uint(200_u64)),
        kv(download_job_snapshot_keys::STATE, Value::Map(vec![kv(0, uint(0_u8))])),
        kv(download_job_snapshot_keys::PLAN, Value::Array(Vec::new())),
        kv(download_job_snapshot_keys::PHOTOS, Value::Array(Vec::new())),
        kv(download_job_snapshot_keys::FAILURE_LOG, Value::Array(Vec::new())),
        kv(download_job_snapshot_keys::LEASE_TOKEN, Value::Null),
        kv(download_job_snapshot_keys::SCOPE_KEY, Value::Text(String::from("auth:00000000000000000000000000000000"))),
        kv(
            download_job_snapshot_keys::SCHEDULE,
            Value::Map(vec![
                kv(download_schedule_keys::KIND, uint(download_schedule_kind_codes::WINDOW)),
                kv(download_schedule_keys::WINDOW_START_HOUR, uint(24_u8)),
                kv(download_schedule_keys::WINDOW_END_HOUR, uint(0_u8)),
                kv(download_schedule_keys::MAX_DELAY_MS, Value::Null),
            ]),
        ),
    ]);
    let mut bytes = Vec::new();
    ciborium::ser::into_writer(&bad, &mut bytes).expect("encode");
    assert!(DownloadJobSnapshot::from_canonical_cbor(&bytes).is_err());
}

#[test]
fn v3_rejects_immediate_kind_on_wire() {
    // An `IMMEDIATE` schedule would be redundant; ensure peers can't smuggle
    // one in, since in-memory it's `None`.
    let bad = Value::Map(vec![
        kv(download_job_snapshot_keys::SCHEMA_VERSION, uint(DOWNLOAD_SNAPSHOT_SCHEMA_VERSION_V3)),
        kv(download_job_snapshot_keys::JOB_ID, Value::Bytes(job_id(11).as_bytes().to_vec())),
        kv(download_job_snapshot_keys::ALBUM_ID, Value::Bytes(uuid(12).as_bytes().to_vec())),
        kv(download_job_snapshot_keys::CREATED_AT_MS, uint(100_u64)),
        kv(download_job_snapshot_keys::LAST_UPDATED_AT_MS, uint(200_u64)),
        kv(download_job_snapshot_keys::STATE, Value::Map(vec![kv(0, uint(0_u8))])),
        kv(download_job_snapshot_keys::PLAN, Value::Array(Vec::new())),
        kv(download_job_snapshot_keys::PHOTOS, Value::Array(Vec::new())),
        kv(download_job_snapshot_keys::FAILURE_LOG, Value::Array(Vec::new())),
        kv(download_job_snapshot_keys::LEASE_TOKEN, Value::Null),
        kv(download_job_snapshot_keys::SCOPE_KEY, Value::Text(String::from("auth:00000000000000000000000000000000"))),
        kv(
            download_job_snapshot_keys::SCHEDULE,
            Value::Map(vec![
                kv(download_schedule_keys::KIND, uint(download_schedule_kind_codes::IMMEDIATE)),
                kv(download_schedule_keys::MAX_DELAY_MS, Value::Null),
            ]),
        ),
    ]);
    let mut bytes = Vec::new();
    ciborium::ser::into_writer(&bad, &mut bytes).expect("encode");
    assert!(DownloadJobSnapshot::from_canonical_cbor(&bytes).is_err());
}

