//! Cross-wrapper DTO parity locks for Rust core facades.
//!
//! These source-text checks intentionally fail when a public FFI DTO gains or
//! loses a field in one wrapper without the corresponding WASM/UniFFI update.
//! WASM checks lock Rust source field shape, not generated JavaScript getter
//! names such as `epochId`.

use std::collections::{BTreeMap, BTreeSet};

const UNIFFI_SOURCE: &str = include_str!("../src/lib.rs");
const WASM_SOURCE: &str = include_str!("../../mosaic-wasm/src/lib.rs");

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
    "HeaderResult",
    "CryptoDomainGoldenVectorSnapshot",
];

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
