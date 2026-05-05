#![allow(clippy::expect_used, clippy::unwrap_used)]

use mosaic_client::{
    AlbumSyncEffect, AlbumSyncEvent, AlbumSyncPhase, AlbumSyncRequest, AlbumSyncSnapshot,
    ClientErrorCode, SyncPageSummary, advance_album_sync, album_sync_snapshot_schema_version,
    new_album_sync,
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
fn album_sync_phase_discriminants_are_frozen() {
    assert_eq!(AlbumSyncPhase::Idle as u8, 0);
    assert_eq!(AlbumSyncPhase::FetchingPage as u8, 1);
    assert_eq!(AlbumSyncPhase::ApplyingPage as u8, 2);
    assert_eq!(AlbumSyncPhase::RetryWaiting as u8, 3);
    assert_eq!(AlbumSyncPhase::Completed as u8, 4);
    assert_eq!(AlbumSyncPhase::Cancelled as u8, 5);
    assert_eq!(AlbumSyncPhase::Failed as u8, 6);

    assert_eq!(AlbumSyncPhase::Idle.to_u8(), 0);
    assert_eq!(AlbumSyncPhase::Failed.to_u8(), 6);
}

#[test]
fn album_sync_phase_iteration_is_discriminant_exhaustive() {
    let mut all_phases = Vec::new();
    for byte in 0..=u8::MAX {
        if let Some(phase) = AlbumSyncPhase::try_from_u8(byte) {
            all_phases.push(phase);
        }
    }

    assert_eq!(
        all_phases,
        vec![
            AlbumSyncPhase::Idle,
            AlbumSyncPhase::FetchingPage,
            AlbumSyncPhase::ApplyingPage,
            AlbumSyncPhase::RetryWaiting,
            AlbumSyncPhase::Completed,
            AlbumSyncPhase::Cancelled,
            AlbumSyncPhase::Failed,
        ],
        "Add new AlbumSyncPhase values append-only and update try_from_u8 plus SPEC-ClientCoreStateMachines"
    );
    assert_eq!(all_phases.len(), 7);
    assert_eq!(AlbumSyncPhase::try_from_u8(7), None);
}

#[test]
fn album_sync_dto_field_shape_is_locked() {
    let snapshot = AlbumSyncSnapshot {
        schema_version: album_sync_snapshot_schema_version(),
        sync_id: "sync-shape-lock".to_owned(),
        album_id: "album-shape-lock".to_owned(),
        phase: AlbumSyncPhase::RetryWaiting,
        initial_page_token: Some("initial".to_owned()),
        next_page_token: Some("next".to_owned()),
        current_page: Some(SyncPageSummary {
            previous_page_token: Some("previous".to_owned()),
            next_page_token: Some("pending".to_owned()),
            reached_end: false,
            encrypted_item_count: 42,
        }),
        rerun_requested: true,
        completed_cycle_count: 3,
        retry: mosaic_client::AlbumSyncRetryMetadata {
            attempt_count: 2,
            max_attempts: 5,
            retry_after_ms: Some(1_500),
            last_error_code: Some(ClientErrorCode::AuthenticationFailed),
            last_error_stage: Some(AlbumSyncPhase::FetchingPage),
            retry_target_phase: Some(AlbumSyncPhase::ApplyingPage),
        },
        failure_code: Some(ClientErrorCode::AuthenticationFailed),
    };

    let AlbumSyncSnapshot {
        schema_version,
        sync_id,
        album_id,
        phase,
        initial_page_token,
        next_page_token,
        current_page,
        rerun_requested,
        completed_cycle_count,
        retry,
        failure_code,
    } = snapshot;

    let _: u16 = schema_version;
    let _: String = sync_id;
    let _: String = album_id;
    let _: AlbumSyncPhase = phase;
    let _: Option<String> = initial_page_token;
    let _: Option<String> = next_page_token;
    let current_page: Option<SyncPageSummary> = current_page;
    let _: bool = rerun_requested;
    let _: u32 = completed_cycle_count;
    let retry: mosaic_client::AlbumSyncRetryMetadata = retry;
    let _: Option<ClientErrorCode> = failure_code;

    let page = current_page.expect("shape-lock snapshot carries a current page");
    let SyncPageSummary {
        previous_page_token,
        next_page_token,
        reached_end,
        encrypted_item_count,
    } = page;
    let _: Option<String> = previous_page_token;
    let _: Option<String> = next_page_token;
    let _: bool = reached_end;
    let _: u32 = encrypted_item_count;

    let mosaic_client::AlbumSyncRetryMetadata {
        attempt_count,
        max_attempts,
        retry_after_ms,
        last_error_code,
        last_error_stage,
        retry_target_phase,
    } = retry;
    let _: u32 = attempt_count;
    let _: u32 = max_attempts;
    let _: Option<u64> = retry_after_ms;
    let _: Option<ClientErrorCode> = last_error_code;
    let _: Option<AlbumSyncPhase> = last_error_stage;
    let _: Option<AlbumSyncPhase> = retry_target_phase;
}

#[test]
fn album_sync_event_and_effect_field_shapes_are_locked() {
    let request_event = AlbumSyncEvent::SyncRequested {
        request: Some(request()),
    };
    assert!(matches!(
        request_event,
        AlbumSyncEvent::SyncRequested {
            request: Some(AlbumSyncRequest { .. })
        }
    ));

    let fetched_event = AlbumSyncEvent::PageFetched {
        page: Some(page(false)),
    };
    assert!(matches!(
        fetched_event,
        AlbumSyncEvent::PageFetched {
            page: Some(SyncPageSummary { .. })
        }
    ));

    let retry_event = AlbumSyncEvent::RetryableFailure {
        code: ClientErrorCode::InvalidInputLength,
        retry_after_ms: Some(250),
    };
    assert!(matches!(
        retry_event,
        AlbumSyncEvent::RetryableFailure {
            code: ClientErrorCode::InvalidInputLength,
            retry_after_ms: Some(250)
        }
    ));

    let non_retry_event = AlbumSyncEvent::NonRetryableFailure {
        code: ClientErrorCode::InvalidPublicKey,
    };
    assert!(matches!(
        non_retry_event,
        AlbumSyncEvent::NonRetryableFailure {
            code: ClientErrorCode::InvalidPublicKey
        }
    ));

    assert!(matches!(
        AlbumSyncEvent::PageApplied,
        AlbumSyncEvent::PageApplied
    ));
    assert!(matches!(
        AlbumSyncEvent::RetryTimerElapsed,
        AlbumSyncEvent::RetryTimerElapsed
    ));
    assert!(matches!(
        AlbumSyncEvent::CancelRequested,
        AlbumSyncEvent::CancelRequested
    ));

    assert!(matches!(
        AlbumSyncEffect::FetchPage {
            page_token: Some("cursor".to_owned())
        },
        AlbumSyncEffect::FetchPage {
            page_token: Some(_)
        }
    ));
    assert!(matches!(
        AlbumSyncEffect::ApplyPage {
            encrypted_item_count: 7
        },
        AlbumSyncEffect::ApplyPage {
            encrypted_item_count: 7
        }
    ));
    assert!(matches!(
        AlbumSyncEffect::ScheduleRetry {
            attempt: 1,
            retry_after_ms: 1_000,
            target_phase: AlbumSyncPhase::FetchingPage
        },
        AlbumSyncEffect::ScheduleRetry {
            attempt: 1,
            retry_after_ms: 1_000,
            target_phase: AlbumSyncPhase::FetchingPage
        }
    ));
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
fn album_sync_retry_budget_exhaustion_preserves_originating_code() {
    let mut fetching = snapshot();
    fetching.phase = AlbumSyncPhase::FetchingPage;
    fetching.retry.attempt_count = 3;
    fetching.retry.max_attempts = 3;

    let transition = match advance_album_sync(
        &fetching,
        AlbumSyncEvent::RetryableFailure {
            code: ClientErrorCode::BackendIdempotencyConflict,
            retry_after_ms: Some(100),
        },
    ) {
        Ok(transition) => transition,
        Err(error) => panic!("retry budget exhaustion should fail cleanly: {error:?}"),
    };

    assert_eq!(transition.snapshot.phase, AlbumSyncPhase::Failed);
    assert_eq!(
        transition.snapshot.failure_code,
        Some(ClientErrorCode::BackendIdempotencyConflict)
    );
    assert_eq!(
        transition.snapshot.retry.last_error_code,
        Some(ClientErrorCode::BackendIdempotencyConflict)
    );
    assert_eq!(
        transition.snapshot.retry.last_error_stage,
        Some(AlbumSyncPhase::FetchingPage)
    );
    assert!(transition.effects.is_empty());
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
