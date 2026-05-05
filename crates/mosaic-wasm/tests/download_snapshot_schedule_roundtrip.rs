mod common;

use ciborium::value::{Integer, Value};
use mosaic_client::ClientErrorCode;
use mosaic_client::download::snapshot::{DownloadJobSnapshot, DownloadSchedule};
use mosaic_wasm::{download_build_plan_v1, download_init_snapshot_v1};

fn build_input_with_schedule(
    plan_cbor: Vec<u8>,
    schedule: Option<Value>,
) -> Result<Vec<u8>, String> {
    let mut entries: Vec<(Value, Value)> = vec![
        (
            Value::Integer(Integer::from(0u32)),
            Value::Bytes(common::JOB_ID.to_vec()),
        ),
        (
            Value::Integer(Integer::from(1u32)),
            Value::Bytes(common::ALBUM_ID.to_vec()),
        ),
        (Value::Integer(Integer::from(2u32)), Value::Bytes(plan_cbor)),
        (
            Value::Integer(Integer::from(3u32)),
            Value::Integer(Integer::from(1_700_000_000_000u64)),
        ),
        (
            Value::Integer(Integer::from(4u32)),
            Value::Text("legacy:00000000000000000000000000000000".to_owned()),
        ),
    ];
    if let Some(schedule_value) = schedule {
        entries.push((Value::Integer(Integer::from(5u32)), schedule_value));
    }
    let mut bytes = Vec::new();
    ciborium::ser::into_writer(&Value::Map(entries), &mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes)
}

fn schedule_value_wifi(max_delay_ms: Option<u64>) -> Value {
    let mut entries: Vec<(Value, Value)> = vec![(
        Value::Integer(Integer::from(0u32)),
        Value::Integer(Integer::from(1u64)), // KIND = WIFI
    )];
    entries.push((
        Value::Integer(Integer::from(3u32)), // MAX_DELAY_MS
        match max_delay_ms {
            Some(v) => Value::Integer(Integer::from(v)),
            None => Value::Null,
        },
    ));
    Value::Map(entries)
}

fn schedule_value_window(start_hour: u8, end_hour: u8, max_delay_ms: Option<u64>) -> Value {
    Value::Map(vec![
        (
            Value::Integer(Integer::from(0u32)),
            Value::Integer(Integer::from(4u64)),
        ), // KIND = WINDOW
        (
            Value::Integer(Integer::from(1u32)),
            Value::Integer(Integer::from(u64::from(start_hour))),
        ),
        (
            Value::Integer(Integer::from(2u32)),
            Value::Integer(Integer::from(u64::from(end_hour))),
        ),
        (
            Value::Integer(Integer::from(3u32)),
            match max_delay_ms {
                Some(v) => Value::Integer(Integer::from(v)),
                None => Value::Null,
            },
        ),
    ])
}

#[test]
fn init_decodes_wifi_schedule_round_trip() -> Result<(), String> {
    let plan = download_build_plan_v1(&common::plan_input_cbor(3)?);
    assert_eq!(plan.code, u32::from(ClientErrorCode::Ok.as_u16()));
    let input = build_input_with_schedule(plan.plan_cbor, Some(schedule_value_wifi(Some(60_000))))?;
    let init = download_init_snapshot_v1(&input);
    assert_eq!(init.code, u32::from(ClientErrorCode::Ok.as_u16()));

    let snapshot = DownloadJobSnapshot::from_canonical_cbor(&init.body)
        .map_err(|error| format!("decode failed: {error:?}"))?;
    assert_eq!(
        snapshot.schedule,
        Some(DownloadSchedule::Wifi {
            max_delay_ms: Some(60_000)
        })
    );
    Ok(())
}

#[test]
fn init_decodes_window_schedule_round_trip() -> Result<(), String> {
    let plan = download_build_plan_v1(&common::plan_input_cbor(3)?);
    let input =
        build_input_with_schedule(plan.plan_cbor, Some(schedule_value_window(22, 6, None)))?;
    let init = download_init_snapshot_v1(&input);
    assert_eq!(init.code, u32::from(ClientErrorCode::Ok.as_u16()));

    let snapshot = DownloadJobSnapshot::from_canonical_cbor(&init.body)
        .map_err(|error| format!("decode failed: {error:?}"))?;
    assert_eq!(
        snapshot.schedule,
        Some(DownloadSchedule::Window {
            start_hour: 22,
            end_hour: 6,
            max_delay_ms: None
        })
    );
    Ok(())
}

#[test]
fn init_treats_null_schedule_as_immediate() -> Result<(), String> {
    let plan = download_build_plan_v1(&common::plan_input_cbor(3)?);
    let input = build_input_with_schedule(plan.plan_cbor, Some(Value::Null))?;
    let init = download_init_snapshot_v1(&input);
    assert_eq!(init.code, u32::from(ClientErrorCode::Ok.as_u16()));
    let snapshot = DownloadJobSnapshot::from_canonical_cbor(&init.body)
        .map_err(|error| format!("decode failed: {error:?}"))?;
    assert!(snapshot.schedule.is_none());
    Ok(())
}

#[test]
fn init_omitted_schedule_is_immediate() -> Result<(), String> {
    let plan = download_build_plan_v1(&common::plan_input_cbor(3)?);
    let input = build_input_with_schedule(plan.plan_cbor, None)?;
    let init = download_init_snapshot_v1(&input);
    assert_eq!(init.code, u32::from(ClientErrorCode::Ok.as_u16()));
    let snapshot = DownloadJobSnapshot::from_canonical_cbor(&init.body)
        .map_err(|error| format!("decode failed: {error:?}"))?;
    assert!(snapshot.schedule.is_none());
    Ok(())
}

#[test]
fn init_rejects_unknown_schedule_kind() -> Result<(), String> {
    let plan = download_build_plan_v1(&common::plan_input_cbor(3)?);
    let bogus = Value::Map(vec![
        (
            Value::Integer(Integer::from(0u32)),
            Value::Integer(Integer::from(99u64)),
        ),
        (Value::Integer(Integer::from(3u32)), Value::Null),
    ]);
    let input = build_input_with_schedule(plan.plan_cbor, Some(bogus))?;
    let init = download_init_snapshot_v1(&input);
    assert_eq!(
        init.code,
        u32::from(ClientErrorCode::DownloadSnapshotCorrupt.as_u16())
    );
    Ok(())
}

#[test]
fn init_rejects_window_with_out_of_range_hour() -> Result<(), String> {
    let plan = download_build_plan_v1(&common::plan_input_cbor(3)?);
    let input =
        build_input_with_schedule(plan.plan_cbor, Some(schedule_value_window(24, 6, None)))?;
    let init = download_init_snapshot_v1(&input);
    assert_eq!(
        init.code,
        u32::from(ClientErrorCode::DownloadSnapshotCorrupt.as_u16())
    );
    Ok(())
}
