//! Download orchestrator skeleton.
//!
//! This module owns the pure Rust foundation for album downloads: a job state
//! machine, a resumable CBOR snapshot schema, a tier-3-only plan builder, and
//! atomic snapshot commit primitives. Browser/native I/O (fetching, OPFS,
//! renames, ZIP/directory output) is intentionally out of scope for Phase 1.
//!
//! Snapshot persistence granularity for Phase 1: every `DownloadJobState`
//! transition and every per-photo status transition (`Pending`/`InFlight`/
//! `Done`/`Failed`/`Skipped`) must be persisted. Per-shard byte progress does
//! not trigger a snapshot until a later rate-limited progress phase.
//!
//! Plan invariant: every [`DownloadPlanEntry`] represents exactly one photo in
//! exactly one epoch. If a photo's tier-3 shards span multiple epochs (for
//! example after historical re-keying), [`DownloadPlanBuilder::build`] rejects
//! the plan with [`DownloadPlanError::MultiEpochPhoto`].

pub mod error;
pub mod plan;
pub mod scope;
pub mod snapshot;
pub mod state;

pub use error::{DownloadError, DownloadErrorCode};
pub use plan::{
    DownloadPlan, DownloadPlanBuilder, DownloadPlanEntry, DownloadPlanError, DownloadPlanInput,
    DownloadShardInput, PhotoId, ShardId, sanitize_download_filename,
};
pub use snapshot::{
    CURRENT_DOWNLOAD_SNAPSHOT_SCHEMA_VERSION, DownloadFailureEntry, DownloadJobSnapshot,
    DownloadSnapshotDecode, DownloadSnapshotError, DownloadSnapshotResumeRepair, JobId, LeaseToken,
    PhotoState, SnapshotBytes, SnapshotTruncation, download_job_snapshot_keys,
    download_job_state_codes, encode_snapshot_bytes, prepare_snapshot_bytes,
    repair_snapshot_for_resume, upgrade_download_snapshot,
};
pub use state::{
    DownloadJobEvent, DownloadJobState, DownloadSideEffect, PhotoStatus, SkipReason,
    TransitionError, apply,
};
