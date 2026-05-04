use std::borrow::Borrow;
use std::fmt;

use ciborium::value::{Integer, Value};

use crate::snapshot_schema::{
    self, SNAPSHOT_SCHEMA_VERSION_V1, SnapshotMigrationError, upload_job_phase_codes,
    upload_job_snapshot_keys,
};
use crate::{ClientError, ClientErrorCode};

pub const CLIENT_CORE_SNAPSHOT_SCHEMA_VERSION: u16 = SNAPSHOT_SCHEMA_VERSION_V1;
pub const MAX_RETRY_COUNT_LIMIT: u8 = 64;
const MIN_RETRY_DELAY_MS: u64 = 1_000;
const MAX_RETRY_DELAY_MS: u64 = 300_000;
const MAX_TIERED_SHARDS: usize = 10_000;
const MAX_UPLOAD_SNAPSHOT_CBOR_BYTES: usize = 1_500_000;
// R-Cl1.1 legacy snapshots used reserved key 14 for upload retry targets.
const LEGACY_UPLOAD_RETRY_TARGET_PHASE_KEY: u32 = 14;

#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Uuid([u8; 16]);

impl Uuid {
    #[must_use]
    pub const fn from_bytes(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }

    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }

    #[must_use]
    pub fn is_uuid_v7(&self) -> bool {
        (self.0[6] >> 4) == 0x7 && (self.0[8] & 0xc0) == 0x80
    }
}

impl fmt::Debug for Uuid {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Uuid(<v7:{}>)", self.is_uuid_v7())
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct UploadJobRequest {
    pub job_id: Uuid,
    pub album_id: Uuid,
    pub asset_id: Uuid,
    pub idempotency_key: Uuid,
    pub max_retry_count: u8,
}

impl fmt::Debug for UploadJobRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UploadJobRequest")
            .field("job_id", &self.job_id)
            .field("album_id", &self.album_id)
            .field("asset_id", &self.asset_id)
            .field("idempotency_key", &self.idempotency_key)
            .field("max_retry_count", &self.max_retry_count)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct UploadJobSnapshot {
    pub schema_version: u16,
    pub job_id: Uuid,
    pub album_id: Uuid,
    pub phase: UploadJobPhase,
    pub retry_count: u8,
    pub max_retry_count: u8,
    pub next_retry_not_before_ms: Option<i64>,
    pub idempotency_key: Uuid,
    pub tiered_shards: Vec<UploadShardRef>,
    pub shard_set_hash: Option<[u8; 32]>,
    pub snapshot_revision: u64,
    pub last_acknowledged_effect_id: Option<Uuid>,
    pub last_applied_event_id: Option<Uuid>,
    pub failure_code: Option<ClientErrorCode>,
}

impl fmt::Debug for UploadJobSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UploadJobSnapshot")
            .field("schema_version", &self.schema_version)
            .field("job_id", &self.job_id)
            .field("album_id", &self.album_id)
            .field("phase", &self.phase)
            .field("retry_count", &self.retry_count)
            .field("max_retry_count", &self.max_retry_count)
            .field("next_retry_not_before_ms", &self.next_retry_not_before_ms)
            .field("idempotency_key", &self.idempotency_key)
            .field("tiered_shards", &self.tiered_shards)
            .field("shard_set_hash", &self.shard_set_hash.map(|_| "<sha256>"))
            .field("snapshot_revision", &self.snapshot_revision)
            .field(
                "last_acknowledged_effect_id",
                &self.last_acknowledged_effect_id,
            )
            .field("last_applied_event_id", &self.last_applied_event_id)
            .field("failure_code", &self.failure_code)
            .finish()
    }
}

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum UploadJobPhase {
    Queued = upload_job_phase_codes::QUEUED,
    AwaitingPreparedMedia = upload_job_phase_codes::AWAITING_PREPARED_MEDIA,
    AwaitingEpochHandle = upload_job_phase_codes::AWAITING_EPOCH_HANDLE,
    EncryptingShard = upload_job_phase_codes::ENCRYPTING_SHARD,
    CreatingShardUpload = upload_job_phase_codes::CREATING_SHARD_UPLOAD,
    UploadingShard = upload_job_phase_codes::UPLOADING_SHARD,
    CreatingManifest = upload_job_phase_codes::CREATING_MANIFEST,
    ManifestCommitUnknown = upload_job_phase_codes::MANIFEST_COMMIT_UNKNOWN,
    AwaitingSyncConfirmation = upload_job_phase_codes::AWAITING_SYNC_CONFIRMATION,
    RetryWaiting = upload_job_phase_codes::RETRY_WAITING,
    Confirmed = upload_job_phase_codes::CONFIRMED,
    Cancelled = upload_job_phase_codes::CANCELLED,
    Failed = upload_job_phase_codes::FAILED,
}

impl UploadJobPhase {
    #[must_use]
    pub const fn to_u8(self) -> u8 {
        self as u8
    }

    pub const fn try_from_u8(value: u8) -> Option<Self> {
        match value {
            upload_job_phase_codes::QUEUED => Some(Self::Queued),
            upload_job_phase_codes::AWAITING_PREPARED_MEDIA => Some(Self::AwaitingPreparedMedia),
            upload_job_phase_codes::AWAITING_EPOCH_HANDLE => Some(Self::AwaitingEpochHandle),
            upload_job_phase_codes::ENCRYPTING_SHARD => Some(Self::EncryptingShard),
            upload_job_phase_codes::CREATING_SHARD_UPLOAD => Some(Self::CreatingShardUpload),
            upload_job_phase_codes::UPLOADING_SHARD => Some(Self::UploadingShard),
            upload_job_phase_codes::CREATING_MANIFEST => Some(Self::CreatingManifest),
            upload_job_phase_codes::MANIFEST_COMMIT_UNKNOWN => Some(Self::ManifestCommitUnknown),
            upload_job_phase_codes::AWAITING_SYNC_CONFIRMATION => {
                Some(Self::AwaitingSyncConfirmation)
            }
            upload_job_phase_codes::RETRY_WAITING => Some(Self::RetryWaiting),
            upload_job_phase_codes::CONFIRMED => Some(Self::Confirmed),
            upload_job_phase_codes::CANCELLED => Some(Self::Cancelled),
            upload_job_phase_codes::FAILED => Some(Self::Failed),
            _ => None,
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct UploadShardRef {
    pub tier: u8,
    pub shard_index: u32,
    pub shard_id: Uuid,
    pub sha256: [u8; 32],
    pub content_length: u64,
    pub envelope_version: u8,
    pub uploaded: bool,
}

impl fmt::Debug for UploadShardRef {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UploadShardRef")
            .field("tier", &self.tier)
            .field("shard_index", &self.shard_index)
            .field("shard_id", &self.shard_id)
            .field("sha256", &"<sha256>")
            .field("content_length", &self.content_length)
            .field("envelope_version", &self.envelope_version)
            .field("uploaded", &self.uploaded)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupStagingReason {
    UserCancelled,
    AlbumDeleted,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManifestRecoveryOutcome {
    Match,
    ShardSetConflict,
    NotFoundTimedOut,
    IdempotencyExpired,
}

#[derive(Clone, PartialEq, Eq)]
pub enum UploadJobEffect {
    PrepareMedia {
        effect_id: Uuid,
    },
    AcquireEpochHandle {
        effect_id: Uuid,
    },
    EncryptShard {
        effect_id: Uuid,
        tier: u8,
        shard_index: u32,
    },
    CreateShardUpload {
        effect_id: Uuid,
        shard: UploadShardRef,
    },
    UploadShard {
        effect_id: Uuid,
        shard: UploadShardRef,
    },
    CreateManifest {
        effect_id: Uuid,
        idempotency_key: Uuid,
        tiered_shards: Vec<UploadShardRef>,
        shard_set_hash: Option<[u8; 32]>,
    },
    AwaitSyncConfirmation {
        effect_id: Uuid,
    },
    RecoverManifestThroughSync {
        effect_id: Uuid,
        asset_id: Uuid,
        since_metadata_version: u64,
        shard_set_hash: Option<[u8; 32]>,
    },
    ScheduleRetry {
        effect_id: Uuid,
        attempt: u8,
        not_before_ms: i64,
        target_phase: UploadJobPhase,
    },
    CleanupStaging {
        effect_id: Uuid,
        reason: CleanupStagingReason,
    },
}

impl fmt::Debug for UploadJobEffect {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PrepareMedia { effect_id } => formatter
                .debug_struct("PrepareMedia")
                .field("effect_id", effect_id)
                .finish(),
            Self::AcquireEpochHandle { effect_id } => formatter
                .debug_struct("AcquireEpochHandle")
                .field("effect_id", effect_id)
                .finish(),
            Self::EncryptShard {
                effect_id,
                tier,
                shard_index,
            } => formatter
                .debug_struct("EncryptShard")
                .field("effect_id", effect_id)
                .field("tier", tier)
                .field("shard_index", shard_index)
                .finish(),
            Self::CreateShardUpload { effect_id, shard } => formatter
                .debug_struct("CreateShardUpload")
                .field("effect_id", effect_id)
                .field("shard", shard)
                .finish(),
            Self::UploadShard { effect_id, shard } => formatter
                .debug_struct("UploadShard")
                .field("effect_id", effect_id)
                .field("shard", shard)
                .finish(),
            Self::CreateManifest {
                effect_id,
                idempotency_key,
                tiered_shards,
                shard_set_hash,
            } => formatter
                .debug_struct("CreateManifest")
                .field("effect_id", effect_id)
                .field("idempotency_key", idempotency_key)
                .field("tiered_shards", tiered_shards)
                .field("shard_set_hash", &shard_set_hash.map(|_| "<sha256>"))
                .finish(),
            Self::AwaitSyncConfirmation { effect_id } => formatter
                .debug_struct("AwaitSyncConfirmation")
                .field("effect_id", effect_id)
                .finish(),
            Self::RecoverManifestThroughSync {
                effect_id,
                asset_id,
                since_metadata_version,
                shard_set_hash,
            } => formatter
                .debug_struct("RecoverManifestThroughSync")
                .field("effect_id", effect_id)
                .field("asset_id", asset_id)
                .field("since_metadata_version", since_metadata_version)
                .field("shard_set_hash", &shard_set_hash.map(|_| "<sha256>"))
                .finish(),
            Self::ScheduleRetry {
                effect_id,
                attempt,
                not_before_ms,
                target_phase,
            } => formatter
                .debug_struct("ScheduleRetry")
                .field("effect_id", effect_id)
                .field("attempt", attempt)
                .field("not_before_ms", not_before_ms)
                .field("target_phase", target_phase)
                .finish(),
            Self::CleanupStaging { effect_id, reason } => formatter
                .debug_struct("CleanupStaging")
                .field("effect_id", effect_id)
                .field("reason", reason)
                .finish(),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub enum UploadJobEvent {
    StartRequested {
        effect_id: Uuid,
    },
    MediaPrepared {
        effect_id: Uuid,
        tiered_shards: Vec<UploadShardRef>,
        shard_set_hash: Option<[u8; 32]>,
    },
    EpochHandleAcquired {
        effect_id: Uuid,
    },
    ShardEncrypted {
        effect_id: Uuid,
        shard: UploadShardRef,
    },
    ShardUploadCreated {
        effect_id: Uuid,
        shard: UploadShardRef,
    },
    ShardUploaded {
        effect_id: Uuid,
        shard: UploadShardRef,
    },
    ManifestCreated {
        effect_id: Uuid,
    },
    ManifestOutcomeUnknown {
        effect_id: Uuid,
        asset_id: Uuid,
        since_metadata_version: u64,
    },
    ManifestRecoveryResolved {
        effect_id: Uuid,
        outcome: ManifestRecoveryOutcome,
        now_ms: i64,
        base_backoff_ms: u64,
        server_retry_after_ms: Option<u64>,
    },
    SyncConfirmed {
        effect_id: Uuid,
    },
    EffectAck {
        effect_id: Uuid,
    },
    RetryableFailure {
        effect_id: Uuid,
        code: ClientErrorCode,
        now_ms: i64,
        base_backoff_ms: u64,
        server_retry_after_ms: Option<u64>,
    },
    RetryTimerElapsed {
        effect_id: Uuid,
        target_phase: UploadJobPhase,
    },
    CancelRequested {
        effect_id: Uuid,
    },
    AlbumDeleted {
        effect_id: Uuid,
    },
    NonRetryableFailure {
        effect_id: Uuid,
        code: ClientErrorCode,
    },
    IdempotencyExpired {
        effect_id: Uuid,
    },
}

impl fmt::Debug for UploadJobEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::StartRequested { effect_id } => formatter
                .debug_struct("StartRequested")
                .field("effect_id", effect_id)
                .finish(),
            Self::MediaPrepared {
                effect_id,
                tiered_shards,
                shard_set_hash,
            } => formatter
                .debug_struct("MediaPrepared")
                .field("effect_id", effect_id)
                .field("tiered_shards", tiered_shards)
                .field("shard_set_hash", &shard_set_hash.map(|_| "<sha256>"))
                .finish(),
            Self::EpochHandleAcquired { effect_id } => formatter
                .debug_struct("EpochHandleAcquired")
                .field("effect_id", effect_id)
                .finish(),
            Self::ShardEncrypted { effect_id, shard } => formatter
                .debug_struct("ShardEncrypted")
                .field("effect_id", effect_id)
                .field("shard", shard)
                .finish(),
            Self::ShardUploadCreated { effect_id, shard } => formatter
                .debug_struct("ShardUploadCreated")
                .field("effect_id", effect_id)
                .field("shard", shard)
                .finish(),
            Self::ShardUploaded { effect_id, shard } => formatter
                .debug_struct("ShardUploaded")
                .field("effect_id", effect_id)
                .field("shard", shard)
                .finish(),
            Self::ManifestCreated { effect_id } => formatter
                .debug_struct("ManifestCreated")
                .field("effect_id", effect_id)
                .finish(),
            Self::ManifestOutcomeUnknown {
                effect_id,
                asset_id,
                since_metadata_version,
            } => formatter
                .debug_struct("ManifestOutcomeUnknown")
                .field("effect_id", effect_id)
                .field("asset_id", asset_id)
                .field("since_metadata_version", since_metadata_version)
                .finish(),
            Self::ManifestRecoveryResolved {
                effect_id,
                outcome,
                now_ms,
                base_backoff_ms,
                server_retry_after_ms,
            } => formatter
                .debug_struct("ManifestRecoveryResolved")
                .field("effect_id", effect_id)
                .field("outcome", outcome)
                .field("now_ms", now_ms)
                .field("base_backoff_ms", base_backoff_ms)
                .field("server_retry_after_ms", server_retry_after_ms)
                .finish(),
            Self::SyncConfirmed { effect_id } => formatter
                .debug_struct("SyncConfirmed")
                .field("effect_id", effect_id)
                .finish(),
            Self::EffectAck { effect_id } => formatter
                .debug_struct("EffectAck")
                .field("effect_id", effect_id)
                .finish(),
            Self::RetryableFailure {
                effect_id,
                code,
                now_ms,
                base_backoff_ms,
                server_retry_after_ms,
            } => formatter
                .debug_struct("RetryableFailure")
                .field("effect_id", effect_id)
                .field("code", code)
                .field("now_ms", now_ms)
                .field("base_backoff_ms", base_backoff_ms)
                .field("server_retry_after_ms", server_retry_after_ms)
                .finish(),
            Self::RetryTimerElapsed {
                effect_id,
                target_phase,
            } => formatter
                .debug_struct("RetryTimerElapsed")
                .field("effect_id", effect_id)
                .field("target_phase", target_phase)
                .finish(),
            Self::CancelRequested { effect_id } => formatter
                .debug_struct("CancelRequested")
                .field("effect_id", effect_id)
                .finish(),
            Self::AlbumDeleted { effect_id } => formatter
                .debug_struct("AlbumDeleted")
                .field("effect_id", effect_id)
                .finish(),
            Self::NonRetryableFailure { effect_id, code } => formatter
                .debug_struct("NonRetryableFailure")
                .field("effect_id", effect_id)
                .field("code", code)
                .finish(),
            Self::IdempotencyExpired { effect_id } => formatter
                .debug_struct("IdempotencyExpired")
                .field("effect_id", effect_id)
                .finish(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadJobTransition {
    pub next_snapshot: UploadJobSnapshot,
    pub effects: Vec<UploadJobEffect>,
}

#[must_use]
pub const fn upload_snapshot_schema_version() -> u16 {
    CLIENT_CORE_SNAPSHOT_SCHEMA_VERSION
}

pub fn new_upload_job(request: UploadJobRequest) -> Result<UploadJobSnapshot, ClientError> {
    validate_uuid_v7(request.job_id)?;
    validate_uuid_v7(request.album_id)?;
    validate_uuid_v7(request.asset_id)?;
    validate_uuid_v7(request.idempotency_key)?;
    validate_retry_bounds(0, request.max_retry_count)?;
    Ok(UploadJobSnapshot {
        schema_version: SNAPSHOT_SCHEMA_VERSION_V1,
        job_id: request.job_id,
        album_id: request.album_id,
        phase: UploadJobPhase::Queued,
        retry_count: 0,
        max_retry_count: request.max_retry_count,
        next_retry_not_before_ms: None,
        idempotency_key: request.idempotency_key,
        tiered_shards: Vec::new(),
        shard_set_hash: None,
        snapshot_revision: 0,
        last_acknowledged_effect_id: None,
        last_applied_event_id: None,
        failure_code: None,
    })
}

pub fn advance_upload_job<S>(
    snapshot: S,
    event: UploadJobEvent,
) -> Result<UploadJobTransition, ClientError>
where
    S: Borrow<UploadJobSnapshot>,
{
    let snapshot = snapshot.borrow();
    validate_upload_snapshot(snapshot)?;
    let event_effect_id = event.effect_id();
    validate_uuid_v7(event_effect_id)?;
    if matches!(event, UploadJobEvent::EffectAck { .. }) {
        return acknowledge_effect(snapshot, event_effect_id);
    }
    if Some(event_effect_id) == snapshot.last_applied_event_id {
        return Ok(upload_transition(snapshot.clone(), Vec::new()));
    }
    match event {
        UploadJobEvent::StartRequested { effect_id } => transition_to(
            snapshot,
            UploadJobPhase::Queued,
            UploadJobPhase::AwaitingPreparedMedia,
            effect_id,
            vec![UploadJobEffect::PrepareMedia { effect_id }],
        ),
        UploadJobEvent::MediaPrepared {
            effect_id,
            tiered_shards,
            shard_set_hash,
        } => {
            require_upload_phase(snapshot.phase, UploadJobPhase::AwaitingPreparedMedia)?;
            if tiered_shards.is_empty() {
                return Err(invalid_snapshot_error("snapshot validation failed"));
            }
            validate_tiered_shards(&tiered_shards)?;
            let mut next = base_next(snapshot, effect_id);
            next.phase = UploadJobPhase::AwaitingEpochHandle;
            next.tiered_shards = tiered_shards;
            next.shard_set_hash = shard_set_hash;
            reset_retry(&mut next);
            Ok(upload_transition(
                next,
                vec![UploadJobEffect::AcquireEpochHandle { effect_id }],
            ))
        }
        UploadJobEvent::EpochHandleAcquired { effect_id } => {
            require_upload_phase(snapshot.phase, UploadJobPhase::AwaitingEpochHandle)?;
            let mut next = base_next(snapshot, effect_id);
            next.phase = UploadJobPhase::EncryptingShard;
            reset_retry(&mut next);
            let Some(first) = next
                .tiered_shards
                .iter()
                .find(|shard| !shard.uploaded)
                .cloned()
            else {
                return Err(invalid_snapshot_error("snapshot validation failed"));
            };
            Ok(upload_transition(
                next,
                vec![UploadJobEffect::EncryptShard {
                    effect_id,
                    tier: first.tier,
                    shard_index: first.shard_index,
                }],
            ))
        }
        UploadJobEvent::ShardEncrypted { effect_id, shard } => shard_step(
            snapshot,
            effect_id,
            shard,
            UploadJobPhase::EncryptingShard,
            UploadJobPhase::CreatingShardUpload,
            |effect_id, shard| UploadJobEffect::CreateShardUpload { effect_id, shard },
        ),
        UploadJobEvent::ShardUploadCreated { effect_id, shard } => shard_step(
            snapshot,
            effect_id,
            shard,
            UploadJobPhase::CreatingShardUpload,
            UploadJobPhase::UploadingShard,
            |effect_id, shard| UploadJobEffect::UploadShard { effect_id, shard },
        ),
        UploadJobEvent::ShardUploaded { effect_id, shard } => {
            require_upload_phase(snapshot.phase, UploadJobPhase::UploadingShard)?;
            validate_upload_shard_ref(&shard)?;
            let mut next = base_next(snapshot, effect_id);
            mark_uploaded(&mut next, &shard)?;
            reset_retry(&mut next);
            if let Some(next_shard) = next
                .tiered_shards
                .iter()
                .find(|candidate| !candidate.uploaded)
                .cloned()
            {
                next.phase = UploadJobPhase::EncryptingShard;
                Ok(upload_transition(
                    next,
                    vec![UploadJobEffect::EncryptShard {
                        effect_id,
                        tier: next_shard.tier,
                        shard_index: next_shard.shard_index,
                    }],
                ))
            } else {
                next.phase = UploadJobPhase::CreatingManifest;
                Ok(upload_transition(
                    next.clone(),
                    vec![UploadJobEffect::CreateManifest {
                        effect_id,
                        idempotency_key: next.idempotency_key,
                        tiered_shards: next.tiered_shards,
                        shard_set_hash: next.shard_set_hash,
                    }],
                ))
            }
        }
        UploadJobEvent::ManifestCreated { effect_id } => transition_to(
            snapshot,
            UploadJobPhase::CreatingManifest,
            UploadJobPhase::AwaitingSyncConfirmation,
            effect_id,
            vec![UploadJobEffect::AwaitSyncConfirmation { effect_id }],
        ),
        UploadJobEvent::ManifestOutcomeUnknown {
            effect_id,
            asset_id,
            since_metadata_version,
        } => manifest_unknown(snapshot, effect_id, asset_id, since_metadata_version),
        UploadJobEvent::ManifestRecoveryResolved {
            effect_id,
            outcome,
            now_ms,
            base_backoff_ms,
            server_retry_after_ms,
        } => manifest_recovery(
            snapshot,
            effect_id,
            outcome,
            now_ms,
            base_backoff_ms,
            server_retry_after_ms,
        ),
        UploadJobEvent::SyncConfirmed { effect_id } => {
            if !matches!(
                snapshot.phase,
                UploadJobPhase::AwaitingSyncConfirmation | UploadJobPhase::ManifestCommitUnknown
            ) {
                return Err(invalid_transition_error("invalid state transition"));
            }
            let mut next = base_next(snapshot, effect_id);
            next.phase = UploadJobPhase::Confirmed;
            reset_retry(&mut next);
            Ok(upload_transition(next, Vec::new()))
        }
        UploadJobEvent::EffectAck { .. } => {
            unreachable!("EffectAck is handled before replay dedup")
        }
        UploadJobEvent::RetryableFailure {
            effect_id,
            code,
            now_ms,
            base_backoff_ms,
            server_retry_after_ms,
        } => retryable_failure(
            snapshot,
            effect_id,
            code,
            now_ms,
            base_backoff_ms,
            server_retry_after_ms,
        ),
        UploadJobEvent::RetryTimerElapsed {
            effect_id,
            target_phase,
        } => {
            require_upload_phase(snapshot.phase, UploadJobPhase::RetryWaiting)?;
            if upload_phase_is_terminal(target_phase) {
                return Err(invalid_transition_error("invalid state transition"));
            }
            let mut next = base_next(snapshot, effect_id);
            next.phase = target_phase;
            next.next_retry_not_before_ms = None;
            let effects = retry_resume_effects(&next, effect_id, target_phase)?;
            Ok(upload_transition(next, effects))
        }
        UploadJobEvent::CancelRequested { effect_id } => cleanup_cancel(
            snapshot,
            effect_id,
            ClientErrorCode::OperationCancelled,
            CleanupStagingReason::UserCancelled,
        ),
        UploadJobEvent::AlbumDeleted { effect_id } => cleanup_cancel(
            snapshot,
            effect_id,
            ClientErrorCode::OperationCancelled,
            CleanupStagingReason::AlbumDeleted,
        ),
        UploadJobEvent::NonRetryableFailure { effect_id, code } => {
            failed(snapshot, effect_id, code, CleanupStagingReason::Failed)
        }
        UploadJobEvent::IdempotencyExpired { effect_id } => failed(
            snapshot,
            effect_id,
            ClientErrorCode::IdempotencyExpired,
            CleanupStagingReason::Failed,
        ),
    }
}

#[must_use]
pub fn next_retry_delay_ms(
    base_backoff_ms: u64,
    attempt: u8,
    server_retry_after_ms: Option<u64>,
) -> u64 {
    let computed = base_backoff_ms.saturating_mul(2_u64.saturating_pow(u32::from(attempt)));
    server_retry_after_ms
        .unwrap_or(0)
        .max(computed)
        .clamp(MIN_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS)
}

impl UploadJobEvent {
    #[must_use]
    pub const fn effect_id(&self) -> Uuid {
        match self {
            Self::StartRequested { effect_id }
            | Self::MediaPrepared { effect_id, .. }
            | Self::EpochHandleAcquired { effect_id }
            | Self::ShardEncrypted { effect_id, .. }
            | Self::ShardUploadCreated { effect_id, .. }
            | Self::ShardUploaded { effect_id, .. }
            | Self::ManifestCreated { effect_id }
            | Self::ManifestOutcomeUnknown { effect_id, .. }
            | Self::ManifestRecoveryResolved { effect_id, .. }
            | Self::SyncConfirmed { effect_id }
            | Self::EffectAck { effect_id }
            | Self::RetryableFailure { effect_id, .. }
            | Self::RetryTimerElapsed { effect_id, .. }
            | Self::CancelRequested { effect_id }
            | Self::AlbumDeleted { effect_id }
            | Self::NonRetryableFailure { effect_id, .. }
            | Self::IdempotencyExpired { effect_id } => *effect_id,
        }
    }
}

impl UploadJobSnapshot {
    #[must_use]
    pub fn to_canonical_cbor(&self) -> Vec<u8> {
        match self.try_to_canonical_cbor() {
            Ok(bytes) => bytes,
            Err(error) => {
                debug_assert!(
                    false,
                    "in-memory UploadJobSnapshot failed CBOR encoding: {error:?}"
                );
                vec![0xff]
            }
        }
    }

    pub fn try_to_canonical_cbor(&self) -> Result<Vec<u8>, SnapshotMigrationError> {
        let value = Value::Map(vec![
            kv(
                upload_job_snapshot_keys::SCHEMA_VERSION,
                uint(self.schema_version),
            ),
            kv(upload_job_snapshot_keys::JOB_ID, uuid_value(self.job_id)),
            kv(
                upload_job_snapshot_keys::ALBUM_ID,
                uuid_value(self.album_id),
            ),
            kv(upload_job_snapshot_keys::PHASE, uint(self.phase.to_u8())),
            kv(
                upload_job_snapshot_keys::RETRY_COUNT,
                uint(self.retry_count),
            ),
            kv(
                upload_job_snapshot_keys::MAX_RETRY_COUNT,
                uint(self.max_retry_count),
            ),
            kv(
                upload_job_snapshot_keys::NEXT_RETRY_NOT_BEFORE_MS,
                option_i64(self.next_retry_not_before_ms),
            ),
            kv(
                upload_job_snapshot_keys::IDEMPOTENCY_KEY,
                uuid_value(self.idempotency_key),
            ),
            kv(
                upload_job_snapshot_keys::TIERED_SHARDS,
                Value::Array(self.tiered_shards.iter().map(shard_value).collect()),
            ),
            kv(
                upload_job_snapshot_keys::SHARD_SET_HASH,
                option_bytes_32(self.shard_set_hash),
            ),
            kv(
                upload_job_snapshot_keys::SNAPSHOT_REVISION,
                uint(self.snapshot_revision),
            ),
            kv(
                upload_job_snapshot_keys::LAST_ACKNOWLEDGED_EFFECT_ID,
                option_uuid(self.last_acknowledged_effect_id),
            ),
            kv(
                upload_job_snapshot_keys::LAST_APPLIED_EVENT_ID,
                option_uuid(self.last_applied_event_id),
            ),
            kv(
                upload_job_snapshot_keys::FAILURE_CODE,
                option_client_error_code(self.failure_code),
            ),
        ]);
        let mut bytes = Vec::new();
        ciborium::ser::into_writer(&value, &mut bytes)
            .map_err(|_| SnapshotMigrationError::SchemaCorrupt)?;
        Ok(bytes)
    }

    pub fn from_canonical_cbor(bytes: &[u8]) -> Result<Self, SnapshotMigrationError> {
        if bytes.len() > MAX_UPLOAD_SNAPSHOT_CBOR_BYTES {
            return Err(SnapshotMigrationError::SchemaCorrupt);
        }
        let value: Value = ciborium::de::from_reader(std::io::Cursor::new(bytes))
            .map_err(|_| SnapshotMigrationError::CborDecodeFailed)?;
        validate_cbor_value(&value, 0)?;
        let decoded = decode_upload_snapshot_value(&value)?;
        if decoded.snapshot.to_canonical_cbor() != bytes && !decoded.migrated_legacy_retry_target {
            return Err(SnapshotMigrationError::SchemaCorrupt);
        }
        Ok(decoded.snapshot)
    }
}

fn transition_to(
    snapshot: &UploadJobSnapshot,
    from: UploadJobPhase,
    to: UploadJobPhase,
    effect_id: Uuid,
    effects: Vec<UploadJobEffect>,
) -> Result<UploadJobTransition, ClientError> {
    require_upload_phase(snapshot.phase, from)?;
    let mut next = base_next(snapshot, effect_id);
    next.phase = to;
    reset_retry(&mut next);
    Ok(upload_transition(next, effects))
}

fn shard_step<F>(
    snapshot: &UploadJobSnapshot,
    effect_id: Uuid,
    shard: UploadShardRef,
    from: UploadJobPhase,
    to: UploadJobPhase,
    effect: F,
) -> Result<UploadJobTransition, ClientError>
where
    F: FnOnce(Uuid, UploadShardRef) -> UploadJobEffect,
{
    require_upload_phase(snapshot.phase, from)?;
    validate_upload_shard_ref(&shard)?;
    let mut next = base_next(snapshot, effect_id);
    next.phase = to;
    upsert_shard(&mut next, shard.clone())?;
    reset_retry(&mut next);
    Ok(upload_transition(next, vec![effect(effect_id, shard)]))
}

fn manifest_unknown(
    snapshot: &UploadJobSnapshot,
    effect_id: Uuid,
    asset_id: Uuid,
    since_metadata_version: u64,
) -> Result<UploadJobTransition, ClientError> {
    if !matches!(
        snapshot.phase,
        UploadJobPhase::CreatingManifest | UploadJobPhase::ManifestCommitUnknown
    ) {
        return Err(invalid_transition_error("invalid state transition"));
    }
    let mut next = base_next(snapshot, effect_id);
    next.phase = UploadJobPhase::ManifestCommitUnknown;
    Ok(upload_transition(
        next,
        vec![UploadJobEffect::RecoverManifestThroughSync {
            effect_id,
            asset_id,
            since_metadata_version,
            shard_set_hash: snapshot.shard_set_hash,
        }],
    ))
}

fn manifest_recovery(
    snapshot: &UploadJobSnapshot,
    effect_id: Uuid,
    outcome: ManifestRecoveryOutcome,
    now_ms: i64,
    base_backoff_ms: u64,
    server_retry_after_ms: Option<u64>,
) -> Result<UploadJobTransition, ClientError> {
    require_upload_phase(snapshot.phase, UploadJobPhase::ManifestCommitUnknown)?;
    match outcome {
        ManifestRecoveryOutcome::Match => {
            let mut next = base_next(snapshot, effect_id);
            next.phase = UploadJobPhase::Confirmed;
            reset_retry(&mut next);
            Ok(upload_transition(next, Vec::new()))
        }
        ManifestRecoveryOutcome::ShardSetConflict => failed(
            snapshot,
            effect_id,
            ClientErrorCode::ManifestSetConflict,
            CleanupStagingReason::Failed,
        ),
        ManifestRecoveryOutcome::IdempotencyExpired => failed(
            snapshot,
            effect_id,
            ClientErrorCode::IdempotencyExpired,
            CleanupStagingReason::Failed,
        ),
        ManifestRecoveryOutcome::NotFoundTimedOut => schedule_manifest_retry(
            snapshot,
            effect_id,
            now_ms,
            base_backoff_ms,
            server_retry_after_ms,
        ),
    }
}

fn retryable_failure(
    snapshot: &UploadJobSnapshot,
    effect_id: Uuid,
    code: ClientErrorCode,
    now_ms: i64,
    base_backoff_ms: u64,
    server_retry_after_ms: Option<u64>,
) -> Result<UploadJobTransition, ClientError> {
    if !upload_phase_allows_retry(snapshot.phase) {
        return Err(invalid_transition_error("invalid state transition"));
    }
    if snapshot.retry_count >= snapshot.max_retry_count {
        let mut transition = failed(
            snapshot,
            effect_id,
            ClientErrorCode::ClientCoreRetryBudgetExhausted,
            CleanupStagingReason::Failed,
        )?;
        transition.next_snapshot.failure_code = Some(code);
        return Ok(transition);
    }
    let target = snapshot.phase;
    let mut next = base_next(snapshot, effect_id);
    next.phase = UploadJobPhase::RetryWaiting;
    next.retry_count = next.retry_count.saturating_add(1);
    let delay = next_retry_delay_ms(base_backoff_ms, snapshot.retry_count, server_retry_after_ms);
    let not_before = add_delay(now_ms, delay)?;
    next.next_retry_not_before_ms = Some(not_before);
    Ok(upload_transition(
        next,
        vec![UploadJobEffect::ScheduleRetry {
            effect_id,
            attempt: snapshot.retry_count,
            not_before_ms: not_before,
            target_phase: target,
        }],
    ))
}

fn schedule_manifest_retry(
    snapshot: &UploadJobSnapshot,
    effect_id: Uuid,
    now_ms: i64,
    base_backoff_ms: u64,
    server_retry_after_ms: Option<u64>,
) -> Result<UploadJobTransition, ClientError> {
    if snapshot.retry_count >= snapshot.max_retry_count {
        return failed(
            snapshot,
            effect_id,
            ClientErrorCode::ClientCoreRetryBudgetExhausted,
            CleanupStagingReason::Failed,
        );
    }
    let mut next = base_next(snapshot, effect_id);
    next.phase = UploadJobPhase::RetryWaiting;
    next.retry_count = next.retry_count.saturating_add(1);
    let delay = next_retry_delay_ms(base_backoff_ms, snapshot.retry_count, server_retry_after_ms);
    let not_before = add_delay(now_ms, delay)?;
    next.next_retry_not_before_ms = Some(not_before);
    Ok(upload_transition(
        next,
        vec![UploadJobEffect::ScheduleRetry {
            effect_id,
            attempt: snapshot.retry_count,
            not_before_ms: not_before,
            target_phase: UploadJobPhase::CreatingManifest,
        }],
    ))
}

fn cleanup_cancel(
    snapshot: &UploadJobSnapshot,
    effect_id: Uuid,
    code: ClientErrorCode,
    reason: CleanupStagingReason,
) -> Result<UploadJobTransition, ClientError> {
    if upload_phase_is_terminal(snapshot.phase) {
        return Err(invalid_transition_error("invalid state transition"));
    }
    let mut next = base_next(snapshot, effect_id);
    next.phase = UploadJobPhase::Cancelled;
    next.failure_code = Some(code);
    Ok(upload_transition(
        next,
        vec![UploadJobEffect::CleanupStaging { effect_id, reason }],
    ))
}

fn failed(
    snapshot: &UploadJobSnapshot,
    effect_id: Uuid,
    code: ClientErrorCode,
    reason: CleanupStagingReason,
) -> Result<UploadJobTransition, ClientError> {
    if upload_phase_is_terminal(snapshot.phase) {
        return Err(invalid_transition_error("invalid state transition"));
    }
    let mut next = base_next(snapshot, effect_id);
    next.phase = UploadJobPhase::Failed;
    next.failure_code = Some(code);
    Ok(upload_transition(
        next,
        vec![UploadJobEffect::CleanupStaging { effect_id, reason }],
    ))
}

fn base_next(snapshot: &UploadJobSnapshot, effect_id: Uuid) -> UploadJobSnapshot {
    let mut next = snapshot.clone();
    next.snapshot_revision = next.snapshot_revision.saturating_add(1);
    next.last_applied_event_id = Some(effect_id);
    next.failure_code = None;
    next
}

fn acknowledge_effect(
    snapshot: &UploadJobSnapshot,
    effect_id: Uuid,
) -> Result<UploadJobTransition, ClientError> {
    validate_uuid_v7(effect_id)?;
    if Some(effect_id) == snapshot.last_acknowledged_effect_id {
        return Ok(upload_transition(snapshot.clone(), Vec::new()));
    }
    if let Some(previous) = snapshot.last_acknowledged_effect_id {
        if effect_id <= previous {
            return Err(invalid_transition_error("stale effect ack"));
        }
    }
    let mut next = snapshot.clone();
    next.snapshot_revision = next.snapshot_revision.saturating_add(1);
    next.last_acknowledged_effect_id = Some(effect_id);
    Ok(upload_transition(next, Vec::new()))
}

fn reset_retry(snapshot: &mut UploadJobSnapshot) {
    snapshot.retry_count = 0;
    snapshot.next_retry_not_before_ms = None;
}

fn upload_transition(
    next_snapshot: UploadJobSnapshot,
    effects: Vec<UploadJobEffect>,
) -> UploadJobTransition {
    UploadJobTransition {
        next_snapshot,
        effects,
    }
}

fn retry_resume_effects(
    snapshot: &UploadJobSnapshot,
    effect_id: Uuid,
    target_phase: UploadJobPhase,
) -> Result<Vec<UploadJobEffect>, ClientError> {
    match target_phase {
        UploadJobPhase::AwaitingPreparedMedia => {
            Ok(vec![UploadJobEffect::PrepareMedia { effect_id }])
        }
        UploadJobPhase::AwaitingEpochHandle => {
            Ok(vec![UploadJobEffect::AcquireEpochHandle { effect_id }])
        }
        UploadJobPhase::EncryptingShard => {
            let shard = next_pending_shard(snapshot)?;
            Ok(vec![UploadJobEffect::EncryptShard {
                effect_id,
                tier: shard.tier,
                shard_index: shard.shard_index,
            }])
        }
        UploadJobPhase::CreatingShardUpload => {
            let shard = next_pending_shard(snapshot)?;
            Ok(vec![UploadJobEffect::CreateShardUpload {
                effect_id,
                shard,
            }])
        }
        UploadJobPhase::UploadingShard => {
            let shard = next_pending_shard(snapshot)?;
            Ok(vec![UploadJobEffect::UploadShard { effect_id, shard }])
        }
        UploadJobPhase::CreatingManifest => Ok(vec![UploadJobEffect::CreateManifest {
            effect_id,
            idempotency_key: snapshot.idempotency_key,
            tiered_shards: snapshot.tiered_shards.clone(),
            shard_set_hash: snapshot.shard_set_hash,
        }]),
        UploadJobPhase::AwaitingSyncConfirmation => {
            Ok(vec![UploadJobEffect::AwaitSyncConfirmation { effect_id }])
        }
        UploadJobPhase::ManifestCommitUnknown
        | UploadJobPhase::Queued
        | UploadJobPhase::RetryWaiting
        | UploadJobPhase::Confirmed
        | UploadJobPhase::Cancelled
        | UploadJobPhase::Failed => Err(invalid_transition_error("invalid state transition")),
    }
}

fn next_pending_shard(snapshot: &UploadJobSnapshot) -> Result<UploadShardRef, ClientError> {
    snapshot
        .tiered_shards
        .iter()
        .find(|shard| !shard.uploaded)
        .cloned()
        .ok_or_else(|| invalid_snapshot_error("snapshot validation failed"))
}

fn add_delay(now_ms: i64, delay_ms: u64) -> Result<i64, ClientError> {
    let delay = i64::try_from(delay_ms)
        .map_err(|_| invalid_snapshot_error("snapshot validation failed"))?;
    now_ms
        .checked_add(delay)
        .ok_or_else(|| invalid_snapshot_error("snapshot validation failed"))
}

fn require_upload_phase(
    actual: UploadJobPhase,
    expected: UploadJobPhase,
) -> Result<(), ClientError> {
    if actual == expected {
        Ok(())
    } else {
        Err(invalid_transition_error("invalid state transition"))
    }
}

fn upload_phase_allows_retry(phase: UploadJobPhase) -> bool {
    matches!(
        phase,
        UploadJobPhase::AwaitingPreparedMedia
            | UploadJobPhase::AwaitingEpochHandle
            | UploadJobPhase::EncryptingShard
            | UploadJobPhase::CreatingShardUpload
            | UploadJobPhase::UploadingShard
            | UploadJobPhase::CreatingManifest
            | UploadJobPhase::AwaitingSyncConfirmation
    )
}

fn upload_phase_is_terminal(phase: UploadJobPhase) -> bool {
    matches!(
        phase,
        UploadJobPhase::Confirmed | UploadJobPhase::Cancelled | UploadJobPhase::Failed
    )
}

fn validate_upload_snapshot(snapshot: &UploadJobSnapshot) -> Result<(), ClientError> {
    if snapshot.schema_version != SNAPSHOT_SCHEMA_VERSION_V1 {
        return Err(ClientError::new(
            ClientErrorCode::ClientCoreUnsupportedSnapshotVersion,
            "snapshot schema version is unsupported",
        ));
    }
    validate_uuid_v7(snapshot.job_id)?;
    validate_uuid_v7(snapshot.album_id)?;
    validate_uuid_v7(snapshot.idempotency_key)?;
    validate_retry_bounds(snapshot.retry_count, snapshot.max_retry_count)?;
    validate_tiered_shards(&snapshot.tiered_shards)?;
    if let Some(effect_id) = snapshot.last_acknowledged_effect_id {
        validate_uuid_v7(effect_id)?;
    }
    if let Some(effect_id) = snapshot.last_applied_event_id {
        validate_uuid_v7(effect_id)?;
    }
    Ok(())
}

fn validate_uuid_v7(uuid: Uuid) -> Result<(), ClientError> {
    if uuid.is_uuid_v7() {
        Ok(())
    } else {
        Err(invalid_snapshot_error("snapshot validation failed"))
    }
}

fn validate_retry_bounds(retry_count: u8, max_retry_count: u8) -> Result<(), ClientError> {
    if retry_count <= max_retry_count && max_retry_count <= MAX_RETRY_COUNT_LIMIT {
        Ok(())
    } else {
        Err(invalid_snapshot_error("snapshot validation failed"))
    }
}

fn validate_tiered_shards(shards: &[UploadShardRef]) -> Result<(), ClientError> {
    if shards.len() > MAX_TIERED_SHARDS {
        return Err(invalid_snapshot_error("snapshot validation failed"));
    }
    let mut seen = std::collections::BTreeSet::new();
    for shard in shards {
        validate_upload_shard_ref(shard)?;
        if !seen.insert((shard.tier, shard.shard_index)) {
            return Err(invalid_snapshot_error("snapshot validation failed"));
        }
    }
    Ok(())
}

fn validate_upload_shard_ref(shard: &UploadShardRef) -> Result<(), ClientError> {
    if !(1..=3).contains(&shard.tier) {
        return Err(invalid_snapshot_error("snapshot validation failed"));
    }
    validate_uuid_v7(shard.shard_id)?;
    if shard.envelope_version != 3 && shard.envelope_version != 4 {
        return Err(invalid_snapshot_error("snapshot validation failed"));
    }
    if shard.content_length == 0 || shard.sha256.iter().all(|byte| *byte == 0) {
        return Err(invalid_snapshot_error("snapshot validation failed"));
    }
    Ok(())
}

fn upsert_shard(
    snapshot: &mut UploadJobSnapshot,
    shard: UploadShardRef,
) -> Result<(), ClientError> {
    match snapshot.tiered_shards.iter_mut().find(|candidate| {
        candidate.tier == shard.tier && candidate.shard_index == shard.shard_index
    }) {
        Some(slot) => {
            if slot.shard_id != shard.shard_id
                || slot.sha256 != shard.sha256
                || slot.content_length != shard.content_length
                || slot.envelope_version != shard.envelope_version
                || (slot.uploaded && !shard.uploaded)
            {
                return Err(invalid_transition_error("invalid state transition"));
            }
            slot.uploaded |= shard.uploaded;
            Ok(())
        }
        None => Err(invalid_transition_error("invalid state transition")),
    }
}

fn mark_uploaded(
    snapshot: &mut UploadJobSnapshot,
    shard: &UploadShardRef,
) -> Result<(), ClientError> {
    match snapshot.tiered_shards.iter_mut().find(|candidate| {
        candidate.tier == shard.tier
            && candidate.shard_index == shard.shard_index
            && candidate.shard_id == shard.shard_id
    }) {
        Some(slot) => {
            if slot.uploaded
                || slot.sha256 != shard.sha256
                || slot.content_length != shard.content_length
                || slot.envelope_version != shard.envelope_version
            {
                return Err(invalid_transition_error("invalid state transition"));
            }
            slot.uploaded = true;
            Ok(())
        }
        None => Err(invalid_transition_error("invalid state transition")),
    }
}

fn invalid_transition_error(message: &'static str) -> ClientError {
    ClientError::new(ClientErrorCode::ClientCoreInvalidTransition, message)
}

fn invalid_snapshot_error(message: &'static str) -> ClientError {
    ClientError::new(ClientErrorCode::ClientCoreInvalidSnapshot, message)
}

fn kv(key: u32, value: Value) -> (Value, Value) {
    (Value::Integer(Integer::from(key)), value)
}
fn uint<T: Into<u64>>(value: T) -> Value {
    Value::Integer(Integer::from(value.into()))
}
fn uuid_value(uuid: Uuid) -> Value {
    Value::Bytes(uuid.0.to_vec())
}
fn option_uuid(uuid: Option<Uuid>) -> Value {
    uuid.map_or(Value::Null, uuid_value)
}
fn option_i64(value: Option<i64>) -> Value {
    value.map_or(Value::Null, |v| Value::Integer(Integer::from(v)))
}
fn option_bytes_32(value: Option<[u8; 32]>) -> Value {
    value.map_or(Value::Null, |bytes| Value::Bytes(bytes.to_vec()))
}
fn option_client_error_code(value: Option<ClientErrorCode>) -> Value {
    value.map_or(Value::Null, |code| {
        Value::Integer(Integer::from(code.as_u16()))
    })
}

fn shard_value(shard: &UploadShardRef) -> Value {
    Value::Map(vec![
        kv(0, uint(shard.tier)),
        kv(1, uint(shard.shard_index)),
        kv(2, uuid_value(shard.shard_id)),
        kv(3, Value::Bytes(shard.sha256.to_vec())),
        kv(4, uint(shard.content_length)),
        kv(5, uint(shard.envelope_version)),
        kv(6, Value::Bool(shard.uploaded)),
    ])
}

struct DecodedUploadSnapshot {
    snapshot: UploadJobSnapshot,
    migrated_legacy_retry_target: bool,
}

fn decode_upload_snapshot_value(
    value: &Value,
) -> Result<DecodedUploadSnapshot, SnapshotMigrationError> {
    let Value::Map(entries) = value else {
        return Err(SnapshotMigrationError::SchemaVersionMissing);
    };
    let schema_version = required_u16(entries, upload_job_snapshot_keys::SCHEMA_VERSION)
        .ok_or(SnapshotMigrationError::SchemaVersionMissing)?;
    if schema_version > snapshot_schema::CURRENT_SNAPSHOT_SCHEMA_VERSION {
        return Err(SnapshotMigrationError::SchemaTooNew {
            found: schema_version,
            max_supported: snapshot_schema::CURRENT_SNAPSHOT_SCHEMA_VERSION,
        });
    }
    let expected_keys =
        upload_job_snapshot_keys::upload_job_keys_for_schema_version(schema_version)
            .ok_or(SnapshotMigrationError::SchemaCorrupt)?;
    let legacy_retry_target_phase = legacy_upload_retry_target_phase(entries)?;
    if legacy_retry_target_phase.is_some() {
        let mut expected_keys = expected_keys.to_vec();
        expected_keys.push(LEGACY_UPLOAD_RETRY_TARGET_PHASE_KEY);
        validate_exact_keys(entries, expected_keys)?;
    } else {
        validate_exact_keys(entries, expected_keys.iter().copied())?;
    }
    if schema_version != SNAPSHOT_SCHEMA_VERSION_V1 {
        return Err(SnapshotMigrationError::StepFailed {
            from: schema_version,
            to: SNAPSHOT_SCHEMA_VERSION_V1,
        });
    }
    let phase = required_u8(entries, upload_job_snapshot_keys::PHASE)
        .and_then(UploadJobPhase::try_from_u8)
        .ok_or(SnapshotMigrationError::SchemaCorrupt)?;
    let retry_count = required_u8(entries, upload_job_snapshot_keys::RETRY_COUNT)
        .ok_or(SnapshotMigrationError::SchemaCorrupt)?;
    let max_retry_count = required_u8(entries, upload_job_snapshot_keys::MAX_RETRY_COUNT)
        .ok_or(SnapshotMigrationError::SchemaCorrupt)?;
    let mut snapshot = UploadJobSnapshot {
        schema_version,
        job_id: required_uuid(entries, upload_job_snapshot_keys::JOB_ID)?,
        album_id: required_uuid(entries, upload_job_snapshot_keys::ALBUM_ID)?,
        phase,
        retry_count,
        max_retry_count,
        next_retry_not_before_ms: optional_i64(
            entries,
            upload_job_snapshot_keys::NEXT_RETRY_NOT_BEFORE_MS,
        )?,
        idempotency_key: required_uuid(entries, upload_job_snapshot_keys::IDEMPOTENCY_KEY)?,
        tiered_shards: required_shards(entries, upload_job_snapshot_keys::TIERED_SHARDS)?,
        shard_set_hash: optional_bytes_32(entries, upload_job_snapshot_keys::SHARD_SET_HASH)?,
        snapshot_revision: required_u64(entries, upload_job_snapshot_keys::SNAPSHOT_REVISION)
            .ok_or(SnapshotMigrationError::SchemaCorrupt)?,
        last_acknowledged_effect_id: optional_uuid(
            entries,
            upload_job_snapshot_keys::LAST_ACKNOWLEDGED_EFFECT_ID,
        )?,
        last_applied_event_id: optional_uuid(
            entries,
            upload_job_snapshot_keys::LAST_APPLIED_EVENT_ID,
        )?,
        failure_code: optional_client_error_code(entries, upload_job_snapshot_keys::FAILURE_CODE)?,
    };
    let migrated_legacy_retry_target =
        migrate_legacy_upload_retry_target_phase(&mut snapshot, legacy_retry_target_phase)?;
    validate_decoded_upload_snapshot(&snapshot)?;
    Ok(DecodedUploadSnapshot {
        snapshot,
        migrated_legacy_retry_target,
    })
}

fn legacy_upload_retry_target_phase(
    entries: &[(Value, Value)],
) -> Result<Option<UploadJobPhase>, SnapshotMigrationError> {
    let Some(value) = entry(entries, LEGACY_UPLOAD_RETRY_TARGET_PHASE_KEY) else {
        return Ok(None);
    };
    let Value::Integer(integer) = value else {
        return Err(SnapshotMigrationError::SchemaCorrupt);
    };
    let phase = integer_to_u8(*integer)
        .and_then(UploadJobPhase::try_from_u8)
        .ok_or(SnapshotMigrationError::SchemaCorrupt)?;
    Ok(Some(phase))
}

fn migrate_legacy_upload_retry_target_phase(
    snapshot: &mut UploadJobSnapshot,
    legacy_retry_target_phase: Option<UploadJobPhase>,
) -> Result<bool, SnapshotMigrationError> {
    match (snapshot.phase, legacy_retry_target_phase) {
        (UploadJobPhase::RetryWaiting, Some(UploadJobPhase::ManifestCommitUnknown)) => {
            snapshot.phase = UploadJobPhase::ManifestCommitUnknown;
            emit_upload_snapshot_migration_telemetry(snapshot);
            Ok(true)
        }
        (_, Some(_)) => Err(SnapshotMigrationError::SchemaCorrupt),
        (_, None) => Ok(false),
    }
}

fn emit_upload_snapshot_migration_telemetry(snapshot: &UploadJobSnapshot) {
    // Stderr key=value line. mosaic-client has no `tracing`/`log` dependency
    // today; when a logger is adopted, swap this for `tracing::warn!` with
    // explicit fields. Tracked under `wave3-1-tracing` follow-up.
    eprintln!(
        "level=warn event=legacy_upload_retry_waiting_manifest_commit_unknown_migrated schema_version={} retry_count={} max_retry_count={}",
        snapshot.schema_version, snapshot.retry_count, snapshot.max_retry_count,
    );
}

fn validate_decoded_upload_snapshot(
    snapshot: &UploadJobSnapshot,
) -> Result<(), SnapshotMigrationError> {
    if !snapshot.job_id.is_uuid_v7()
        || !snapshot.album_id.is_uuid_v7()
        || !snapshot.idempotency_key.is_uuid_v7()
    {
        return Err(SnapshotMigrationError::SchemaCorrupt);
    }
    if snapshot.retry_count > snapshot.max_retry_count
        || snapshot.max_retry_count > MAX_RETRY_COUNT_LIMIT
    {
        return Err(SnapshotMigrationError::SchemaCorrupt);
    }
    if let Some(effect_id) = snapshot.last_acknowledged_effect_id {
        if !effect_id.is_uuid_v7() {
            return Err(SnapshotMigrationError::SchemaCorrupt);
        }
    }
    if let Some(effect_id) = snapshot.last_applied_event_id {
        if !effect_id.is_uuid_v7() {
            return Err(SnapshotMigrationError::SchemaCorrupt);
        }
    }
    if snapshot.tiered_shards.len() > MAX_TIERED_SHARDS {
        return Err(SnapshotMigrationError::SchemaCorrupt);
    }
    let mut seen = std::collections::BTreeSet::new();
    for shard in &snapshot.tiered_shards {
        if !(1..=3).contains(&shard.tier)
            || !shard.shard_id.is_uuid_v7()
            || (shard.envelope_version != 3 && shard.envelope_version != 4)
            || shard.content_length == 0
            || shard.sha256.iter().all(|byte| *byte == 0)
        {
            return Err(SnapshotMigrationError::SchemaCorrupt);
        }
        if !seen.insert((shard.tier, shard.shard_index)) {
            return Err(SnapshotMigrationError::SchemaCorrupt);
        }
    }
    let has_shards = !snapshot.tiered_shards.is_empty();
    let all_uploaded = snapshot.tiered_shards.iter().all(|shard| shard.uploaded);
    let has_pending_upload = snapshot.tiered_shards.iter().any(|shard| !shard.uploaded);
    match snapshot.phase {
        UploadJobPhase::Queued | UploadJobPhase::AwaitingPreparedMedia => {
            if has_shards {
                return Err(SnapshotMigrationError::SchemaCorrupt);
            }
        }
        UploadJobPhase::AwaitingEpochHandle
        | UploadJobPhase::EncryptingShard
        | UploadJobPhase::CreatingShardUpload
        | UploadJobPhase::UploadingShard
        | UploadJobPhase::RetryWaiting => {
            if !has_shards || !has_pending_upload {
                return Err(SnapshotMigrationError::SchemaCorrupt);
            }
        }
        UploadJobPhase::CreatingManifest
        | UploadJobPhase::AwaitingSyncConfirmation
        | UploadJobPhase::Confirmed
        | UploadJobPhase::ManifestCommitUnknown => {
            if !has_shards || !all_uploaded {
                return Err(SnapshotMigrationError::SchemaCorrupt);
            }
        }
        UploadJobPhase::Failed => {
            if snapshot.failure_code.is_none() {
                return Err(SnapshotMigrationError::SchemaCorrupt);
            }
        }
        UploadJobPhase::Cancelled => {}
    }
    Ok(())
}

fn entry(entries: &[(Value, Value)], key: u32) -> Option<&Value> {
    entries.iter().find_map(|(candidate, value)| {
        match candidate.as_integer().and_then(integer_to_u32) {
            Some(found) if found == key => Some(value),
            _ => None,
        }
    })
}
fn required_u16(entries: &[(Value, Value)], key: u32) -> Option<u16> {
    entry(entries, key)?.as_integer().and_then(integer_to_u16)
}
fn required_u8(entries: &[(Value, Value)], key: u32) -> Option<u8> {
    entry(entries, key)?.as_integer().and_then(integer_to_u8)
}
fn required_u64(entries: &[(Value, Value)], key: u32) -> Option<u64> {
    entry(entries, key)?.as_integer().and_then(integer_to_u64)
}
fn required_uuid(entries: &[(Value, Value)], key: u32) -> Result<Uuid, SnapshotMigrationError> {
    value_to_uuid(entry(entries, key).ok_or(SnapshotMigrationError::SchemaCorrupt)?)
}
fn optional_uuid(
    entries: &[(Value, Value)],
    key: u32,
) -> Result<Option<Uuid>, SnapshotMigrationError> {
    match entry(entries, key).ok_or(SnapshotMigrationError::SchemaCorrupt)? {
        Value::Null => Ok(None),
        value => value_to_uuid(value).map(Some),
    }
}
fn optional_i64(
    entries: &[(Value, Value)],
    key: u32,
) -> Result<Option<i64>, SnapshotMigrationError> {
    match entry(entries, key).ok_or(SnapshotMigrationError::SchemaCorrupt)? {
        Value::Null => Ok(None),
        Value::Integer(integer) => i64::try_from(*integer)
            .map(Some)
            .map_err(|_| SnapshotMigrationError::SchemaCorrupt),
        _ => Err(SnapshotMigrationError::SchemaCorrupt),
    }
}
fn optional_client_error_code(
    entries: &[(Value, Value)],
    key: u32,
) -> Result<Option<ClientErrorCode>, SnapshotMigrationError> {
    match entry(entries, key).ok_or(SnapshotMigrationError::SchemaCorrupt)? {
        Value::Null => Ok(None),
        Value::Integer(integer) => {
            let code = integer_to_u16(*integer).ok_or(SnapshotMigrationError::SchemaCorrupt)?;
            ClientErrorCode::try_from_u16(code)
                .ok_or(SnapshotMigrationError::SchemaCorrupt)
                .map(Some)
        }
        _ => Err(SnapshotMigrationError::SchemaCorrupt),
    }
}
fn optional_bytes_32(
    entries: &[(Value, Value)],
    key: u32,
) -> Result<Option<[u8; 32]>, SnapshotMigrationError> {
    match entry(entries, key).ok_or(SnapshotMigrationError::SchemaCorrupt)? {
        Value::Null => Ok(None),
        Value::Bytes(bytes) => bytes
            .as_slice()
            .try_into()
            .map(Some)
            .map_err(|_| SnapshotMigrationError::SchemaCorrupt),
        _ => Err(SnapshotMigrationError::SchemaCorrupt),
    }
}

fn value_to_uuid(value: &Value) -> Result<Uuid, SnapshotMigrationError> {
    let Value::Bytes(bytes) = value else {
        return Err(SnapshotMigrationError::SchemaCorrupt);
    };
    let bytes: [u8; 16] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| SnapshotMigrationError::SchemaCorrupt)?;
    let uuid = Uuid::from_bytes(bytes);
    if uuid.is_uuid_v7() {
        Ok(uuid)
    } else {
        Err(SnapshotMigrationError::SchemaCorrupt)
    }
}

fn required_shards(
    entries: &[(Value, Value)],
    key: u32,
) -> Result<Vec<UploadShardRef>, SnapshotMigrationError> {
    let Value::Array(items) = entry(entries, key).ok_or(SnapshotMigrationError::SchemaCorrupt)?
    else {
        return Err(SnapshotMigrationError::SchemaCorrupt);
    };
    items.iter().map(decode_shard).collect()
}

fn decode_shard(value: &Value) -> Result<UploadShardRef, SnapshotMigrationError> {
    let Value::Map(entries) = value else {
        return Err(SnapshotMigrationError::SchemaCorrupt);
    };
    validate_exact_keys(entries, 0_u32..=6_u32)?;
    let sha256 = match entry(entries, 3).ok_or(SnapshotMigrationError::SchemaCorrupt)? {
        Value::Bytes(bytes) => bytes
            .as_slice()
            .try_into()
            .map_err(|_| SnapshotMigrationError::SchemaCorrupt)?,
        _ => return Err(SnapshotMigrationError::SchemaCorrupt),
    };
    let uploaded = match entry(entries, 6).ok_or(SnapshotMigrationError::SchemaCorrupt)? {
        Value::Bool(value) => *value,
        _ => return Err(SnapshotMigrationError::SchemaCorrupt),
    };
    Ok(UploadShardRef {
        tier: required_u8(entries, 0).ok_or(SnapshotMigrationError::SchemaCorrupt)?,
        shard_index: required_u32(entries, 1).ok_or(SnapshotMigrationError::SchemaCorrupt)?,
        shard_id: required_uuid(entries, 2)?,
        sha256,
        content_length: required_u64(entries, 4).ok_or(SnapshotMigrationError::SchemaCorrupt)?,
        envelope_version: required_u8(entries, 5).ok_or(SnapshotMigrationError::SchemaCorrupt)?,
        uploaded,
    })
}
fn required_u32(entries: &[(Value, Value)], key: u32) -> Option<u32> {
    entry(entries, key)?.as_integer().and_then(integer_to_u32)
}
fn integer_to_u8(integer: Integer) -> Option<u8> {
    u8::try_from(integer).ok()
}
fn integer_to_u16(integer: Integer) -> Option<u16> {
    u16::try_from(integer).ok()
}
fn integer_to_u32(integer: Integer) -> Option<u32> {
    u32::try_from(integer).ok()
}
fn integer_to_u64(integer: Integer) -> Option<u64> {
    u64::try_from(integer).ok()
}

fn validate_cbor_value(value: &Value, depth: usize) -> Result<(), SnapshotMigrationError> {
    if depth > 64 {
        return Err(SnapshotMigrationError::CborDecodeFailed);
    }
    match value {
        Value::Integer(_) | Value::Bytes(_) | Value::Bool(_) | Value::Null => Ok(()),
        Value::Float(_) => Err(SnapshotMigrationError::SchemaCorrupt),
        Value::Text(_) | Value::Tag(_, _) => Err(SnapshotMigrationError::SchemaCorrupt),
        Value::Array(items) => items
            .iter()
            .try_for_each(|item| validate_cbor_value(item, depth + 1)),
        Value::Map(entries) => {
            let mut previous = None;
            for (key, nested) in entries {
                match key {
                    Value::Integer(integer) => {
                        let key = integer_to_u32(*integer)
                            .ok_or(SnapshotMigrationError::SchemaCorrupt)?;
                        if previous.is_some_and(|prior| prior >= key) {
                            return Err(SnapshotMigrationError::SchemaCorrupt);
                        }
                        previous = Some(key);
                    }
                    Value::Text(name)
                        if snapshot_schema::FORBIDDEN_FIELD_NAMES
                            .iter()
                            .any(|forbidden| name.to_ascii_lowercase().contains(forbidden)) =>
                    {
                        return Err(SnapshotMigrationError::ForbiddenField);
                    }
                    Value::Text(_) => return Err(SnapshotMigrationError::SchemaCorrupt),
                    _ => return Err(SnapshotMigrationError::SchemaCorrupt),
                }
                validate_cbor_value(nested, depth + 1)?;
            }
            Ok(())
        }
        _ => Err(SnapshotMigrationError::SchemaCorrupt),
    }
}

fn validate_exact_keys<I>(
    entries: &[(Value, Value)],
    expected_keys: I,
) -> Result<(), SnapshotMigrationError>
where
    I: IntoIterator<Item = u32>,
{
    let found: Result<Vec<u32>, SnapshotMigrationError> = entries
        .iter()
        .map(|(key, _)| {
            key.as_integer()
                .and_then(integer_to_u32)
                .ok_or(SnapshotMigrationError::SchemaCorrupt)
        })
        .collect();
    let found = found?;
    let expected: Vec<u32> = expected_keys.into_iter().collect();
    if found == expected {
        Ok(())
    } else {
        Err(SnapshotMigrationError::SchemaCorrupt)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlbumSyncRequest {
    pub sync_id: String,
    pub album_id: String,
    pub initial_page_token: Option<String>,
    pub max_retry_count: u32,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AlbumSyncPhase {
    Idle,
    FetchingPage,
    ApplyingPage,
    RetryWaiting,
    Completed,
    Cancelled,
    Failed,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlbumSyncSnapshot {
    pub schema_version: u16,
    pub sync_id: String,
    pub album_id: String,
    pub phase: AlbumSyncPhase,
    pub initial_page_token: Option<String>,
    pub next_page_token: Option<String>,
    pub current_page: Option<SyncPageSummary>,
    pub rerun_requested: bool,
    pub completed_cycle_count: u32,
    pub retry: AlbumSyncRetryMetadata,
    pub failure_code: Option<ClientErrorCode>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AlbumSyncEffect {
    FetchPage {
        page_token: Option<String>,
    },
    ApplyPage {
        encrypted_item_count: u32,
    },
    ScheduleRetry {
        attempt: u32,
        retry_after_ms: u64,
        target_phase: AlbumSyncPhase,
    },
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AlbumSyncEvent {
    SyncRequested {
        request: Option<AlbumSyncRequest>,
    },
    PageFetched {
        page: Option<SyncPageSummary>,
    },
    PageApplied,
    RetryableFailure {
        code: ClientErrorCode,
        retry_after_ms: Option<u64>,
    },
    RetryTimerElapsed,
    CancelRequested,
    NonRetryableFailure {
        code: ClientErrorCode,
    },
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlbumSyncTransition {
    pub snapshot: AlbumSyncSnapshot,
    pub effects: Vec<AlbumSyncEffect>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncPageSummary {
    pub previous_page_token: Option<String>,
    pub next_page_token: Option<String>,
    pub reached_end: bool,
    pub encrypted_item_count: u32,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlbumSyncRetryMetadata {
    pub attempt_count: u32,
    pub max_attempts: u32,
    pub retry_after_ms: Option<u64>,
    pub last_error_code: Option<ClientErrorCode>,
    pub last_error_stage: Option<AlbumSyncPhase>,
    pub retry_target_phase: Option<AlbumSyncPhase>,
}
#[must_use]
pub const fn album_sync_snapshot_schema_version() -> u16 {
    CLIENT_CORE_SNAPSHOT_SCHEMA_VERSION
}

pub fn new_album_sync(request: AlbumSyncRequest) -> Result<AlbumSyncSnapshot, ClientError> {
    Ok(AlbumSyncSnapshot {
        schema_version: CLIENT_CORE_SNAPSHOT_SCHEMA_VERSION,
        sync_id: request.sync_id,
        album_id: request.album_id,
        phase: AlbumSyncPhase::Idle,
        initial_page_token: request.initial_page_token.clone(),
        next_page_token: request.initial_page_token,
        current_page: None,
        rerun_requested: false,
        completed_cycle_count: 0,
        retry: AlbumSyncRetryMetadata {
            attempt_count: 0,
            max_attempts: request.max_retry_count,
            retry_after_ms: None,
            last_error_code: None,
            last_error_stage: None,
            retry_target_phase: None,
        },
        failure_code: None,
    })
}

pub fn advance_album_sync(
    snapshot: &AlbumSyncSnapshot,
    event: AlbumSyncEvent,
) -> Result<AlbumSyncTransition, ClientError> {
    match event {
        AlbumSyncEvent::SyncRequested { request } => {
            let request = request.ok_or_else(|| {
                ClientError::new(
                    ClientErrorCode::ClientCoreMissingEventPayload,
                    "required event payload is missing",
                )
            })?;
            let mut next = snapshot.clone();
            // Phase matrix: active syncs coalesce rerun requests; idle and
            // terminal snapshots start a fresh sync cycle.
            if matches!(
                next.phase,
                AlbumSyncPhase::FetchingPage
                    | AlbumSyncPhase::ApplyingPage
                    | AlbumSyncPhase::RetryWaiting
            ) {
                next.rerun_requested = true;
                return Ok(AlbumSyncTransition {
                    snapshot: next,
                    effects: Vec::new(),
                });
            }
            next.sync_id = request.sync_id;
            next.album_id = request.album_id;
            next.initial_page_token = request.initial_page_token.clone();
            next.next_page_token = request.initial_page_token;
            next.phase = AlbumSyncPhase::FetchingPage;
            next.rerun_requested = false;
            next.failure_code = None;
            Ok(AlbumSyncTransition {
                snapshot: next.clone(),
                effects: vec![AlbumSyncEffect::FetchPage {
                    page_token: next.next_page_token,
                }],
            })
        }
        AlbumSyncEvent::PageFetched { page } => {
            require_album_sync_phase(snapshot.phase, AlbumSyncPhase::FetchingPage)?;
            let page = page.ok_or_else(|| {
                ClientError::new(
                    ClientErrorCode::ClientCoreMissingEventPayload,
                    "required event payload is missing",
                )
            })?;
            let mut next = snapshot.clone();
            next.current_page = Some(page.clone());
            next.phase = AlbumSyncPhase::ApplyingPage;
            next.failure_code = None;
            Ok(AlbumSyncTransition {
                snapshot: next,
                effects: vec![AlbumSyncEffect::ApplyPage {
                    encrypted_item_count: page.encrypted_item_count,
                }],
            })
        }
        AlbumSyncEvent::PageApplied => {
            require_album_sync_phase(snapshot.phase, AlbumSyncPhase::ApplyingPage)?;
            let page = snapshot
                .current_page
                .clone()
                .ok_or_else(|| invalid_snapshot_error("snapshot validation failed"))?;
            let mut next = snapshot.clone();
            next.current_page = None;
            if page.reached_end {
                next.completed_cycle_count = next.completed_cycle_count.saturating_add(1);
                if next.rerun_requested {
                    next.rerun_requested = false;
                    next.next_page_token = next.initial_page_token.clone();
                    next.phase = AlbumSyncPhase::FetchingPage;
                    Ok(AlbumSyncTransition {
                        snapshot: next.clone(),
                        effects: vec![AlbumSyncEffect::FetchPage {
                            page_token: next.next_page_token,
                        }],
                    })
                } else {
                    next.phase = AlbumSyncPhase::Completed;
                    Ok(AlbumSyncTransition {
                        snapshot: next,
                        effects: Vec::new(),
                    })
                }
            } else {
                next.next_page_token = page.next_page_token;
                next.phase = AlbumSyncPhase::FetchingPage;
                Ok(AlbumSyncTransition {
                    snapshot: next.clone(),
                    effects: vec![AlbumSyncEffect::FetchPage {
                        page_token: next.next_page_token,
                    }],
                })
            }
        }
        AlbumSyncEvent::RetryableFailure {
            code,
            retry_after_ms,
        } => {
            if !matches!(
                snapshot.phase,
                AlbumSyncPhase::FetchingPage | AlbumSyncPhase::ApplyingPage
            ) {
                return Err(invalid_transition_error("invalid state transition"));
            }
            if snapshot.retry.attempt_count >= snapshot.retry.max_attempts {
                let mut next = snapshot.clone();
                next.phase = AlbumSyncPhase::Failed;
                next.failure_code = Some(code);
                next.retry.last_error_code = Some(code);
                next.retry.last_error_stage = Some(snapshot.phase);
                return Ok(AlbumSyncTransition {
                    snapshot: next,
                    effects: Vec::new(),
                });
            }
            let mut next = snapshot.clone();
            next.retry.attempt_count = next.retry.attempt_count.saturating_add(1);
            next.retry.retry_after_ms = retry_after_ms.or(Some(1_000));
            next.retry.last_error_code = Some(code);
            next.retry.retry_target_phase = Some(snapshot.phase);
            next.phase = AlbumSyncPhase::RetryWaiting;
            Ok(AlbumSyncTransition {
                snapshot: next,
                effects: vec![AlbumSyncEffect::ScheduleRetry {
                    attempt: snapshot.retry.attempt_count.saturating_add(1),
                    retry_after_ms: retry_after_ms.unwrap_or(1_000),
                    target_phase: snapshot.phase,
                }],
            })
        }
        AlbumSyncEvent::RetryTimerElapsed => {
            require_album_sync_phase(snapshot.phase, AlbumSyncPhase::RetryWaiting)?;
            let mut next = snapshot.clone();
            let target = next
                .retry
                .retry_target_phase
                .ok_or_else(|| invalid_snapshot_error("snapshot validation failed"))?;
            if !matches!(
                target,
                AlbumSyncPhase::FetchingPage | AlbumSyncPhase::ApplyingPage
            ) {
                return Err(invalid_transition_error("invalid state transition"));
            }
            next.phase = target;
            let effect = match target {
                AlbumSyncPhase::FetchingPage => vec![AlbumSyncEffect::FetchPage {
                    page_token: next.next_page_token.clone(),
                }],
                AlbumSyncPhase::ApplyingPage => vec![AlbumSyncEffect::ApplyPage {
                    encrypted_item_count: next
                        .current_page
                        .as_ref()
                        .map_or(0, |p| p.encrypted_item_count),
                }],
                _ => Vec::new(),
            };
            Ok(AlbumSyncTransition {
                snapshot: next,
                effects: effect,
            })
        }
        AlbumSyncEvent::CancelRequested => {
            if snapshot.phase == AlbumSyncPhase::Cancelled {
                return Ok(AlbumSyncTransition {
                    snapshot: snapshot.clone(),
                    effects: Vec::new(),
                });
            }
            if matches!(
                snapshot.phase,
                AlbumSyncPhase::Completed | AlbumSyncPhase::Failed
            ) {
                return Err(invalid_transition_error("invalid state transition"));
            }
            let mut next = snapshot.clone();
            next.phase = AlbumSyncPhase::Cancelled;
            Ok(AlbumSyncTransition {
                snapshot: next,
                effects: Vec::new(),
            })
        }
        AlbumSyncEvent::NonRetryableFailure { code } => {
            if album_sync_phase_is_terminal(snapshot.phase) {
                return Err(invalid_transition_error("invalid state transition"));
            }
            let mut next = snapshot.clone();
            next.phase = AlbumSyncPhase::Failed;
            next.failure_code = Some(code);
            Ok(AlbumSyncTransition {
                snapshot: next,
                effects: Vec::new(),
            })
        }
    }
}

fn require_album_sync_phase(
    actual: AlbumSyncPhase,
    expected: AlbumSyncPhase,
) -> Result<(), ClientError> {
    if actual == expected {
        Ok(())
    } else {
        Err(invalid_transition_error("invalid state transition"))
    }
}

fn album_sync_phase_is_terminal(phase: AlbumSyncPhase) -> bool {
    matches!(
        phase,
        AlbumSyncPhase::Completed | AlbumSyncPhase::Cancelled | AlbumSyncPhase::Failed
    )
}
