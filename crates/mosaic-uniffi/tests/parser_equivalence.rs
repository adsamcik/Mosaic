const UNIFFI_SOURCE: &str = include_str!("../src/lib.rs");
const WASM_SOURCE: &str = include_str!("../../mosaic-wasm/src/lib.rs");

const DUPLICATED_STRING_PARSERS: [&str; 5] = [
    "upload_event_to_client",
    "album_sync_event_to_client",
    "upload_phase_from_string",
    "album_sync_phase_from_string",
    "manifest_recovery_outcome_from_string",
];

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
