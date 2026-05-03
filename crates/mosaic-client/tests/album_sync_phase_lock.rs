#![allow(clippy::expect_used, clippy::unwrap_used)]

use mosaic_client::{
    AlbumSyncEffect, AlbumSyncEvent, AlbumSyncPhase, AlbumSyncRequest, AlbumSyncSnapshot,
    ClientErrorCode, SyncPageSummary, advance_album_sync, new_album_sync,
};

fn request() -> AlbumSyncRequest {
    AlbumSyncRequest {
        sync_id: "sync-phase-lock".to_owned(),
        album_id: "album-phase-lock".to_owned(),
        initial_page_token: Some("start".to_owned()),
        max_retry_count: 3,
    }
}

fn snapshot() -> AlbumSyncSnapshot {
    new_album_sync(request()).expect("album sync initializes")
}

fn page(reached_end: bool) -> SyncPageSummary {
    SyncPageSummary {
        previous_page_token: Some("prev".to_owned()),
        next_page_token: (!reached_end).then_some("next".to_owned()),
        reached_end,
        encrypted_item_count: 2,
    }
}

fn assert_invalid_transition(
    result: Result<mosaic_client::AlbumSyncTransition, mosaic_client::ClientError>,
) {
    assert_eq!(
        result.expect_err("transition should be rejected").code,
        ClientErrorCode::ClientCoreInvalidTransition
    );
}

#[test]
fn album_sync_completed_to_apply_page_rejected() {
    let mut completed = snapshot();
    completed.phase = AlbumSyncPhase::Completed;

    assert_invalid_transition(advance_album_sync(
        &completed,
        AlbumSyncEvent::PageFetched {
            page: Some(page(false)),
        },
    ));
}

#[test]
fn album_sync_completed_retryable_failure_rejected() {
    let mut completed = snapshot();
    completed.phase = AlbumSyncPhase::Completed;

    assert_invalid_transition(advance_album_sync(
        &completed,
        AlbumSyncEvent::RetryableFailure {
            code: ClientErrorCode::InvalidInputLength,
            retry_after_ms: Some(100),
        },
    ));
}

#[test]
fn album_sync_cancelled_cancel_requested_idempotent() {
    let mut cancelled = snapshot();
    cancelled.phase = AlbumSyncPhase::Cancelled;

    let transition = advance_album_sync(&cancelled, AlbumSyncEvent::CancelRequested).unwrap();

    assert_eq!(transition.snapshot, cancelled);
    assert!(transition.effects.is_empty());
}

#[test]
fn album_sync_cancelled_to_apply_page_rejected() {
    let mut cancelled = snapshot();
    cancelled.phase = AlbumSyncPhase::Cancelled;

    assert_invalid_transition(advance_album_sync(
        &cancelled,
        AlbumSyncEvent::PageFetched {
            page: Some(page(false)),
        },
    ));
}

#[test]
fn album_sync_retry_timer_elapsed_requires_retry_waiting() {
    let fetching = advance_album_sync(
        &snapshot(),
        AlbumSyncEvent::SyncRequested {
            request: Some(request()),
        },
    )
    .unwrap()
    .snapshot;

    assert_invalid_transition(advance_album_sync(
        &fetching,
        AlbumSyncEvent::RetryTimerElapsed,
    ));
}

#[test]
fn album_sync_retry_timer_elapsed_requires_retry_target_phase_set() {
    let mut retrying = snapshot();
    retrying.phase = AlbumSyncPhase::RetryWaiting;
    retrying.retry.retry_target_phase = None;

    assert_eq!(
        advance_album_sync(&retrying, AlbumSyncEvent::RetryTimerElapsed)
            .expect_err("missing retry target is corrupt snapshot")
            .code,
        ClientErrorCode::ClientCoreInvalidSnapshot
    );
}

#[test]
fn album_sync_positive_phase_event_matrix_succeeds() {
    let idle = snapshot();
    let fetching = advance_album_sync(
        &idle,
        AlbumSyncEvent::SyncRequested {
            request: Some(request()),
        },
    )
    .unwrap();
    assert_eq!(fetching.snapshot.phase, AlbumSyncPhase::FetchingPage);
    assert!(matches!(
        fetching.effects.as_slice(),
        [AlbumSyncEffect::FetchPage { .. }]
    ));

    let active_rerun = advance_album_sync(
        &fetching.snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(request()),
        },
    )
    .unwrap();
    assert_eq!(active_rerun.snapshot.phase, AlbumSyncPhase::FetchingPage);
    assert!(active_rerun.snapshot.rerun_requested);
    assert!(active_rerun.effects.is_empty());

    let applying = advance_album_sync(
        &fetching.snapshot,
        AlbumSyncEvent::PageFetched {
            page: Some(page(false)),
        },
    )
    .unwrap();
    assert_eq!(applying.snapshot.phase, AlbumSyncPhase::ApplyingPage);
    assert!(matches!(
        applying.effects.as_slice(),
        [AlbumSyncEffect::ApplyPage {
            encrypted_item_count: 2
        }]
    ));

    let next_fetch = advance_album_sync(&applying.snapshot, AlbumSyncEvent::PageApplied).unwrap();
    assert_eq!(next_fetch.snapshot.phase, AlbumSyncPhase::FetchingPage);
    assert!(matches!(
        next_fetch.effects.as_slice(),
        [AlbumSyncEffect::FetchPage { .. }]
    ));

    let retry_from_fetch = advance_album_sync(
        &next_fetch.snapshot,
        AlbumSyncEvent::RetryableFailure {
            code: ClientErrorCode::InvalidInputLength,
            retry_after_ms: Some(250),
        },
    )
    .unwrap();
    assert_eq!(
        retry_from_fetch.snapshot.phase,
        AlbumSyncPhase::RetryWaiting
    );
    assert_eq!(
        retry_from_fetch.snapshot.retry.retry_target_phase,
        Some(AlbumSyncPhase::FetchingPage)
    );

    let resumed = advance_album_sync(
        &retry_from_fetch.snapshot,
        AlbumSyncEvent::RetryTimerElapsed,
    )
    .unwrap();
    assert_eq!(resumed.snapshot.phase, AlbumSyncPhase::FetchingPage);

    let applying_again = advance_album_sync(
        &resumed.snapshot,
        AlbumSyncEvent::PageFetched {
            page: Some(page(true)),
        },
    )
    .unwrap()
    .snapshot;
    let retry_from_apply = advance_album_sync(
        &applying_again,
        AlbumSyncEvent::RetryableFailure {
            code: ClientErrorCode::AuthenticationFailed,
            retry_after_ms: None,
        },
    )
    .unwrap();
    assert_eq!(
        retry_from_apply.snapshot.retry.retry_target_phase,
        Some(AlbumSyncPhase::ApplyingPage)
    );

    let cancelled =
        advance_album_sync(&retry_from_apply.snapshot, AlbumSyncEvent::CancelRequested).unwrap();
    assert_eq!(cancelled.snapshot.phase, AlbumSyncPhase::Cancelled);

    let resynced_after_cancel = advance_album_sync(
        &cancelled.snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(request()),
        },
    )
    .unwrap();
    assert_eq!(
        resynced_after_cancel.snapshot.phase,
        AlbumSyncPhase::FetchingPage
    );

    let failed = advance_album_sync(
        &resynced_after_cancel.snapshot,
        AlbumSyncEvent::NonRetryableFailure {
            code: ClientErrorCode::InvalidPublicKey,
        },
    )
    .unwrap();
    assert_eq!(failed.snapshot.phase, AlbumSyncPhase::Failed);

    let resynced_after_failed = advance_album_sync(
        &failed.snapshot,
        AlbumSyncEvent::SyncRequested {
            request: Some(request()),
        },
    )
    .unwrap();
    assert_eq!(
        resynced_after_failed.snapshot.phase,
        AlbumSyncPhase::FetchingPage
    );

    let mut completed = snapshot();
    completed.phase = AlbumSyncPhase::Completed;
    let resynced_after_completed = advance_album_sync(
        &completed,
        AlbumSyncEvent::SyncRequested {
            request: Some(request()),
        },
    )
    .unwrap();
    assert_eq!(
        resynced_after_completed.snapshot.phase,
        AlbumSyncPhase::FetchingPage
    );
}
