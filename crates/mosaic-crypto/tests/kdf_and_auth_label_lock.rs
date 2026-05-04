//! Late-v1 protocol freeze lock tests for KDF and auth domain labels.
//!
//! These labels are byte-level protocol commitments. Changing any value after
//! freeze requires an ADR amendment, a versioned migration plan, and matching
//! cross-client vectors.

use mosaic_crypto::{
    AUTH_CHALLENGE_CONTEXT, AUTH_SIGNING_KEY_INFO, BUNDLE_SIGN_CONTEXT, CONTENT_KEY_INFO,
    DB_SESSION_KEY_INFO, FULL_KEY_INFO, PREVIEW_KEY_INFO, ROOT_KEY_INFO, THUMB_KEY_INFO,
};

const FREEZE_HINT: &str = "KDF/auth domain label changed after late-v1 freeze; update the \
ADR/spec and add migration vectors before changing this byte string.";

#[test]
fn root_key_info_label_is_frozen() {
    assert_eq!(ROOT_KEY_INFO, b"mosaic:root-key:v1", "{FREEZE_HINT}");
}

#[test]
fn auth_signing_key_info_label_is_frozen() {
    assert_eq!(
        AUTH_SIGNING_KEY_INFO, b"mosaic:auth-signing:v1",
        "{FREEZE_HINT}"
    );
}

#[test]
fn thumb_key_info_label_is_frozen() {
    assert_eq!(THUMB_KEY_INFO, b"mosaic:tier:thumb:v1", "{FREEZE_HINT}");
}

#[test]
fn preview_key_info_label_is_frozen() {
    assert_eq!(PREVIEW_KEY_INFO, b"mosaic:tier:preview:v1", "{FREEZE_HINT}");
}

#[test]
fn full_key_info_label_is_frozen() {
    assert_eq!(FULL_KEY_INFO, b"mosaic:tier:full:v1", "{FREEZE_HINT}");
}

#[test]
fn content_key_info_label_is_frozen() {
    assert_eq!(CONTENT_KEY_INFO, b"mosaic:tier:content:v1", "{FREEZE_HINT}");
}

#[test]
fn db_session_key_info_label_is_frozen() {
    assert_eq!(
        DB_SESSION_KEY_INFO, b"mosaic:db-session-key:v1",
        "{FREEZE_HINT}"
    );
}

#[test]
fn auth_challenge_context_label_is_frozen() {
    assert_eq!(
        AUTH_CHALLENGE_CONTEXT, b"Mosaic_Auth_Challenge_v1",
        "{FREEZE_HINT}"
    );
}

#[test]
fn bundle_sign_context_label_is_frozen() {
    assert_eq!(
        BUNDLE_SIGN_CONTEXT, b"Mosaic_EpochBundle_v1",
        "{FREEZE_HINT}"
    );
}
