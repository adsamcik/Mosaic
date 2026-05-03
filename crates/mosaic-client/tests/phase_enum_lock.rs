//! Append-only lock test for upload-job and album-sync phase numeric allocations.
//!
//! Per ADR-023, phase enums are serialized as `u8` values. Any reordering,
//! renumbering, or accidental collision fails CI before persisted snapshots can
//! be misread by a binding consumer.

use std::collections::BTreeSet;

use mosaic_client::snapshot_schema::{album_sync_phase_codes, upload_job_phase_codes};

const SNAPSHOT_SCHEMA_SOURCE: &str = include_str!("../src/snapshot_schema.rs");
const EXPECTED_UPLOAD_JOB_PHASE_COUNT: usize = 13;
const EXPECTED_ALBUM_SYNC_PHASE_COUNT: usize = 7;

fn expected_upload_job_phases() -> Vec<(&'static str, u8)> {
    vec![
        ("QUEUED", 0),
        ("AWAITING_PREPARED_MEDIA", 1),
        ("AWAITING_EPOCH_HANDLE", 2),
        ("ENCRYPTING_SHARD", 3),
        ("CREATING_SHARD_UPLOAD", 4),
        ("UPLOADING_SHARD", 5),
        ("CREATING_MANIFEST", 6),
        ("MANIFEST_COMMIT_UNKNOWN", 7),
        ("AWAITING_SYNC_CONFIRMATION", 8),
        ("RETRY_WAITING", 9),
        ("CONFIRMED", 10),
        ("CANCELLED", 11),
        ("FAILED", 12),
    ]
}

fn live_upload_job_phases() -> Vec<(&'static str, u8)> {
    vec![
        ("QUEUED", upload_job_phase_codes::QUEUED),
        (
            "AWAITING_PREPARED_MEDIA",
            upload_job_phase_codes::AWAITING_PREPARED_MEDIA,
        ),
        (
            "AWAITING_EPOCH_HANDLE",
            upload_job_phase_codes::AWAITING_EPOCH_HANDLE,
        ),
        ("ENCRYPTING_SHARD", upload_job_phase_codes::ENCRYPTING_SHARD),
        (
            "CREATING_SHARD_UPLOAD",
            upload_job_phase_codes::CREATING_SHARD_UPLOAD,
        ),
        ("UPLOADING_SHARD", upload_job_phase_codes::UPLOADING_SHARD),
        (
            "CREATING_MANIFEST",
            upload_job_phase_codes::CREATING_MANIFEST,
        ),
        (
            "MANIFEST_COMMIT_UNKNOWN",
            upload_job_phase_codes::MANIFEST_COMMIT_UNKNOWN,
        ),
        (
            "AWAITING_SYNC_CONFIRMATION",
            upload_job_phase_codes::AWAITING_SYNC_CONFIRMATION,
        ),
        ("RETRY_WAITING", upload_job_phase_codes::RETRY_WAITING),
        ("CONFIRMED", upload_job_phase_codes::CONFIRMED),
        ("CANCELLED", upload_job_phase_codes::CANCELLED),
        ("FAILED", upload_job_phase_codes::FAILED),
    ]
}

fn expected_album_sync_phases() -> Vec<(&'static str, u8)> {
    vec![
        ("IDLE", 0),
        ("FETCHING_PAGE", 1),
        ("APPLYING_PAGE", 2),
        ("RETRY_WAITING", 3),
        ("COMPLETED", 4),
        ("CANCELLED", 5),
        ("FAILED", 6),
    ]
}

fn live_album_sync_phases() -> Vec<(&'static str, u8)> {
    vec![
        ("IDLE", album_sync_phase_codes::IDLE),
        ("FETCHING_PAGE", album_sync_phase_codes::FETCHING_PAGE),
        ("APPLYING_PAGE", album_sync_phase_codes::APPLYING_PAGE),
        ("RETRY_WAITING", album_sync_phase_codes::RETRY_WAITING),
        ("COMPLETED", album_sync_phase_codes::COMPLETED),
        ("CANCELLED", album_sync_phase_codes::CANCELLED),
        ("FAILED", album_sync_phase_codes::FAILED),
    ]
}

fn source_const_names(module_name: &str, value_type: &str) -> Vec<&'static str> {
    let start_marker = format!("pub mod {module_name} {{");
    let Some(module_start) = SNAPSHOT_SCHEMA_SOURCE.find(&start_marker) else {
        panic!("snapshot_schema module {module_name} should exist");
    };
    let module_body = &SNAPSHOT_SCHEMA_SOURCE[module_start + start_marker.len()..];
    let Some(module_end) = module_body.find("\n}") else {
        panic!("snapshot_schema module {module_name} should have a closing brace");
    };

    module_body[..module_end]
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            let rest = trimmed.strip_prefix("pub const ")?;
            let (name, type_and_value) = rest.split_once(':')?;
            type_and_value
                .trim_start()
                .starts_with(value_type)
                .then_some(name)
        })
        .collect()
}

#[test]
fn upload_job_phase_table_matches_expected() {
    assert_eq!(
        expected_upload_job_phases(),
        live_upload_job_phases(),
        "UploadJobPhase numeric allocations drifted. ADR-023 makes existing \
         phase codes append-only; add new phases at the end and update \
         SPEC-ClientCoreSnapshotSchema plus this lock test."
    );
}

#[test]
fn upload_job_phase_table_has_no_collisions() {
    let mut seen = BTreeSet::new();
    for (name, code) in live_upload_job_phases() {
        assert!(
            seen.insert(code),
            "UploadJobPhase::{name} collides on numeric value {code}"
        );
    }
}

#[test]
fn known_upload_job_phases_matches_expected_table() {
    assert_eq!(
        expected_upload_job_phases().as_slice(),
        upload_job_phase_codes::KNOWN_UPLOAD_JOB_PHASES,
        "KNOWN_UPLOAD_JOB_PHASES must be updated append-only with the literal lock table"
    );
}

#[test]
fn known_upload_job_phases_has_no_collisions() {
    let mut seen_names = BTreeSet::new();
    let mut seen_values = BTreeSet::new();
    for (name, code) in upload_job_phase_codes::KNOWN_UPLOAD_JOB_PHASES {
        assert!(
            seen_names.insert(*name),
            "UploadJobPhase name {name} is duplicated in KNOWN_UPLOAD_JOB_PHASES"
        );
        assert!(
            seen_values.insert(*code),
            "UploadJobPhase::{name} collides on numeric value {code}"
        );
    }
}

#[test]
fn known_upload_job_phases_exhaustively_lists_source_consts() {
    let source_names = source_const_names("upload_job_phase_codes", "u8");
    let known_names = upload_job_phase_codes::KNOWN_UPLOAD_JOB_PHASES
        .iter()
        .map(|(name, _)| *name)
        .collect::<Vec<_>>();

    assert_eq!(EXPECTED_UPLOAD_JOB_PHASE_COUNT, known_names.len());
    assert_eq!(
        source_names, known_names,
        "Every pub const u8 in upload_job_phase_codes must appear in KNOWN_UPLOAD_JOB_PHASES"
    );
}

#[test]
fn album_sync_phase_table_matches_expected() {
    assert_eq!(
        expected_album_sync_phases(),
        live_album_sync_phases(),
        "AlbumSyncPhase numeric allocations drifted. ADR-023 makes existing \
         phase codes append-only; add new phases at the end and update \
         SPEC-ClientCoreSnapshotSchema plus this lock test."
    );
}

#[test]
fn album_sync_phase_table_has_no_collisions() {
    let mut seen = BTreeSet::new();
    for (name, code) in live_album_sync_phases() {
        assert!(
            seen.insert(code),
            "AlbumSyncPhase::{name} collides on numeric value {code}"
        );
    }
}

#[test]
fn known_album_sync_phases_matches_expected_table() {
    assert_eq!(
        expected_album_sync_phases().as_slice(),
        album_sync_phase_codes::KNOWN_ALBUM_SYNC_PHASES,
        "KNOWN_ALBUM_SYNC_PHASES must be updated append-only with the literal lock table"
    );
}

#[test]
fn known_album_sync_phases_has_no_collisions() {
    let mut seen_names = BTreeSet::new();
    let mut seen_values = BTreeSet::new();
    for (name, code) in album_sync_phase_codes::KNOWN_ALBUM_SYNC_PHASES {
        assert!(
            seen_names.insert(*name),
            "AlbumSyncPhase name {name} is duplicated in KNOWN_ALBUM_SYNC_PHASES"
        );
        assert!(
            seen_values.insert(*code),
            "AlbumSyncPhase::{name} collides on numeric value {code}"
        );
    }
}

#[test]
fn known_album_sync_phases_exhaustively_lists_source_consts() {
    let source_names = source_const_names("album_sync_phase_codes", "u8");
    let known_names = album_sync_phase_codes::KNOWN_ALBUM_SYNC_PHASES
        .iter()
        .map(|(name, _)| *name)
        .collect::<Vec<_>>();

    assert_eq!(EXPECTED_ALBUM_SYNC_PHASE_COUNT, known_names.len());
    assert_eq!(
        source_names, known_names,
        "Every pub const u8 in album_sync_phase_codes must appear in KNOWN_ALBUM_SYNC_PHASES"
    );
}
