#![allow(clippy::expect_used)]

use std::fs;
use std::path::PathBuf;

use mosaic_media::{MediaFormat, strip_known_metadata};

struct CorpusCase {
    name: &'static str,
    format: MediaFormat,
    input_file: &'static str,
    stripped_file: &'static str,
    removed_metadata_count: usize,
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|crates_dir| crates_dir.parent())
        .expect("mosaic-media crate should live under <repo>/crates")
        .to_path_buf()
}

fn corpus_bytes(file_name: &str) -> Vec<u8> {
    fs::read(
        repo_root()
            .join("apps")
            .join("web")
            .join("tests")
            .join("fixtures")
            .join("strip-corpus")
            .join(file_name),
    )
    .expect("strip corpus fixture should be readable")
}

#[test]
fn native_rust_matches_web_wasm_strip_corpus_goldens() {
    let cases = [
        CorpusCase {
            name: "jpeg-app2-icc-app13-iptc",
            format: MediaFormat::Jpeg,
            input_file: "jpeg-with-appn.jpg",
            stripped_file: "jpeg-with-appn.stripped.jpg",
            removed_metadata_count: 3,
        },
        CorpusCase {
            name: "png-itxt-time-iccp",
            format: MediaFormat::Png,
            input_file: "png-with-text.png",
            stripped_file: "png-with-text.stripped.png",
            removed_metadata_count: 3,
        },
        CorpusCase {
            name: "webp-vp8x-exif-xmp-iccp",
            format: MediaFormat::WebP,
            input_file: "webp-with-metadata.webp",
            stripped_file: "webp-with-metadata.stripped.webp",
            removed_metadata_count: 3,
        },
    ];

    for case in cases {
        let input = corpus_bytes(case.input_file);
        let expected = corpus_bytes(case.stripped_file);
        let stripped =
            strip_known_metadata(case.format, &input).expect("fixture should strip successfully");

        assert_eq!(
            stripped.removed.len(),
            case.removed_metadata_count,
            "{} removed metadata count mismatch",
            case.name
        );
        assert_eq!(
            stripped.bytes, expected,
            "{} stripped bytes differ from shared web golden",
            case.name
        );
    }
}
