//! Late-v1 protocol freeze lock tests for KDF, auth, and AEAD domain labels.
//!
//! These labels are byte-level protocol commitments. Changing any value after
//! freeze requires an ADR amendment, a versioned migration plan, and matching
//! cross-client vectors.

use mosaic_crypto::{
    ACCOUNT_DATA_AAD, AUTH_CHALLENGE_CONTEXT, AUTH_SIGNING_KEY_INFO, BUNDLE_SIGN_CONTEXT,
    CONTENT_KEY_INFO, DB_SESSION_KEY_INFO, EPOCH_SEED_AAD, FULL_KEY_INFO, IDENTITY_SEED_AAD,
    PREVIEW_KEY_INFO, ROOT_KEY_INFO, THUMB_KEY_INFO,
};

const FREEZE_HINT: &str = "domain label changed after late-v1 freeze; update the ADR/spec and add migration vectors before changing this byte string.";

#[test]
fn kdf_info_labels_are_frozen() {
    assert_eq!(ROOT_KEY_INFO, b"mosaic:root-key:v1", "{FREEZE_HINT}");
    assert_eq!(
        AUTH_SIGNING_KEY_INFO, b"mosaic:auth-signing:v1",
        "{FREEZE_HINT}"
    );
    assert_eq!(THUMB_KEY_INFO, b"mosaic:tier:thumb:v1", "{FREEZE_HINT}");
    assert_eq!(PREVIEW_KEY_INFO, b"mosaic:tier:preview:v1", "{FREEZE_HINT}");
    assert_eq!(FULL_KEY_INFO, b"mosaic:tier:full:v1", "{FREEZE_HINT}");
    assert_eq!(CONTENT_KEY_INFO, b"mosaic:tier:content:v1", "{FREEZE_HINT}");
    assert_eq!(
        DB_SESSION_KEY_INFO, b"mosaic:db-session-key:v1",
        "{FREEZE_HINT}"
    );
}

#[test]
fn auth_and_bundle_context_labels_are_frozen() {
    assert_eq!(
        AUTH_CHALLENGE_CONTEXT, b"Mosaic_Auth_Challenge_v1",
        "{FREEZE_HINT}"
    );
    assert_eq!(
        BUNDLE_SIGN_CONTEXT, b"Mosaic_EpochBundle_v1",
        "{FREEZE_HINT}"
    );
}

#[test]
fn aead_wrap_domain_labels_are_frozen() {
    assert_eq!(EPOCH_SEED_AAD, b"mosaic:l3-epoch-seed:v1", "{FREEZE_HINT}");
    assert_eq!(
        IDENTITY_SEED_AAD, b"mosaic:l3-identity-seed:v1",
        "{FREEZE_HINT}"
    );
    assert_eq!(
        ACCOUNT_DATA_AAD, b"mosaic:account-wrapped-data:v1",
        "{FREEZE_HINT}"
    );
}
