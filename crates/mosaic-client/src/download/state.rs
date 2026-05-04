use crate::download::DownloadErrorCode;

/// Download job transition table.
///
/// | State | Event | Next state | Notes |
/// |---|---|---|---|
/// | `Idle` | `StartRequested` | `Preparing` | job metadata is carried by the event; plan construction is external. |
/// | `Preparing` | `PlanReady` | `Running` | empty plans are valid and move to `Running`. |
/// | `Preparing`/`Running`/`Paused` | `ErrorEncountered` | `Errored` | terminal; includes `AccessRevoked` and `AuthorizationChanged`. |
/// | `Running` | `PauseRequested` | `Paused` | active work should stop scheduling. |
/// | `Paused` | `ResumeRequested` | `Running` | resume queued photo work. |
/// | `Running` | `AllPhotosDone` | `Finalizing` | output consumer finalization begins. |
/// | `Finalizing` | `FinalizationDone` | `Done` | terminal success. |
/// | `Idle`/`Preparing`/`Running`/`Paused` | `CancelRequested { soft }` | `Cancelled { soft }` | soft preserves staged files; hard purges staged files. |
/// | `Finalizing` | `CancelRequested { soft: true }` | `Cancelled { soft: true }` | staged files preserved; caller purges partial output. |
/// | `Finalizing` | `CancelRequested { soft: false }` | `Cancelled { soft: false }` | staged files and partial output are purged. |
/// | `Cancelled { soft: true }` | `CancelRequested { soft: false }` | `Cancelled { soft: false }` | escalation to hard cancel is allowed. |
/// | `Cancelled { soft: false }` | `CancelRequested { soft: true }` | illegal | cannot un-purge staged files. |
/// | `Done`/`Errored`/`Cancelled` | `CancelRequested` | unchanged | terminal cancel replay is idempotent except soft-after-hard cancel. |
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum DownloadJobState {
    Idle,
    Preparing,
    Running,
    Paused,
    Finalizing,
    Done,
    Errored { reason: DownloadErrorCode },
    Cancelled { soft: bool },
}

impl DownloadJobState {
    #[must_use]
    pub const fn to_u8(&self) -> u8 {
        match self {
            Self::Idle => crate::download::snapshot::download_job_state_codes::IDLE,
            Self::Preparing => crate::download::snapshot::download_job_state_codes::PREPARING,
            Self::Running => crate::download::snapshot::download_job_state_codes::RUNNING,
            Self::Paused => crate::download::snapshot::download_job_state_codes::PAUSED,
            Self::Finalizing => crate::download::snapshot::download_job_state_codes::FINALIZING,
            Self::Done => crate::download::snapshot::download_job_state_codes::DONE,
            Self::Errored { .. } => crate::download::snapshot::download_job_state_codes::ERRORED,
            Self::Cancelled { .. } => {
                crate::download::snapshot::download_job_state_codes::CANCELLED
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DownloadJobEvent {
    StartRequested {
        job_id: crate::download::snapshot::JobId,
        album_id: crate::Uuid,
    },
    PlanReady,
    PauseRequested,
    ResumeRequested,
    CancelRequested {
        soft: bool,
    },
    ErrorEncountered {
        reason: DownloadErrorCode,
    },
    AllPhotosDone,
    FinalizationDone,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadSideEffect {
    PurgeOutput,
    PurgeStaging,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransitionError {
    pub from: DownloadJobState,
    pub event: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum PhotoStatus {
    Pending,
    InFlight,
    Done,
    Failed { reason: DownloadErrorCode },
    Skipped { reason: SkipReason },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SkipReason {
    NotFound,
    UserExcluded,
}

#[must_use]
pub const fn event_persists_snapshot(_event: &DownloadJobEvent) -> bool {
    true
}

pub fn apply(
    state: &DownloadJobState,
    event: &DownloadJobEvent,
) -> Result<DownloadJobState, TransitionError> {
    use DownloadJobEvent as E;
    use DownloadJobState as S;
    let next = match (state, event) {
        (S::Idle, E::StartRequested { .. }) => S::Preparing,
        (S::Preparing, E::PlanReady) => S::Running,
        (S::Running, E::PauseRequested) => S::Paused,
        (S::Paused, E::ResumeRequested) => S::Running,
        (S::Running, E::AllPhotosDone) => S::Finalizing,
        (S::Finalizing, E::FinalizationDone) => S::Done,
        (S::Idle | S::Preparing | S::Running | S::Paused, E::CancelRequested { soft }) => {
            S::Cancelled { soft: *soft }
        }
        (S::Finalizing, E::CancelRequested { soft }) => S::Cancelled { soft: *soft },
        (S::Cancelled { soft: true }, E::CancelRequested { soft: false }) => {
            S::Cancelled { soft: false }
        }
        (S::Cancelled { soft: false }, E::CancelRequested { soft: true }) => {
            return Err(TransitionError {
                from: state.clone(),
                event: event_name(event),
            });
        }
        (S::Done | S::Errored { .. } | S::Cancelled { .. }, E::CancelRequested { .. }) => {
            state.clone()
        }
        (S::Preparing | S::Running | S::Paused | S::Finalizing, E::ErrorEncountered { reason }) => {
            S::Errored { reason: *reason }
        }
        (S::Errored { .. }, E::ErrorEncountered { .. }) | (S::Done, E::FinalizationDone) => {
            state.clone()
        }
        _ => {
            return Err(TransitionError {
                from: state.clone(),
                event: event_name(event),
            });
        }
    };
    Ok(next)
}

#[must_use]
pub const fn event_name(event: &DownloadJobEvent) -> &'static str {
    match event {
        DownloadJobEvent::StartRequested { .. } => "StartRequested",
        DownloadJobEvent::PlanReady => "PlanReady",
        DownloadJobEvent::PauseRequested => "PauseRequested",
        DownloadJobEvent::ResumeRequested => "ResumeRequested",
        DownloadJobEvent::CancelRequested { .. } => "CancelRequested",
        DownloadJobEvent::ErrorEncountered { .. } => "ErrorEncountered",
        DownloadJobEvent::AllPhotosDone => "AllPhotosDone",
        DownloadJobEvent::FinalizationDone => "FinalizationDone",
    }
}

#[must_use]
pub fn photo_status_persists_snapshot(before: &PhotoStatus, after: &PhotoStatus) -> bool {
    before != after
}
