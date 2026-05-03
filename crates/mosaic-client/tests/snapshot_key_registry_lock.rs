//! Append-only lock test for snapshot integer-key registries.
//!
//! Per ADR-023, snapshot CBOR maps use integer keys only, with
//! `schema_version` pinned at integer key 0. Existing keys are immutable.

use std::collections::BTreeSet;

use mosaic_client::snapshot_schema::{self, album_sync_snapshot_keys, upload_job_snapshot_keys};

const SNAPSHOT_SCHEMA_SOURCE: &str = include_str!("../src/snapshot_schema.rs");
const EXPECTED_UPLOAD_JOB_KEY_COUNT: usize = 12;
const EXPECTED_ALBUM_SYNC_KEY_COUNT: usize = 11;

fn expected_upload_job_keys() -> Vec<(&'static str, u32)> {
    vec![
        ("SCHEMA_VERSION", 0),
        ("JOB_ID", 1),
        ("ALBUM_ID", 2),
        ("PHASE", 3),
        ("RETRY_COUNT", 4),
        ("MAX_RETRY_COUNT", 5),
        ("NEXT_RETRY_NOT_BEFORE_MS", 6),
        ("IDEMPOTENCY_KEY", 7),
        ("TIERED_SHARDS", 8),
        ("SHARD_SET_HASH", 9),
        ("SNAPSHOT_REVISION", 10),
        ("LAST_EFFECT_ID", 11),
    ]
}

fn live_upload_job_keys() -> Vec<(&'static str, u32)> {
    vec![
        ("SCHEMA_VERSION", upload_job_snapshot_keys::SCHEMA_VERSION),
        ("JOB_ID", upload_job_snapshot_keys::JOB_ID),
        ("ALBUM_ID", upload_job_snapshot_keys::ALBUM_ID),
        ("PHASE", upload_job_snapshot_keys::PHASE),
        ("RETRY_COUNT", upload_job_snapshot_keys::RETRY_COUNT),
        ("MAX_RETRY_COUNT", upload_job_snapshot_keys::MAX_RETRY_COUNT),
        (
            "NEXT_RETRY_NOT_BEFORE_MS",
            upload_job_snapshot_keys::NEXT_RETRY_NOT_BEFORE_MS,
        ),
        ("IDEMPOTENCY_KEY", upload_job_snapshot_keys::IDEMPOTENCY_KEY),
        ("TIERED_SHARDS", upload_job_snapshot_keys::TIERED_SHARDS),
        ("SHARD_SET_HASH", upload_job_snapshot_keys::SHARD_SET_HASH),
        (
            "SNAPSHOT_REVISION",
            upload_job_snapshot_keys::SNAPSHOT_REVISION,
        ),
        ("LAST_EFFECT_ID", upload_job_snapshot_keys::LAST_EFFECT_ID),
    ]
}

fn expected_album_sync_keys() -> Vec<(&'static str, u32)> {
    vec![
        ("SCHEMA_VERSION", 0),
        ("ALBUM_ID", 1),
        ("PHASE", 2),
        ("CURSOR", 3),
        ("PAGE_HASH", 4),
        ("RETRY_COUNT", 5),
        ("MAX_RETRY_COUNT", 6),
        ("NEXT_RETRY_NOT_BEFORE_MS", 7),
        ("SNAPSHOT_REVISION", 8),
        ("LAST_EFFECT_ID", 9),
        ("RERUN_REQUESTED", 10),
    ]
}

fn live_album_sync_keys() -> Vec<(&'static str, u32)> {
    vec![
        ("SCHEMA_VERSION", album_sync_snapshot_keys::SCHEMA_VERSION),
        ("ALBUM_ID", album_sync_snapshot_keys::ALBUM_ID),
        ("PHASE", album_sync_snapshot_keys::PHASE),
        ("CURSOR", album_sync_snapshot_keys::CURSOR),
        ("PAGE_HASH", album_sync_snapshot_keys::PAGE_HASH),
        ("RETRY_COUNT", album_sync_snapshot_keys::RETRY_COUNT),
        ("MAX_RETRY_COUNT", album_sync_snapshot_keys::MAX_RETRY_COUNT),
        (
            "NEXT_RETRY_NOT_BEFORE_MS",
            album_sync_snapshot_keys::NEXT_RETRY_NOT_BEFORE_MS,
        ),
        (
            "SNAPSHOT_REVISION",
            album_sync_snapshot_keys::SNAPSHOT_REVISION,
        ),
        ("LAST_EFFECT_ID", album_sync_snapshot_keys::LAST_EFFECT_ID),
        ("RERUN_REQUESTED", album_sync_snapshot_keys::RERUN_REQUESTED),
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
fn upload_job_snapshot_key_registry_matches_expected() {
    assert_eq!(
        expected_upload_job_keys(),
        live_upload_job_keys(),
        "UploadJobSnapshot integer-key registry drifted. ADR-023 requires \
         append-only allocation; existing key numbers are immutable."
    );
}

#[test]
fn upload_job_snapshot_key_registry_has_no_collisions() {
    let mut seen = BTreeSet::new();
    for (name, key) in live_upload_job_keys() {
        assert!(
            seen.insert(key),
            "UploadJobSnapshot key {name} collides on integer key {key}"
        );
    }
}

#[test]
fn known_upload_job_keys_matches_expected_table() {
    assert_eq!(
        expected_upload_job_keys().as_slice(),
        upload_job_snapshot_keys::KNOWN_UPLOAD_JOB_KEYS,
        "KNOWN_UPLOAD_JOB_KEYS must be updated append-only with the literal lock table"
    );
}

#[test]
fn known_upload_job_keys_has_no_collisions() {
    let mut seen_names = BTreeSet::new();
    let mut seen_values = BTreeSet::new();
    for (name, key) in upload_job_snapshot_keys::KNOWN_UPLOAD_JOB_KEYS {
        assert!(
            seen_names.insert(*name),
            "UploadJobSnapshot key name {name} is duplicated in KNOWN_UPLOAD_JOB_KEYS"
        );
        assert!(
            seen_values.insert(*key),
            "UploadJobSnapshot key {name} collides on integer key {key}"
        );
    }
}

#[test]
fn known_upload_job_keys_exhaustively_lists_source_consts() {
    let source_names = source_const_names("upload_job_snapshot_keys", "u32");
    let known_names = upload_job_snapshot_keys::KNOWN_UPLOAD_JOB_KEYS
        .iter()
        .map(|(name, _)| *name)
        .collect::<Vec<_>>();

    assert_eq!(EXPECTED_UPLOAD_JOB_KEY_COUNT, known_names.len());
    assert_eq!(
        source_names, known_names,
        "Every pub const u32 in upload_job_snapshot_keys must appear in KNOWN_UPLOAD_JOB_KEYS"
    );
}

#[test]
fn upload_job_snapshot_key_zero_is_schema_version() {
    assert_eq!(upload_job_snapshot_keys::SCHEMA_VERSION, 0);
}

#[test]
fn schema_version_key_is_zero_in_both_registries() {
    assert_eq!(upload_job_snapshot_keys::SCHEMA_VERSION, 0);
    assert_eq!(album_sync_snapshot_keys::SCHEMA_VERSION, 0);
    assert_eq!(snapshot_schema::SCHEMA_VERSION_KEY, 0);
}

#[test]
fn album_sync_snapshot_key_registry_matches_expected() {
    assert_eq!(
        expected_album_sync_keys(),
        live_album_sync_keys(),
        "AlbumSyncSnapshot integer-key registry drifted. ADR-023 requires \
         append-only allocation; existing key numbers are immutable."
    );
}

#[test]
fn album_sync_snapshot_key_registry_has_no_collisions() {
    let mut seen = BTreeSet::new();
    for (name, key) in live_album_sync_keys() {
        assert!(
            seen.insert(key),
            "AlbumSyncSnapshot key {name} collides on integer key {key}"
        );
    }
}

#[test]
fn known_album_sync_keys_matches_expected_table() {
    assert_eq!(
        expected_album_sync_keys().as_slice(),
        album_sync_snapshot_keys::KNOWN_ALBUM_SYNC_KEYS,
        "KNOWN_ALBUM_SYNC_KEYS must be updated append-only with the literal lock table"
    );
}

#[test]
fn known_album_sync_keys_has_no_collisions() {
    let mut seen_names = BTreeSet::new();
    let mut seen_values = BTreeSet::new();
    for (name, key) in album_sync_snapshot_keys::KNOWN_ALBUM_SYNC_KEYS {
        assert!(
            seen_names.insert(*name),
            "AlbumSyncSnapshot key name {name} is duplicated in KNOWN_ALBUM_SYNC_KEYS"
        );
        assert!(
            seen_values.insert(*key),
            "AlbumSyncSnapshot key {name} collides on integer key {key}"
        );
    }
}

#[test]
fn known_album_sync_keys_exhaustively_lists_source_consts() {
    let source_names = source_const_names("album_sync_snapshot_keys", "u32");
    let known_names = album_sync_snapshot_keys::KNOWN_ALBUM_SYNC_KEYS
        .iter()
        .map(|(name, _)| *name)
        .collect::<Vec<_>>();

    assert_eq!(EXPECTED_ALBUM_SYNC_KEY_COUNT, known_names.len());
    assert_eq!(
        source_names, known_names,
        "Every pub const u32 in album_sync_snapshot_keys must appear in KNOWN_ALBUM_SYNC_KEYS"
    );
}

#[test]
fn album_sync_snapshot_key_zero_is_schema_version() {
    assert_eq!(album_sync_snapshot_keys::SCHEMA_VERSION, 0);
}
