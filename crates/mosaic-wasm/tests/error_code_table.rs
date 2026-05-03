//! WASM-side lock tests for stable `ClientErrorCode` numeric decoding.

use mosaic_client::ClientErrorCode;
use strum::{EnumCount, IntoEnumIterator};

#[test]
fn wasm_client_error_code_from_u16_round_trips_every_variant() {
    for variant in ClientErrorCode::iter() {
        assert_eq!(
            mosaic_wasm::client_error_code_from_u16(variant.as_u16()),
            Some(variant),
            "WASM round-trip failed for {variant:?}"
        );
    }
}

#[test]
fn wasm_client_error_code_table_covers_every_variant() {
    let variants: Vec<ClientErrorCode> = ClientErrorCode::iter().collect();
    assert_eq!(variants.len(), ClientErrorCode::COUNT);

    for variant in variants {
        assert_eq!(
            ClientErrorCode::try_from_u16(variant.as_u16()),
            mosaic_wasm::client_error_code_from_u16(variant.as_u16()),
            "WASM mapping diverged from canonical try_from_u16 for {variant:?}"
        );
    }
}

#[test]
fn wasm_client_error_code_rejects_unknown_gaps() {
    for n in [1_u16, 99, 105, 199, 228, 301, 404, 501, 619, 712, 799, 801] {
        assert_eq!(mosaic_wasm::client_error_code_from_u16(n), None);
    }
}
