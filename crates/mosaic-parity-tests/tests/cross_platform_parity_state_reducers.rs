// SPDX-License-Identifier: MIT
// Auto-organized from cross_platform_parity.rs as part of v1.0.2 monolith-test-files
// split. Each split file exercises one domain of cross-facade parity tests.
// See `tests/common/mod.rs` for shared imports, constants, and helpers.
#![allow(clippy::expect_used)]

mod common;
use common::*;

#[test]
fn canonical_upload_snapshot_cbor_matches_wasm_and_uniffi_facades() {
    let wasm = wasm_upload_snapshot();
    let uniffi = uniffi_upload_snapshot();

    let wasm_bytes = canonical_wasm_snapshot_bytes(&wasm);
    let uniffi_bytes = canonical_uniffi_snapshot_bytes(&uniffi);

    assert_eq!(wasm_bytes, uniffi_bytes);
}

#[test]
fn upload_reducer_outputs_match_wasm_and_uniffi() {
    for case in [
        UploadReducerCase {
            name: "successful shard upload",
            phase: "UploadingShard",
            shard_uploaded: false,
            event_kind: "ShardUploaded",
            error_code: 0,
        },
        UploadReducerCase {
            name: "retryable failure",
            phase: "AwaitingPreparedMedia",
            shard_uploaded: false,
            event_kind: "RetryableFailure",
            error_code: ClientErrorCode::InvalidInputLength.as_u16(),
        },
        UploadReducerCase {
            name: "non-retryable failure",
            phase: "AwaitingPreparedMedia",
            shard_uploaded: false,
            event_kind: "NonRetryableFailure",
            error_code: ClientErrorCode::InvalidInputLength.as_u16(),
        },
    ] {
        let wasm = mosaic_wasm::advance_upload_job(
            wasm_upload_snapshot_for_phase(case.phase, case.shard_uploaded),
            wasm_upload_event(case.event_kind, case.error_code),
        );
        let uniffi = mosaic_uniffi::advance_upload_job(
            uniffi_upload_snapshot_for_phase(case.phase, case.shard_uploaded),
            uniffi_upload_event(case.event_kind, case.error_code),
        );

        assert_eq!(wasm.code, uniffi.code, "{}", case.name);
        assert_ok(wasm.code, case.name);
        assert_eq!(
            canonical_wasm_upload_transition_bytes(&wasm.transition),
            canonical_uniffi_upload_transition_bytes(&uniffi.transition),
            "{} snapshot/effects drift",
            case.name
        );
    }
}

#[test]
fn album_sync_reducer_outputs_match_wasm_and_uniffi() {
    for case in [
        AlbumSyncReducerCase {
            name: "successful sync request",
            phase: "Idle",
            event_kind: "SyncRequested",
            error_code: 0,
        },
        AlbumSyncReducerCase {
            name: "retryable failure",
            phase: "FetchingPage",
            event_kind: "RetryableFailure",
            error_code: ClientErrorCode::InvalidInputLength.as_u16(),
        },
        AlbumSyncReducerCase {
            name: "non-retryable failure",
            phase: "FetchingPage",
            event_kind: "NonRetryableFailure",
            error_code: ClientErrorCode::InvalidInputLength.as_u16(),
        },
    ] {
        let wasm = mosaic_wasm::advance_album_sync(
            wasm_album_sync_snapshot_for_phase(case.phase),
            wasm_album_sync_event(case.event_kind, case.error_code),
        );
        let uniffi = mosaic_uniffi::advance_album_sync(
            uniffi_album_sync_snapshot_for_phase(case.phase),
            uniffi_album_sync_event(case.event_kind, case.error_code),
        );

        assert_eq!(wasm.code, uniffi.code, "{}", case.name);
        assert_ok(wasm.code, case.name);
        assert_eq!(
            canonical_wasm_album_sync_transition_bytes(&wasm.transition),
            canonical_uniffi_album_sync_transition_bytes(&uniffi.transition),
            "{} snapshot/effects drift",
            case.name
        );
    }
}

#[test]
fn canonical_download_snapshot_cbor_matches_wasm_and_uniffi() {
    let wasm_plan = mosaic_wasm::download_build_plan_v1(&download_plan_builder_input_cbor());
    assert_ok_u32(wasm_plan.code, "wasm download build plan");
    let uniffi_plan = mosaic_uniffi::build_download_plan(download_plan_input());
    assert_ok(uniffi_plan.code, "uniffi download build plan");
    assert_eq!(wasm_plan.plan_cbor, uniffi_plan.plan_cbor);

    let init_input = download_init_input_cbor(&wasm_plan.plan_cbor);
    let wasm_snapshot = mosaic_wasm::download_init_snapshot_v1(&init_input);
    assert_ok_u32(wasm_snapshot.code, "wasm download init snapshot");
    let uniffi_snapshot = mosaic_uniffi::init_download_job(DownloadInitInput {
        job_id: uuid_to_bytes(JOB_ID),
        album_id: uuid_to_bytes(ALBUM_ID),
        plan_cbor: uniffi_plan.plan_cbor.clone(),
        now_ms: 1_700_000_020_000,
    });
    assert_ok(uniffi_snapshot.code, "uniffi download init snapshot");
    assert_eq!(wasm_snapshot.body, uniffi_snapshot.body);
    assert_eq!(wasm_snapshot.checksum, uniffi_snapshot.checksum);

    let wasm_load =
        mosaic_wasm::download_load_snapshot_v1(&wasm_snapshot.body, &wasm_snapshot.checksum);
    assert_ok_u32(wasm_load.code, "wasm download load snapshot");
    let uniffi_load = mosaic_uniffi::load_download_snapshot(
        uniffi_snapshot.body.clone(),
        uniffi_snapshot.checksum.clone(),
    );
    assert_ok(uniffi_load.code, "uniffi download load snapshot");
    assert_eq!(wasm_load.snapshot_cbor, uniffi_load.snapshot_cbor);
    assert_eq!(
        wasm_load.schema_version_loaded,
        uniffi_load.schema_version_loaded
    );

    let wasm_commit = mosaic_wasm::download_commit_snapshot_v1(&wasm_load.snapshot_cbor);
    assert_ok_u32(wasm_commit.code, "wasm download commit snapshot");
    let uniffi_commit = mosaic_uniffi::commit_download_snapshot(uniffi_load.snapshot_cbor.clone());
    assert_ok(uniffi_commit.code, "uniffi download commit snapshot");
    assert_eq!(wasm_commit.checksum, uniffi_commit.checksum);
    assert_eq!(uniffi_commit.body, uniffi_load.snapshot_cbor);

    let wasm_verify =
        mosaic_wasm::download_verify_snapshot_v1(&wasm_load.snapshot_cbor, &wasm_commit.checksum);
    let uniffi_verify = mosaic_uniffi::verify_download_snapshot(
        uniffi_load.snapshot_cbor.clone(),
        uniffi_commit.checksum.clone(),
    );
    assert_ok_u32(wasm_verify.code, "wasm download verify snapshot");
    assert_ok(uniffi_verify.code, "uniffi download verify snapshot");
    assert!(wasm_verify.valid);
    assert_eq!(wasm_verify.valid, uniffi_verify.valid);
    assert_eq!(
        wasm_commit.checksum,
        mosaic_wasm::blake2b_snapshot_checksum_32(wasm_load.snapshot_cbor.clone())
    );
    assert_eq!(
        uniffi_commit.checksum,
        mosaic_uniffi::blake2b_snapshot_checksum_32(uniffi_load.snapshot_cbor)
    );

    let mut wasm_state = download_state_cbor(0);
    let mut uniffi_state = wasm_state.clone();
    for event in [
        download_start_event_cbor(),
        download_plan_ready_event_cbor(),
    ] {
        let wasm_next = mosaic_wasm::download_apply_event_v1(&wasm_state, &event);
        let uniffi_next = mosaic_uniffi::apply_download_event(uniffi_state, event);
        assert_ok_u32(wasm_next.code, "wasm download apply event");
        assert_ok(uniffi_next.code, "uniffi download apply event");
        assert_eq!(wasm_next.new_state_cbor, uniffi_next.new_state_cbor);
        wasm_state = wasm_next.new_state_cbor;
        uniffi_state = uniffi_next.new_state_cbor;
    }
    assert_eq!(wasm_state, download_state_cbor(2));
}

#[test]
fn metadata_strip_outputs_match_wasm_and_uniffi() {
    for case in strip_cases() {
        let wasm = match case.format {
            StripFormat::Jpeg => {
                wasm_strip_result(mosaic_wasm::strip_jpeg_metadata_js(case.input.clone()))
            }
            StripFormat::Png => {
                wasm_strip_result(mosaic_wasm::strip_png_metadata_js(case.input.clone()))
            }
            StripFormat::WebP => {
                wasm_strip_result(mosaic_wasm::strip_webp_metadata_js(case.input.clone()))
            }
            StripFormat::Avif => {
                wasm_strip_result(mosaic_wasm::strip_avif_metadata_js(case.input.clone()))
            }
            StripFormat::Heic => {
                wasm_strip_result(mosaic_wasm::strip_heic_metadata_js(case.input.clone()))
            }
            StripFormat::Mp4 => {
                wasm_strip_result(mosaic_wasm::strip_video_metadata_js(case.input.clone()))
            }
        };
        assert_ok(wasm.code, case.name);

        let uniffi = match case.format {
            StripFormat::Jpeg => {
                mosaic_uniffi::strip_known_metadata(UniMediaFormat::Jpeg, case.input.clone())
            }
            StripFormat::Png => {
                mosaic_uniffi::strip_known_metadata(UniMediaFormat::Png, case.input.clone())
            }
            StripFormat::WebP => {
                mosaic_uniffi::strip_known_metadata(UniMediaFormat::WebP, case.input.clone())
            }
            StripFormat::Avif => mosaic_uniffi::strip_avif_metadata(case.input.clone()),
            StripFormat::Heic => mosaic_uniffi::strip_heic_metadata(case.input.clone()),
            StripFormat::Mp4 => mosaic_uniffi::strip_video_metadata(case.input.clone()),
        };
        assert_ok(uniffi.code, case.name);

        assert_eq!(
            wasm.removed_metadata_count, uniffi.removed_metadata_count,
            "{}",
            case.name
        );
        assert_eq!(wasm.stripped_bytes, uniffi.stripped_bytes, "{}", case.name);
        if matches!(
            case.format,
            StripFormat::Avif | StripFormat::Heic | StripFormat::Mp4
        ) {
            let direct = match case.format {
                StripFormat::Avif => {
                    strip_result_from_media(mosaic_media::strip_avif_metadata(&case.input))
                }
                StripFormat::Heic => {
                    strip_result_from_media(mosaic_media::strip_heic_metadata(&case.input))
                }
                StripFormat::Mp4 => {
                    strip_result_from_media(mosaic_media::strip_video_metadata(&case.input))
                }
                StripFormat::Jpeg | StripFormat::Png | StripFormat::WebP => unreachable!(),
            };
            assert_ok(direct.code, case.name);
            assert_eq!(wasm, direct, "{} facade drift from media core", case.name);
        }
        if let Some(expected) = case.expected {
            assert_eq!(wasm.stripped_bytes, expected, "{}", case.name);
        }
    }
}
