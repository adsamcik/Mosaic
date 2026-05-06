//! Late-v1 protocol freeze lock tests for KDF, auth, and AEAD domain labels.
//!
//! These labels are byte-level protocol commitments. Changing any value after
//! freeze requires an ADR amendment, a versioned migration plan, and matching
//! cross-client vectors.
//!
//! Each frozen label MUST have its own `#[test] fn` — DO NOT consolidate into
//! grouped tests. Per-label tests provide:
//!   1. Fail-fast independence: a single broken byte fails one test, not all.
//!   2. Stable §11 (Irreversibility Register) citations.
//!   3. Forensic clarity: which label drifted is obvious from CI output.
//!
//! This was learned the hard way when commit 88c443e (R-C6) silently
//! consolidated 9 individually-named tests into 3 grouped tests. The
//! consolidation broke §11 citations and reduced fail-fast resolution. G0.7
//! restored the per-label structure.

use mosaic_crypto::{
    ACCOUNT_DATA_AAD, ACCOUNT_KEY_WRAP_AAD, AUTH_CHALLENGE_CONTEXT, AUTH_SIGNING_KEY_INFO,
    BUNDLE_SIGN_CONTEXT, CONTENT_KEY_INFO, DB_SESSION_KEY_INFO, EPOCH_SEED_AAD, FULL_KEY_INFO,
    IDENTITY_SEED_AAD, LINK_TIER_KEY_AAD, PREVIEW_KEY_INFO, ROOT_KEY_INFO, STREAM_FRAME_AAD,
    STREAM_FRAME_KEY_AAD, THUMB_KEY_INFO,
};

const FREEZE_HINT: &str = "domain label changed after late-v1 freeze; update the ADR/spec and add migration vectors before changing this byte string.";

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

#[test]
fn epoch_seed_aad_label_is_frozen() {
    assert_eq!(EPOCH_SEED_AAD, b"mosaic:l3-epoch-seed:v1", "{FREEZE_HINT}");
}

#[test]
fn identity_seed_aad_label_is_frozen() {
    assert_eq!(
        IDENTITY_SEED_AAD, b"mosaic:l3-identity-seed:v1",
        "{FREEZE_HINT}"
    );
}

#[test]
fn account_data_aad_label_is_frozen() {
    assert_eq!(
        ACCOUNT_DATA_AAD, b"mosaic:account-wrapped-data:v1",
        "{FREEZE_HINT}"
    );
}

#[test]
fn account_key_wrap_aad_label_is_frozen() {
    assert_eq!(
        ACCOUNT_KEY_WRAP_AAD, b"mosaic:l2-account-key:v1",
        "{FREEZE_HINT}"
    );
}

#[test]
fn link_tier_key_aad_label_is_frozen() {
    assert_eq!(
        LINK_TIER_KEY_AAD, b"mosaic:l3-link-tier-key:v1",
        "{FREEZE_HINT}"
    );
}

#[test]
fn stream_frame_key_aad_label_is_frozen() {
    assert_eq!(
        STREAM_FRAME_KEY_AAD, b"mosaic:stream-frame-key:v1",
        "{FREEZE_HINT}"
    );
}

#[test]
fn stream_frame_aad_label_is_frozen() {
    assert_eq!(STREAM_FRAME_AAD, b"mosaic:stream-frame:v1", "{FREEZE_HINT}");
}
