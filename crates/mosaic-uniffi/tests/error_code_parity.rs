//! UniFFI parity lock for stable `ClientErrorCode` numeric decoding.
//!
//! WASM has the matching canonical parity lock in `mosaic-wasm/tests/error_code_table.rs`;
//! both facades therefore converge on `ClientErrorCode::try_from_u16` without
//! introducing an architecture-forbidden facade-to-facade dependency.

use mosaic_client::ClientErrorCode;
use strum::IntoEnumIterator;

#[test]
fn client_error_code_from_u16_matches_canonical_try_from_u16() {
    for code in ClientErrorCode::iter() {
        let n = code.as_u16();
        assert_eq!(
            mosaic_uniffi::client_error_code_from_u16(n),
            ClientErrorCode::try_from_u16(n),
            "UniFFI missed code {n} ({code:?})"
        );
    }
}

#[test]
fn unknown_client_error_codes_are_rejected_by_uniffi() {
    for n in [1_u16, 99, 105, 199, 228, 301, 404, 501, 619, 712, 799, 801] {
        assert_eq!(
            mosaic_uniffi::client_error_code_from_u16(n),
            None,
            "UniFFI unexpectedly accepted unknown code {n}"
        );
    }
}
