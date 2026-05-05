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
    assert_eq!(load.schema_version_loaded, 2);
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
