#![allow(dead_code)]

use mosaic_client::download::*;

#[test]
fn download_job_state_codes_are_locked() {
    assert_eq!(
        download_job_state_codes::KNOWN_DOWNLOAD_JOB_STATES,
        &[
            ("IDLE", 0),
            ("PREPARING", 1),
            ("RUNNING", 2),
            ("PAUSED", 3),
            ("FINALIZING", 4),
            ("DONE", 5),
            ("ERRORED", 6),
            ("CANCELLED", 7),
        ]
    );
    assert_eq!(DownloadJobState::Idle.to_u8(), 0);
    assert_eq!(
        DownloadJobState::Errored {
            reason: DownloadErrorCode::AccessRevoked
        }
        .to_u8(),
        6
    );
}
