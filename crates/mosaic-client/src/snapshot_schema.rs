//! Snapshot schema versioning + migration framework.
//!
//! Per ADR-023:
//! - CBOR canonical encoding via `ciborium`.
//! - Integer-key registry (string keys forbidden in canonical maps).
//! - `schema_version: u16` at integer key 0 (first map key under canonical sort).
//! - Phase enums serialized as `u8`; allocations append-only.
//! - Forbidden field types: `f32`/`f64`, non-integer map keys, arbitrary-precision integers.
//!
//! `UploadJobSnapshotPlaceholder` and `AlbumSyncSnapshotPlaceholder` are R-Cl3-only
//! migration scaffolding. R-Cl1/R-Cl2 replace them with concrete snapshot structs;
//! binding/FFI consumer code must not make them part of a stable public contract.

use std::fmt;
use std::io::Cursor;

use ciborium::value::{Integer, Value};

/// Errors raised by snapshot encode/decode/migrate paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotMigrationError {
    /// CBOR bytes failed to decode at all.
    CborDecodeFailed,
    /// `schema_version` field missing or wrong type.
    SchemaVersionMissing,
    /// `schema_version` newer than this client supports (downgrade not supported).
    SchemaTooNew { found: u16, max_supported: u16 },
    /// Migration step failed (semantic-conversion error).
    StepFailed { from: u16, to: u16 },
    /// Snapshot bytes parsed but a field is corrupt for its declared schema_version
    /// (e.g., phase numeric out-of-range, validation rule violated).
    SchemaCorrupt,
    /// Forbidden field detected (forbidden-name list per ADR-023 rule 6).
    ForbiddenField,
}

/// Snapshot schema version constants. Append-only.
///
/// `CURRENT` is the schema_version this build emits and is highest version it can read.
/// Legacy versions can be read via `upgrade_*_snapshot` migration steps but never written.
pub const SNAPSHOT_SCHEMA_VERSION_V1: u16 = 1;
pub const CURRENT_SNAPSHOT_SCHEMA_VERSION: u16 = SNAPSHOT_SCHEMA_VERSION_V1;
/// Canonical integer key for the `schema_version` field in every snapshot registry.
pub const SCHEMA_VERSION_KEY: u32 = 0;
const MAX_CBOR_DEPTH: usize = 64;

/// Integer-key registry for upload-job snapshot fields.
///
/// Append-only. Locked by `tests/snapshot_key_registry_lock.rs`.
pub mod upload_job_snapshot_keys {
    pub const SCHEMA_VERSION: u32 = super::SCHEMA_VERSION_KEY;
    pub const JOB_ID: u32 = 1;
    pub const ALBUM_ID: u32 = 2;
    pub const PHASE: u32 = 3;
    pub const RETRY_COUNT: u32 = 4;
    pub const MAX_RETRY_COUNT: u32 = 5;
    pub const NEXT_RETRY_NOT_BEFORE_MS: u32 = 6;
    pub const IDEMPOTENCY_KEY: u32 = 7;
    pub const TIERED_SHARDS: u32 = 8;
    pub const SHARD_SET_HASH: u32 = 9;
    pub const SNAPSHOT_REVISION: u32 = 10;
    pub const LAST_EFFECT_ID: u32 = 11;
    // 12-127 reserved for v1+ append-only growth.

    /// Append-only registry of every `(name, value)` tuple in this module.
    ///
    /// Adding a new `pub const u32` requires adding a row here and updating
    /// `tests/snapshot_key_registry_lock.rs::expected_upload_job_keys()`.
    /// The lock test asserts this slice exhaustively pins all 12 key consts.
    pub const KNOWN_UPLOAD_JOB_KEYS: &[(&str, u32)] = &[
        ("SCHEMA_VERSION", SCHEMA_VERSION),
        ("JOB_ID", JOB_ID),
        ("ALBUM_ID", ALBUM_ID),
        ("PHASE", PHASE),
        ("RETRY_COUNT", RETRY_COUNT),
        ("MAX_RETRY_COUNT", MAX_RETRY_COUNT),
        ("NEXT_RETRY_NOT_BEFORE_MS", NEXT_RETRY_NOT_BEFORE_MS),
        ("IDEMPOTENCY_KEY", IDEMPOTENCY_KEY),
        ("TIERED_SHARDS", TIERED_SHARDS),
        ("SHARD_SET_HASH", SHARD_SET_HASH),
        ("SNAPSHOT_REVISION", SNAPSHOT_REVISION),
        ("LAST_EFFECT_ID", LAST_EFFECT_ID),
    ];
}

/// Integer-key registry for album-sync snapshot fields.
///
/// Append-only. Locked by `tests/snapshot_key_registry_lock.rs`.
pub mod album_sync_snapshot_keys {
    pub const SCHEMA_VERSION: u32 = super::SCHEMA_VERSION_KEY;
    pub const ALBUM_ID: u32 = 1;
    pub const PHASE: u32 = 2;
    pub const CURSOR: u32 = 3;
    pub const PAGE_HASH: u32 = 4;
    pub const RETRY_COUNT: u32 = 5;
    pub const MAX_RETRY_COUNT: u32 = 6;
    pub const NEXT_RETRY_NOT_BEFORE_MS: u32 = 7;
    pub const SNAPSHOT_REVISION: u32 = 8;
    pub const LAST_EFFECT_ID: u32 = 9;
    pub const RERUN_REQUESTED: u32 = 10;
    // 11-127 reserved for v1+ append-only growth.

    /// Append-only registry of every `(name, value)` tuple in this module.
    ///
    /// Adding a new `pub const u32` requires adding a row here and updating
    /// `tests/snapshot_key_registry_lock.rs::expected_album_sync_keys()`.
    /// The lock test asserts this slice exhaustively pins all 11 key consts.
    pub const KNOWN_ALBUM_SYNC_KEYS: &[(&str, u32)] = &[
        ("SCHEMA_VERSION", SCHEMA_VERSION),
        ("ALBUM_ID", ALBUM_ID),
        ("PHASE", PHASE),
        ("CURSOR", CURSOR),
        ("PAGE_HASH", PAGE_HASH),
        ("RETRY_COUNT", RETRY_COUNT),
        ("MAX_RETRY_COUNT", MAX_RETRY_COUNT),
        ("NEXT_RETRY_NOT_BEFORE_MS", NEXT_RETRY_NOT_BEFORE_MS),
        ("SNAPSHOT_REVISION", SNAPSHOT_REVISION),
        ("LAST_EFFECT_ID", LAST_EFFECT_ID),
        ("RERUN_REQUESTED", RERUN_REQUESTED),
    ];
}

/// Phase-enum numeric allocations for upload jobs.
///
/// Append-only. Locked by `tests/phase_enum_lock.rs`.
pub mod upload_job_phase_codes {
    pub const QUEUED: u8 = 0;
    pub const AWAITING_PREPARED_MEDIA: u8 = 1;
    pub const AWAITING_EPOCH_HANDLE: u8 = 2;
    pub const ENCRYPTING_SHARD: u8 = 3;
    pub const CREATING_SHARD_UPLOAD: u8 = 4;
    pub const UPLOADING_SHARD: u8 = 5;
    pub const CREATING_MANIFEST: u8 = 6;
    pub const MANIFEST_COMMIT_UNKNOWN: u8 = 7;
    pub const AWAITING_SYNC_CONFIRMATION: u8 = 8;
    pub const RETRY_WAITING: u8 = 9;
    pub const CONFIRMED: u8 = 10;
    pub const CANCELLED: u8 = 11;
    pub const FAILED: u8 = 12;

    /// Append-only registry of every `(name, value)` tuple in this module.
    ///
    /// Adding a new `pub const u8` requires adding a row here and updating
    /// `tests/phase_enum_lock.rs::expected_upload_job_phases()`.
    /// The lock test asserts this slice exhaustively pins all 13 phase consts.
    pub const KNOWN_UPLOAD_JOB_PHASES: &[(&str, u8)] = &[
        ("QUEUED", QUEUED),
        ("AWAITING_PREPARED_MEDIA", AWAITING_PREPARED_MEDIA),
        ("AWAITING_EPOCH_HANDLE", AWAITING_EPOCH_HANDLE),
        ("ENCRYPTING_SHARD", ENCRYPTING_SHARD),
        ("CREATING_SHARD_UPLOAD", CREATING_SHARD_UPLOAD),
        ("UPLOADING_SHARD", UPLOADING_SHARD),
        ("CREATING_MANIFEST", CREATING_MANIFEST),
        ("MANIFEST_COMMIT_UNKNOWN", MANIFEST_COMMIT_UNKNOWN),
        ("AWAITING_SYNC_CONFIRMATION", AWAITING_SYNC_CONFIRMATION),
        ("RETRY_WAITING", RETRY_WAITING),
        ("CONFIRMED", CONFIRMED),
        ("CANCELLED", CANCELLED),
        ("FAILED", FAILED),
    ];
}

/// Phase-enum numeric allocations for album sync.
///
/// Append-only. Locked by `tests/phase_enum_lock.rs`.
pub mod album_sync_phase_codes {
    pub const IDLE: u8 = 0;
    pub const FETCHING_PAGE: u8 = 1;
    pub const APPLYING_PAGE: u8 = 2;
    pub const RETRY_WAITING: u8 = 3;
    pub const COMPLETED: u8 = 4;
    pub const CANCELLED: u8 = 5;
    pub const FAILED: u8 = 6;

    /// Append-only registry of every `(name, value)` tuple in this module.
    ///
    /// Adding a new `pub const u8` requires adding a row here and updating
    /// `tests/phase_enum_lock.rs::expected_album_sync_phases()`.
    /// The lock test asserts this slice exhaustively pins all 7 phase consts.
    pub const KNOWN_ALBUM_SYNC_PHASES: &[(&str, u8)] = &[
        ("IDLE", IDLE),
        ("FETCHING_PAGE", FETCHING_PAGE),
        ("APPLYING_PAGE", APPLYING_PAGE),
        ("RETRY_WAITING", RETRY_WAITING),
        ("COMPLETED", COMPLETED),
        ("CANCELLED", CANCELLED),
        ("FAILED", FAILED),
    ];
}

/// Forbidden field names — defense-in-depth check at decode time (ADR-023 rule 6).
///
/// If a snapshot CBOR has a *string* key containing any of these substrings
/// case-insensitively, decode returns `ForbiddenField`. Canonical snapshots
/// allow only integer keys, so any string key is rejected.
pub const FORBIDDEN_FIELD_NAMES: &[&str] = &[
    "account_key",
    "caption",
    "description",
    "device_metadata",
    "device_timestamp",
    "epoch_seed",
    "exif",
    "filename",
    "gps",
    "gps_lat",
    "gps_lon",
    "key",
    "make",
    "master_key",
    "model",
    "password",
    "plaintext",
    "private_key",
    "raw_uri",
    "read_key",
    "secret",
    "signing_key",
    "tier_key",
    "uri",
];

/// Migration entry point for upload-job snapshots.
///
/// Reads `schema_version` from CBOR bytes and validates the R-Cl3 schema-level
/// invariants. R-Cl1 replaces the current-version placeholder branch with the
/// concrete v1 decode and migration steps.
pub fn upgrade_upload_job_snapshot(
    bytes: &[u8],
) -> Result<UploadJobSnapshotPlaceholder, SnapshotMigrationError> {
    let schema_version = read_schema_version(bytes, upload_job_snapshot_keys::SCHEMA_VERSION)?;
    if schema_version > CURRENT_SNAPSHOT_SCHEMA_VERSION {
        return Err(SnapshotMigrationError::SchemaTooNew {
            found: schema_version,
            max_supported: CURRENT_SNAPSHOT_SCHEMA_VERSION,
        });
    }

    Err(SnapshotMigrationError::StepFailed {
        from: schema_version,
        to: CURRENT_SNAPSHOT_SCHEMA_VERSION,
    })
}

/// Migration entry point for album-sync snapshots.
///
/// Reads `schema_version` from CBOR bytes and validates the R-Cl3 schema-level
/// invariants. R-Cl2 replaces the current-version placeholder branch with the
/// concrete v1 decode and migration steps.
pub fn upgrade_album_sync_snapshot(
    bytes: &[u8],
) -> Result<AlbumSyncSnapshotPlaceholder, SnapshotMigrationError> {
    let schema_version = read_schema_version(bytes, album_sync_snapshot_keys::SCHEMA_VERSION)?;
    if schema_version > CURRENT_SNAPSHOT_SCHEMA_VERSION {
        return Err(SnapshotMigrationError::SchemaTooNew {
            found: schema_version,
            max_supported: CURRENT_SNAPSHOT_SCHEMA_VERSION,
        });
    }

    Err(SnapshotMigrationError::StepFailed {
        from: schema_version,
        to: CURRENT_SNAPSHOT_SCHEMA_VERSION,
    })
}

/// Placeholder type — R-Cl1 replaces with the real struct.
#[derive(Clone, PartialEq, Eq)]
pub struct UploadJobSnapshotPlaceholder {
    pub schema_version: u16,
    pub raw_cbor: Vec<u8>,
}

impl fmt::Debug for UploadJobSnapshotPlaceholder {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UploadJobSnapshotPlaceholder")
            .field("schema_version", &self.schema_version)
            .field(
                "raw_cbor",
                &format_args!("<{} CBOR bytes>", self.raw_cbor.len()),
            )
            .finish()
    }
}

/// Placeholder type — R-Cl2 replaces with the real struct.
#[derive(Clone, PartialEq, Eq)]
pub struct AlbumSyncSnapshotPlaceholder {
    pub schema_version: u16,
    pub raw_cbor: Vec<u8>,
}

impl fmt::Debug for AlbumSyncSnapshotPlaceholder {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AlbumSyncSnapshotPlaceholder")
            .field("schema_version", &self.schema_version)
            .field(
                "raw_cbor",
                &format_args!("<{} CBOR bytes>", self.raw_cbor.len()),
            )
            .finish()
    }
}

fn read_schema_version(bytes: &[u8], expected_key: u32) -> Result<u16, SnapshotMigrationError> {
    match cbor_contains_forbidden_bigint_tag(bytes) {
        Ok(true) => return Err(SnapshotMigrationError::SchemaCorrupt),
        Ok(false) => {}
        Err(()) => return Err(SnapshotMigrationError::CborDecodeFailed),
    }

    let value: Value = ciborium::de::from_reader(Cursor::new(bytes))
        .map_err(|_| SnapshotMigrationError::CborDecodeFailed)?;
    validate_value(&value, 0)?;
    schema_version_from_root_map(&value, expected_key)
}

fn schema_version_from_root_map(
    value: &Value,
    expected_key: u32,
) -> Result<u16, SnapshotMigrationError> {
    let Value::Map(entries) = value else {
        return Err(SnapshotMigrationError::SchemaVersionMissing);
    };

    if entries.is_empty() {
        return Err(SnapshotMigrationError::SchemaVersionMissing);
    }

    let Some((first_key, _)) = entries.first() else {
        return Err(SnapshotMigrationError::SchemaVersionMissing);
    };
    if key_as_u32(first_key)? != expected_key {
        let has_schema_version = entries.iter().any(|(key, _)| {
            key.as_integer()
                .and_then(integer_to_u32)
                .is_some_and(|key| key == expected_key)
        });
        return match has_schema_version {
            true => Err(SnapshotMigrationError::SchemaCorrupt),
            false => Err(SnapshotMigrationError::SchemaVersionMissing),
        };
    }

    let Some((_, version_value)) = entries.iter().find(|(key, _)| {
        key.as_integer()
            .and_then(integer_to_u32)
            .is_some_and(|key| key == expected_key)
    }) else {
        return Err(SnapshotMigrationError::SchemaVersionMissing);
    };

    let Some(version_integer) = version_value.as_integer() else {
        return Err(SnapshotMigrationError::SchemaVersionMissing);
    };
    integer_to_u16(version_integer).ok_or(SnapshotMigrationError::SchemaVersionMissing)
}

fn validate_value(value: &Value, depth: usize) -> Result<(), SnapshotMigrationError> {
    if depth > MAX_CBOR_DEPTH {
        return Err(SnapshotMigrationError::CborDecodeFailed);
    }

    match value {
        Value::Integer(_) | Value::Bytes(_) | Value::Bool(_) | Value::Null => Ok(()),
        Value::Float(_) => Err(SnapshotMigrationError::SchemaCorrupt),
        Value::Text(_) => Ok(()),
        Value::Tag(tag, _) if *tag == 2 || *tag == 3 => Err(SnapshotMigrationError::SchemaCorrupt),
        Value::Tag(_, tagged) => validate_value(tagged, depth + 1),
        Value::Array(items) => {
            for item in items {
                validate_value(item, depth + 1)?;
            }
            Ok(())
        }
        Value::Map(entries) => {
            for (key, nested_value) in entries {
                validate_map_key(key)?;
                validate_value(nested_value, depth + 1)?;
            }
            Ok(())
        }
        _ => Err(SnapshotMigrationError::SchemaCorrupt),
    }
}

fn validate_map_key(key: &Value) -> Result<(), SnapshotMigrationError> {
    match key {
        Value::Integer(integer) => {
            integer_to_u32(*integer).ok_or(SnapshotMigrationError::SchemaCorrupt)?;
            Ok(())
        }
        Value::Text(field_name) if is_forbidden_name(field_name) => {
            Err(SnapshotMigrationError::ForbiddenField)
        }
        Value::Text(_) => Err(SnapshotMigrationError::SchemaCorrupt),
        _ => Err(SnapshotMigrationError::SchemaCorrupt),
    }
}

fn is_forbidden_name(field_name: &str) -> bool {
    let lower = field_name.to_ascii_lowercase();
    FORBIDDEN_FIELD_NAMES
        .iter()
        .any(|forbidden| lower.contains(forbidden))
}

fn key_as_u32(value: &Value) -> Result<u32, SnapshotMigrationError> {
    let Some(integer) = value.as_integer() else {
        return Err(SnapshotMigrationError::SchemaVersionMissing);
    };
    integer_to_u32(integer).ok_or(SnapshotMigrationError::SchemaCorrupt)
}

fn integer_to_u16(integer: Integer) -> Option<u16> {
    u16::try_from(integer).ok()
}

fn integer_to_u32(integer: Integer) -> Option<u32> {
    u32::try_from(integer).ok()
}

fn cbor_contains_forbidden_bigint_tag(bytes: &[u8]) -> Result<bool, ()> {
    let mut offset = 0;
    let contains = parse_cbor_item_forbidden_bigint_tag(bytes, &mut offset, 0)?;
    if !contains && offset != bytes.len() {
        return Err(());
    }
    Ok(contains)
}

fn parse_cbor_item_forbidden_bigint_tag(
    bytes: &[u8],
    offset: &mut usize,
    depth: usize,
) -> Result<bool, ()> {
    if depth > MAX_CBOR_DEPTH {
        return Err(());
    }

    let initial = read_cbor_byte(bytes, offset)?;
    let major = initial >> 5;
    let additional = initial & 0x1f;

    match major {
        0 | 1 => {
            read_cbor_argument(bytes, offset, additional)?;
            Ok(false)
        }
        2 | 3 => {
            let len = read_cbor_argument(bytes, offset, additional)?;
            skip_cbor_bytes(bytes, offset, len)?;
            Ok(false)
        }
        4 => {
            let len = read_cbor_argument(bytes, offset, additional)?;
            for _ in 0..len {
                if parse_cbor_item_forbidden_bigint_tag(bytes, offset, depth + 1)? {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        5 => {
            let len = read_cbor_argument(bytes, offset, additional)?;
            for _ in 0..len {
                if parse_cbor_item_forbidden_bigint_tag(bytes, offset, depth + 1)? {
                    return Ok(true);
                }
                if parse_cbor_item_forbidden_bigint_tag(bytes, offset, depth + 1)? {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        6 => {
            let tag = read_cbor_argument(bytes, offset, additional)?;
            if tag == 2 || tag == 3 {
                return Ok(true);
            }
            parse_cbor_item_forbidden_bigint_tag(bytes, offset, depth + 1)
        }
        7 => {
            skip_cbor_simple_payload(bytes, offset, additional)?;
            Ok(false)
        }
        _ => Err(()),
    }
}

fn read_cbor_byte(bytes: &[u8], offset: &mut usize) -> Result<u8, ()> {
    let Some(byte) = bytes.get(*offset).copied() else {
        return Err(());
    };
    *offset += 1;
    Ok(byte)
}

fn read_cbor_argument(bytes: &[u8], offset: &mut usize, additional: u8) -> Result<u64, ()> {
    match additional {
        value @ 0..=23 => Ok(u64::from(value)),
        24 => Ok(u64::from(read_cbor_byte(bytes, offset)?)),
        25 => read_cbor_be_uint(bytes, offset, 2),
        26 => read_cbor_be_uint(bytes, offset, 4),
        27 => read_cbor_be_uint(bytes, offset, 8),
        _ => Err(()),
    }
}

fn read_cbor_be_uint(bytes: &[u8], offset: &mut usize, width: usize) -> Result<u64, ()> {
    let end = (*offset).checked_add(width).ok_or(())?;
    let Some(slice) = bytes.get(*offset..end) else {
        return Err(());
    };
    let mut value = 0_u64;
    for byte in slice {
        value = (value << 8) | u64::from(*byte);
    }
    *offset = end;
    Ok(value)
}

fn skip_cbor_bytes(bytes: &[u8], offset: &mut usize, len: u64) -> Result<(), ()> {
    let len = usize::try_from(len).map_err(|_| ())?;
    let end = (*offset).checked_add(len).ok_or(())?;
    if end > bytes.len() {
        return Err(());
    }
    *offset = end;
    Ok(())
}

fn skip_cbor_simple_payload(bytes: &[u8], offset: &mut usize, additional: u8) -> Result<(), ()> {
    match additional {
        0..=23 => Ok(()),
        24 => skip_cbor_bytes(bytes, offset, 1),
        25 => skip_cbor_bytes(bytes, offset, 2),
        26 => skip_cbor_bytes(bytes, offset, 4),
        27 => skip_cbor_bytes(bytes, offset, 8),
        _ => Err(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_value(value: &Value) -> Vec<u8> {
        let mut bytes = Vec::new();
        if let Err(error) = ciborium::ser::into_writer(value, &mut bytes) {
            panic!("test CBOR value should encode: {error}");
        }
        bytes
    }

    #[test]
    fn current_version_placeholder_branch_is_explicit_step_failed() {
        let bytes = encode_value(&Value::Map(vec![(
            Value::Integer(upload_job_snapshot_keys::SCHEMA_VERSION.into()),
            Value::Integer(SNAPSHOT_SCHEMA_VERSION_V1.into()),
        )]));

        assert_eq!(
            upgrade_upload_job_snapshot(&bytes),
            Err(SnapshotMigrationError::StepFailed { from: 1, to: 1 })
        );
        assert_eq!(
            upgrade_album_sync_snapshot(&bytes),
            Err(SnapshotMigrationError::StepFailed { from: 1, to: 1 })
        );
    }

    #[test]
    fn future_version_is_schema_too_new() {
        let bytes = encode_value(&Value::Map(vec![(
            Value::Integer(upload_job_snapshot_keys::SCHEMA_VERSION.into()),
            Value::Integer((CURRENT_SNAPSHOT_SCHEMA_VERSION + 1).into()),
        )]));

        assert_eq!(
            upgrade_upload_job_snapshot(&bytes),
            Err(SnapshotMigrationError::SchemaTooNew {
                found: CURRENT_SNAPSHOT_SCHEMA_VERSION + 1,
                max_supported: CURRENT_SNAPSHOT_SCHEMA_VERSION,
            })
        );
    }

    #[test]
    fn malformed_cbor_is_decode_failed() {
        assert_eq!(
            upgrade_upload_job_snapshot(&[0xff]),
            Err(SnapshotMigrationError::CborDecodeFailed)
        );
    }

    #[test]
    fn missing_or_wrong_schema_version_is_rejected() {
        let missing = encode_value(&Value::Map(vec![(
            Value::Integer(upload_job_snapshot_keys::JOB_ID.into()),
            Value::Bytes(vec![1, 2, 3]),
        )]));
        let wrong_type = encode_value(&Value::Map(vec![(
            Value::Integer(upload_job_snapshot_keys::SCHEMA_VERSION.into()),
            Value::Text("1".to_owned()),
        )]));

        assert_eq!(
            upgrade_upload_job_snapshot(&missing),
            Err(SnapshotMigrationError::SchemaVersionMissing)
        );
        assert_eq!(
            upgrade_upload_job_snapshot(&wrong_type),
            Err(SnapshotMigrationError::SchemaVersionMissing)
        );
    }

    #[test]
    fn noncanonical_schema_version_position_is_corrupt() {
        let bytes = encode_value(&Value::Map(vec![
            (
                Value::Integer(upload_job_snapshot_keys::JOB_ID.into()),
                Value::Bytes(vec![1, 2, 3]),
            ),
            (
                Value::Integer(upload_job_snapshot_keys::SCHEMA_VERSION.into()),
                Value::Integer(SNAPSHOT_SCHEMA_VERSION_V1.into()),
            ),
        ]));

        assert_eq!(
            upgrade_upload_job_snapshot(&bytes),
            Err(SnapshotMigrationError::SchemaCorrupt)
        );
    }

    #[test]
    fn noncanonical_schema_version_position_is_corrupt_album_sync() {
        let bytes = encode_value(&Value::Map(vec![
            (
                Value::Integer(album_sync_snapshot_keys::ALBUM_ID.into()),
                Value::Bytes(vec![1, 2, 3]),
            ),
            (
                Value::Integer(album_sync_snapshot_keys::SCHEMA_VERSION.into()),
                Value::Integer(SNAPSHOT_SCHEMA_VERSION_V1.into()),
            ),
        ]));

        assert_eq!(
            upgrade_album_sync_snapshot(&bytes),
            Err(SnapshotMigrationError::SchemaCorrupt)
        );
    }

    #[test]
    fn forbidden_field_name_is_rejected() {
        let bytes = encode_value(&Value::Map(vec![
            (
                Value::Integer(upload_job_snapshot_keys::SCHEMA_VERSION.into()),
                Value::Integer(SNAPSHOT_SCHEMA_VERSION_V1.into()),
            ),
            (
                Value::Text("private_key".to_owned()),
                Value::Bytes(vec![1, 2, 3]),
            ),
        ]));

        assert_eq!(
            upgrade_upload_job_snapshot(&bytes),
            Err(SnapshotMigrationError::ForbiddenField)
        );
    }

    #[test]
    fn forbidden_field_name_is_rejected_album_sync() {
        let bytes = encode_value(&Value::Map(vec![
            (
                Value::Integer(album_sync_snapshot_keys::SCHEMA_VERSION.into()),
                Value::Integer(SNAPSHOT_SCHEMA_VERSION_V1.into()),
            ),
            (
                Value::Text("Account_Key_Wrapped".to_owned()),
                Value::Bytes(vec![1, 2, 3]),
            ),
        ]));

        assert_eq!(
            upgrade_album_sync_snapshot(&bytes),
            Err(SnapshotMigrationError::ForbiddenField)
        );
    }

    #[test]
    fn string_map_key_and_float_payload_are_corrupt() {
        let string_key = encode_value(&Value::Map(vec![
            (
                Value::Integer(upload_job_snapshot_keys::SCHEMA_VERSION.into()),
                Value::Integer(SNAPSHOT_SCHEMA_VERSION_V1.into()),
            ),
            (Value::Text("phase".to_owned()), Value::Integer(0_u8.into())),
        ]));
        let float_payload = encode_value(&Value::Map(vec![
            (
                Value::Integer(upload_job_snapshot_keys::SCHEMA_VERSION.into()),
                Value::Integer(SNAPSHOT_SCHEMA_VERSION_V1.into()),
            ),
            (
                Value::Integer(upload_job_snapshot_keys::RETRY_COUNT.into()),
                Value::Float(1.0),
            ),
        ]));

        assert_eq!(
            upgrade_upload_job_snapshot(&string_key),
            Err(SnapshotMigrationError::SchemaCorrupt)
        );
        assert_eq!(
            upgrade_upload_job_snapshot(&float_payload),
            Err(SnapshotMigrationError::SchemaCorrupt)
        );
    }

    #[test]
    fn arbitrary_precision_integer_tag_is_corrupt() {
        let bytes = vec![
            0xa2, // map(2)
            0x00, // key 0
            0x01, // schema_version 1
            0x04, // key 4
            0xc2, // tag(2): positive arbitrary-precision integer
            0x41, // bytes(1)
            0x01,
        ];

        assert_eq!(
            upgrade_upload_job_snapshot(&bytes),
            Err(SnapshotMigrationError::SchemaCorrupt)
        );
    }

    #[test]
    fn deeply_nested_cbor_is_rejected_without_panic() {
        let mut bytes = vec![0x81; 1_000];
        bytes.extend_from_slice(&[0xa1, 0x00, 0x01]);

        assert_eq!(
            upgrade_upload_job_snapshot(&bytes),
            Err(SnapshotMigrationError::CborDecodeFailed)
        );
    }

    #[test]
    fn placeholder_debug_redacts_raw_cbor() {
        let placeholder = UploadJobSnapshotPlaceholder {
            schema_version: 1,
            raw_cbor: vec![1, 2, 3],
        };

        let debug = format!("{placeholder:?}");
        assert!(debug.contains("<3 CBOR bytes>"));
        assert!(!debug.contains("[1, 2, 3]"));
    }

    #[test]
    fn placeholder_debug_redacts_raw_cbor_album_sync() {
        let placeholder = AlbumSyncSnapshotPlaceholder {
            schema_version: 1,
            raw_cbor: vec![1, 2, 3],
        };

        let debug = format!("{placeholder:?}");
        assert!(debug.contains("<3 CBOR bytes>"));
        assert!(!debug.contains("[1, 2, 3]"));
    }
}
