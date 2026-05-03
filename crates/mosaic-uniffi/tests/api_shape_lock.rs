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
    let lines: Vec<&str> = source.lines().collect();
    let mut output = String::from("mosaic-uniffi-api-shape:v1\n");
    let mut index = 0;

    while index < lines.len() {
        let line = lines[index].trim();

        if line.contains("uniffi::Record") {
            if let Some((next_index, record)) = parse_record(&lines, index + 1) {
                output.push_str(&record);
                index = next_index;
                continue;
            }
        }

        if line == "#[uniffi::export]" {
            if let Some((next_index, signature)) = parse_exported_function(&lines, index + 1) {
                output.push_str("export ");
                output.push_str(&signature);
                output.push('\n');
                index = next_index;
                continue;
            }
        }

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
        if line.starts_with("#[") || line.starts_with("///") || line.is_empty() {
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
        if line.starts_with("#[") || line.starts_with("///") || line.is_empty() {
            index += 1;
            continue;
        }
        if line.starts_with("pub fn ") {
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
