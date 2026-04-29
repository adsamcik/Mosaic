use std::collections::HashSet;

use crate::{ClientError, ClientErrorCode};

pub const CLIENT_CORE_SNAPSHOT_SCHEMA_VERSION: u16 = 1;

/// Hard upper bound on `max_retry_count` accepted by request and snapshot
/// validators.
///
/// A platform bug or replayed snapshot could otherwise supply `u32::MAX`,
/// allowing the state machine to retry indefinitely. 64 is well above any
/// reasonable upload/sync retry budget; tests in this crate use values up to 3.
pub const MAX_RETRY_COUNT_LIMIT: u32 = 64;

const MAX_SAFE_TEXT_LEN: usize = 256;
const MAX_PLANNED_SHARDS: usize = 10_000;
const DEFAULT_RETRY_AFTER_MS: u64 = 1_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadJobRequest {
    pub local_job_id: String,
    pub upload_id: String,
    pub album_id: String,
    pub asset_id: String,
    pub max_retry_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadJobSnapshot {
    pub schema_version: u16,
    pub local_job_id: String,
    pub upload_id: String,
    pub album_id: String,
    pub asset_id: String,
    pub epoch_id: Option<u32>,
    pub phase: UploadJobPhase,
    pub planned_shard_count: u32,
    pub planned_shards: Vec<UploadShardSlot>,
    pub next_shard_index: u32,
    pub pending_shard: Option<PendingShardRef>,
    pub completed_shards: Vec<CompletedShardRef>,
    pub manifest_receipt: Option<ManifestReceipt>,
    pub retry: UploadRetryMetadata,
    pub confirmation_metadata: Option<UploadSyncConfirmation>,
    pub failure_code: Option<ClientErrorCode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum UploadJobPhase {
    Queued,
    AwaitingPreparedMedia,
    AwaitingEpochHandle,
    EncryptingShard,
    CreatingShardUpload,
    UploadingShard,
    CreatingManifest,
    ManifestCommitUnknown,
    AwaitingSyncConfirmation,
    RetryWaiting,
    Confirmed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UploadJobEffect {
    PrepareMedia,
    AcquireEpochHandle,
    EncryptShard {
        tier: u8,
        index: u32,
    },
    CreateShardUpload {
        tier: u8,
        index: u32,
        sha256: String,
    },
    UploadShard {
        tier: u8,
        index: u32,
        shard_id: String,
        sha256: String,
    },
    CreateManifest,
    AwaitSyncConfirmation,
    RecoverManifestThroughSync,
    ScheduleRetry {
        attempt: u32,
        retry_after_ms: u64,
        target_phase: UploadJobPhase,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UploadJobEvent {
    StartRequested,
    MediaPrepared {
        plan: Option<PreparedMediaPlan>,
    },
    EpochHandleAcquired {
        epoch_id: Option<u32>,
    },
    ShardEncrypted {
        shard: Option<EncryptedShardRef>,
    },
    ShardUploadCreated {
        upload: Option<CreatedShardUpload>,
    },
    ShardUploaded {
        shard: Option<CompletedShardRef>,
    },
    ManifestCreated {
        receipt: Option<ManifestReceipt>,
    },
    ManifestOutcomeUnknown,
    SyncConfirmed {
        confirmation: Option<UploadSyncConfirmation>,
    },
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
pub struct UploadJobTransition {
    pub snapshot: UploadJobSnapshot,
    pub effects: Vec<UploadJobEffect>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadShardSlot {
    pub tier: u8,
    pub index: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedMediaPlan {
    pub planned_shards: Vec<UploadShardSlot>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedShardRef {
    pub tier: u8,
    pub index: u32,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedShardUpload {
    pub tier: u8,
    pub index: u32,
    pub shard_id: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletedShardRef {
    pub tier: u8,
    pub index: u32,
    pub shard_id: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingShardRef {
    pub tier: u8,
    pub index: u32,
    pub sha256: String,
    pub shard_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestReceipt {
    pub manifest_id: String,
    pub version: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadSyncConfirmation {
    pub asset_id: String,
    pub confirmed_at_ms: u64,
    pub sync_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadRetryMetadata {
    pub attempt_count: u32,
    pub max_attempts: u32,
    pub retry_after_ms: Option<u64>,
    pub last_error_code: Option<ClientErrorCode>,
    pub last_error_stage: Option<UploadJobPhase>,
    pub retry_target_phase: Option<UploadJobPhase>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlbumSyncRequest {
    pub sync_id: String,
    pub album_id: String,
    pub initial_page_token: Option<String>,
    pub max_retry_count: u32,
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
pub const fn upload_snapshot_schema_version() -> u16 {
    CLIENT_CORE_SNAPSHOT_SCHEMA_VERSION
}

#[must_use]
pub const fn album_sync_snapshot_schema_version() -> u16 {
    CLIENT_CORE_SNAPSHOT_SCHEMA_VERSION
}

pub fn new_upload_job(request: UploadJobRequest) -> Result<UploadJobSnapshot, ClientError> {
    validate_upload_request(&request)?;

    Ok(UploadJobSnapshot {
        schema_version: CLIENT_CORE_SNAPSHOT_SCHEMA_VERSION,
        local_job_id: request.local_job_id,
        upload_id: request.upload_id,
        album_id: request.album_id,
        asset_id: request.asset_id,
        epoch_id: None,
        phase: UploadJobPhase::Queued,
        planned_shard_count: 0,
        planned_shards: Vec::new(),
        next_shard_index: 0,
        pending_shard: None,
        completed_shards: Vec::new(),
        manifest_receipt: None,
        retry: UploadRetryMetadata {
            attempt_count: 0,
            max_attempts: request.max_retry_count,
            retry_after_ms: None,
            last_error_code: None,
            last_error_stage: None,
            retry_target_phase: None,
        },
        confirmation_metadata: None,
        failure_code: None,
    })
}

pub fn advance_upload_job(
    snapshot: &UploadJobSnapshot,
    event: UploadJobEvent,
) -> Result<UploadJobTransition, ClientError> {
    validate_upload_snapshot(snapshot)?;

    match event {
        UploadJobEvent::StartRequested => start_upload(snapshot),
        UploadJobEvent::MediaPrepared { plan } => upload_media_prepared(snapshot, plan),
        UploadJobEvent::EpochHandleAcquired { epoch_id } => {
            upload_epoch_handle_acquired(snapshot, epoch_id)
        }
        UploadJobEvent::ShardEncrypted { shard } => upload_shard_encrypted(snapshot, shard),
        UploadJobEvent::ShardUploadCreated { upload } => {
            upload_shard_upload_created(snapshot, upload)
        }
        UploadJobEvent::ShardUploaded { shard } => upload_shard_uploaded(snapshot, shard),
        UploadJobEvent::ManifestCreated { receipt } => upload_manifest_created(snapshot, receipt),
        UploadJobEvent::ManifestOutcomeUnknown => upload_manifest_unknown(snapshot),
        UploadJobEvent::SyncConfirmed { confirmation } => {
            upload_sync_confirmed(snapshot, confirmation)
        }
        UploadJobEvent::RetryableFailure {
            code,
            retry_after_ms,
        } => upload_retryable_failure(snapshot, code, retry_after_ms),
        UploadJobEvent::RetryTimerElapsed => upload_retry_timer_elapsed(snapshot),
        UploadJobEvent::CancelRequested => upload_cancel_requested(snapshot),
        UploadJobEvent::NonRetryableFailure { code } => {
            upload_failed_transition(snapshot, code, Vec::new())
        }
    }
}

pub fn new_album_sync(request: AlbumSyncRequest) -> Result<AlbumSyncSnapshot, ClientError> {
    validate_album_sync_request(&request)?;

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
    validate_album_sync_snapshot(snapshot)?;

    match event {
        AlbumSyncEvent::SyncRequested { request } => sync_requested(snapshot, request),
        AlbumSyncEvent::PageFetched { page } => sync_page_fetched(snapshot, page),
        AlbumSyncEvent::PageApplied => sync_page_applied(snapshot),
        AlbumSyncEvent::RetryableFailure {
            code,
            retry_after_ms,
        } => sync_retryable_failure(snapshot, code, retry_after_ms),
        AlbumSyncEvent::RetryTimerElapsed => sync_retry_timer_elapsed(snapshot),
        AlbumSyncEvent::CancelRequested => sync_cancel_requested(snapshot),
        AlbumSyncEvent::NonRetryableFailure { code } => sync_failed_transition(snapshot, code),
    }
}

fn start_upload(snapshot: &UploadJobSnapshot) -> Result<UploadJobTransition, ClientError> {
    require_upload_phase(snapshot.phase, UploadJobPhase::Queued)?;

    let mut next = snapshot.clone();
    next.phase = UploadJobPhase::AwaitingPreparedMedia;
    next.failure_code = None;
    reset_upload_retry_progress(&mut next);
    Ok(upload_transition(next, vec![UploadJobEffect::PrepareMedia]))
}

fn upload_media_prepared(
    snapshot: &UploadJobSnapshot,
    plan: Option<PreparedMediaPlan>,
) -> Result<UploadJobTransition, ClientError> {
    require_upload_phase(snapshot.phase, UploadJobPhase::AwaitingPreparedMedia)?;
    let plan = require_payload(plan)?;
    validate_prepared_media_plan(&plan)?;

    let mut next = snapshot.clone();
    next.planned_shard_count = u32::try_from(plan.planned_shards.len())
        .map_err(|_| invalid_snapshot_error("snapshot validation failed"))?;
    next.next_shard_index = match plan.planned_shards.first() {
        Some(slot) => slot.index,
        None => return Err(invalid_snapshot_error("snapshot validation failed")),
    };
    next.planned_shards = plan.planned_shards;
    next.phase = UploadJobPhase::AwaitingEpochHandle;
    next.failure_code = None;
    reset_upload_retry_progress(&mut next);

    Ok(upload_transition(
        next,
        vec![UploadJobEffect::AcquireEpochHandle],
    ))
}

fn upload_epoch_handle_acquired(
    snapshot: &UploadJobSnapshot,
    epoch_id: Option<u32>,
) -> Result<UploadJobTransition, ClientError> {
    require_upload_phase(snapshot.phase, UploadJobPhase::AwaitingEpochHandle)?;
    let epoch_id = require_payload(epoch_id)?;

    let mut next = snapshot.clone();
    next.epoch_id = Some(epoch_id);
    next.phase = UploadJobPhase::EncryptingShard;
    next.failure_code = None;
    reset_upload_retry_progress(&mut next);
    let effects = upload_effects_for_phase(&next, UploadJobPhase::EncryptingShard)?;

    Ok(upload_transition(next, effects))
}

fn upload_shard_encrypted(
    snapshot: &UploadJobSnapshot,
    shard: Option<EncryptedShardRef>,
) -> Result<UploadJobTransition, ClientError> {
    require_upload_phase(snapshot.phase, UploadJobPhase::EncryptingShard)?;
    let shard = require_payload(shard)?;
    validate_encrypted_shard_ref(&shard)?;
    let expected = next_upload_slot(snapshot)?;
    if expected.tier != shard.tier || expected.index != shard.index {
        return Err(invalid_transition_error("invalid state transition"));
    }

    let mut next = snapshot.clone();
    next.pending_shard = Some(PendingShardRef {
        tier: shard.tier,
        index: shard.index,
        sha256: shard.sha256,
        shard_id: None,
    });
    next.phase = UploadJobPhase::CreatingShardUpload;
    next.failure_code = None;
    reset_upload_retry_progress(&mut next);
    let effects = upload_effects_for_phase(&next, UploadJobPhase::CreatingShardUpload)?;

    Ok(upload_transition(next, effects))
}

fn upload_shard_upload_created(
    snapshot: &UploadJobSnapshot,
    upload: Option<CreatedShardUpload>,
) -> Result<UploadJobTransition, ClientError> {
    require_upload_phase(snapshot.phase, UploadJobPhase::CreatingShardUpload)?;
    let upload = require_payload(upload)?;
    validate_created_shard_upload(&upload)?;
    let pending = require_pending_shard(snapshot)?;
    if pending.tier != upload.tier
        || pending.index != upload.index
        || pending.sha256 != upload.sha256
    {
        return Err(invalid_transition_error("invalid state transition"));
    }

    let mut next = snapshot.clone();
    next.pending_shard = Some(PendingShardRef {
        tier: upload.tier,
        index: upload.index,
        sha256: upload.sha256,
        shard_id: Some(upload.shard_id),
    });
    next.phase = UploadJobPhase::UploadingShard;
    next.failure_code = None;
    reset_upload_retry_progress(&mut next);
    let effects = upload_effects_for_phase(&next, UploadJobPhase::UploadingShard)?;

    Ok(upload_transition(next, effects))
}

fn upload_shard_uploaded(
    snapshot: &UploadJobSnapshot,
    shard: Option<CompletedShardRef>,
) -> Result<UploadJobTransition, ClientError> {
    require_upload_phase(snapshot.phase, UploadJobPhase::UploadingShard)?;
    let shard = require_payload(shard)?;
    validate_completed_shard_ref(&shard)?;
    let pending = require_pending_shard(snapshot)?;
    let pending_shard_id = match &pending.shard_id {
        Some(value) => value,
        None => return Err(invalid_snapshot_error("snapshot validation failed")),
    };
    if pending.tier != shard.tier
        || pending.index != shard.index
        || pending.sha256 != shard.sha256
        || pending_shard_id != &shard.shard_id
    {
        return Err(invalid_transition_error("invalid state transition"));
    }

    let mut next = snapshot.clone();
    next.completed_shards.push(shard);
    next.pending_shard = None;
    next.failure_code = None;
    reset_upload_retry_progress(&mut next);

    if next.completed_shards.len() < next.planned_shards.len() {
        next.phase = UploadJobPhase::EncryptingShard;
        next.next_shard_index = next_upload_slot(&next)?.index;
        let effects = upload_effects_for_phase(&next, UploadJobPhase::EncryptingShard)?;
        Ok(upload_transition(next, effects))
    } else {
        next.phase = UploadJobPhase::CreatingManifest;
        next.next_shard_index = next.planned_shard_count;
        Ok(upload_transition(
            next,
            vec![UploadJobEffect::CreateManifest],
        ))
    }
}

fn upload_manifest_created(
    snapshot: &UploadJobSnapshot,
    receipt: Option<ManifestReceipt>,
) -> Result<UploadJobTransition, ClientError> {
    require_upload_phase(snapshot.phase, UploadJobPhase::CreatingManifest)?;
    let receipt = require_payload(receipt)?;
    validate_manifest_receipt(&receipt)?;

    let mut next = snapshot.clone();
    next.manifest_receipt = Some(receipt);
    next.phase = UploadJobPhase::AwaitingSyncConfirmation;
    next.failure_code = None;
    reset_upload_retry_progress(&mut next);

    Ok(upload_transition(
        next,
        vec![UploadJobEffect::AwaitSyncConfirmation],
    ))
}

fn upload_manifest_unknown(
    snapshot: &UploadJobSnapshot,
) -> Result<UploadJobTransition, ClientError> {
    match snapshot.phase {
        UploadJobPhase::CreatingManifest | UploadJobPhase::ManifestCommitUnknown => {
            let mut next = snapshot.clone();
            next.phase = UploadJobPhase::ManifestCommitUnknown;
            next.failure_code = Some(ClientErrorCode::ClientCoreManifestOutcomeUnknown);
            Ok(upload_transition(
                next,
                vec![UploadJobEffect::RecoverManifestThroughSync],
            ))
        }
        _ => Err(invalid_transition_error("invalid state transition")),
    }
}

fn upload_sync_confirmed(
    snapshot: &UploadJobSnapshot,
    confirmation: Option<UploadSyncConfirmation>,
) -> Result<UploadJobTransition, ClientError> {
    match snapshot.phase {
        UploadJobPhase::AwaitingSyncConfirmation | UploadJobPhase::ManifestCommitUnknown => {}
        _ => return Err(invalid_transition_error("invalid state transition")),
    }

    let confirmation = require_payload(confirmation)?;
    validate_upload_sync_confirmation(&confirmation)?;
    if confirmation.asset_id != snapshot.asset_id {
        return Err(invalid_transition_error("invalid state transition"));
    }

    let mut next = snapshot.clone();
    next.phase = UploadJobPhase::Confirmed;
    next.confirmation_metadata = Some(confirmation);
    next.failure_code = None;
    reset_upload_retry_progress(&mut next);

    Ok(upload_transition(next, Vec::new()))
}

fn upload_retryable_failure(
    snapshot: &UploadJobSnapshot,
    code: ClientErrorCode,
    retry_after_ms: Option<u64>,
) -> Result<UploadJobTransition, ClientError> {
    if !upload_phase_allows_retry(snapshot.phase) {
        return Err(invalid_transition_error("invalid state transition"));
    }

    if snapshot.retry.attempt_count >= snapshot.retry.max_attempts {
        return upload_failed_transition(
            snapshot,
            ClientErrorCode::ClientCoreRetryBudgetExhausted,
            Vec::new(),
        );
    }

    let mut next = snapshot.clone();
    let retry_after_ms = retry_after_ms.unwrap_or(DEFAULT_RETRY_AFTER_MS);
    next.retry.attempt_count = next.retry.attempt_count.saturating_add(1);
    next.retry.retry_after_ms = Some(retry_after_ms);
    next.retry.last_error_code = Some(code);
    next.retry.last_error_stage = Some(snapshot.phase);
    next.retry.retry_target_phase = Some(snapshot.phase);
    next.phase = UploadJobPhase::RetryWaiting;
    next.failure_code = None;

    Ok(upload_transition(
        next,
        vec![UploadJobEffect::ScheduleRetry {
            attempt: snapshot.retry.attempt_count.saturating_add(1),
            retry_after_ms,
            target_phase: snapshot.phase,
        }],
    ))
}

fn upload_retry_timer_elapsed(
    snapshot: &UploadJobSnapshot,
) -> Result<UploadJobTransition, ClientError> {
    require_upload_phase(snapshot.phase, UploadJobPhase::RetryWaiting)?;
    let target_phase = match snapshot.retry.retry_target_phase {
        Some(value) => value,
        None => return Err(invalid_snapshot_error("snapshot validation failed")),
    };

    let mut next = snapshot.clone();
    next.phase = target_phase;
    next.retry.retry_after_ms = None;
    next.retry.retry_target_phase = None;
    let effects = upload_effects_for_phase(&next, target_phase)?;

    Ok(upload_transition(next, effects))
}

fn upload_cancel_requested(
    snapshot: &UploadJobSnapshot,
) -> Result<UploadJobTransition, ClientError> {
    if upload_phase_is_terminal(snapshot.phase) {
        return Err(invalid_transition_error("invalid state transition"));
    }

    let mut next = snapshot.clone();
    if upload_manifest_may_have_committed(snapshot) {
        next.phase = UploadJobPhase::ManifestCommitUnknown;
        next.failure_code = Some(ClientErrorCode::ClientCoreManifestOutcomeUnknown);
        Ok(upload_transition(
            next,
            vec![UploadJobEffect::RecoverManifestThroughSync],
        ))
    } else {
        next.phase = UploadJobPhase::Cancelled;
        Ok(upload_transition(next, Vec::new()))
    }
}

fn upload_failed_transition(
    snapshot: &UploadJobSnapshot,
    code: ClientErrorCode,
    effects: Vec<UploadJobEffect>,
) -> Result<UploadJobTransition, ClientError> {
    if upload_phase_is_terminal(snapshot.phase) {
        return Err(invalid_transition_error("invalid state transition"));
    }

    let mut next = snapshot.clone();
    next.phase = UploadJobPhase::Failed;
    next.failure_code = Some(code);
    Ok(upload_transition(next, effects))
}

fn sync_requested(
    snapshot: &AlbumSyncSnapshot,
    request: Option<AlbumSyncRequest>,
) -> Result<AlbumSyncTransition, ClientError> {
    let request = require_payload(request)?;
    validate_album_sync_request(&request)?;
    if request.album_id != snapshot.album_id {
        return Err(invalid_transition_error("invalid state transition"));
    }

    if album_sync_phase_is_active(snapshot.phase) {
        let mut next = snapshot.clone();
        next.rerun_requested = true;
        return Ok(sync_transition(next, Vec::new()));
    }

    let mut next = snapshot.clone();
    next.sync_id = request.sync_id;
    next.initial_page_token = request.initial_page_token.clone();
    next.next_page_token = request.initial_page_token;
    next.current_page = None;
    next.rerun_requested = false;
    next.phase = AlbumSyncPhase::FetchingPage;
    next.failure_code = None;
    next.retry.max_attempts = request.max_retry_count;
    reset_sync_retry_progress(&mut next);

    let effects = sync_effects_for_phase(&next, AlbumSyncPhase::FetchingPage)?;
    Ok(sync_transition(next, effects))
}

fn sync_page_fetched(
    snapshot: &AlbumSyncSnapshot,
    page: Option<SyncPageSummary>,
) -> Result<AlbumSyncTransition, ClientError> {
    require_sync_phase(snapshot.phase, AlbumSyncPhase::FetchingPage)?;
    let page = require_payload(page)?;
    validate_sync_page_summary(&page)?;
    if page.previous_page_token != snapshot.next_page_token {
        return Err(invalid_transition_error("invalid state transition"));
    }
    if !page.reached_end {
        match &page.next_page_token {
            Some(next_token) if Some(next_token) != snapshot.next_page_token.as_ref() => {}
            _ => return Err(sync_page_did_not_advance_error()),
        }
    }

    let encrypted_item_count = page.encrypted_item_count;
    let mut next = snapshot.clone();
    next.current_page = Some(page);
    next.phase = AlbumSyncPhase::ApplyingPage;
    next.failure_code = None;
    reset_sync_retry_progress(&mut next);

    Ok(sync_transition(
        next,
        vec![AlbumSyncEffect::ApplyPage {
            encrypted_item_count,
        }],
    ))
}

fn sync_page_applied(snapshot: &AlbumSyncSnapshot) -> Result<AlbumSyncTransition, ClientError> {
    require_sync_phase(snapshot.phase, AlbumSyncPhase::ApplyingPage)?;
    let page = match &snapshot.current_page {
        Some(value) => value,
        None => return Err(invalid_snapshot_error("snapshot validation failed")),
    };

    let mut next = snapshot.clone();
    next.current_page = None;
    next.failure_code = None;
    reset_sync_retry_progress(&mut next);

    if page.reached_end {
        next.completed_cycle_count = next.completed_cycle_count.saturating_add(1);
        if snapshot.rerun_requested {
            next.rerun_requested = false;
            next.next_page_token = next.initial_page_token.clone();
            next.phase = AlbumSyncPhase::FetchingPage;
            let effects = sync_effects_for_phase(&next, AlbumSyncPhase::FetchingPage)?;
            Ok(sync_transition(next, effects))
        } else {
            next.phase = AlbumSyncPhase::Completed;
            Ok(sync_transition(next, Vec::new()))
        }
    } else {
        next.next_page_token = page.next_page_token.clone();
        next.phase = AlbumSyncPhase::FetchingPage;
        let effects = sync_effects_for_phase(&next, AlbumSyncPhase::FetchingPage)?;
        Ok(sync_transition(next, effects))
    }
}

fn sync_retryable_failure(
    snapshot: &AlbumSyncSnapshot,
    code: ClientErrorCode,
    retry_after_ms: Option<u64>,
) -> Result<AlbumSyncTransition, ClientError> {
    if !album_sync_phase_allows_retry(snapshot.phase) {
        return Err(invalid_transition_error("invalid state transition"));
    }

    if snapshot.retry.attempt_count >= snapshot.retry.max_attempts {
        return sync_failed_transition(snapshot, ClientErrorCode::ClientCoreRetryBudgetExhausted);
    }

    let mut next = snapshot.clone();
    let retry_after_ms = retry_after_ms.unwrap_or(DEFAULT_RETRY_AFTER_MS);
    next.retry.attempt_count = next.retry.attempt_count.saturating_add(1);
    next.retry.retry_after_ms = Some(retry_after_ms);
    next.retry.last_error_code = Some(code);
    next.retry.last_error_stage = Some(snapshot.phase);
    next.retry.retry_target_phase = Some(snapshot.phase);
    next.phase = AlbumSyncPhase::RetryWaiting;
    next.failure_code = None;

    Ok(sync_transition(
        next,
        vec![AlbumSyncEffect::ScheduleRetry {
            attempt: snapshot.retry.attempt_count.saturating_add(1),
            retry_after_ms,
            target_phase: snapshot.phase,
        }],
    ))
}

fn sync_retry_timer_elapsed(
    snapshot: &AlbumSyncSnapshot,
) -> Result<AlbumSyncTransition, ClientError> {
    require_sync_phase(snapshot.phase, AlbumSyncPhase::RetryWaiting)?;
    let target_phase = match snapshot.retry.retry_target_phase {
        Some(value) => value,
        None => return Err(invalid_snapshot_error("snapshot validation failed")),
    };

    let mut next = snapshot.clone();
    next.phase = target_phase;
    next.retry.retry_after_ms = None;
    next.retry.retry_target_phase = None;
    let effects = sync_effects_for_phase(&next, target_phase)?;

    Ok(sync_transition(next, effects))
}

fn sync_cancel_requested(snapshot: &AlbumSyncSnapshot) -> Result<AlbumSyncTransition, ClientError> {
    if album_sync_phase_is_terminal(snapshot.phase) {
        return Err(invalid_transition_error("invalid state transition"));
    }

    let mut next = snapshot.clone();
    next.phase = AlbumSyncPhase::Cancelled;
    Ok(sync_transition(next, Vec::new()))
}

fn sync_failed_transition(
    snapshot: &AlbumSyncSnapshot,
    code: ClientErrorCode,
) -> Result<AlbumSyncTransition, ClientError> {
    if album_sync_phase_is_terminal(snapshot.phase) {
        return Err(invalid_transition_error("invalid state transition"));
    }

    let mut next = snapshot.clone();
    next.phase = AlbumSyncPhase::Failed;
    next.failure_code = Some(code);
    Ok(sync_transition(next, Vec::new()))
}

fn upload_effects_for_phase(
    snapshot: &UploadJobSnapshot,
    phase: UploadJobPhase,
) -> Result<Vec<UploadJobEffect>, ClientError> {
    match phase {
        UploadJobPhase::AwaitingPreparedMedia => Ok(vec![UploadJobEffect::PrepareMedia]),
        UploadJobPhase::AwaitingEpochHandle => Ok(vec![UploadJobEffect::AcquireEpochHandle]),
        UploadJobPhase::EncryptingShard => {
            let slot = next_upload_slot(snapshot)?;
            Ok(vec![UploadJobEffect::EncryptShard {
                tier: slot.tier,
                index: slot.index,
            }])
        }
        UploadJobPhase::CreatingShardUpload => {
            let pending = require_pending_shard(snapshot)?;
            Ok(vec![UploadJobEffect::CreateShardUpload {
                tier: pending.tier,
                index: pending.index,
                sha256: pending.sha256.clone(),
            }])
        }
        UploadJobPhase::UploadingShard => {
            let pending = require_pending_shard(snapshot)?;
            let shard_id = match &pending.shard_id {
                Some(value) => value.clone(),
                None => return Err(invalid_snapshot_error("snapshot validation failed")),
            };
            Ok(vec![UploadJobEffect::UploadShard {
                tier: pending.tier,
                index: pending.index,
                shard_id,
                sha256: pending.sha256.clone(),
            }])
        }
        UploadJobPhase::CreatingManifest => Ok(vec![UploadJobEffect::CreateManifest]),
        UploadJobPhase::ManifestCommitUnknown => {
            Ok(vec![UploadJobEffect::RecoverManifestThroughSync])
        }
        UploadJobPhase::AwaitingSyncConfirmation => {
            Ok(vec![UploadJobEffect::AwaitSyncConfirmation])
        }
        _ => Err(invalid_transition_error("invalid state transition")),
    }
}

fn sync_effects_for_phase(
    snapshot: &AlbumSyncSnapshot,
    phase: AlbumSyncPhase,
) -> Result<Vec<AlbumSyncEffect>, ClientError> {
    match phase {
        AlbumSyncPhase::FetchingPage => Ok(vec![AlbumSyncEffect::FetchPage {
            page_token: snapshot.next_page_token.clone(),
        }]),
        AlbumSyncPhase::ApplyingPage => match &snapshot.current_page {
            Some(page) => Ok(vec![AlbumSyncEffect::ApplyPage {
                encrypted_item_count: page.encrypted_item_count,
            }]),
            None => Err(invalid_snapshot_error("snapshot validation failed")),
        },
        _ => Err(invalid_transition_error("invalid state transition")),
    }
}

fn next_upload_slot(snapshot: &UploadJobSnapshot) -> Result<&UploadShardSlot, ClientError> {
    match snapshot.planned_shards.get(snapshot.completed_shards.len()) {
        Some(slot) => Ok(slot),
        None => Err(invalid_snapshot_error("snapshot validation failed")),
    }
}

fn require_pending_shard(snapshot: &UploadJobSnapshot) -> Result<&PendingShardRef, ClientError> {
    match &snapshot.pending_shard {
        Some(value) => Ok(value),
        None => Err(invalid_snapshot_error("snapshot validation failed")),
    }
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

fn require_sync_phase(actual: AlbumSyncPhase, expected: AlbumSyncPhase) -> Result<(), ClientError> {
    if actual == expected {
        Ok(())
    } else {
        Err(invalid_transition_error("invalid state transition"))
    }
}

fn require_payload<T>(payload: Option<T>) -> Result<T, ClientError> {
    match payload {
        Some(value) => Ok(value),
        None => Err(ClientError::new(
            ClientErrorCode::ClientCoreMissingEventPayload,
            "required event payload is missing",
        )),
    }
}

fn reset_upload_retry_progress(snapshot: &mut UploadJobSnapshot) {
    snapshot.retry.attempt_count = 0;
    snapshot.retry.retry_after_ms = None;
    snapshot.retry.last_error_code = None;
    snapshot.retry.last_error_stage = None;
    snapshot.retry.retry_target_phase = None;
}

fn reset_sync_retry_progress(snapshot: &mut AlbumSyncSnapshot) {
    snapshot.retry.attempt_count = 0;
    snapshot.retry.retry_after_ms = None;
    snapshot.retry.last_error_code = None;
    snapshot.retry.last_error_stage = None;
    snapshot.retry.retry_target_phase = None;
}

fn upload_transition(
    snapshot: UploadJobSnapshot,
    effects: Vec<UploadJobEffect>,
) -> UploadJobTransition {
    UploadJobTransition { snapshot, effects }
}

fn sync_transition(
    snapshot: AlbumSyncSnapshot,
    effects: Vec<AlbumSyncEffect>,
) -> AlbumSyncTransition {
    AlbumSyncTransition { snapshot, effects }
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
            | UploadJobPhase::ManifestCommitUnknown
            | UploadJobPhase::AwaitingSyncConfirmation
    )
}

fn upload_phase_is_terminal(phase: UploadJobPhase) -> bool {
    matches!(
        phase,
        UploadJobPhase::Confirmed | UploadJobPhase::Cancelled | UploadJobPhase::Failed
    )
}

fn upload_manifest_may_have_committed(snapshot: &UploadJobSnapshot) -> bool {
    match snapshot.phase {
        UploadJobPhase::CreatingManifest
        | UploadJobPhase::ManifestCommitUnknown
        | UploadJobPhase::AwaitingSyncConfirmation => true,
        UploadJobPhase::RetryWaiting => snapshot.retry.retry_target_phase.is_some_and(|phase| {
            matches!(
                phase,
                UploadJobPhase::CreatingManifest
                    | UploadJobPhase::ManifestCommitUnknown
                    | UploadJobPhase::AwaitingSyncConfirmation
            )
        }),
        _ => false,
    }
}

fn album_sync_phase_is_active(phase: AlbumSyncPhase) -> bool {
    matches!(
        phase,
        AlbumSyncPhase::FetchingPage | AlbumSyncPhase::ApplyingPage | AlbumSyncPhase::RetryWaiting
    )
}

fn album_sync_phase_allows_retry(phase: AlbumSyncPhase) -> bool {
    matches!(
        phase,
        AlbumSyncPhase::FetchingPage | AlbumSyncPhase::ApplyingPage
    )
}

fn album_sync_phase_is_terminal(phase: AlbumSyncPhase) -> bool {
    matches!(phase, AlbumSyncPhase::Cancelled | AlbumSyncPhase::Failed)
}

fn validate_upload_request(request: &UploadJobRequest) -> Result<(), ClientError> {
    validate_safe_text(&request.local_job_id)?;
    validate_safe_text(&request.upload_id)?;
    validate_safe_text(&request.album_id)?;
    validate_safe_text(&request.asset_id)?;
    validate_request_max_retry_count(request.max_retry_count)?;
    Ok(())
}

fn validate_upload_snapshot(snapshot: &UploadJobSnapshot) -> Result<(), ClientError> {
    if snapshot.schema_version != CLIENT_CORE_SNAPSHOT_SCHEMA_VERSION {
        return Err(ClientError::new(
            ClientErrorCode::ClientCoreUnsupportedSnapshotVersion,
            "snapshot schema version is unsupported",
        ));
    }
    validate_safe_text(&snapshot.local_job_id)?;
    validate_safe_text(&snapshot.upload_id)?;
    validate_safe_text(&snapshot.album_id)?;
    validate_safe_text(&snapshot.asset_id)?;
    validate_snapshot_retry_bounds(snapshot.retry.attempt_count, snapshot.retry.max_attempts)?;
    validate_prepared_shards(&snapshot.planned_shards)?;
    if usize::try_from(snapshot.planned_shard_count)
        .map_err(|_| invalid_snapshot_error("snapshot validation failed"))?
        != snapshot.planned_shards.len()
    {
        return Err(invalid_snapshot_error("snapshot validation failed"));
    }
    if snapshot.completed_shards.len() > snapshot.planned_shards.len() {
        return Err(invalid_snapshot_error("snapshot validation failed"));
    }
    validate_completed_shards(&snapshot.completed_shards)?;
    if let Some(pending) = &snapshot.pending_shard {
        validate_pending_shard_ref(pending)?;
    }
    if let Some(receipt) = &snapshot.manifest_receipt {
        validate_manifest_receipt(receipt)?;
    }
    if let Some(confirmation) = &snapshot.confirmation_metadata {
        validate_upload_sync_confirmation(confirmation)?;
        if confirmation.asset_id != snapshot.asset_id {
            return Err(invalid_snapshot_error("snapshot validation failed"));
        }
    }
    Ok(())
}

fn validate_prepared_media_plan(plan: &PreparedMediaPlan) -> Result<(), ClientError> {
    if plan.planned_shards.is_empty() || plan.planned_shards.len() > MAX_PLANNED_SHARDS {
        return Err(invalid_snapshot_error("snapshot validation failed"));
    }
    validate_prepared_shards(&plan.planned_shards)
}

fn validate_prepared_shards(shards: &[UploadShardSlot]) -> Result<(), ClientError> {
    let mut seen = HashSet::with_capacity(shards.len());
    for slot in shards {
        validate_shard_tier(slot.tier)?;
        if !seen.insert((slot.tier, slot.index)) {
            return Err(invalid_snapshot_error("snapshot validation failed"));
        }
    }
    Ok(())
}

fn validate_encrypted_shard_ref(shard: &EncryptedShardRef) -> Result<(), ClientError> {
    validate_shard_tier(shard.tier)?;
    validate_safe_text(&shard.sha256)
}

fn validate_created_shard_upload(upload: &CreatedShardUpload) -> Result<(), ClientError> {
    validate_shard_tier(upload.tier)?;
    validate_safe_text(&upload.shard_id)?;
    validate_safe_text(&upload.sha256)
}

fn validate_completed_shards(shards: &[CompletedShardRef]) -> Result<(), ClientError> {
    let mut seen = HashSet::with_capacity(shards.len());
    for shard in shards {
        validate_completed_shard_ref(shard)?;
        if !seen.insert((shard.tier, shard.index)) {
            return Err(invalid_snapshot_error("snapshot validation failed"));
        }
    }
    Ok(())
}

fn validate_completed_shard_ref(shard: &CompletedShardRef) -> Result<(), ClientError> {
    validate_shard_tier(shard.tier)?;
    validate_safe_text(&shard.shard_id)?;
    validate_safe_text(&shard.sha256)
}

fn validate_pending_shard_ref(shard: &PendingShardRef) -> Result<(), ClientError> {
    validate_shard_tier(shard.tier)?;
    validate_safe_text(&shard.sha256)?;
    if let Some(shard_id) = &shard.shard_id {
        validate_safe_text(shard_id)?;
    }
    Ok(())
}

fn validate_manifest_receipt(receipt: &ManifestReceipt) -> Result<(), ClientError> {
    validate_safe_text(&receipt.manifest_id)
}

fn validate_upload_sync_confirmation(
    confirmation: &UploadSyncConfirmation,
) -> Result<(), ClientError> {
    validate_safe_text(&confirmation.asset_id)?;
    validate_optional_safe_text(&confirmation.sync_cursor)
}

fn validate_album_sync_request(request: &AlbumSyncRequest) -> Result<(), ClientError> {
    validate_safe_text(&request.sync_id)?;
    validate_safe_text(&request.album_id)?;
    validate_optional_safe_text(&request.initial_page_token)?;
    validate_request_max_retry_count(request.max_retry_count)
}

fn validate_album_sync_snapshot(snapshot: &AlbumSyncSnapshot) -> Result<(), ClientError> {
    if snapshot.schema_version != CLIENT_CORE_SNAPSHOT_SCHEMA_VERSION {
        return Err(ClientError::new(
            ClientErrorCode::ClientCoreUnsupportedSnapshotVersion,
            "snapshot schema version is unsupported",
        ));
    }
    validate_safe_text(&snapshot.sync_id)?;
    validate_safe_text(&snapshot.album_id)?;
    validate_optional_safe_text(&snapshot.initial_page_token)?;
    validate_optional_safe_text(&snapshot.next_page_token)?;
    validate_snapshot_retry_bounds(snapshot.retry.attempt_count, snapshot.retry.max_attempts)?;
    if let Some(page) = &snapshot.current_page {
        validate_sync_page_summary(page)?;
    }
    if snapshot.phase == AlbumSyncPhase::ApplyingPage && snapshot.current_page.is_none() {
        return Err(invalid_snapshot_error("snapshot validation failed"));
    }
    Ok(())
}

fn validate_sync_page_summary(page: &SyncPageSummary) -> Result<(), ClientError> {
    validate_optional_safe_text(&page.previous_page_token)?;
    validate_optional_safe_text(&page.next_page_token)
}

fn validate_optional_safe_text(value: &Option<String>) -> Result<(), ClientError> {
    if let Some(text) = value {
        validate_safe_text(text)?;
    }
    Ok(())
}

fn validate_shard_tier(tier: u8) -> Result<(), ClientError> {
    if (1..=3).contains(&tier) {
        Ok(())
    } else {
        Err(invalid_snapshot_error("snapshot validation failed"))
    }
}

fn validate_safe_text(value: &str) -> Result<(), ClientError> {
    let normalized = value.to_ascii_lowercase();
    let forbidden_extension = [
        ".jpg", ".jpeg", ".png", ".gif", ".heic", ".heif", ".webp", ".avif", ".mp4", ".mov",
    ]
    .iter()
    .any(|extension| normalized.ends_with(extension));

    if value.is_empty()
        || value.len() > MAX_SAFE_TEXT_LEN
        || value.chars().any(char::is_control)
        || value.contains('/')
        || value.contains('\\')
        || normalized.contains("://")
        || normalized.starts_with("content:")
        || normalized.starts_with("file:")
        || forbidden_extension
    {
        return Err(invalid_snapshot_error("snapshot validation failed"));
    }

    Ok(())
}

fn invalid_transition_error(message: &'static str) -> ClientError {
    ClientError::new(ClientErrorCode::ClientCoreInvalidTransition, message)
}

fn invalid_snapshot_error(message: &'static str) -> ClientError {
    ClientError::new(ClientErrorCode::ClientCoreInvalidSnapshot, message)
}

fn validate_request_max_retry_count(max_retry_count: u32) -> Result<(), ClientError> {
    if max_retry_count > MAX_RETRY_COUNT_LIMIT {
        return Err(ClientError::new(
            ClientErrorCode::InvalidInputLength,
            "max_retry_count exceeds MAX_RETRY_COUNT_LIMIT",
        ));
    }
    Ok(())
}

fn validate_snapshot_retry_bounds(
    attempt_count: u32,
    max_attempts: u32,
) -> Result<(), ClientError> {
    if max_attempts > MAX_RETRY_COUNT_LIMIT {
        return Err(invalid_snapshot_error("snapshot validation failed"));
    }
    if attempt_count > max_attempts {
        return Err(invalid_snapshot_error("snapshot validation failed"));
    }
    Ok(())
}

fn sync_page_did_not_advance_error() -> ClientError {
    ClientError::new(
        ClientErrorCode::ClientCoreSyncPageDidNotAdvance,
        "sync page did not advance",
    )
}
