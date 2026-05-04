use std::{env, fs, path::PathBuf};

const SOURCE: &str = include_str!("../src/lib.rs");
const GOLDEN: &str = include_str!("golden/uniffi_api.txt");

/// Locks the actual UniFFI export surface by introspecting the crate source for
/// `#[uniffi::export]` functions and `uniffi::Record` DTOs. UniFFI 0.31.1 does
/// emit metadata statics, but it does not expose a stable runtime iterator over
/// those statics to tests. This source-introspection fallback still fails on
/// any added, removed, or signature-changed exported function/record.
///
/// Update intentionally with:
/// `UPDATE_GOLDEN=1 cargo test -p mosaic-uniffi --test api_shape_lock --locked`
#[test]
fn uniffi_exported_api_shape_matches_golden() {
    let actual = canonical_uniffi_api_shape(SOURCE);

    if env::var_os("UPDATE_GOLDEN").is_some() {
        let path = golden_path("uniffi_api.txt");
        let Some(parent) = path.parent() else {
            panic!("golden file has no parent: {}", path.display());
        };
        if let Err(error) = fs::create_dir_all(parent) {
            panic!(
                "failed to create golden directory {}: {error}",
                parent.display()
            );
        }
        if let Err(error) = fs::write(&path, &actual) {
            panic!(
                "failed to write UniFFI API-shape golden {}: {error}",
                path.display()
            );
        }
        return;
    }

    assert_eq!(
        normalize_newlines(GOLDEN),
        actual,
        "UniFFI API-shape drift detected. Regenerate only after reviewing the \
         FFI surface for raw-secret exports: UPDATE_GOLDEN=1 cargo test -p \
         mosaic-uniffi --test api_shape_lock --locked"
    );
}

fn canonical_uniffi_api_shape(source: &str) -> String {
    canonical_uniffi_api_shape_for_features(source, false)
}

fn canonical_uniffi_api_shape_for_features(
    source: &str,
    cross_client_vectors_enabled: bool,
) -> String {
    let lines: Vec<&str> = source.lines().collect();
    let mut output = String::from("mosaic-uniffi-api-shape:v1\n");
    let mut index = 0;
    let mut pending_attrs: Vec<String> = Vec::new();

    while index < lines.len() {
        let line = lines[index].trim();

        if starts_attribute(line) {
            let (next_attr_index, attr) = collect_attribute(&lines, index);
            pending_attrs.push(attr.clone());

            if attr_has_uniffi_marker(&attr, "Record") {
                if let Some((next_index, record)) = parse_record(&lines, next_attr_index) {
                    output.push_str(&record);
                    index = next_index;
                    continue;
                }
            }

            if is_uniffi_export_attr(&attr)
                && cfg_attrs_enabled(&pending_attrs, cross_client_vectors_enabled)
                && let Some((next_index, signature)) =
                    parse_exported_function(&lines, next_attr_index)
            {
                output.push_str("export ");
                output.push_str(&signature);
                output.push('\n');
                index = next_index;
                pending_attrs.clear();
                continue;
            }

            index = next_attr_index;
            continue;
        }

        pending_attrs.clear();
        index += 1;
    }

    output
}

fn parse_record(lines: &[&str], start: usize) -> Option<(usize, String)> {
    let mut index = start;
    while index < lines.len() {
        let line = lines[index].trim();
        if let Some(name) = line
            .strip_prefix("pub struct ")
            .and_then(|rest| rest.split_whitespace().next())
        {
            let name = name.trim_end_matches('{');
            let mut output = format!("record {name}\n");
            index += 1;
            while index < lines.len() {
                let field = lines[index].trim();
                if field.starts_with('}') {
                    output.push_str("end\n");
                    return Some((index + 1, output));
                }
                if let Some(field) = field.strip_prefix("pub ") {
                    output.push_str("  ");
                    output.push_str(&normalize_field(field));
                    output.push('\n');
                }
                index += 1;
            }
            return None;
        }
        if starts_attribute(line) {
            let (next_index, _) = collect_attribute(lines, index);
            index = next_index;
            continue;
        }
        if line.starts_with("///") || line.is_empty() {
            index += 1;
            continue;
        }
        return None;
    }
    None
}

fn parse_exported_function(lines: &[&str], start: usize) -> Option<(usize, String)> {
    let mut index = start;
    while index < lines.len() {
        let line = lines[index].trim();
        if starts_attribute(line) {
            let (next_index, _) = collect_attribute(lines, index);
            index = next_index;
            continue;
        }
        if line.starts_with("///") || line.is_empty() {
            index += 1;
            continue;
        }
        if line.starts_with("pub fn ") || line.starts_with("pub async fn ") {
            let mut signature = String::new();
            while index < lines.len() {
                signature.push(' ');
                signature.push_str(lines[index].trim());
                if lines[index].contains('{') {
                    break;
                }
                index += 1;
            }
            let signature = signature
                .split_once('{')
                .map_or(signature.as_str(), |(prefix, _)| prefix);
            return Some((index + 1, normalize_whitespace(signature)));
        }
        return None;
    }
    None
}

fn normalize_field(field: &str) -> String {
    normalize_whitespace(field.trim_end_matches(','))
}

#[test]
fn default_api_shape_excludes_cross_client_vector_seed_verifier() {
    let actual = canonical_uniffi_api_shape_for_features(SOURCE, false);

    assert!(
        !actual.contains("verify_and_open_bundle_with_recipient_seed"),
        "default UniFFI API shape must not expose the raw recipient-seed corpus driver"
    );
    assert!(
        !actual.contains("derive_link_keys_from_raw_secret"),
        "default UniFFI API shape must not expose the raw link-secret corpus driver"
    );
    assert!(
        !actual.contains("derive_identity_from_raw_seed"),
        "default UniFFI API shape must not expose the raw identity-seed corpus driver"
    );
}

#[test]
fn feature_enabled_api_shape_includes_cross_client_vector_seed_verifier() {
    let actual = canonical_uniffi_api_shape_for_features(SOURCE, true);

    assert!(
        actual.contains("export pub fn verify_and_open_bundle_with_recipient_seed("),
        "cross-client-vectors shape must retain the sealed_bundle.json corpus driver"
    );
    assert!(
        actual.contains("export pub fn derive_link_keys_from_raw_secret("),
        "cross-client-vectors shape must retain the link_keys.json corpus driver"
    );
    assert!(
        actual.contains("export pub fn derive_identity_from_raw_seed("),
        "cross-client-vectors shape must retain the identity.json corpus driver"
    );
}

#[test]
fn cfg_gated_export_parser_tracks_cross_client_vectors_feature() {
    let source = r#"
        #[cfg(feature = "cross-client-vectors")]
        #[uniffi::export]
        pub fn corpus_driver_seed_verifier() -> Vec<u8> {
            Vec::new()
        }

        #[uniffi::export]
        pub fn production_handle_verifier() -> u64 {
            0
        }
    "#;

    let default_shape = canonical_uniffi_api_shape_for_features(source, false);
    assert!(!default_shape.contains("corpus_driver_seed_verifier"));
    assert!(default_shape.contains("production_handle_verifier"));

    let feature_shape = canonical_uniffi_api_shape_for_features(source, true);
    assert!(feature_shape.contains("corpus_driver_seed_verifier"));
    assert!(feature_shape.contains("production_handle_verifier"));
}

#[test]
fn uniffi_export_attribute_detection_accepts_format_variants() {
    assert!(is_uniffi_export_attr("#[uniffi::export]"));
    assert!(is_uniffi_export_attr("#[::uniffi::export]"));
    assert!(is_uniffi_export_attr("# [uniffi::export]"));
    assert!(is_uniffi_export_attr(r#"#[uniffi::export(name = "x")]"#));
    assert!(is_uniffi_export_attr(r#"#[::uniffi::export(name = "x")]"#));
    assert!(is_uniffi_export_attr(
        "#[\n    uniffi :: export(\n        name = \"x\"\n    )\n]"
    ));
    assert!(!is_uniffi_export_attr("#[uniffi::Record]"));
}

#[test]
fn exported_api_parser_keeps_async_functions_in_shape_lock() {
    let source = r#"
        #[uniffi::export]
        pub async fn leak_seed() -> Vec<u8> {
            Vec::new()
        }
    "#;

    assert!(
        canonical_uniffi_api_shape(source).contains("export pub async fn leak_seed() -> Vec<u8>"),
        "negative fixture: #[uniffi::export] pub async fn must be locked instead of dropped"
    );
}

#[test]
fn golden_parser_has_no_unhandled_uniffi_enum_or_object_surfaces() {
    let attrs = collect_source_attributes(SOURCE);
    assert!(
        attrs
            .iter()
            .all(|attr| !attr_has_uniffi_marker(attr, "Enum")),
        "api_shape_lock.rs must parse UniFFI enum variants before adding uniffi::Enum"
    );
    assert!(
        attrs
            .iter()
            .all(|attr| !attr_has_uniffi_marker(attr, "Object")),
        "api_shape_lock.rs must parse UniFFI object methods before adding uniffi::Object"
    );
}

#[test]
fn uniffi_enum_and_object_canary_detection_accepts_derive_format_variants() {
    assert!(attr_has_uniffi_marker(
        "#[derive(Debug, uniffi::Enum)]",
        "Enum"
    ));
    assert!(attr_has_uniffi_marker(
        "#[derive(Debug, uniffi :: Enum)]",
        "Enum"
    ));
    assert!(attr_has_uniffi_marker(
        "#[\n  derive(\n    Debug,\n    uniffi :: Object,\n  )\n]",
        "Object"
    ));
    assert!(attr_has_uniffi_marker("#[uniffi::Object]", "Object"));
    assert!(!attr_has_uniffi_marker(
        "#[derive(Debug, uniffi::Record)]",
        "Enum"
    ));
}

fn cfg_attrs_enabled(attrs: &[String], cross_client_vectors_enabled: bool) -> bool {
    attrs.iter().all(|attr| {
        let compact = compact_attr(attr);
        if compact == r#"#[cfg(feature="cross-client-vectors")]"# {
            cross_client_vectors_enabled
        } else {
            true
        }
    })
}

fn is_uniffi_export_attr(line: &str) -> bool {
    let compact = compact_attr(line);
    (compact.starts_with("#[uniffi::export") || compact.starts_with("#[::uniffi::export"))
        && compact.ends_with(']')
}

fn attr_has_uniffi_marker(attr: &str, marker: &str) -> bool {
    compact_attr(attr).contains(&format!("uniffi::{marker}"))
}

fn compact_attr(attr: &str) -> String {
    attr.split_whitespace().collect::<String>()
}

fn starts_attribute(line: &str) -> bool {
    compact_attr(line).starts_with("#[")
}

fn collect_source_attributes(source: &str) -> Vec<String> {
    let lines: Vec<&str> = source.lines().collect();
    let mut attrs = Vec::new();
    let mut index = 0;

    while index < lines.len() {
        let line = lines[index].trim();
        if starts_attribute(line) {
            let (next_index, attr) = collect_attribute(&lines, index);
            attrs.push(attr);
            index = next_index;
        } else {
            index += 1;
        }
    }

    attrs
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

fn normalize_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalize_newlines(value: &str) -> String {
    value.replace("\r\n", "\n")
}

fn golden_path(file_name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("golden")
        .join(file_name)
}
