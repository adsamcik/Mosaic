use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    path::PathBuf,
};

const SOURCE: &str = include_str!("../src/lib.rs");
const CLIENT_SOURCE: &str = include_str!("../../mosaic-client/src/lib.rs");
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

            if attr_has_uniffi_marker(&attr, "Enum") {
                if let Some((next_index, enum_shape)) = parse_enum(&lines, next_attr_index) {
                    output.push_str(&enum_shape);
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

fn parse_enum(lines: &[&str], start: usize) -> Option<(usize, String)> {
    let mut index = start;
    while index < lines.len() {
        let line = lines[index].trim();
        if let Some(name) = line
            .strip_prefix("pub enum ")
            .and_then(|rest| rest.split_whitespace().next())
        {
            let name = name.trim_end_matches('{');
            let mut output = format!("enum {name}\n");
            index += 1;
            while index < lines.len() {
                let variant = lines[index].trim();
                if variant.starts_with('}') {
                    output.push_str("end\n");
                    return Some((index + 1, output));
                }
                if let Some(variant) = parse_enum_variant(variant) {
                    output.push_str("  ");
                    output.push_str(&variant);
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

fn parse_enum_variant(line: &str) -> Option<String> {
    let line = line
        .split_once("//")
        .map_or(line, |(prefix, _)| prefix)
        .trim();
    if line.is_empty() || line.starts_with("///") || line.starts_with("#[") {
        return None;
    }
    let line = line.trim_end_matches(',');
    let name = line.split_once('=').map_or(line, |(name, _)| name).trim();
    if name.is_empty() {
        return None;
    }
    Some(normalize_whitespace(line))
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
fn upload_reducer_uniffi_export_is_present() {
    let actual = canonical_uniffi_api_shape(SOURCE);

    assert!(
        actual.contains(
            "export pub fn advance_upload_job_uniffi( snapshot: ClientCoreUploadJobSnapshot, event: ClientCoreUploadJobEvent, ) -> ClientCoreUploadJobTransition"
        ),
        "direct upload reducer export must be present in UniFFI API shape"
    );
}

#[test]
fn sync_reducer_uniffi_export_is_present() {
    let actual = canonical_uniffi_api_shape(SOURCE);

    assert!(
        actual.contains(
            "export pub fn advance_album_sync_uniffi( snapshot: ClientCoreAlbumSyncSnapshot, event: ClientCoreAlbumSyncEvent, ) -> ClientCoreAlbumSyncTransition"
        ),
        "direct album sync reducer export must be present in UniFFI API shape"
    );
}

#[test]
fn manifest_transcript_uniffi_export_is_present() {
    let actual = canonical_uniffi_api_shape(SOURCE);

    assert!(
        actual.contains(
            "export pub fn manifest_transcript_bytes_uniffi(inputs: ClientCoreManifestTranscriptInputs) -> Vec<u8>"
        ),
        "manifest transcript bytes export must be present in UniFFI API shape"
    );
    assert!(
        actual.contains("record ClientCoreManifestShardRef"),
        "manifest shard input record must be locked"
    );
    assert!(
        actual.contains("record ClientCoreManifestTranscriptInputs"),
        "manifest transcript input record must be locked"
    );
}

#[test]
fn upload_transition_round_trips_through_uniffi() {
    let initialized = mosaic_uniffi::init_upload_job(mosaic_uniffi::ClientCoreUploadJobRequest {
        job_id: "018f0000-0000-7000-8000-000000000001".to_owned(),
        album_id: "018f0000-0000-7000-8000-000000000002".to_owned(),
        asset_id: "018f0000-0000-7000-8000-000000000003".to_owned(),
        idempotency_key: "018f0000-0000-7000-8000-000000000004".to_owned(),
        max_retry_count: 5,
    });
    assert_eq!(initialized.code, 0);

    let event = mosaic_uniffi::ClientCoreUploadJobEvent {
        kind: "StartRequested".to_owned(),
        effect_id: "018f0000-0000-7000-8000-000000000005".to_owned(),
        tier: 0,
        shard_index: 0,
        shard_id: String::new(),
        sha256: Vec::new(),
        content_length: 0,
        envelope_version: 0,
        uploaded: false,
        tiered_shards: Vec::new(),
        shard_set_hash: Vec::new(),
        asset_id: String::new(),
        since_metadata_version: 0,
        recovery_outcome: String::new(),
        now_ms: 0,
        base_backoff_ms: 0,
        server_retry_after_ms: 0,
        has_server_retry_after_ms: false,
        has_error_code: false,
        error_code: 0,
        target_phase: String::new(),
    };

    let wrapped = mosaic_uniffi::advance_upload_job(initialized.snapshot.clone(), event.clone());
    let direct = mosaic_uniffi::advance_upload_job_uniffi(initialized.snapshot, event);

    assert_eq!(wrapped.code, 0);
    assert_eq!(
        wrapped.transition.next_snapshot.phase,
        "AwaitingPreparedMedia"
    );
    assert_eq!(
        direct.next_snapshot.phase,
        wrapped.transition.next_snapshot.phase
    );
    assert_eq!(
        direct.next_snapshot.max_retry_count,
        wrapped.transition.next_snapshot.max_retry_count
    );
}

#[test]
fn album_sync_transition_round_trips_through_uniffi() {
    let snapshot = mosaic_uniffi::ClientCoreAlbumSyncSnapshot {
        schema_version: 1,
        album_id: "album-direct-sync-regression".to_owned(),
        phase: "Idle".to_owned(),
        active_cursor: String::new(),
        pending_cursor: String::new(),
        rerun_requested: false,
        retry_count: 0,
        max_retry_count: 5,
        next_retry_unix_ms: 0,
        last_error_code: 0,
        last_error_stage: String::new(),
        updated_at_unix_ms: 1_700_000_000_000,
    };
    let event = mosaic_uniffi::ClientCoreAlbumSyncEvent {
        kind: "SyncRequested".to_owned(),
        fetched_cursor: String::new(),
        next_cursor: String::new(),
        applied_count: 0,
        observed_asset_ids: Vec::new(),
        retry_after_unix_ms: 0,
        has_error_code: false,
        error_code: 0,
    };

    let wrapped = mosaic_uniffi::advance_album_sync(snapshot.clone(), event.clone());
    let direct = mosaic_uniffi::advance_album_sync_uniffi(snapshot, event);

    assert_eq!(wrapped.code, 0);
    assert_eq!(direct, wrapped.transition);
    assert_eq!(direct.snapshot.phase, "FetchingPage");
    assert_eq!(direct.snapshot.max_retry_count, 5);
}

#[test]
fn manifest_transcript_bytes_uniffi_matches_domain_vector() {
    let shards = vec![
        mosaic_uniffi::ClientCoreManifestShardRef {
            tier: 3,
            shard_index: 1,
            shard_id: "20212223-2425-2627-2829-2a2b2c2d2e2f".to_owned(),
            sha256: vec![0x22; 32],
        },
        mosaic_uniffi::ClientCoreManifestShardRef {
            tier: 1,
            shard_index: 0,
            shard_id: "10111213-1415-1617-1819-1a1b1c1d1e1f".to_owned(),
            sha256: vec![0x11; 32],
        },
    ];
    let inputs = mosaic_uniffi::ClientCoreManifestTranscriptInputs {
        album_id: (0_u8..16).collect(),
        epoch_id: 7,
        encrypted_metadata_envelope: vec![0xaa, 0xbb, 0xcc],
        shards,
    };

    let result = mosaic_uniffi::manifest_transcript_bytes_uniffi(inputs);

    assert_eq!(
        result,
        match mosaic_domain::golden_vectors::manifest_transcript_bytes() {
            Ok(bytes) => bytes,
            Err(error) => panic!("domain manifest transcript vector is invalid: {error:?}"),
        }
    );
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

/// Verifies that the production UniFFI build (default features) does NOT export
/// the cross-client-vectors gated symbols. This is the counterpart to the
/// Gradle invariant: if this assertion holds and Gradle forbids mixed
/// production/test task graphs, corpus driver symbols cannot enter a production
/// APK through the Android wiring.
#[test]
#[cfg_attr(
    feature = "cross-client-vectors",
    should_panic(
        expected = "cross-client-vectors feature is enabled in this build — production APK would leak corpus drivers"
    )
)]
fn production_uniffi_bindings_do_not_expose_corpus_drivers() {
    #[cfg(not(feature = "cross-client-vectors"))]
    {
        let actual = canonical_uniffi_api_shape_for_features(SOURCE, false);
        assert!(!actual.contains("verify_and_open_bundle_with_recipient_seed"));
        assert!(!actual.contains("derive_link_keys_from_raw_secret"));
        assert!(!actual.contains("derive_identity_from_raw_seed"));
    }

    #[cfg(feature = "cross-client-vectors")]
    {
        panic!(
            "cross-client-vectors feature is enabled in this build — production APK would leak corpus drivers"
        );
    }
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
fn client_error_code_uniffi_export_includes_all_variants() {
    let source_variants = client_error_code_variants(CLIENT_SOURCE);
    let golden_variants = uniffi_enum_variants(GOLDEN, "ClientErrorCode");

    assert_eq!(
        source_variants.keys().collect::<BTreeSet<_>>(),
        golden_variants.keys().collect::<BTreeSet<_>>(),
        "UniFFI ClientErrorCode enum must export every source ClientErrorCode variant"
    );
}

#[test]
fn client_error_code_uniffi_discriminants_match_rust_source() {
    let source_variants = client_error_code_variants(CLIENT_SOURCE);

    for (variant, expected) in source_variants {
        let code = mosaic_uniffi::client_error_code_enum_from_u16(expected)
            .unwrap_or_else(|| panic!("UniFFI rejected source ClientErrorCode::{variant}"));

        assert_eq!(
            format!("{code:?}"),
            variant,
            "UniFFI numeric conversion returned the wrong variant for {expected}"
        );
        assert_eq!(
            mosaic_uniffi::client_error_code_to_u16(code),
            expected,
            "UniFFI ClientErrorCode::{variant} discriminant drifted from Rust source"
        );
    }
}

#[test]
fn golden_parser_has_no_unhandled_uniffi_object_surfaces() {
    let attrs = collect_source_attributes(SOURCE);
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

fn client_error_code_variants(source: &str) -> BTreeMap<String, u16> {
    let body = enum_body(source, "ClientErrorCode")
        .unwrap_or_else(|| panic!("missing ClientErrorCode enum in source"));
    let mut variants = BTreeMap::new();
    for line in body.lines() {
        let Some(variant) = parse_enum_variant(line) else {
            continue;
        };
        let Some((name, value)) = variant.split_once('=') else {
            panic!("ClientErrorCode variant must pin an explicit discriminant: {variant}");
        };
        let value = value.trim().parse::<u16>().unwrap_or_else(|error| {
            panic!("invalid ClientErrorCode discriminant {variant}: {error}")
        });
        variants.insert(name.trim().to_owned(), value);
    }
    variants
}

fn uniffi_enum_variants(source: &str, enum_name: &str) -> BTreeMap<String, u16> {
    let body = golden_enum_body(source, enum_name)
        .unwrap_or_else(|| panic!("missing {enum_name} enum in UniFFI golden"));
    body.lines()
        .filter_map(parse_enum_variant)
        .map(|variant| {
            let Some((name, value)) = variant.split_once('=') else {
                panic!("UniFFI golden enum variant must pin a discriminant: {variant}");
            };
            let value = value.trim().parse::<u16>().unwrap_or_else(|error| {
                panic!("invalid UniFFI golden discriminant {variant}: {error}")
            });
            (name.trim().to_owned(), value)
        })
        .collect()
}

fn enum_body<'a>(source: &'a str, enum_name: &str) -> Option<&'a str> {
    source
        .split_once(&format!("enum {enum_name}"))
        .and_then(|(_, rest)| rest.split_once('{'))
        .and_then(|(_, rest)| rest.split_once('}'))
        .map(|(body, _)| body)
}

fn golden_enum_body(source: &str, enum_name: &str) -> Option<String> {
    let source = normalize_newlines(source);
    source
        .split_once(&format!("enum {enum_name}\n"))
        .and_then(|(_, rest)| rest.split_once("\nend"))
        .map(|(body, _)| body.to_owned())
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
