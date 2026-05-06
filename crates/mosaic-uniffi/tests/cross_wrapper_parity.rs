//! Cross-wrapper DTO parity locks for Rust core facades.
//!
//! These source-text checks intentionally fail when a public FFI DTO gains or
//! loses a field in one wrapper without the corresponding WASM/UniFFI update.
//! WASM checks lock Rust source field shape, not generated JavaScript getter
//! names such as `epochId`.

use std::collections::{BTreeMap, BTreeSet};

const UNIFFI_SOURCE: &str = include_str!("../src/lib.rs");
const WASM_SOURCE: &str = include_str!("../../mosaic-wasm/src/lib.rs");
const WASM_ONLY_MEDIA_EXPORTS: &[&str] = &[
    // UniFFI exposes these through strip_known_metadata(format, bytes) instead
    // of per-format convenience functions.
    "stripJpegMetadata",
    "stripPngMetadata",
    "stripWebpMetadata",
];

const REQUIRED_SHARED_DTOS: &[&str] = &[
    "IdentityHandleResult",
    "AccountUnlockResult",
    "EncryptedShardResult",
    "DecryptedShardResult",
    "ClientCoreUploadJobRequest",
    "ClientCoreUploadJobSnapshot",
    "ClientCoreUploadJobEvent",
    "ClientCoreUploadJobEffect",
    "ClientCoreUploadJobTransition",
    "ClientCoreAlbumSyncRequest",
    "ClientCoreAlbumSyncSnapshot",
    "ClientCoreAlbumSyncEvent",
    "ClientCoreAlbumSyncEffect",
    "ClientCoreAlbumSyncTransition",
    "BytesResult",
    "StripResult",
    "ImageInspectResult",
    "VideoInspectResult",
    "MediaTierDimensions",
    "MediaTierLayoutResult",
    "HeaderResult",
    "CryptoDomainGoldenVectorSnapshot",
];

const ALIASED_TWINS: &[(&str, &str)] = &[("EncryptedFrame", "StreamingFrameResult")];

const EXPECTED_DIVERGENCES: &[ExpectedDivergence] = &[ExpectedDivergence {
    // WASM flattens progress events into integer pairs for wasm-bindgen
    // marshalling while UniFFI exposes the nested ProgressEvent record.
    name: "ProgressResult",
    uniffi_fields: &[("code", "u16"), ("events", "Vec<ProgressEvent>")],
    wasm_fields: &[("code", "u16"), ("event_pairs", "Vec<u32>")],
}];

#[derive(Debug, Clone, PartialEq, Eq)]
struct StructShape {
    attributes: Vec<String>,
    fields: BTreeMap<String, String>,
}

struct ExpectedDivergence {
    name: &'static str,
    uniffi_fields: &'static [(&'static str, &'static str)],
    wasm_fields: &'static [(&'static str, &'static str)],
}

#[test]
fn uniffi_records_and_wasm_structs_keep_matching_field_shapes() {
    assert_matching_field_shapes(UNIFFI_SOURCE, WASM_SOURCE);
}

#[test]
fn media_exports_match_between_wasm_and_uniffi() {
    assert_media_exports_match(UNIFFI_SOURCE, WASM_SOURCE);
}

#[test]
#[should_panic(expected = "UniFFI media export `strip_gif_metadata` is missing for P-W2 parity")]
fn new_wasm_media_export_without_uniffi_mirror_fails_parity() {
    let wasm_source = format!(
        "{WASM_SOURCE}\n\
         #[wasm_bindgen(js_name = stripGifMetadata)]\n\
         pub fn strip_gif_metadata() -> JsValue {{ JsValue::NULL }}\n"
    );

    assert_media_exports_match(UNIFFI_SOURCE, &wasm_source);
}

#[test]
fn aliased_dto_twins_share_required_field_intersection() {
    let uniffi_records = parse_uniffi_records(UNIFFI_SOURCE);
    let wasm_structs = parse_wasm_structs(WASM_SOURCE);

    for (uniffi_name, wasm_name) in ALIASED_TWINS {
        let uniffi = uniffi_records
            .get(*uniffi_name)
            .unwrap_or_else(|| panic!("UniFFI aliased DTO `{uniffi_name}` is missing"));
        let wasm = wasm_structs
            .get(*wasm_name)
            .unwrap_or_else(|| panic!("WASM aliased DTO `{wasm_name}` is missing"));
        let shared = uniffi
            .fields
            .keys()
            .filter(|field| wasm.fields.contains_key(*field))
            .cloned()
            .collect::<BTreeSet<_>>();

        assert_eq!(
            shared,
            BTreeSet::from(["bytes".to_owned(), "frame_index".to_owned()]),
            "aliased DTO pair `{uniffi_name}`/`{wasm_name}` lost streaming AEAD shared fields"
        );
        for field in &shared {
            assert_eq!(
                uniffi.fields[field], wasm.fields[field],
                "aliased DTO pair `{uniffi_name}`/`{wasm_name}` field `{field}` type drifted"
            );
        }
    }
}

#[test]
fn streaming_aead_wasm_and_uniffi_surfaces_keep_parity() {
    let uniffi_exports = parse_uniffi_streaming_surface(UNIFFI_SOURCE);
    assert_eq!(
        BTreeSet::from([
            "StreamingEncryptor",
            "StreamingEncryptor::new",
            "StreamingEncryptor::encrypt_frame",
            "StreamingEncryptor::finalize",
            "StreamingDecryptor",
            "StreamingDecryptor::new",
            "StreamingDecryptor::decrypt_frame",
            "StreamingDecryptor::finalize",
            "EncryptedFrame",
            "decrypt_envelope",
        ]),
        uniffi_exports,
        "P-U5 UniFFI streaming AEAD surface drifted"
    );

    let wasm_exports = parse_wasm_streaming_surface(WASM_SOURCE);
    assert_eq!(
        BTreeSet::from([
            "StreamingShardEncryptor",
            "StreamingShardEncryptor::new",
            "StreamingShardEncryptor::encrypt_frame",
            "StreamingShardEncryptor::finalize",
            "StreamingShardDecryptor",
            "StreamingShardDecryptor::new",
            "StreamingShardDecryptor::decrypt_frame",
            "StreamingShardDecryptor::finalize",
            "StreamingFrameResult",
            "StreamingEnvelopeResult",
            "decryptEnvelope",
        ]),
        wasm_exports,
        "P-W5 WASM streaming AEAD surface drifted"
    );
}

fn parse_uniffi_streaming_surface(source: &str) -> BTreeSet<&'static str> {
    let mut surface = BTreeSet::new();
    if source.contains("pub struct StreamingEncryptor") {
        surface.insert("StreamingEncryptor");
    }
    if source.contains("pub struct StreamingDecryptor") {
        surface.insert("StreamingDecryptor");
    }
    if source.contains("pub struct EncryptedFrame") {
        surface.insert("EncryptedFrame");
    }
    if source.contains("pub fn decrypt_envelope(") {
        surface.insert("decrypt_envelope");
    }
    for (needle, name) in [
        ("impl StreamingEncryptor", "StreamingEncryptor"),
        (
            "expected_frame_count: Option<u32>",
            "StreamingEncryptor::new",
        ),
        (
            "pub fn encrypt_frame(&self",
            "StreamingEncryptor::encrypt_frame",
        ),
        (
            "pub fn finalize(&self) -> Result<Vec<u8>, MosaicError>",
            "StreamingEncryptor::finalize",
        ),
        ("impl StreamingDecryptor", "StreamingDecryptor"),
        ("pub fn new(epoch_handle_id", "StreamingDecryptor::new"),
        (
            "pub fn decrypt_frame(&self",
            "StreamingDecryptor::decrypt_frame",
        ),
        (
            "pub fn finalize(&self) -> Result<(), MosaicError>",
            "StreamingDecryptor::finalize",
        ),
    ] {
        if source.contains(needle) {
            surface.insert(name);
        }
    }
    surface
}

fn parse_wasm_streaming_surface(source: &str) -> BTreeSet<&'static str> {
    let mut surface = BTreeSet::new();
    for (needle, name) in [
        (
            "pub struct StreamingShardEncryptor",
            "StreamingShardEncryptor",
        ),
        (
            "pub fn new(_epoch_handle_id: u64, _tier: u8, _expected_frame_count: Option<u32>) -> Self",
            "StreamingShardEncryptor::new",
        ),
        (
            "pub fn encrypt_frame(&mut self, _plaintext: Vec<u8>) -> JsValue",
            "StreamingShardEncryptor::encrypt_frame",
        ),
        (
            "pub fn finalize(self) -> JsValue",
            "StreamingShardEncryptor::finalize",
        ),
        (
            "pub struct StreamingShardDecryptor",
            "StreamingShardDecryptor",
        ),
        (
            "pub fn new(_epoch_handle_id: u64, _envelope_header: Vec<u8>) -> Self",
            "StreamingShardDecryptor::new",
        ),
        (
            "pub fn decrypt_frame(&mut self, _frame: Vec<u8>) -> JsValue",
            "StreamingShardDecryptor::decrypt_frame",
        ),
        ("pub struct StreamingFrameResult", "StreamingFrameResult"),
        (
            "pub struct StreamingEnvelopeResult",
            "StreamingEnvelopeResult",
        ),
        (
            "#[wasm_bindgen(js_name = decryptEnvelope)]",
            "decryptEnvelope",
        ),
    ] {
        if source.contains(needle) {
            surface.insert(name);
        }
    }
    if source.matches("pub fn finalize(self) -> JsValue").count() >= 2 {
        surface.insert("StreamingShardDecryptor::finalize");
    }
    surface
}

fn assert_matching_field_shapes(uniffi_source: &str, wasm_source: &str) {
    let uniffi_records = parse_uniffi_records(uniffi_source);
    let wasm_structs = parse_wasm_structs(wasm_source);
    let intentional_divergences = EXPECTED_DIVERGENCES
        .iter()
        .map(|divergence| divergence.name)
        .collect::<BTreeSet<_>>();

    assert!(
        !uniffi_records.is_empty(),
        "source parser found no UniFFI records; update the lock-test parser"
    );
    assert!(
        !wasm_structs.is_empty(),
        "source parser found no WASM structs; update the lock-test parser"
    );

    let mut matched = BTreeSet::new();
    for (name, uniffi) in &uniffi_records {
        let Some(wasm) = wasm_structs.get(name) else {
            continue;
        };
        matched.insert(name.as_str());
        if intentional_divergences.contains(name.as_str()) {
            let Some(expected) = EXPECTED_DIVERGENCES
                .iter()
                .find(|divergence| divergence.name == name)
            else {
                panic!("intentional divergence `{name}` is missing its expected shape");
            };
            assert_eq!(
                uniffi.fields,
                fields_from_pairs(expected.uniffi_fields),
                "UniFFI side of intentional divergence `{name}` drifted"
            );
            assert_eq!(
                wasm.fields,
                fields_from_pairs(expected.wasm_fields),
                "WASM side of intentional divergence `{name}` drifted"
            );
            continue;
        }

        assert_eq!(
            uniffi.fields, wasm.fields,
            "FFI DTO `{name}` drifted between UniFFI and WASM wrappers"
        );
    }

    for required in REQUIRED_SHARED_DTOS {
        assert!(
            matched.contains(required),
            "required cross-wrapper DTO `{required}` was not covered by parity lock"
        );
    }

    assert!(
        matched.len() >= REQUIRED_SHARED_DTOS.len(),
        "expected broad UniFFI/WASM DTO parity coverage, matched only {matched:?}"
    );
}

fn assert_media_exports_match(uniffi_source: &str, wasm_source: &str) {
    let uniffi_exports = parse_uniffi_exported_function_names(uniffi_source);
    let wasm_exports = parse_wasm_media_export_names(wasm_source);

    assert!(
        !wasm_exports.is_empty(),
        "P-W2 WASM media export parser found no exports; update the parity parser"
    );

    for export in &wasm_exports {
        assert!(
            uniffi_exports.contains(export),
            "UniFFI media export `{export}` is missing for P-W2 parity"
        );
    }

    assert!(
        uniffi_exports.contains("strip_known_metadata"),
        "UniFFI generic media-strip convenience export must remain available"
    );
}

fn parse_uniffi_exported_function_names(source: &str) -> BTreeSet<String> {
    let lines = source.lines().collect::<Vec<_>>();
    let mut exports = BTreeSet::new();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index].trim();
        if starts_attribute(line) {
            let (next_index, attr) = collect_attribute(&lines, index);
            if is_uniffi_export_attr(&attr)
                && let Some((function_index, name)) = next_function_name(&lines, next_index)
            {
                exports.insert(name.to_owned());
                index = function_index + 1;
                continue;
            }
            index = next_index;
            continue;
        }
        index += 1;
    }
    exports
}

fn parse_wasm_media_export_names(source: &str) -> BTreeSet<String> {
    let lines = source.lines().collect::<Vec<_>>();
    let mut exports = BTreeSet::new();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index].trim();
        if starts_attribute(line) {
            let (next_index, attr) = collect_attribute(&lines, index);
            if let Some(js_name) = wasm_js_name(&attr)
                && is_media_export(&js_name)
                && !WASM_ONLY_MEDIA_EXPORTS.contains(&js_name.as_str())
                && next_function_name(&lines, next_index).is_some()
            {
                let uniffi_name = wasm_media_export_to_uniffi_name(&js_name)
                    .unwrap_or_else(|error| panic!("{error}"));
                exports.insert(uniffi_name);
            }
            index = next_index;
            continue;
        }
        index += 1;
    }
    exports
}

fn is_media_export(js_name: &str) -> bool {
    js_name.starts_with("strip")
        || js_name.starts_with("inspect")
        || js_name == "canonicalTierLayout"
        || (js_name.starts_with("canonical") && js_name.contains("Sidecar"))
}

fn is_uniffi_export_attr(attr: &str) -> bool {
    let compact = compact_attr(attr);
    compact.starts_with("#[uniffi::export") || compact.starts_with("#[::uniffi::export")
}

fn wasm_js_name(attr: &str) -> Option<String> {
    let compact = compact_attr(attr);
    compact
        .strip_prefix("#[wasm_bindgen(js_name=")
        .and_then(|rest| rest.strip_suffix(")]"))
        .map(str::to_owned)
}

fn wasm_media_export_to_uniffi_name(js_name: &str) -> Result<String, String> {
    camel_case_to_snake_case(js_name)
        .map_err(|reason| format!("unmappable WASM media export `{js_name}`: {reason}"))
}

fn camel_case_to_snake_case(name: &str) -> Result<String, &'static str> {
    if name.is_empty() {
        return Err("name is empty");
    }
    if !name
        .chars()
        .all(|character| character.is_ascii_alphanumeric())
    {
        return Err("name contains non-ASCII-alphanumeric characters");
    }

    let mut snake = String::with_capacity(name.len());
    let mut previous_was_lower_or_digit = false;
    for character in name.chars() {
        if character.is_ascii_uppercase() {
            if previous_was_lower_or_digit {
                snake.push('_');
            }
            snake.push(character.to_ascii_lowercase());
            previous_was_lower_or_digit = false;
        } else {
            snake.push(character);
            previous_was_lower_or_digit =
                character.is_ascii_lowercase() || character.is_ascii_digit();
        }
    }
    Ok(snake)
}

fn next_function_name<'a>(lines: &'a [&str], start: usize) -> Option<(usize, &'a str)> {
    let mut index = start;
    while index < lines.len() {
        let line = lines[index].trim();
        if starts_attribute(line) || line.starts_with("///") || line.is_empty() {
            if starts_attribute(line) {
                let (next_index, _) = collect_attribute(lines, index);
                index = next_index;
            } else {
                index += 1;
            }
            continue;
        }
        return line
            .strip_prefix("pub fn ")
            .and_then(|rest| rest.split('(').next())
            .filter(|name| !name.is_empty())
            .map(|name| (index, name));
    }
    None
}

fn parse_uniffi_records(source: &str) -> BTreeMap<String, StructShape> {
    parse_structs(source, |attrs, _line| {
        attrs
            .iter()
            .any(|attr| compact_attr(attr).contains("uniffi::Record"))
    })
}

fn parse_wasm_structs(source: &str) -> BTreeMap<String, StructShape> {
    parse_structs(source, |attrs, line| {
        attrs
            .iter()
            .any(|attr| compact_attr(attr).contains("wasm_bindgen"))
            || struct_name(line).is_some_and(|name| name.starts_with("ClientCore"))
    })
}

fn parse_structs(
    source: &str,
    mut accepts_struct: impl FnMut(&[String], &str) -> bool,
) -> BTreeMap<String, StructShape> {
    let lines = source.lines().collect::<Vec<_>>();
    let mut shapes = BTreeMap::new();
    let mut attrs = Vec::new();
    let mut index = 0;

    while index < lines.len() {
        let line = lines[index].trim();
        if starts_attribute(line) {
            let (next_index, attr) = collect_attribute(&lines, index);
            attrs.push(attr);
            index = next_index;
            continue;
        }
        if line.starts_with("///") || line.is_empty() {
            index += 1;
            continue;
        }

        if accepts_struct(&attrs, line) {
            if let Some(name) = struct_name(line) {
                if let Some((next_index, fields)) = parse_struct_fields(&lines, index) {
                    shapes.insert(
                        strip_js_prefix(name).to_owned(),
                        StructShape {
                            attributes: attrs.clone(),
                            fields,
                        },
                    );
                    attrs.clear();
                    index = next_index;
                    continue;
                }
            }
        }

        attrs.clear();
        index += 1;
    }

    shapes
}

fn struct_name(line: &str) -> Option<&str> {
    line.strip_prefix("pub struct ")
        .and_then(|rest| {
            rest.split(|character: char| character == '{' || character.is_whitespace())
                .next()
        })
        .filter(|name| !name.is_empty())
}

fn parse_struct_fields(lines: &[&str], start: usize) -> Option<(usize, BTreeMap<String, String>)> {
    let mut fields = BTreeMap::new();
    let mut index = start + 1;

    while index < lines.len() {
        let line = lines[index].trim();
        if line.starts_with('}') {
            return Some((index + 1, fields));
        }
        if starts_attribute(line) {
            let (next_index, _) = collect_attribute(lines, index);
            index = next_index;
            continue;
        }
        if line.starts_with("///") || line.starts_with("//") || line.is_empty() {
            index += 1;
            continue;
        }

        let field = line.strip_prefix("pub ").unwrap_or(line);
        if let Some((name, ty)) = field.trim_end_matches(',').split_once(':') {
            fields.insert(name.trim().to_owned(), normalize_type(ty));
        }
        index += 1;
    }

    None
}

fn strip_js_prefix(name: &str) -> &str {
    name.strip_prefix("Js").unwrap_or(name)
}

fn normalize_type(ty: &str) -> String {
    ty.split_whitespace().collect::<String>()
}

fn fields_from_pairs(fields: &[(&str, &str)]) -> BTreeMap<String, String> {
    fields
        .iter()
        .map(|(name, ty)| ((*name).to_owned(), (*ty).to_owned()))
        .collect()
}

fn starts_attribute(line: &str) -> bool {
    compact_attr(line).starts_with("#[")
}

fn compact_attr(attr: &str) -> String {
    attr.split_whitespace().collect::<String>()
}

fn collect_attribute(lines: &[&str], start: usize) -> (usize, String) {
    let mut attr = String::new();
    let mut bracket_depth = 0_i32;
    let mut saw_open = false;
    let mut index = start;

    while index < lines.len() {
        let line = lines[index].trim();
        if !attr.is_empty() {
            attr.push('\n');
        }
        attr.push_str(line);

        for character in line.chars() {
            match character {
                '[' => {
                    bracket_depth += 1;
                    saw_open = true;
                }
                ']' => bracket_depth -= 1,
                _ => {}
            }
        }

        index += 1;
        if saw_open && bracket_depth <= 0 {
            break;
        }
    }

    (index, attr)
}

#[test]
fn struct_parser_associates_multiline_attrs_with_following_struct() {
    let source = r#"
        #[
            derive(
                Debug,
                uniffi::Record,
            )
        ]
        pub struct MultiLineRecord {
            #[serde(default)]
            pub code: u16,
            pub payload: Vec<u8>,
        }
    "#;

    let records = parse_uniffi_records(source);
    assert_eq!(
        records["MultiLineRecord"].fields,
        fields_from_pairs(&[("code", "u16"), ("payload", "Vec<u8>")])
    );
}

#[test]
fn struct_parser_associates_stacked_attrs_with_following_struct() {
    let source = r#"
        #[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
        #[serde(rename_all = "camelCase")]
        pub struct StackedAttributeRecord {
            pub schema_version: u32,
            pub payload_bytes: Vec<u8>,
        }
    "#;

    let records = parse_uniffi_records(source);
    let record = &records["StackedAttributeRecord"];

    // Option A: expose the test parser's associated attribute list and assert
    // both stacked attributes attach to the following UniFFI record.
    assert!(
        record
            .attributes
            .iter()
            .any(|attr| compact_attr(attr).contains("uniffi::Record"))
    );
    assert!(
        record
            .attributes
            .iter()
            .any(|attr| compact_attr(attr).contains("serde"))
    );
    assert_eq!(
        record.fields,
        fields_from_pairs(&[("schema_version", "u32"), ("payload_bytes", "Vec<u8>")])
    );
}

#[test]
#[should_panic(
    expected = "FFI DTO `ClientCoreUploadJobSnapshot` drifted between UniFFI and WASM wrappers"
)]
fn plain_client_core_struct_drift_is_rejected() {
    let uniffi_source = r#"
        #[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
        pub struct ClientCoreUploadJobSnapshot {
            pub schema_version: u32,
        }
    "#;
    let wasm_source = r#"
        #[derive(Debug, Clone, PartialEq, Eq)]
        pub struct ClientCoreUploadJobSnapshot {
            pub schema_version: u32,
            pub injected_regression: u32,
        }
    "#;

    assert_matching_field_shapes(uniffi_source, wasm_source);
}
