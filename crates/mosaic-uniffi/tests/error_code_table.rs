//! Snapshot test that pins the full numeric `ClientErrorCode` → `u16` table.
//!
//! Any reordering, renumbering, or accidental collision in the
//! `mosaic_client::ClientErrorCode` enum will fail this test before it can
//! reach a binding consumer (Android Kotlin via UniFFI, web via WASM, or the
//! shared `tests/contracts/*` cross-client fixtures). The numeric codes are
//! protocol-stable: every consumer parses the raw `u16`, and the protocol
//! freeze (see `docs/specs/SPEC-LateV1ProtocolFreeze.md`) treats this table
//! as part of the v1 wire surface.

use mosaic_client::ClientErrorCode;

/// Returns the canonical `(name, u16)` table for every `ClientErrorCode`
/// variant. Adding a new variant requires a corresponding row here.
fn expected_table() -> Vec<(&'static str, u16)> {
    vec![
        ("Ok", 0),
        ("InvalidHeaderLength", 100),
        ("InvalidMagic", 101),
        ("UnsupportedVersion", 102),
        ("InvalidTier", 103),
        ("NonZeroReservedByte", 104),
        ("EmptyContext", 200),
        ("InvalidKeyLength", 201),
        ("InvalidInputLength", 202),
        ("InvalidEnvelope", 203),
        ("MissingCiphertext", 204),
        ("AuthenticationFailed", 205),
        ("RngFailure", 206),
        ("WrappedKeyTooShort", 207),
        ("KdfProfileTooWeak", 208),
        ("InvalidSaltLength", 209),
        ("KdfFailure", 210),
        ("InvalidSignatureLength", 211),
        ("InvalidPublicKey", 212),
        ("InvalidUsername", 213),
        ("KdfProfileTooCostly", 214),
        ("LinkTierMismatch", 215),
        ("BundleSignatureInvalid", 216),
        ("BundleAlbumIdEmpty", 217),
        ("BundleAlbumIdMismatch", 218),
        ("BundleEpochTooOld", 219),
        ("BundleRecipientMismatch", 220),
        ("BundleJsonParse", 221),
        ("BundleSealOpenFailed", 222),
        ("OperationCancelled", 300),
        ("SecretHandleNotFound", 400),
        ("IdentityHandleNotFound", 401),
        ("HandleSpaceExhausted", 402),
        ("EpochHandleNotFound", 403),
        ("InternalStatePoisoned", 500),
        ("UnsupportedMediaFormat", 600),
        ("InvalidMediaContainer", 601),
        ("InvalidMediaDimensions", 602),
        ("MediaOutputTooLarge", 603),
        ("MediaMetadataMismatch", 604),
        ("InvalidMediaSidecar", 605),
        ("MediaAdapterOutputMismatch", 606),
        ("ClientCoreInvalidTransition", 700),
        ("ClientCoreMissingEventPayload", 701),
        ("ClientCoreRetryBudgetExhausted", 702),
        ("ClientCoreSyncPageDidNotAdvance", 703),
        ("ClientCoreManifestOutcomeUnknown", 704),
        ("ClientCoreUnsupportedSnapshotVersion", 705),
        ("ClientCoreInvalidSnapshot", 706),
    ]
}

fn live_table() -> Vec<(&'static str, u16)> {
    vec![
        ("Ok", ClientErrorCode::Ok.as_u16()),
        (
            "InvalidHeaderLength",
            ClientErrorCode::InvalidHeaderLength.as_u16(),
        ),
        ("InvalidMagic", ClientErrorCode::InvalidMagic.as_u16()),
        (
            "UnsupportedVersion",
            ClientErrorCode::UnsupportedVersion.as_u16(),
        ),
        ("InvalidTier", ClientErrorCode::InvalidTier.as_u16()),
        (
            "NonZeroReservedByte",
            ClientErrorCode::NonZeroReservedByte.as_u16(),
        ),
        ("EmptyContext", ClientErrorCode::EmptyContext.as_u16()),
        (
            "InvalidKeyLength",
            ClientErrorCode::InvalidKeyLength.as_u16(),
        ),
        (
            "InvalidInputLength",
            ClientErrorCode::InvalidInputLength.as_u16(),
        ),
        ("InvalidEnvelope", ClientErrorCode::InvalidEnvelope.as_u16()),
        (
            "MissingCiphertext",
            ClientErrorCode::MissingCiphertext.as_u16(),
        ),
        (
            "AuthenticationFailed",
            ClientErrorCode::AuthenticationFailed.as_u16(),
        ),
        ("RngFailure", ClientErrorCode::RngFailure.as_u16()),
        (
            "WrappedKeyTooShort",
            ClientErrorCode::WrappedKeyTooShort.as_u16(),
        ),
        (
            "KdfProfileTooWeak",
            ClientErrorCode::KdfProfileTooWeak.as_u16(),
        ),
        (
            "InvalidSaltLength",
            ClientErrorCode::InvalidSaltLength.as_u16(),
        ),
        ("KdfFailure", ClientErrorCode::KdfFailure.as_u16()),
        (
            "InvalidSignatureLength",
            ClientErrorCode::InvalidSignatureLength.as_u16(),
        ),
        (
            "InvalidPublicKey",
            ClientErrorCode::InvalidPublicKey.as_u16(),
        ),
        ("InvalidUsername", ClientErrorCode::InvalidUsername.as_u16()),
        (
            "KdfProfileTooCostly",
            ClientErrorCode::KdfProfileTooCostly.as_u16(),
        ),
        (
            "LinkTierMismatch",
            ClientErrorCode::LinkTierMismatch.as_u16(),
        ),
        (
            "BundleSignatureInvalid",
            ClientErrorCode::BundleSignatureInvalid.as_u16(),
        ),
        (
            "BundleAlbumIdEmpty",
            ClientErrorCode::BundleAlbumIdEmpty.as_u16(),
        ),
        (
            "BundleAlbumIdMismatch",
            ClientErrorCode::BundleAlbumIdMismatch.as_u16(),
        ),
        (
            "BundleEpochTooOld",
            ClientErrorCode::BundleEpochTooOld.as_u16(),
        ),
        (
            "BundleRecipientMismatch",
            ClientErrorCode::BundleRecipientMismatch.as_u16(),
        ),
        ("BundleJsonParse", ClientErrorCode::BundleJsonParse.as_u16()),
        (
            "BundleSealOpenFailed",
            ClientErrorCode::BundleSealOpenFailed.as_u16(),
        ),
        (
            "OperationCancelled",
            ClientErrorCode::OperationCancelled.as_u16(),
        ),
        (
            "SecretHandleNotFound",
            ClientErrorCode::SecretHandleNotFound.as_u16(),
        ),
        (
            "IdentityHandleNotFound",
            ClientErrorCode::IdentityHandleNotFound.as_u16(),
        ),
        (
            "HandleSpaceExhausted",
            ClientErrorCode::HandleSpaceExhausted.as_u16(),
        ),
        (
            "EpochHandleNotFound",
            ClientErrorCode::EpochHandleNotFound.as_u16(),
        ),
        (
            "InternalStatePoisoned",
            ClientErrorCode::InternalStatePoisoned.as_u16(),
        ),
        (
            "UnsupportedMediaFormat",
            ClientErrorCode::UnsupportedMediaFormat.as_u16(),
        ),
        (
            "InvalidMediaContainer",
            ClientErrorCode::InvalidMediaContainer.as_u16(),
        ),
        (
            "InvalidMediaDimensions",
            ClientErrorCode::InvalidMediaDimensions.as_u16(),
        ),
        (
            "MediaOutputTooLarge",
            ClientErrorCode::MediaOutputTooLarge.as_u16(),
        ),
        (
            "MediaMetadataMismatch",
            ClientErrorCode::MediaMetadataMismatch.as_u16(),
        ),
        (
            "InvalidMediaSidecar",
            ClientErrorCode::InvalidMediaSidecar.as_u16(),
        ),
        (
            "MediaAdapterOutputMismatch",
            ClientErrorCode::MediaAdapterOutputMismatch.as_u16(),
        ),
        (
            "ClientCoreInvalidTransition",
            ClientErrorCode::ClientCoreInvalidTransition.as_u16(),
        ),
        (
            "ClientCoreMissingEventPayload",
            ClientErrorCode::ClientCoreMissingEventPayload.as_u16(),
        ),
        (
            "ClientCoreRetryBudgetExhausted",
            ClientErrorCode::ClientCoreRetryBudgetExhausted.as_u16(),
        ),
        (
            "ClientCoreSyncPageDidNotAdvance",
            ClientErrorCode::ClientCoreSyncPageDidNotAdvance.as_u16(),
        ),
        (
            "ClientCoreManifestOutcomeUnknown",
            ClientErrorCode::ClientCoreManifestOutcomeUnknown.as_u16(),
        ),
        (
            "ClientCoreUnsupportedSnapshotVersion",
            ClientErrorCode::ClientCoreUnsupportedSnapshotVersion.as_u16(),
        ),
        (
            "ClientCoreInvalidSnapshot",
            ClientErrorCode::ClientCoreInvalidSnapshot.as_u16(),
        ),
    ]
}

#[test]
fn client_error_code_table_matches_expected_v1_layout() {
    let expected = expected_table();
    let live = live_table();
    assert_eq!(
        expected.len(),
        live.len(),
        "ClientErrorCode variant count drifted from the snapshot — \
         add the new variant to expected_table() and live_table()"
    );

    for ((expected_name, expected_code), (live_name, live_code)) in expected.iter().zip(&live) {
        assert_eq!(
            expected_name, live_name,
            "ClientErrorCode variant order drifted at code {}",
            expected_code
        );
        assert_eq!(
            expected_code, live_code,
            "ClientErrorCode::{expected_name} numeric value drifted: \
             expected {expected_code}, live {live_code}"
        );
    }
}

#[test]
fn client_error_code_table_has_no_collisions() {
    let live = live_table();
    let mut seen: Vec<u16> = Vec::with_capacity(live.len());
    for (name, code) in &live {
        assert!(
            !seen.contains(code),
            "ClientErrorCode::{name} collides on numeric value {code}"
        );
        seen.push(*code);
    }
}
