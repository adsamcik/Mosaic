mod common;

use mosaic_client::ClientErrorCode;
use mosaic_client::download::snapshot::DownloadJobSnapshot;
use mosaic_wasm::{
    download_build_plan_v1, download_commit_snapshot_v1, download_init_snapshot_v1,
    download_load_snapshot_v1, download_verify_snapshot_v1,
};

#[test]
fn init_commit_load_round_trip_and_rejects_corrupt_body() -> Result<(), String> {
    let plan = download_build_plan_v1(&common::plan_input_cbor(3)?);
    assert_eq!(plan.code, u32::from(ClientErrorCode::Ok.as_u16()));

    let init = download_init_snapshot_v1(&common::init_snapshot_input_cbor(plan.plan_cbor)?);
    assert_eq!(init.code, u32::from(ClientErrorCode::Ok.as_u16()));
    assert_eq!(init.checksum.len(), 32);

    let commit = download_commit_snapshot_v1(&init.body);
    assert_eq!(commit.code, u32::from(ClientErrorCode::Ok.as_u16()));
    assert_eq!(commit.checksum, init.checksum);

    let verify = download_verify_snapshot_v1(&init.body, &commit.checksum);
    assert_eq!(verify.code, u32::from(ClientErrorCode::Ok.as_u16()));
    assert!(verify.valid);

    let load = download_load_snapshot_v1(&init.body, &commit.checksum);
    assert_eq!(load.code, u32::from(ClientErrorCode::Ok.as_u16()));
    assert_eq!(load.schema_version_loaded, 3);
    assert_eq!(load.snapshot_cbor, init.body);

    let snapshot = DownloadJobSnapshot::from_canonical_cbor(&load.snapshot_cbor)
        .map_err(|error| format!("snapshot decode failed: {error:?}"))?;
    assert_eq!(snapshot.photos.len(), 1);
    assert_eq!(snapshot.plan.entries.len(), 1);

    let mut corrupt = init.body.clone();
    let Some(byte) = corrupt.last_mut() else {
        return Err("snapshot body unexpectedly empty".to_owned());
    };
    *byte ^= 0x01;

    let corrupt_load = download_load_snapshot_v1(&corrupt, &commit.checksum);
    assert_eq!(
        corrupt_load.code,
        u32::from(ClientErrorCode::DownloadSnapshotChecksumMismatch.as_u16())
    );

    let corrupt_verify = download_verify_snapshot_v1(&corrupt, &commit.checksum);
    assert_eq!(corrupt_verify.code, u32::from(ClientErrorCode::Ok.as_u16()));
    assert!(!corrupt_verify.valid);
    Ok(())
}

#[test]
fn init_threads_scope_key_from_input() -> Result<(), String> {
    let plan = download_build_plan_v1(&common::plan_input_cbor(3)?);
    assert_eq!(plan.code, u32::from(ClientErrorCode::Ok.as_u16()));
    let scope = "auth:0123456789abcdef0123456789abcdef";
    let init = download_init_snapshot_v1(&common::init_snapshot_input_cbor_with_scope(
        plan.plan_cbor,
        scope,
    )?);
    assert_eq!(init.code, u32::from(ClientErrorCode::Ok.as_u16()));
    let snapshot = DownloadJobSnapshot::from_canonical_cbor(&init.body)
        .map_err(|error| format!("decode failed: {error:?}"))?;
    assert_eq!(snapshot.scope_key, scope);
    Ok(())
}

#[test]
fn init_rejects_missing_scope_key() -> Result<(), String> {
    use ciborium::value::{Integer, Value};
    let plan = download_build_plan_v1(&common::plan_input_cbor(3)?);
    assert_eq!(plan.code, u32::from(ClientErrorCode::Ok.as_u16()));
    // Manually craft input WITHOUT key 4 (scope_key).
    let input = Value::Map(vec![
        (
            Value::Integer(Integer::from(0u32)),
            Value::Bytes(common::JOB_ID.to_vec()),
        ),
        (
            Value::Integer(Integer::from(1u32)),
            Value::Bytes(common::ALBUM_ID.to_vec()),
        ),
        (
            Value::Integer(Integer::from(2u32)),
            Value::Bytes(plan.plan_cbor),
        ),
        (
            Value::Integer(Integer::from(3u32)),
            Value::Integer(Integer::from(1_700_000_000_000u64)),
        ),
    ]);
    let mut bytes = Vec::new();
    ciborium::ser::into_writer(&input, &mut bytes).map_err(|e| e.to_string())?;
    let init = download_init_snapshot_v1(&bytes);
    assert_ne!(init.code, u32::from(ClientErrorCode::Ok.as_u16()));
    Ok(())
}

#[test]
fn init_rejects_malformed_scope_key() -> Result<(), String> {
    let plan = download_build_plan_v1(&common::plan_input_cbor(3)?);
    let init = download_init_snapshot_v1(&common::init_snapshot_input_cbor_with_scope(
        plan.plan_cbor,
        "bogus:zzzz",
    )?);
    assert_eq!(
        init.code,
        u32::from(ClientErrorCode::DownloadInvalidPlan.as_u16())
    );
    Ok(())
}
