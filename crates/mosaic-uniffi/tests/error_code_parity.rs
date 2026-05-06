//! UniFFI parity lock for stable `ClientErrorCode` numeric decoding.
//!
//! WASM has the matching canonical parity lock in `mosaic-wasm/tests/error_code_table.rs`;
//! both facades therefore converge on `ClientErrorCode::try_from_u16` without
//! introducing an architecture-forbidden facade-to-facade dependency.

use std::collections::BTreeMap;

use mosaic_client::ClientErrorCode;
use strum::IntoEnumIterator;

const GENERATED_WORKER_CRYPTO_ERROR_CODE_TS: &str =
    include_str!("../../../apps/web/src/workers/worker-crypto-error-code.generated.ts");

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

#[test]
fn rust_client_error_codes_below_worker_range_equal_typescript_worker_enum() {
    let ts_codes =
        worker_crypto_error_codes_below_worker_range(GENERATED_WORKER_CRYPTO_ERROR_CODE_TS);
    let rust_codes = rust_client_error_codes();

    for code in ClientErrorCode::iter() {
        let numeric_code = code.as_u16();
        assert!(
            numeric_code < 1000,
            "Rust ClientErrorCode::{code:?} moved into the TypeScript worker-only range"
        );
    }

    assert_eq!(
        ts_codes, rust_codes,
        "TypeScript WorkerCryptoErrorCode entries below 1000 must exactly match Rust ClientErrorCode"
    );
}

fn worker_crypto_error_codes_below_worker_range(source: &str) -> BTreeMap<String, u16> {
    let Some(enum_body) = source
        .split_once("export enum WorkerCryptoErrorCode")
        .and_then(|(_, rest)| rest.split_once('{'))
        .and_then(|(_, rest)| rest.split_once('}'))
        .map(|(body, _)| body)
    else {
        panic!("types.ts should declare WorkerCryptoErrorCode enum");
    };

    enum_body
        .lines()
        .filter_map(|line| {
            let line = line
                .split_once("//")
                .map_or(line, |(prefix, _)| prefix)
                .trim();
            let (name, value) = line.trim_end_matches(',').split_once('=')?;
            let value = value.trim().parse::<u16>().ok()?;
            (value < 1000).then(|| (name.trim().to_owned(), value))
        })
        .collect()
}

fn rust_client_error_codes() -> BTreeMap<String, u16> {
    ClientErrorCode::iter()
        .map(|code| (format!("{code:?}"), code.as_u16()))
        .collect()
}
