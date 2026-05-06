//! CBOR snapshot schema and atomic commit primitives for downloads.
//!
//! Phase 1 persistence granularity is intentionally coarse: persist on every
//! [`crate::download::DownloadJobState`] transition and every per-photo status
//! transition. Per-shard byte progress is not persisted until the Phase 2
//! rate-limited progress writer.
//!
//! Atomic commit protocol: Rust produces [`SnapshotBytes`] containing canonical
//! snapshot body bytes plus a BLAKE2b-256 checksum over the body. The TypeScript
//! I/O layer writes the encoded envelope to `snapshot.cbor.tmp`, fsyncs when the
//! platform exposes it, then atomically renames it to `snapshot.cbor`. On resume,
//! [`repair_snapshot_for_resume`] enforces the invariant that each persisted
//! `bytes_written` is less than or equal to the actual staged file length.

use std::collections::BTreeMap;
use std::io::Cursor;

use blake2::{
    Blake2bVar,
    digest::{Update, VariableOutput},
};
use ciborium::value::{Integer, Value};
use mosaic_domain::ShardTier;

use crate::Uuid;
use crate::download::error::DownloadErrorCode;
use crate::download::plan::{DownloadPlan, DownloadPlanEntry, PhotoId, ShardId};
use crate::download::state::{DownloadJobState, PhotoStatus, SkipReason};

pub const DOWNLOAD_SNAPSHOT_SCHEMA_VERSION_V1: u32 = 1;
pub const DOWNLOAD_SNAPSHOT_SCHEMA_VERSION_V2: u32 = 2;
pub const DOWNLOAD_SNAPSHOT_SCHEMA_VERSION_V3: u32 = 3;
pub const CURRENT_DOWNLOAD_SNAPSHOT_SCHEMA_VERSION: u32 = DOWNLOAD_SNAPSHOT_SCHEMA_VERSION_V3;
const SNAPSHOT_ENVELOPE_VERSION: u32 = 1;
const MAX_DOWNLOAD_SNAPSHOT_BYTES: usize = 1_500_000;

pub type LeaseToken = [u8; 16];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct JobId([u8; 16]);

impl JobId {
    #[must_use]
    pub const fn from_bytes(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }

    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }
}

pub mod download_job_state_codes {
    pub const IDLE: u8 = 0;
    pub const PREPARING: u8 = 1;
    pub const RUNNING: u8 = 2;
    pub const PAUSED: u8 = 3;
    pub const FINALIZING: u8 = 4;
    pub const DONE: u8 = 5;
    pub const ERRORED: u8 = 6;
    pub const CANCELLED: u8 = 7;

    pub const KNOWN_DOWNLOAD_JOB_STATES: &[(&str, u8)] = &[
        ("IDLE", IDLE),
        ("PREPARING", PREPARING),
        ("RUNNING", RUNNING),
        ("PAUSED", PAUSED),
        ("FINALIZING", FINALIZING),
        ("DONE", DONE),
        ("ERRORED", ERRORED),
        ("CANCELLED", CANCELLED),
    ];
}

pub mod download_schedule_kind_codes {
    pub const IMMEDIATE: u8 = 0;
    pub const WIFI: u8 = 1;
    pub const WIFI_CHARGING: u8 = 2;
    pub const IDLE: u8 = 3;
    pub const WINDOW: u8 = 4;

    pub const KNOWN_DOWNLOAD_SCHEDULE_KINDS: &[(&str, u8)] = &[
        ("IMMEDIATE", IMMEDIATE),
        ("WIFI", WIFI),
        ("WIFI_CHARGING", WIFI_CHARGING),
        ("IDLE", IDLE),
        ("WINDOW", WINDOW),
    ];
}

pub mod download_schedule_keys {
    /// Schedule kind code, see [`super::download_schedule_kind_codes`].
    pub const KIND: u32 = 0;
    /// `Window` start hour (0..=23). Required for `Window`, absent otherwise.
    pub const WINDOW_START_HOUR: u32 = 1;
    /// `Window` end hour (0..=23, exclusive). Required for `Window`, absent otherwise.
    pub const WINDOW_END_HOUR: u32 = 2;
    /// Optional max-delay-before-force-start (ms). `Null` when unset.
    pub const MAX_DELAY_MS: u32 = 3;

    pub const KNOWN_DOWNLOAD_SCHEDULE_KEYS: &[(&str, u32)] = &[
        ("KIND", KIND),
        ("WINDOW_START_HOUR", WINDOW_START_HOUR),
        ("WINDOW_END_HOUR", WINDOW_END_HOUR),
        ("MAX_DELAY_MS", MAX_DELAY_MS),
    ];
}

/// Conditional download schedule. Mirrors the TypeScript `DownloadSchedule`.
///
/// `Immediate` is represented by [`Option::None`] in [`DownloadJobSnapshot::schedule`];
/// only non-trivial schedules are persisted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DownloadSchedule {
    Wifi {
        max_delay_ms: Option<u64>,
    },
    WifiCharging {
        max_delay_ms: Option<u64>,
    },
    Idle {
        max_delay_ms: Option<u64>,
    },
    Window {
        start_hour: u8,
        end_hour: u8,
        max_delay_ms: Option<u64>,
    },
}

impl DownloadSchedule {
    /// Returns the `download_schedule_kind_codes` byte for this schedule.
    #[must_use]
    pub const fn kind_code(&self) -> u8 {
        match self {
            Self::Wifi { .. } => download_schedule_kind_codes::WIFI,
            Self::WifiCharging { .. } => download_schedule_kind_codes::WIFI_CHARGING,
            Self::Idle { .. } => download_schedule_kind_codes::IDLE,
            Self::Window { .. } => download_schedule_kind_codes::WINDOW,
        }
    }
}

pub mod download_job_snapshot_keys {
    pub const SCHEMA_VERSION: u32 = 0;
    pub const JOB_ID: u32 = 1;
    pub const ALBUM_ID: u32 = 2;
    pub const CREATED_AT_MS: u32 = 3;
    pub const LAST_UPDATED_AT_MS: u32 = 4;
    pub const STATE: u32 = 5;
    pub const PLAN: u32 = 6;
    pub const PHOTOS: u32 = 7;
    pub const FAILURE_LOG: u32 = 8;
    pub const LEASE_TOKEN: u32 = 9;
    pub const SCOPE_KEY: u32 = 10;
    pub const SCHEDULE: u32 = 11;

    pub const KNOWN_DOWNLOAD_JOB_KEYS: &[(&str, u32)] = &[
        ("SCHEMA_VERSION", SCHEMA_VERSION),
        ("JOB_ID", JOB_ID),
        ("ALBUM_ID", ALBUM_ID),
        ("CREATED_AT_MS", CREATED_AT_MS),
        ("LAST_UPDATED_AT_MS", LAST_UPDATED_AT_MS),
        ("STATE", STATE),
        ("PLAN", PLAN),
        ("PHOTOS", PHOTOS),
        ("FAILURE_LOG", FAILURE_LOG),
        ("LEASE_TOKEN", LEASE_TOKEN),
        ("SCOPE_KEY", SCOPE_KEY),
        ("SCHEDULE", SCHEDULE),
    ];

    pub const DOWNLOAD_JOB_KEYS_V1: &[u32] = &[
        SCHEMA_VERSION,
        JOB_ID,
        ALBUM_ID,
        CREATED_AT_MS,
        LAST_UPDATED_AT_MS,
        STATE,
        PLAN,
        PHOTOS,
        FAILURE_LOG,
        LEASE_TOKEN,
    ];

    pub const DOWNLOAD_JOB_KEYS_V2: &[u32] = &[
        SCHEMA_VERSION,
        JOB_ID,
        ALBUM_ID,
        CREATED_AT_MS,
        LAST_UPDATED_AT_MS,
        STATE,
        PLAN,
        PHOTOS,
        FAILURE_LOG,
        LEASE_TOKEN,
        SCOPE_KEY,
    ];

    /// Keys for v3 snapshots WITHOUT a schedule. The schedule field is
    /// optional; encoders omit key 11 when no schedule is set.
    pub const DOWNLOAD_JOB_KEYS_V3_NO_SCHEDULE: &[u32] = DOWNLOAD_JOB_KEYS_V2;

    /// Keys for v3 snapshots that include a schedule.
    pub const DOWNLOAD_JOB_KEYS_V3_WITH_SCHEDULE: &[u32] = &[
        SCHEMA_VERSION,
        JOB_ID,
        ALBUM_ID,
        CREATED_AT_MS,
        LAST_UPDATED_AT_MS,
        STATE,
        PLAN,
        PHOTOS,
        FAILURE_LOG,
        LEASE_TOKEN,
        SCOPE_KEY,
        SCHEDULE,
    ];
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadJobSnapshot {
    pub schema_version: u32,
    pub job_id: JobId,
    pub album_id: Uuid,
    pub created_at_ms: u64,
    pub last_updated_at_ms: u64,
    pub state: DownloadJobState,
    pub plan: DownloadPlan,
    pub photos: Vec<PhotoState>,
    pub failure_log: Vec<DownloadFailureEntry>,
    pub lease_token: Option<LeaseToken>,
    /// Tray scope key partitioning this job by identity. Format
    /// `<prefix>:<32-hex>` where prefix is `auth`/`visitor`/`legacy`.
    /// Derived via [`crate::download::scope`]; ZK-safe to log only the prefix.
    pub scope_key: String,
    /// Conditional schedule controlling when this job may transition out
    /// of `Scheduled`. `None` means "start immediately".
    pub schedule: Option<DownloadSchedule>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhotoState {
    pub photo_id: PhotoId,
    pub status: PhotoStatus,
    pub bytes_written: u64,
    pub last_attempt_at_ms: Option<u64>,
    pub retry_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadFailureEntry {
    pub photo_id: Option<PhotoId>,
    pub reason: DownloadErrorCode,
    pub at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotBytes {
    pub body: Vec<u8>,
    pub checksum: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DownloadSnapshotDecode {
    Verified(DownloadJobSnapshot),
    LegacyWithoutChecksum(DownloadJobSnapshot),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DownloadSnapshotError {
    CborDecodeFailed,
    SchemaVersionMissing,
    SchemaTooNew {
        found: u32,
        max_supported: u32,
    },
    SchemaCorrupt,
    ForbiddenField,
    ChecksumMismatch,
    Torn {
        photo_id: PhotoId,
        bytes_written: u64,
        actual_len: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotTruncation {
    pub photo_id: PhotoId,
    pub len: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadSnapshotResumeRepair {
    pub snapshot: DownloadJobSnapshot,
    pub truncations: Vec<SnapshotTruncation>,
    pub torn_photos: Vec<PhotoId>,
}

pub fn prepare_snapshot_bytes(
    snapshot: &DownloadJobSnapshot,
) -> Result<SnapshotBytes, DownloadSnapshotError> {
    let body = snapshot.to_canonical_cbor()?;
    let checksum = checksum_body(&body)?;
    Ok(SnapshotBytes { body, checksum })
}

pub fn encode_snapshot_bytes(bytes: &SnapshotBytes) -> Result<Vec<u8>, DownloadSnapshotError> {
    let value = Value::Map(vec![
        kv(0, uint(SNAPSHOT_ENVELOPE_VERSION)),
        kv(1, Value::Bytes(bytes.body.clone())),
        kv(2, Value::Bytes(bytes.checksum.to_vec())),
    ]);
    let mut out = Vec::new();
    ciborium::ser::into_writer(&value, &mut out)
        .map_err(|_| DownloadSnapshotError::SchemaCorrupt)?;
    Ok(out)
}

pub fn upgrade_download_snapshot(
    bytes: &[u8],
) -> Result<DownloadSnapshotDecode, DownloadSnapshotError> {
    if bytes.len() > MAX_DOWNLOAD_SNAPSHOT_BYTES {
        return Err(DownloadSnapshotError::SchemaCorrupt);
    }
    let value: Value = ciborium::de::from_reader(Cursor::new(bytes))
        .map_err(|_| DownloadSnapshotError::CborDecodeFailed)?;
    validate_cbor_value(&value, 0)?;
    if let Value::Map(entries) = &value {
        if entries.len() == 3 && has_key(entries, 0) && has_key(entries, 1) && has_key(entries, 2) {
            validate_exact_keys(entries, &[0, 1, 2])?;
            let body = required_bytes(entries, 1)?;
            let checksum = required_bytes_32(entries, 2)?;
            if checksum_body(&body)? != checksum {
                return Err(DownloadSnapshotError::ChecksumMismatch);
            }
            let snapshot = DownloadJobSnapshot::from_canonical_cbor(&body)?;
            return Ok(DownloadSnapshotDecode::Verified(snapshot));
        }
    }
    let snapshot = DownloadJobSnapshot::from_canonical_cbor(bytes)?;
    Ok(DownloadSnapshotDecode::LegacyWithoutChecksum(snapshot))
}

pub fn repair_snapshot_for_resume(
    snapshot: &DownloadJobSnapshot,
    actual_lengths: &[(PhotoId, u64)],
) -> Result<DownloadSnapshotResumeRepair, DownloadSnapshotError> {
    let lengths: BTreeMap<&PhotoId, u64> =
        actual_lengths.iter().map(|(id, len)| (id, *len)).collect();
    let mut repaired = snapshot.clone();
    let mut truncations = Vec::new();
    let mut torn_photos = Vec::new();
    for photo in &mut repaired.photos {
        let actual = lengths.get(&photo.photo_id).copied().unwrap_or(0);
        if photo.bytes_written > actual {
            torn_photos.push(photo.photo_id.clone());
            photo.status = PhotoStatus::Pending;
            photo.bytes_written = 0;
        } else if photo.bytes_written < actual {
            truncations.push(SnapshotTruncation {
                photo_id: photo.photo_id.clone(),
                len: photo.bytes_written,
            });
        }
    }
    Ok(DownloadSnapshotResumeRepair {
        snapshot: repaired,
        truncations,
        torn_photos,
    })
}

impl DownloadJobSnapshot {
    pub fn to_canonical_cbor(&self) -> Result<Vec<u8>, DownloadSnapshotError> {
        validate_snapshot(self)?;
        let mut entries = vec![
            kv(
                download_job_snapshot_keys::SCHEMA_VERSION,
                uint(self.schema_version),
            ),
            kv(
                download_job_snapshot_keys::JOB_ID,
                Value::Bytes(self.job_id.0.to_vec()),
            ),
            kv(
                download_job_snapshot_keys::ALBUM_ID,
                Value::Bytes(self.album_id.as_bytes().to_vec()),
            ),
            kv(
                download_job_snapshot_keys::CREATED_AT_MS,
                uint(self.created_at_ms),
            ),
            kv(
                download_job_snapshot_keys::LAST_UPDATED_AT_MS,
                uint(self.last_updated_at_ms),
            ),
            kv(download_job_snapshot_keys::STATE, state_value(&self.state)),
            kv(download_job_snapshot_keys::PLAN, plan_value(&self.plan)),
            kv(
                download_job_snapshot_keys::PHOTOS,
                Value::Array(self.photos.iter().map(photo_state_value).collect()),
            ),
            kv(
                download_job_snapshot_keys::FAILURE_LOG,
                Value::Array(self.failure_log.iter().map(failure_value).collect()),
            ),
            kv(
                download_job_snapshot_keys::LEASE_TOKEN,
                option_lease(self.lease_token),
            ),
            kv(
                download_job_snapshot_keys::SCOPE_KEY,
                Value::Text(self.scope_key.clone()),
            ),
        ];
        // Optional v3 schedule. Omitted entirely when `None` so that
        // unscheduled jobs continue to round-trip with the v2 key set.
        if let Some(schedule) = &self.schedule {
            entries.push(kv(
                download_job_snapshot_keys::SCHEDULE,
                schedule_value(schedule),
            ));
        }
        let value = Value::Map(entries);
        let mut out = Vec::new();
        ciborium::ser::into_writer(&value, &mut out)
            .map_err(|_| DownloadSnapshotError::SchemaCorrupt)?;
        Ok(out)
    }

    pub fn from_canonical_cbor(bytes: &[u8]) -> Result<Self, DownloadSnapshotError> {
        if bytes.len() > MAX_DOWNLOAD_SNAPSHOT_BYTES {
            return Err(DownloadSnapshotError::SchemaCorrupt);
        }
        let value: Value = ciborium::de::from_reader(Cursor::new(bytes))
            .map_err(|_| DownloadSnapshotError::CborDecodeFailed)?;
        validate_cbor_value(&value, 0)?;
        let snapshot = decode_snapshot_value(&value)?;
        Ok(snapshot)
    }
}

fn checksum_body(body: &[u8]) -> Result<[u8; 32], DownloadSnapshotError> {
    let mut hasher = Blake2bVar::new(32).map_err(|_| DownloadSnapshotError::SchemaCorrupt)?;
    hasher.update(body);
    let mut out = [0_u8; 32];
    hasher
        .finalize_variable(&mut out)
        .map_err(|_| DownloadSnapshotError::SchemaCorrupt)?;
    Ok(out)
}

fn validate_snapshot(snapshot: &DownloadJobSnapshot) -> Result<(), DownloadSnapshotError> {
    if snapshot.schema_version != CURRENT_DOWNLOAD_SNAPSHOT_SCHEMA_VERSION {
        if snapshot.schema_version > CURRENT_DOWNLOAD_SNAPSHOT_SCHEMA_VERSION {
            return Err(DownloadSnapshotError::SchemaTooNew {
                found: snapshot.schema_version,
                max_supported: CURRENT_DOWNLOAD_SNAPSHOT_SCHEMA_VERSION,
            });
        }
        return Err(DownloadSnapshotError::SchemaCorrupt);
    }
    if snapshot.lease_token.is_some() {
        return Err(DownloadSnapshotError::SchemaCorrupt);
    }
    let mut plan_totals = BTreeMap::new();
    for entry in &snapshot.plan.entries {
        if entry.tier != ShardTier::Original {
            return Err(DownloadSnapshotError::SchemaCorrupt);
        }
        plan_totals.insert(entry.photo_id.clone(), entry.total_bytes);
    }
    for photo in &snapshot.photos {
        if let Some(total) = plan_totals.get(&photo.photo_id) {
            if photo.bytes_written > *total {
                return Err(DownloadSnapshotError::SchemaCorrupt);
            }
        }
    }
    Ok(())
}

fn decode_snapshot_value(value: &Value) -> Result<DownloadJobSnapshot, DownloadSnapshotError> {
    let Value::Map(entries) = value else {
        return Err(DownloadSnapshotError::SchemaVersionMissing);
    };
    let schema_version = required_u32(entries, download_job_snapshot_keys::SCHEMA_VERSION)
        .ok_or(DownloadSnapshotError::SchemaVersionMissing)?;
    if schema_version > CURRENT_DOWNLOAD_SNAPSHOT_SCHEMA_VERSION {
        return Err(DownloadSnapshotError::SchemaTooNew {
            found: schema_version,
            max_supported: CURRENT_DOWNLOAD_SNAPSHOT_SCHEMA_VERSION,
        });
    }
    // V3 admits two key shapes: with or without the optional `schedule`
    // entry at key 11. We pick the right one by the entries length, then
    // run `validate_exact_keys` for strict positional verification.
    let expected_keys: &[u32] = match schema_version {
        DOWNLOAD_SNAPSHOT_SCHEMA_VERSION_V1 => download_job_snapshot_keys::DOWNLOAD_JOB_KEYS_V1,
        DOWNLOAD_SNAPSHOT_SCHEMA_VERSION_V2 => download_job_snapshot_keys::DOWNLOAD_JOB_KEYS_V2,
        DOWNLOAD_SNAPSHOT_SCHEMA_VERSION_V3 => {
            if entries.len() == download_job_snapshot_keys::DOWNLOAD_JOB_KEYS_V3_WITH_SCHEDULE.len()
            {
                download_job_snapshot_keys::DOWNLOAD_JOB_KEYS_V3_WITH_SCHEDULE
            } else {
                download_job_snapshot_keys::DOWNLOAD_JOB_KEYS_V3_NO_SCHEDULE
            }
        }
        _ => return Err(DownloadSnapshotError::SchemaCorrupt),
    };
    validate_exact_keys(entries, expected_keys)?;
    let job_id = JobId(required_bytes_16(
        entries,
        download_job_snapshot_keys::JOB_ID,
    )?);
    let scope_key = match schema_version {
        DOWNLOAD_SNAPSHOT_SCHEMA_VERSION_V1 => crate::download::scope::legacy_scope_for(&job_id),
        _ => required_text(entries, download_job_snapshot_keys::SCOPE_KEY)?,
    };
    let snapshot = DownloadJobSnapshot {
        // Migration: in-memory snapshots are always normalized to the
        // current schema. Re-encoding a v1/v2 input therefore writes v3.
        schema_version: CURRENT_DOWNLOAD_SNAPSHOT_SCHEMA_VERSION,
        job_id,
        album_id: Uuid::from_bytes(required_bytes_16(
            entries,
            download_job_snapshot_keys::ALBUM_ID,
        )?),
        created_at_ms: required_u64(entries, download_job_snapshot_keys::CREATED_AT_MS)
            .ok_or(DownloadSnapshotError::SchemaCorrupt)?,
        last_updated_at_ms: required_u64(entries, download_job_snapshot_keys::LAST_UPDATED_AT_MS)
            .ok_or(DownloadSnapshotError::SchemaCorrupt)?,
        state: decode_state(
            entry(entries, download_job_snapshot_keys::STATE)
                .ok_or(DownloadSnapshotError::SchemaCorrupt)?,
        )?,
        plan: decode_plan(
            entry(entries, download_job_snapshot_keys::PLAN)
                .ok_or(DownloadSnapshotError::SchemaCorrupt)?,
        )?,
        photos: decode_photos(
            entry(entries, download_job_snapshot_keys::PHOTOS)
                .ok_or(DownloadSnapshotError::SchemaCorrupt)?,
        )?,
        failure_log: decode_failures(
            entry(entries, download_job_snapshot_keys::FAILURE_LOG)
                .ok_or(DownloadSnapshotError::SchemaCorrupt)?,
        )?,
        lease_token: optional_lease(entries, download_job_snapshot_keys::LEASE_TOKEN)?,
        scope_key,
        schedule: match schema_version {
            DOWNLOAD_SNAPSHOT_SCHEMA_VERSION_V3 => {
                match entry(entries, download_job_snapshot_keys::SCHEDULE) {
                    Some(value) => Some(decode_schedule(value)?),
                    None => None,
                }
            }
            // v1 + v2 snapshots predate the schedule field; carry as None.
            _ => None,
        },
    };
    validate_snapshot(&snapshot)?;
    Ok(snapshot)
}

fn state_value(state: &DownloadJobState) -> Value {
    match state {
        DownloadJobState::Errored { reason } => Value::Map(vec![
            kv(0, uint(state.to_u8())),
            kv(1, error_value(*reason)),
        ]),
        DownloadJobState::Cancelled { soft } => {
            Value::Map(vec![kv(0, uint(state.to_u8())), kv(2, Value::Bool(*soft))])
        }
        _ => Value::Map(vec![kv(0, uint(state.to_u8()))]),
    }
}

fn decode_state(value: &Value) -> Result<DownloadJobState, DownloadSnapshotError> {
    let Value::Map(entries) = value else {
        return Err(DownloadSnapshotError::SchemaCorrupt);
    };
    let code = required_u8(entries, 0).ok_or(DownloadSnapshotError::SchemaCorrupt)?;
    match code {
        download_job_state_codes::IDLE => {
            validate_exact_keys(entries, &[0])?;
            Ok(DownloadJobState::Idle)
        }
        download_job_state_codes::PREPARING => {
            validate_exact_keys(entries, &[0])?;
            Ok(DownloadJobState::Preparing)
        }
        download_job_state_codes::RUNNING => {
            validate_exact_keys(entries, &[0])?;
            Ok(DownloadJobState::Running)
        }
        download_job_state_codes::PAUSED => {
            validate_exact_keys(entries, &[0])?;
            Ok(DownloadJobState::Paused)
        }
        download_job_state_codes::FINALIZING => {
            validate_exact_keys(entries, &[0])?;
            Ok(DownloadJobState::Finalizing)
        }
        download_job_state_codes::DONE => {
            validate_exact_keys(entries, &[0])?;
            Ok(DownloadJobState::Done)
        }
        download_job_state_codes::ERRORED => {
            validate_exact_keys(entries, &[0, 1])?;
            Ok(DownloadJobState::Errored {
                reason: decode_error(
                    entry(entries, 1).ok_or(DownloadSnapshotError::SchemaCorrupt)?,
                )?,
            })
        }
        download_job_state_codes::CANCELLED => {
            validate_exact_keys(entries, &[0, 2])?;
            Ok(DownloadJobState::Cancelled {
                soft: required_bool(entries, 2)?,
            })
        }
        _ => Err(DownloadSnapshotError::SchemaCorrupt),
    }
}

fn plan_value(plan: &DownloadPlan) -> Value {
    Value::Array(plan.entries.iter().map(plan_entry_value).collect())
}

fn plan_entry_value(entry: &DownloadPlanEntry) -> Value {
    Value::Map(vec![
        kv(0, Value::Text(entry.photo_id.as_str().to_owned())),
        kv(1, uint(entry.epoch_id)),
        kv(2, uint(entry.tier.to_byte())),
        kv(
            3,
            Value::Array(
                entry
                    .shard_ids
                    .iter()
                    .map(|id| Value::Bytes(id.as_bytes().to_vec()))
                    .collect(),
            ),
        ),
        kv(
            4,
            Value::Array(
                entry
                    .expected_hashes
                    .iter()
                    .map(|hash| Value::Bytes(hash.to_vec()))
                    .collect(),
            ),
        ),
        kv(5, Value::Text(entry.filename.clone())),
        kv(6, uint(entry.total_bytes)),
    ])
}

fn decode_plan(value: &Value) -> Result<DownloadPlan, DownloadSnapshotError> {
    let Value::Array(items) = value else {
        return Err(DownloadSnapshotError::SchemaCorrupt);
    };
    let mut entries = Vec::with_capacity(items.len());
    for item in items {
        let Value::Map(fields) = item else {
            return Err(DownloadSnapshotError::SchemaCorrupt);
        };
        validate_exact_keys(fields, &[0, 1, 2, 3, 4, 5, 6])?;
        let tier = match required_u8(fields, 2).ok_or(DownloadSnapshotError::SchemaCorrupt)? {
            3 => ShardTier::Original,
            _ => return Err(DownloadSnapshotError::SchemaCorrupt),
        };
        let shard_ids =
            decode_shard_ids(entry(fields, 3).ok_or(DownloadSnapshotError::SchemaCorrupt)?)?;
        let expected_hashes =
            decode_hashes(entry(fields, 4).ok_or(DownloadSnapshotError::SchemaCorrupt)?)?;
        if shard_ids.len() != expected_hashes.len() || shard_ids.is_empty() {
            return Err(DownloadSnapshotError::SchemaCorrupt);
        }
        entries.push(DownloadPlanEntry {
            photo_id: PhotoId::new(required_text(fields, 0)?),
            epoch_id: required_u32(fields, 1).ok_or(DownloadSnapshotError::SchemaCorrupt)?,
            tier,
            shard_ids,
            expected_hashes,
            filename: required_text(fields, 5)?,
            total_bytes: required_u64(fields, 6).ok_or(DownloadSnapshotError::SchemaCorrupt)?,
        });
    }
    Ok(DownloadPlan { entries })
}

fn photo_state_value(photo: &PhotoState) -> Value {
    Value::Map(vec![
        kv(0, Value::Text(photo.photo_id.as_str().to_owned())),
        kv(1, photo_status_value(&photo.status)),
        kv(2, uint(photo.bytes_written)),
        kv(3, option_u64(photo.last_attempt_at_ms)),
        kv(4, uint(photo.retry_count)),
    ])
}

fn decode_photos(value: &Value) -> Result<Vec<PhotoState>, DownloadSnapshotError> {
    let Value::Array(items) = value else {
        return Err(DownloadSnapshotError::SchemaCorrupt);
    };
    let mut photos = Vec::with_capacity(items.len());
    for item in items {
        let Value::Map(fields) = item else {
            return Err(DownloadSnapshotError::SchemaCorrupt);
        };
        validate_exact_keys(fields, &[0, 1, 2, 3, 4])?;
        photos.push(PhotoState {
            photo_id: PhotoId::new(required_text(fields, 0)?),
            status: decode_photo_status(
                entry(fields, 1).ok_or(DownloadSnapshotError::SchemaCorrupt)?,
            )?,
            bytes_written: required_u64(fields, 2).ok_or(DownloadSnapshotError::SchemaCorrupt)?,
            last_attempt_at_ms: optional_u64(fields, 3)?,
            retry_count: required_u32(fields, 4).ok_or(DownloadSnapshotError::SchemaCorrupt)?,
        });
    }
    Ok(photos)
}

fn photo_status_value(status: &PhotoStatus) -> Value {
    match status {
        PhotoStatus::Pending => Value::Map(vec![kv(0, uint(0_u8))]),
        PhotoStatus::InFlight => Value::Map(vec![kv(0, uint(1_u8))]),
        PhotoStatus::Done => Value::Map(vec![kv(0, uint(2_u8))]),
        PhotoStatus::Failed { reason } => {
            Value::Map(vec![kv(0, uint(3_u8)), kv(1, error_value(*reason))])
        }
        PhotoStatus::Skipped { reason } => {
            Value::Map(vec![kv(0, uint(4_u8)), kv(2, skip_value(*reason))])
        }
    }
}

fn decode_photo_status(value: &Value) -> Result<PhotoStatus, DownloadSnapshotError> {
    let Value::Map(fields) = value else {
        return Err(DownloadSnapshotError::SchemaCorrupt);
    };
    match required_u8(fields, 0).ok_or(DownloadSnapshotError::SchemaCorrupt)? {
        0 => {
            validate_exact_keys(fields, &[0])?;
            Ok(PhotoStatus::Pending)
        }
        1 => {
            validate_exact_keys(fields, &[0])?;
            Ok(PhotoStatus::InFlight)
        }
        2 => {
            validate_exact_keys(fields, &[0])?;
            Ok(PhotoStatus::Done)
        }
        3 => {
            validate_exact_keys(fields, &[0, 1])?;
            Ok(PhotoStatus::Failed {
                reason: decode_error(
                    entry(fields, 1).ok_or(DownloadSnapshotError::SchemaCorrupt)?,
                )?,
            })
        }
        4 => {
            validate_exact_keys(fields, &[0, 2])?;
            Ok(PhotoStatus::Skipped {
                reason: decode_skip(entry(fields, 2).ok_or(DownloadSnapshotError::SchemaCorrupt)?)?,
            })
        }
        _ => Err(DownloadSnapshotError::SchemaCorrupt),
    }
}

fn failure_value(failure: &DownloadFailureEntry) -> Value {
    Value::Map(vec![
        kv(
            0,
            failure
                .photo_id
                .as_ref()
                .map_or(Value::Null, |id| Value::Text(id.as_str().to_owned())),
        ),
        kv(1, error_value(failure.reason)),
        kv(2, uint(failure.at_ms)),
    ])
}

fn decode_failures(value: &Value) -> Result<Vec<DownloadFailureEntry>, DownloadSnapshotError> {
    let Value::Array(items) = value else {
        return Err(DownloadSnapshotError::SchemaCorrupt);
    };
    let mut failures = Vec::with_capacity(items.len());
    for item in items {
        let Value::Map(fields) = item else {
            return Err(DownloadSnapshotError::SchemaCorrupt);
        };
        validate_exact_keys(fields, &[0, 1, 2])?;
        failures.push(DownloadFailureEntry {
            photo_id: optional_text(fields, 0)?.map(PhotoId::new),
            reason: decode_error(entry(fields, 1).ok_or(DownloadSnapshotError::SchemaCorrupt)?)?,
            at_ms: required_u64(fields, 2).ok_or(DownloadSnapshotError::SchemaCorrupt)?,
        });
    }
    Ok(failures)
}

fn error_value(error: DownloadErrorCode) -> Value {
    uint(match error {
        DownloadErrorCode::TransientNetwork => 0_u8,
        DownloadErrorCode::Integrity => 1,
        DownloadErrorCode::Decrypt => 2,
        DownloadErrorCode::NotFound => 3,
        DownloadErrorCode::AccessRevoked => 4,
        DownloadErrorCode::AuthorizationChanged => 5,
        DownloadErrorCode::Quota => 6,
        DownloadErrorCode::Cancelled => 7,
        DownloadErrorCode::IllegalState => 8,
    })
}

fn decode_error(value: &Value) -> Result<DownloadErrorCode, DownloadSnapshotError> {
    let Value::Integer(integer) = value else {
        return Err(DownloadSnapshotError::SchemaCorrupt);
    };
    match u8::try_from(*integer).map_err(|_| DownloadSnapshotError::SchemaCorrupt)? {
        0 => Ok(DownloadErrorCode::TransientNetwork),
        1 => Ok(DownloadErrorCode::Integrity),
        2 => Ok(DownloadErrorCode::Decrypt),
        3 => Ok(DownloadErrorCode::NotFound),
        4 => Ok(DownloadErrorCode::AccessRevoked),
        5 => Ok(DownloadErrorCode::AuthorizationChanged),
        6 => Ok(DownloadErrorCode::Quota),
        7 => Ok(DownloadErrorCode::Cancelled),
        8 => Ok(DownloadErrorCode::IllegalState),
        _ => Err(DownloadSnapshotError::SchemaCorrupt),
    }
}

fn skip_value(reason: SkipReason) -> Value {
    uint(match reason {
        SkipReason::NotFound => 0_u8,
        SkipReason::UserExcluded => 1,
    })
}
fn decode_skip(value: &Value) -> Result<SkipReason, DownloadSnapshotError> {
    let Value::Integer(integer) = value else {
        return Err(DownloadSnapshotError::SchemaCorrupt);
    };
    match u8::try_from(*integer).map_err(|_| DownloadSnapshotError::SchemaCorrupt)? {
        0 => Ok(SkipReason::NotFound),
        1 => Ok(SkipReason::UserExcluded),
        _ => Err(DownloadSnapshotError::SchemaCorrupt),
    }
}

fn schedule_value(schedule: &DownloadSchedule) -> Value {
    match schedule {
        DownloadSchedule::Wifi { max_delay_ms }
        | DownloadSchedule::WifiCharging { max_delay_ms }
        | DownloadSchedule::Idle { max_delay_ms } => Value::Map(vec![
            kv(download_schedule_keys::KIND, uint(schedule.kind_code())),
            kv(
                download_schedule_keys::MAX_DELAY_MS,
                option_u64(*max_delay_ms),
            ),
        ]),
        DownloadSchedule::Window {
            start_hour,
            end_hour,
            max_delay_ms,
        } => Value::Map(vec![
            kv(download_schedule_keys::KIND, uint(schedule.kind_code())),
            kv(download_schedule_keys::WINDOW_START_HOUR, uint(*start_hour)),
            kv(download_schedule_keys::WINDOW_END_HOUR, uint(*end_hour)),
            kv(
                download_schedule_keys::MAX_DELAY_MS,
                option_u64(*max_delay_ms),
            ),
        ]),
    }
}

fn decode_schedule(value: &Value) -> Result<DownloadSchedule, DownloadSnapshotError> {
    let Value::Map(fields) = value else {
        return Err(DownloadSnapshotError::SchemaCorrupt);
    };
    let kind = required_u8(fields, download_schedule_keys::KIND)
        .ok_or(DownloadSnapshotError::SchemaCorrupt)?;
    match kind {
        download_schedule_kind_codes::WIFI => {
            validate_exact_keys(
                fields,
                &[
                    download_schedule_keys::KIND,
                    download_schedule_keys::MAX_DELAY_MS,
                ],
            )?;
            Ok(DownloadSchedule::Wifi {
                max_delay_ms: optional_u64(fields, download_schedule_keys::MAX_DELAY_MS)?,
            })
        }
        download_schedule_kind_codes::WIFI_CHARGING => {
            validate_exact_keys(
                fields,
                &[
                    download_schedule_keys::KIND,
                    download_schedule_keys::MAX_DELAY_MS,
                ],
            )?;
            Ok(DownloadSchedule::WifiCharging {
                max_delay_ms: optional_u64(fields, download_schedule_keys::MAX_DELAY_MS)?,
            })
        }
        download_schedule_kind_codes::IDLE => {
            validate_exact_keys(
                fields,
                &[
                    download_schedule_keys::KIND,
                    download_schedule_keys::MAX_DELAY_MS,
                ],
            )?;
            Ok(DownloadSchedule::Idle {
                max_delay_ms: optional_u64(fields, download_schedule_keys::MAX_DELAY_MS)?,
            })
        }
        download_schedule_kind_codes::WINDOW => {
            validate_exact_keys(
                fields,
                &[
                    download_schedule_keys::KIND,
                    download_schedule_keys::WINDOW_START_HOUR,
                    download_schedule_keys::WINDOW_END_HOUR,
                    download_schedule_keys::MAX_DELAY_MS,
                ],
            )?;
            let start_hour = required_u8(fields, download_schedule_keys::WINDOW_START_HOUR)
                .ok_or(DownloadSnapshotError::SchemaCorrupt)?;
            let end_hour = required_u8(fields, download_schedule_keys::WINDOW_END_HOUR)
                .ok_or(DownloadSnapshotError::SchemaCorrupt)?;
            if start_hour > 23 || end_hour > 23 {
                return Err(DownloadSnapshotError::SchemaCorrupt);
            }
            Ok(DownloadSchedule::Window {
                start_hour,
                end_hour,
                max_delay_ms: optional_u64(fields, download_schedule_keys::MAX_DELAY_MS)?,
            })
        }
        // IMMEDIATE is not persisted; encountering it on the wire means a
        // peer encoded a redundant schedule. Treat as schema-corrupt to keep
        // the on-disk representation canonical.
        _ => Err(DownloadSnapshotError::SchemaCorrupt),
    }
}

fn kv(key: u32, value: Value) -> (Value, Value) {
    (Value::Integer(Integer::from(key)), value)
}
fn uint<T: Into<u64>>(value: T) -> Value {
    Value::Integer(Integer::from(value.into()))
}
fn option_u64(value: Option<u64>) -> Value {
    value.map_or(Value::Null, uint)
}
fn option_lease(value: Option<LeaseToken>) -> Value {
    value.map_or(Value::Null, |token| Value::Bytes(token.to_vec()))
}

fn entry(entries: &[(Value, Value)], key: u32) -> Option<&Value> {
    entries.iter().find_map(|(candidate, value)| {
        match candidate
            .as_integer()
            .and_then(|integer| u32::try_from(integer).ok())
        {
            Some(found) if found == key => Some(value),
            _ => None,
        }
    })
}
fn has_key(entries: &[(Value, Value)], key: u32) -> bool {
    entry(entries, key).is_some()
}
fn required_u8(entries: &[(Value, Value)], key: u32) -> Option<u8> {
    entry(entries, key)?
        .as_integer()
        .and_then(|integer| u8::try_from(integer).ok())
}
fn required_u32(entries: &[(Value, Value)], key: u32) -> Option<u32> {
    entry(entries, key)?
        .as_integer()
        .and_then(|integer| u32::try_from(integer).ok())
}
fn required_u64(entries: &[(Value, Value)], key: u32) -> Option<u64> {
    entry(entries, key)?
        .as_integer()
        .and_then(|integer| u64::try_from(integer).ok())
}
fn required_bool(entries: &[(Value, Value)], key: u32) -> Result<bool, DownloadSnapshotError> {
    match entry(entries, key).ok_or(DownloadSnapshotError::SchemaCorrupt)? {
        Value::Bool(value) => Ok(*value),
        _ => Err(DownloadSnapshotError::SchemaCorrupt),
    }
}
fn required_text(entries: &[(Value, Value)], key: u32) -> Result<String, DownloadSnapshotError> {
    match entry(entries, key).ok_or(DownloadSnapshotError::SchemaCorrupt)? {
        Value::Text(value) => Ok(value.clone()),
        _ => Err(DownloadSnapshotError::SchemaCorrupt),
    }
}
fn optional_text(
    entries: &[(Value, Value)],
    key: u32,
) -> Result<Option<String>, DownloadSnapshotError> {
    match entry(entries, key).ok_or(DownloadSnapshotError::SchemaCorrupt)? {
        Value::Null => Ok(None),
        Value::Text(value) => Ok(Some(value.clone())),
        _ => Err(DownloadSnapshotError::SchemaCorrupt),
    }
}
fn optional_u64(
    entries: &[(Value, Value)],
    key: u32,
) -> Result<Option<u64>, DownloadSnapshotError> {
    match entry(entries, key).ok_or(DownloadSnapshotError::SchemaCorrupt)? {
        Value::Null => Ok(None),
        Value::Integer(integer) => u64::try_from(*integer)
            .map(Some)
            .map_err(|_| DownloadSnapshotError::SchemaCorrupt),
        _ => Err(DownloadSnapshotError::SchemaCorrupt),
    }
}
fn required_bytes(entries: &[(Value, Value)], key: u32) -> Result<Vec<u8>, DownloadSnapshotError> {
    match entry(entries, key).ok_or(DownloadSnapshotError::SchemaCorrupt)? {
        Value::Bytes(value) => Ok(value.clone()),
        _ => Err(DownloadSnapshotError::SchemaCorrupt),
    }
}
fn required_bytes_16(
    entries: &[(Value, Value)],
    key: u32,
) -> Result<[u8; 16], DownloadSnapshotError> {
    required_bytes(entries, key)?
        .as_slice()
        .try_into()
        .map_err(|_| DownloadSnapshotError::SchemaCorrupt)
}
fn required_bytes_32(
    entries: &[(Value, Value)],
    key: u32,
) -> Result<[u8; 32], DownloadSnapshotError> {
    required_bytes(entries, key)?
        .as_slice()
        .try_into()
        .map_err(|_| DownloadSnapshotError::SchemaCorrupt)
}
fn optional_lease(
    entries: &[(Value, Value)],
    key: u32,
) -> Result<Option<LeaseToken>, DownloadSnapshotError> {
    match entry(entries, key).ok_or(DownloadSnapshotError::SchemaCorrupt)? {
        Value::Null => Ok(None),
        Value::Bytes(value) => value
            .as_slice()
            .try_into()
            .map(Some)
            .map_err(|_| DownloadSnapshotError::SchemaCorrupt),
        _ => Err(DownloadSnapshotError::SchemaCorrupt),
    }
}

fn decode_shard_ids(value: &Value) -> Result<Vec<ShardId>, DownloadSnapshotError> {
    let Value::Array(items) = value else {
        return Err(DownloadSnapshotError::SchemaCorrupt);
    };
    items
        .iter()
        .map(|item| match item {
            Value::Bytes(bytes) => bytes
                .as_slice()
                .try_into()
                .map(ShardId::from_bytes)
                .map_err(|_| DownloadSnapshotError::SchemaCorrupt),
            _ => Err(DownloadSnapshotError::SchemaCorrupt),
        })
        .collect()
}
fn decode_hashes(value: &Value) -> Result<Vec<[u8; 32]>, DownloadSnapshotError> {
    let Value::Array(items) = value else {
        return Err(DownloadSnapshotError::SchemaCorrupt);
    };
    items
        .iter()
        .map(|item| match item {
            Value::Bytes(bytes) => bytes
                .as_slice()
                .try_into()
                .map_err(|_| DownloadSnapshotError::SchemaCorrupt),
            _ => Err(DownloadSnapshotError::SchemaCorrupt),
        })
        .collect()
}

fn validate_exact_keys(
    entries: &[(Value, Value)],
    expected: &[u32],
) -> Result<(), DownloadSnapshotError> {
    if entries.len() != expected.len() {
        return Err(DownloadSnapshotError::SchemaCorrupt);
    }
    for (index, expected_key) in expected.iter().enumerate() {
        let Some((Value::Integer(integer), _)) = entries.get(index) else {
            return Err(DownloadSnapshotError::ForbiddenField);
        };
        let found = u32::try_from(*integer).map_err(|_| DownloadSnapshotError::SchemaCorrupt)?;
        if found != *expected_key {
            return Err(DownloadSnapshotError::SchemaCorrupt);
        }
    }
    Ok(())
}

fn validate_cbor_value(value: &Value, depth: usize) -> Result<(), DownloadSnapshotError> {
    if depth > 64 {
        return Err(DownloadSnapshotError::SchemaCorrupt);
    }
    match value {
        Value::Integer(_) | Value::Bytes(_) | Value::Bool(_) | Value::Null => Ok(()),
        Value::Float(_) | Value::Tag(_, _) => Err(DownloadSnapshotError::ForbiddenField),
        Value::Text(_) => Ok(()),
        Value::Array(items) => items
            .iter()
            .try_for_each(|item| validate_cbor_value(item, depth + 1)),
        Value::Map(entries) => {
            let mut previous = None;
            for (key, item) in entries {
                let Value::Integer(integer) = key else {
                    return Err(DownloadSnapshotError::ForbiddenField);
                };
                let found =
                    u32::try_from(*integer).map_err(|_| DownloadSnapshotError::SchemaCorrupt)?;
                if previous.is_some_and(|prior| prior >= found) {
                    return Err(DownloadSnapshotError::SchemaCorrupt);
                }
                previous = Some(found);
                validate_cbor_value(item, depth + 1)?;
            }
            Ok(())
        }
        _ => Err(DownloadSnapshotError::SchemaCorrupt),
    }
}
