//! Cross-wrapper DTO parity locks for Rust core facades.
//!
//! These source-text checks intentionally fail when an FFI DTO gains or loses a
//! field in one wrapper without the corresponding native/WASM/UniFFI updates.

const CLIENT_SOURCE: &str = include_str!("../../mosaic-client/src/lib.rs");
const UNIFFI_SOURCE: &str = include_str!("../src/lib.rs");
const WASM_SOURCE: &str = include_str!("../../mosaic-wasm/src/lib.rs");

const EXPECTED_EPOCH_KEY_HANDLE_RESULT_FIELDS: [&str; 5] = [
    "code",
    "handle",
    "epoch_id",
    "wrapped_epoch_seed",
    "sign_public_key",
];

fn record_fields(source: &str, struct_name: &str) -> Vec<String> {
    let start_marker = format!("pub struct {struct_name} {{");
    let Some(struct_start) = source.find(&start_marker) else {
        panic!("source should contain `pub struct {struct_name}`");
    };
    let struct_body = &source[struct_start + start_marker.len()..];
    let Some(struct_end) = struct_body.find("\n}") else {
        panic!("`pub struct {struct_name}` should have a closing brace");
    };

    struct_body[..struct_end]
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            let field = trimmed.strip_prefix("pub ")?;
            let (name, _) = field.split_once(':')?;
            Some(name.to_owned())
        })
        .collect()
}

#[test]
fn epoch_key_handle_result_fields_match_across_wrappers() {
    let expected = EXPECTED_EPOCH_KEY_HANDLE_RESULT_FIELDS
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();

    assert_eq!(
        record_fields(CLIENT_SOURCE, "EpochKeyHandleResult"),
        expected,
        "mosaic-client::EpochKeyHandleResult drifted; update all wrappers together"
    );
    assert_eq!(
        record_fields(UNIFFI_SOURCE, "EpochKeyHandleResult"),
        expected,
        "mosaic-uniffi::EpochKeyHandleResult drifted from native/WASM parity"
    );
    assert_eq!(
        record_fields(WASM_SOURCE, "EpochKeyHandleResult"),
        expected,
        "mosaic-wasm::EpochKeyHandleResult drifted from native/UniFFI parity"
    );
}
