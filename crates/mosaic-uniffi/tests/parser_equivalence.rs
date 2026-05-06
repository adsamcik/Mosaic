const UNIFFI_SOURCE: &str = include_str!("../src/lib.rs");
const WASM_SOURCE: &str = include_str!("../../mosaic-wasm/src/lib.rs");

const DUPLICATED_STRING_PARSERS: [&str; 5] = [
    "upload_event_to_client",
    "album_sync_event_to_client",
    "upload_phase_from_string",
    "album_sync_phase_from_string",
    "manifest_recovery_outcome_from_string",
];

/// Source-equivalence locks for the download CBOR codec helpers duplicated
/// from `mosaic-wasm` into `mosaic-uniffi` so both wrappers emit and accept
/// byte-identical canonical CBOR for plans, states, and events while staying
/// architecturally independent (mosaic-uniffi must not depend on mosaic-wasm
/// per `tests/architecture/rust-boundaries.sh`). Drift in either copy is the
/// only way wire-format compatibility can break, and is therefore the only
/// thing this lock needs to catch.
const DUPLICATED_DOWNLOAD_CODEC_FNS: &[&str] = &[
    "cbor_value",
    "cbor_bytes",
    "cbor_kv",
    "cbor_uint",
    "download_state_from_cbor",
    "download_state_to_cbor",
    "download_event_from_cbor",
    "download_plan_to_cbor",
    "download_plan_from_cbor",
    "download_state_value",
    "decode_download_state",
    "decode_download_event",
    "download_plan_value",
    "download_plan_entry_value",
    "decode_download_plan",
    "download_plan_error_detail",
    "download_snapshot_error_code",
    "download_checksum_body",
    "checksum_32",
    "checksum_32_padded",
    "checksum_matches",
    "map_entries",
    "array_items",
    "required_entry",
    "u8_from_value",
    "u32_from_value",
    "u64_from_value",
    "bool_from_value",
    "text_from_value",
    "bytes_from_value",
    "bytes_16_from_value",
    "bytes_32_from_value",
    "uuid_from_cbor_value",
    "shard_tier_from_value",
    "download_error_value",
    "decode_download_error",
];

#[test]
fn duplicated_download_codec_helpers_are_source_equivalent() {
    for function_name in DUPLICATED_DOWNLOAD_CODEC_FNS {
        let uniffi_function = normalized_function(UNIFFI_SOURCE, function_name);
        let wasm_function = normalized_function(WASM_SOURCE, function_name);
        assert_eq!(
            uniffi_function, wasm_function,
            "{function_name} must stay source-equivalent between mosaic-uniffi              and mosaic-wasm so the download CBOR wire format is byte-identical"
        );
    }
}

/// Asserts that calling `mosaic_client::download::plan::DownloadPlanBuilder`
/// directly and calling the new UniFFI `build_download_plan` export yields a
/// byte-identical canonical plan CBOR for equivalent inputs. Together with
/// `duplicated_download_codec_helpers_are_source_equivalent` this gives the
/// strongest cross-wrapper byte-equivalence guarantee we can express without
/// introducing a forbidden dependency on `mosaic-wasm`.
#[test]
fn build_download_plan_uniffi_matches_direct_mosaic_client() {
    use mosaic_client::ClientErrorCode;
    use mosaic_client::download::plan::{
        DownloadPlanBuilder, DownloadPlanInput as ClientPlanInput, DownloadShardInput, PhotoId,
        ShardId,
    };
    use mosaic_domain::ShardTier;
    use mosaic_uniffi::{
        DownloadPlanEntryInput, DownloadPlanInput, DownloadPlanShardInput, build_download_plan,
    };

    let shard_id = [9_u8; 16];
    let expected_hash = [3_u8; 32];

    let uniffi_input = DownloadPlanInput {
        album_id: vec![0_u8; 16],
        entries: vec![DownloadPlanEntryInput {
            photo_id: "photo-001".to_owned(),
            filename: "vacation.jpg".to_owned(),
            shards: vec![DownloadPlanShardInput {
                shard_id: shard_id.to_vec(),
                epoch_id: 5,
                tier: ShardTier::Original.to_byte(),
                expected_hash: expected_hash.to_vec(),
                declared_size: 1024,
            }],
        }],
    };
    let uniffi_result = build_download_plan(uniffi_input);
    assert_eq!(uniffi_result.code, ClientErrorCode::Ok.as_u16());
    assert!(uniffi_result.error_detail.is_none());

    let direct_plan = DownloadPlanBuilder::new()
        .with_photo(ClientPlanInput {
            photo_id: PhotoId::new("photo-001"),
            filename: "vacation.jpg".to_owned(),
            shards: vec![DownloadShardInput {
                shard_id: ShardId::from_bytes(shard_id),
                epoch_id: 5,
                tier: ShardTier::Original,
                expected_hash,
                declared_size: 1024,
            }],
        })
        .build()
        .unwrap_or_else(|_| panic!("direct plan must build"));
    let direct_cbor = match download_plan_canonical_cbor(&direct_plan) {
        Ok(value) => value,
        Err(_) => panic!("direct plan must encode"),
    };
    assert_eq!(uniffi_result.plan_cbor, direct_cbor);
}

/// Re-implements `mosaic_uniffi::download_plan_to_cbor` for tests so the test
/// stays independent of any private uniffi helper. Source-equivalence with
/// the wrapper helpers is locked by `duplicated_download_codec_helpers_*`.
fn download_plan_canonical_cbor(
    plan: &mosaic_client::download::plan::DownloadPlan,
) -> Result<Vec<u8>, mosaic_client::ClientErrorCode> {
    use ciborium::value::{Integer, Value};
    let entries: Vec<Value> = plan
        .entries
        .iter()
        .map(|entry| {
            Value::Map(vec![
                (
                    Value::Integer(Integer::from(0_u32)),
                    Value::Text(entry.photo_id.as_str().to_owned()),
                ),
                (
                    Value::Integer(Integer::from(1_u32)),
                    Value::Integer(Integer::from(u64::from(entry.epoch_id))),
                ),
                (
                    Value::Integer(Integer::from(2_u32)),
                    Value::Integer(Integer::from(u64::from(entry.tier.to_byte()))),
                ),
                (
                    Value::Integer(Integer::from(3_u32)),
                    Value::Array(
                        entry
                            .shard_ids
                            .iter()
                            .map(|id| Value::Bytes(id.as_bytes().to_vec()))
                            .collect(),
                    ),
                ),
                (
                    Value::Integer(Integer::from(4_u32)),
                    Value::Array(
                        entry
                            .expected_hashes
                            .iter()
                            .map(|hash| Value::Bytes(hash.to_vec()))
                            .collect(),
                    ),
                ),
                (
                    Value::Integer(Integer::from(5_u32)),
                    Value::Text(entry.filename.clone()),
                ),
                (
                    Value::Integer(Integer::from(6_u32)),
                    Value::Integer(Integer::from(entry.total_bytes)),
                ),
            ])
        })
        .collect();
    let value = Value::Array(entries);
    let mut out = Vec::new();
    ciborium::ser::into_writer(&value, &mut out)
        .map_err(|_| mosaic_client::ClientErrorCode::DownloadSnapshotCorrupt)?;
    Ok(out)
}

#[test]
fn duplicated_string_parsers_are_source_equivalent() {
    for function_name in DUPLICATED_STRING_PARSERS {
        let uniffi_function = normalized_function(UNIFFI_SOURCE, function_name);
        let wasm_function = normalized_function(WASM_SOURCE, function_name);

        assert_eq!(
            uniffi_function, wasm_function,
            "{function_name} must stay source-equivalent between mosaic-uniffi and mosaic-wasm"
        );
    }
}

#[test]
fn extract_function_uses_exact_name_boundaries() {
    let source = r#"
        fn parse_value_extra() -> &'static str {
            "wrong suffix"
        }

        fn wrapper() {
            let _parse_value = "wrong non-function";
        }

        fn xparse_value() -> &'static str {
            "wrong prefix"
        }

        fn parse_value() -> &'static str {
            "right"
        }
    "#;

    let extracted = extract_function(source, "parse_value");

    assert!(extracted.contains("\"right\""));
    assert!(!extracted.contains("wrong suffix"));
    assert!(!extracted.contains("wrong non-function"));
    assert!(!extracted.contains("wrong prefix"));
}

#[test]
fn normalization_strips_comments_before_comparing_whitespace() {
    let with_comments = r#"
        fn parse_value(value: &str) -> Option<u8> {
            // Line comments are ignored.
            match value {
                /* Block comments are ignored too. */
                "One" => Some(1),
                _ => None, // Trailing comments are ignored.
            }
        }
    "#;
    let without_comments = r#"
        fn parse_value(value:&str)->Option<u8>{
            match value {
                "One"=>Some(1),
                _=>None,
            }
        }
    "#;

    assert_eq!(
        normalized_function(with_comments, "parse_value"),
        normalized_function(without_comments, "parse_value")
    );
}

fn normalized_function(source: &str, function_name: &str) -> String {
    normalize_source(extract_function(source, function_name))
}

fn normalize_source(source: &str) -> String {
    strip_comments(source)
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect()
}

fn extract_function<'source>(source: &'source str, function_name: &str) -> &'source str {
    let function_start = find_function_start(source, function_name)
        .unwrap_or_else(|| panic!("missing function with exact name boundary: {function_name}"));
    let function_end = find_function_end(source, function_start)
        .unwrap_or_else(|| panic!("unterminated function body for: {function_name}"));

    &source[function_start..function_end]
}

fn find_function_start(source: &str, function_name: &str) -> Option<usize> {
    let mut search_start = 0;
    while let Some(relative_name_start) = source[search_start..].find(function_name) {
        let name_start = search_start + relative_name_start;
        let name_end = name_start + function_name.len();
        search_start = name_end;

        if !has_identifier_boundaries(source, name_start, name_end) {
            continue;
        }

        let Some(function_keyword_start) = source[..name_start].rfind("fn") else {
            continue;
        };

        if !has_identifier_boundaries(source, function_keyword_start, function_keyword_start + 2) {
            continue;
        }

        if source[function_keyword_start + 2..name_start]
            .chars()
            .all(char::is_whitespace)
        {
            return Some(function_keyword_start);
        }
    }

    None
}

fn has_identifier_boundaries(source: &str, start: usize, end: usize) -> bool {
    !previous_char(source, start).is_some_and(is_identifier_char)
        && !next_char(source, end).is_some_and(is_identifier_char)
}

fn previous_char(source: &str, index: usize) -> Option<char> {
    source[..index].chars().next_back()
}

fn next_char(source: &str, index: usize) -> Option<char> {
    source[index..].chars().next()
}

fn is_identifier_char(character: char) -> bool {
    character == '_' || character.is_ascii_alphanumeric()
}

fn find_function_end(source: &str, function_start: usize) -> Option<usize> {
    let mut scanner = RustScanner::default();
    let mut depth = 0_u32;

    for (index, character) in source[function_start..].char_indices() {
        let absolute_index = function_start + index;
        if !scanner.update(source, absolute_index, character) {
            continue;
        }

        match character {
            '{' => depth += 1,
            '}' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(absolute_index + character.len_utf8());
                }
            }
            _ => {}
        }
    }

    None
}

fn strip_comments(source: &str) -> String {
    let mut stripped = String::with_capacity(source.len());
    let mut scanner = RustScanner::default();

    for (index, character) in source.char_indices() {
        if scanner.update(source, index, character) {
            stripped.push(character);
        }
    }

    stripped
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum ScannerState {
    #[default]
    Normal,
    LineComment,
    BlockComment,
    String,
    Char,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct RustScanner {
    state: ScannerState,
    escaped: bool,
    skip_next: bool,
}

impl RustScanner {
    fn update(&mut self, source: &str, index: usize, character: char) -> bool {
        if self.skip_next {
            self.skip_next = false;
            return false;
        }

        let next = next_char(source, index + character.len_utf8());

        match self.state {
            ScannerState::Normal => match (character, next) {
                ('/', Some('/')) => {
                    self.state = ScannerState::LineComment;
                    self.skip_next = true;
                    false
                }
                ('/', Some('*')) => {
                    self.state = ScannerState::BlockComment;
                    self.skip_next = true;
                    false
                }
                ('"', _) => {
                    self.state = ScannerState::String;
                    true
                }
                ('\'', _) => {
                    self.state = ScannerState::Char;
                    true
                }
                _ => true,
            },
            ScannerState::LineComment => {
                if character == '\n' {
                    self.state = ScannerState::Normal;
                    true
                } else {
                    false
                }
            }
            ScannerState::BlockComment => {
                if character == '*' && next == Some('/') {
                    self.state = ScannerState::Normal;
                    self.skip_next = true;
                }
                false
            }
            ScannerState::String => {
                let was_escaped = self.escaped;
                self.escaped = character == '\\' && !self.escaped;
                if character == '"' && !was_escaped {
                    self.state = ScannerState::Normal;
                }
                true
            }
            ScannerState::Char => {
                let was_escaped = self.escaped;
                self.escaped = character == '\\' && !self.escaped;
                if character == '\'' && !was_escaped {
                    self.state = ScannerState::Normal;
                }
                true
            }
        }
    }
}
