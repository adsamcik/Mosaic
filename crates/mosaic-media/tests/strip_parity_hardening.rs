#![allow(clippy::expect_used)]

use std::time::{Duration, Instant};

use mosaic_media::{
    MediaFormat, MetadataKind, MosaicMediaError, extract_exif_orientation, inspect_image,
    strip_known_metadata,
};

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
const WEBP_VP8X_ICC_FLAG: u8 = 0x20;
const WEBP_VP8X_ALPHA_FLAG: u8 = 0x10;
const WEBP_VP8X_EXIF_FLAG: u8 = 0x04;
const WEBP_VP8X_XMP_FLAG: u8 = 0x01;
const WEBP_VP8X_METADATA_FLAGS: u8 = WEBP_VP8X_ICC_FLAG | WEBP_VP8X_EXIF_FLAG | WEBP_VP8X_XMP_FLAG;

#[test]
fn jpeg_strip_set_removes_every_app_comment_and_known_metadata_kind() {
    let input = jpeg_with_segments(&[
        jpeg_segment(0xe0, b"JFIF\0thumbnail"),
        jpeg_segment(0xe1, b"Exif\0\0orientation/gps"),
        jpeg_segment(0xe1, b"http://ns.adobe.com/xap/1.0/\0xmp"),
        jpeg_segment(0xe1, b"http://ns.adobe.com/xmp/extension/\0extended-xmp"),
        jpeg_segment(0xe1, b"opaque-app1-private"),
        jpeg_segment(0xe2, b"ICC_PROFILE\0\x01\x01profile"),
        jpeg_segment(0xe2, b"app2-private-profile"),
        jpeg_segment(0xed, b"Photoshop 3.0\0iptc"),
        jpeg_segment(0xee, b"adobe-rendering"),
        jpeg_segment(0xef, b"app15-private"),
        jpeg_segment(0xfe, b"camera comment"),
        jpeg_segment(0xdb, &[0_u8; 65]),
        jpeg_sof_segment(0xc0, 64, 64),
    ]);

    let stripped = strip_known_metadata(MediaFormat::Jpeg, &input).expect("JPEG should strip");

    assert_eq!(
        stripped.removed,
        vec![
            MetadataKind::RenderingHint,
            MetadataKind::Exif,
            MetadataKind::Xmp,
            MetadataKind::Xmp,
            MetadataKind::RenderingHint,
            MetadataKind::ColorProfile,
            MetadataKind::RenderingHint,
            MetadataKind::Iptc,
            MetadataKind::RenderingHint,
            MetadataKind::RenderingHint,
            MetadataKind::Comment,
        ]
    );
    assert_no_jpeg_metadata(&stripped.bytes);
    assert!(contains_ascii(&stripped.bytes, b"scan bytes"));
    assert!(contains_ascii(&stripped.bytes, &[0xff, 0xdb]));
    assert_restrip_removes_nothing(MediaFormat::Jpeg, &stripped.bytes);
}

#[test]
fn jpeg_strip_skips_repeated_ff_fill_bytes_between_segments() {
    let mut input = vec![0xff, 0xd8];
    input.extend_from_slice(&[0xff, 0xff, 0xff]);
    input.extend_from_slice(&jpeg_segment(0xfe, b"comment behind fill bytes"));
    input.extend_from_slice(&[0xff, 0xff]);
    input.extend_from_slice(&jpeg_sof_segment(0xc0, 8, 8));
    input.extend_from_slice(&[0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6]);
    input.extend_from_slice(b"scan bytes");
    input.extend_from_slice(&[0xff, 0xd9]);

    let stripped =
        strip_known_metadata(MediaFormat::Jpeg, &input).expect("fill-byte JPEG should strip");

    assert_eq!(stripped.removed, vec![MetadataKind::Comment]);
    assert!(!contains_ascii(
        &stripped.bytes,
        b"comment behind fill bytes"
    ));
    assert!(contains_ascii(&stripped.bytes, b"scan bytes"));
}

#[test]
fn png_strip_set_removes_named_metadata_and_all_ancillary_chunks() {
    let input = png_with_chunks(&[
        png_ihdr_chunk(32, 32),
        png_chunk(*b"eXIf", b"gps"),
        png_chunk(*b"iTXt", b"caption\0\0\0\0\0Hello"),
        png_chunk(*b"tEXt", b"Author\0Mosaic"),
        png_chunk(*b"zTXt", b"Comment\0\0compressed"),
        png_chunk(*b"tIME", &[24, 1, 2, 3, 4, 5, 6]),
        png_chunk(*b"iCCP", b"profile\0\0payload"),
        png_chunk(*b"sRGB", &[0]),
        png_chunk(*b"cHRM", &[0; 32]),
        png_chunk(*b"gAMA", &[0, 0, 0xb1, 0x8f]),
        png_chunk(*b"pHYs", &[0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1]),
        png_chunk(*b"sPLT", b"palette\0\x08"),
        png_chunk(*b"bKGD", &[0, 1, 0, 2, 0, 3]),
        png_chunk(*b"hIST", &[0, 1, 0, 2]),
        png_chunk(*b"tRNS", b"transparent color"),
        png_chunk(*b"aaAA", b"private ancillary"),
        png_chunk(*b"IDAT", b"pixel bytes"),
        png_chunk(*b"IEND", b""),
    ]);

    let stripped = strip_known_metadata(MediaFormat::Png, &input).expect("PNG should strip");

    assert_eq!(stripped.removed.len(), 15);
    assert!(stripped.removed.contains(&MetadataKind::Exif));
    assert!(stripped.removed.contains(&MetadataKind::Text));
    assert!(stripped.removed.contains(&MetadataKind::Timestamp));
    assert!(stripped.removed.contains(&MetadataKind::ColorProfile));
    assert!(stripped.removed.contains(&MetadataKind::PhysicalDimensions));
    assert!(stripped.removed.contains(&MetadataKind::SuggestedPalette));
    assert!(stripped.removed.contains(&MetadataKind::RenderingHint));
    assert_no_png_metadata(&stripped.bytes);
    assert!(contains_ascii(&stripped.bytes, b"IDAT"));
    assert!(contains_ascii(&stripped.bytes, b"pixel bytes"));
    assert_restrip_removes_nothing(MediaFormat::Png, &stripped.bytes);
}

#[test]
fn jpeg_inspect_and_orientation_handle_app1_payloads_and_fill_bytes() {
    let opaque_app1 = jpeg_with_segments(&[
        jpeg_segment(0xe1, b"opaque-app1-private"),
        jpeg_sof_segment(0xc0, 8, 8),
    ]);
    assert_eq!(
        extract_exif_orientation(MediaFormat::Jpeg, &opaque_app1),
        Ok(1)
    );

    let mut filled = vec![0xff, 0xd8, 0xff, 0xff, 0xff];
    filled.extend_from_slice(&jpeg_sof_segment(0xc0, 8, 8));
    filled.extend_from_slice(&[0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6]);
    filled.extend_from_slice(b"scan bytes");
    filled.extend_from_slice(&[0xff, 0xd9]);
    let metadata = inspect_image(&filled).expect("JPEG fill bytes before SOF should inspect");
    assert_eq!((metadata.width, metadata.height), (8, 8));
}

#[test]
fn webp_strip_rejects_each_signature_predicate_independently() {
    assert_eq!(
        strip_known_metadata(MediaFormat::WebP, b"NOPE\0\0\0\0WEBP"),
        Err(MosaicMediaError::InvalidWebP)
    );
    assert_eq!(
        strip_known_metadata(MediaFormat::WebP, b"RIFF\0\0\0\0NOPE"),
        Err(MosaicMediaError::InvalidWebP)
    );
}

#[test]
fn webp_strip_set_removes_exif_xmp_iccp_clears_vp8x_and_preserves_animation() {
    let input = webp_with_chunks(&[
        webp_vp8x_chunk_with_flags(
            64,
            64,
            WEBP_VP8X_METADATA_FLAGS | WEBP_VP8X_ALPHA_FLAG | 0x02,
        ),
        webp_chunk(*b"ANIM", b"animation-control"),
        webp_chunk(*b"ANMF", b"animation-frame"),
        webp_chunk(*b"ALPH", b"alpha-plane"),
        webp_chunk(*b"EXIF", b"gps"),
        webp_chunk(*b"XMP ", b"caption"),
        webp_chunk(*b"ICCP", b"profile"),
        webp_vp8_chunk(64, 64),
    ]);

    let stripped = strip_known_metadata(MediaFormat::WebP, &input).expect("WebP should strip");

    assert_eq!(
        stripped.removed,
        vec![
            MetadataKind::Exif,
            MetadataKind::Xmp,
            MetadataKind::ColorProfile
        ]
    );
    assert_no_webp_metadata(&stripped.bytes);
    let flags = webp_vp8x_flags(&stripped.bytes);
    assert_eq!(flags & WEBP_VP8X_METADATA_FLAGS, 0);
    assert_eq!(flags & WEBP_VP8X_ALPHA_FLAG, WEBP_VP8X_ALPHA_FLAG);
    assert_eq!(flags & 0x02, 0x02);
    assert!(contains_ascii(&stripped.bytes, b"ANIM"));
    assert!(contains_ascii(&stripped.bytes, b"ANMF"));
    assert!(contains_ascii(&stripped.bytes, b"ALPH"));
    assert!(contains_ascii(&stripped.bytes, b"alpha-plane"));
    assert_restrip_removes_nothing(MediaFormat::WebP, &stripped.bytes);
}

#[test]
fn strip_fuzz_fixtures_do_not_panic_hang_or_leave_metadata_after_ok() {
    let cases = fuzz_cases();
    assert!(
        cases.len() >= 28,
        "expected broad JPEG/PNG/WebP fuzz inventory"
    );

    for case in cases {
        let started = Instant::now();
        let result = strip_known_metadata(case.format, &case.bytes);
        let elapsed = started.elapsed();
        assert!(
            elapsed < Duration::from_secs(1),
            "{} should complete within one second, took {elapsed:?}",
            case.name
        );
        match result {
            Ok(stripped) => assert_no_metadata_for_format(case.format, &stripped.bytes),
            Err(
                MosaicMediaError::InvalidJpeg
                | MosaicMediaError::InvalidPng
                | MosaicMediaError::InvalidWebP,
            ) => {}
            Err(other) => panic!("{} returned unexpected error: {other:?}", case.name),
        }
    }
}

struct FuzzCase {
    name: &'static str,
    format: MediaFormat,
    bytes: Vec<u8>,
}

fn fuzz_cases() -> Vec<FuzzCase> {
    let mut cases = Vec::new();

    for len in 0..2 {
        cases.push(FuzzCase {
            name: "jpeg-truncated-magic",
            format: MediaFormat::Jpeg,
            bytes: [0xff, 0xd8][..len].to_vec(),
        });
    }
    cases.push(FuzzCase {
        name: "jpeg-truncated-mid-segment",
        format: MediaFormat::Jpeg,
        bytes: vec![0xff, 0xd8, 0xff, 0xe1, 0x00, 0x20, b'E', b'x'],
    });
    cases.push(FuzzCase {
        name: "jpeg-oversized-declared-segment",
        format: MediaFormat::Jpeg,
        bytes: vec![0xff, 0xd8, 0xff, 0xe2, 0xff, 0xff, b'I'],
    });
    cases.push(FuzzCase {
        name: "jpeg-recursive-comment-markers",
        format: MediaFormat::Jpeg,
        bytes: jpeg_with_segments(&[
            jpeg_segment(0xfe, b"COM->COM->COM"),
            jpeg_segment(0xfe, b"COM<-COM<-COM"),
            jpeg_sof_segment(0xc0, 16, 16),
        ]),
    });
    cases.push(FuzzCase {
        name: "jpeg-pathological-icc",
        format: MediaFormat::Jpeg,
        bytes: jpeg_with_segments(&[
            jpeg_segment(0xe2, &large_icc_payload()),
            jpeg_sof_segment(0xc0, 16, 16),
        ]),
    });
    cases.push(FuzzCase {
        name: "jpeg-malformed-exif-rationals",
        format: MediaFormat::Jpeg,
        bytes: jpeg_with_segments(&[
            jpeg_segment(0xe1, &malformed_exif_payload()),
            jpeg_sof_segment(0xc0, 16, 16),
        ]),
    });
    cases.push(FuzzCase {
        name: "jpeg-all-metadata",
        format: MediaFormat::Jpeg,
        bytes: jpeg_with_segments(&[
            jpeg_segment(0xe1, b"Exif\0\0gps"),
            jpeg_segment(0xe1, b"http://ns.adobe.com/xap/1.0/\0xmp"),
            jpeg_segment(0xe2, b"ICC_PROFILE\0\x01\x01profile"),
            jpeg_segment(0xed, b"iptc"),
            jpeg_segment(0xfe, b"comment"),
            jpeg_sof_segment(0xc0, 16, 16),
        ]),
    });

    for len in 0..PNG_SIGNATURE.len() {
        cases.push(FuzzCase {
            name: "png-truncated-magic",
            format: MediaFormat::Png,
            bytes: PNG_SIGNATURE[..len].to_vec(),
        });
    }
    let mut png_mid = PNG_SIGNATURE.to_vec();
    png_mid.extend_from_slice(&100_u32.to_be_bytes());
    png_mid.extend_from_slice(b"iTXt");
    png_mid.extend_from_slice(b"short");
    cases.push(FuzzCase {
        name: "png-truncated-mid-chunk",
        format: MediaFormat::Png,
        bytes: png_mid,
    });
    let mut png_oversized = PNG_SIGNATURE.to_vec();
    png_oversized.extend_from_slice(&u32::MAX.to_be_bytes());
    png_oversized.extend_from_slice(b"iCCP");
    png_oversized.extend_from_slice(b"profile");
    cases.push(FuzzCase {
        name: "png-oversized-declared-chunk",
        format: MediaFormat::Png,
        bytes: png_oversized,
    });
    cases.push(FuzzCase {
        name: "png-pathological-icc",
        format: MediaFormat::Png,
        bytes: png_with_chunks(&[
            png_ihdr_chunk(16, 16),
            png_chunk(*b"iCCP", &large_icc_payload()),
            png_chunk(*b"IDAT", b"pixels"),
            png_chunk(*b"IEND", b""),
        ]),
    });
    cases.push(FuzzCase {
        name: "png-malformed-exif-rationals",
        format: MediaFormat::Png,
        bytes: png_with_chunks(&[
            png_ihdr_chunk(16, 16),
            png_chunk(*b"eXIf", &malformed_exif_payload()),
            png_chunk(*b"IDAT", b"pixels"),
            png_chunk(*b"IEND", b""),
        ]),
    });
    cases.push(FuzzCase {
        name: "png-all-metadata",
        format: MediaFormat::Png,
        bytes: png_with_chunks(&[
            png_ihdr_chunk(16, 16),
            png_chunk(*b"eXIf", b"gps"),
            png_chunk(*b"iTXt", b"caption"),
            png_chunk(*b"tEXt", b"author"),
            png_chunk(*b"zTXt", b"zip"),
            png_chunk(*b"tIME", &[1; 7]),
            png_chunk(*b"iCCP", b"profile"),
            png_chunk(*b"tRNS", b"alpha"),
            png_chunk(*b"IDAT", b"pixels"),
            png_chunk(*b"IEND", b""),
        ]),
    });

    for len in 0..12 {
        cases.push(FuzzCase {
            name: "webp-truncated-magic",
            format: MediaFormat::WebP,
            bytes: b"RIFF\0\0\0\0WEBP"[..len].to_vec(),
        });
    }
    let mut webp_mid = b"RIFF\0\0\0\0WEBP".to_vec();
    webp_mid.extend_from_slice(b"EXIF");
    webp_mid.extend_from_slice(&100_u32.to_le_bytes());
    webp_mid.extend_from_slice(b"short");
    cases.push(FuzzCase {
        name: "webp-truncated-mid-chunk",
        format: MediaFormat::WebP,
        bytes: webp_mid,
    });
    let mut webp_oversized = b"RIFF\0\0\0\0WEBP".to_vec();
    webp_oversized.extend_from_slice(b"ICCP");
    webp_oversized.extend_from_slice(&u32::MAX.to_le_bytes());
    webp_oversized.extend_from_slice(b"profile");
    cases.push(FuzzCase {
        name: "webp-oversized-declared-chunk",
        format: MediaFormat::WebP,
        bytes: webp_oversized,
    });
    cases.push(FuzzCase {
        name: "webp-pathological-icc",
        format: MediaFormat::WebP,
        bytes: webp_with_chunks(&[
            webp_chunk(*b"ICCP", &large_icc_payload()),
            webp_vp8_chunk(16, 16),
        ]),
    });
    cases.push(FuzzCase {
        name: "webp-malformed-exif-rationals",
        format: MediaFormat::WebP,
        bytes: webp_with_chunks(&[
            webp_chunk(*b"EXIF", &malformed_exif_payload()),
            webp_vp8_chunk(16, 16),
        ]),
    });
    cases.push(FuzzCase {
        name: "webp-all-metadata",
        format: MediaFormat::WebP,
        bytes: webp_with_chunks(&[
            webp_vp8x_chunk_with_flags(16, 16, WEBP_VP8X_METADATA_FLAGS),
            webp_chunk(*b"EXIF", b"gps"),
            webp_chunk(*b"XMP ", b"caption"),
            webp_chunk(*b"ICCP", b"profile"),
            webp_vp8_chunk(16, 16),
        ]),
    });

    cases
}

fn assert_restrip_removes_nothing(format: MediaFormat, bytes: &[u8]) {
    let restripped = strip_known_metadata(format, bytes).expect("stripped bytes should re-parse");
    assert!(
        restripped.removed.is_empty(),
        "re-strip should find no metadata: {:?}",
        restripped.removed
    );
    assert_eq!(restripped.bytes, bytes);
}

fn assert_no_metadata_for_format(format: MediaFormat, bytes: &[u8]) {
    match format {
        MediaFormat::Jpeg => assert_no_jpeg_metadata(bytes),
        MediaFormat::Png => assert_no_png_metadata(bytes),
        MediaFormat::WebP => assert_no_webp_metadata(bytes),
    }
    assert_restrip_removes_nothing(format, bytes);
}

fn assert_no_jpeg_metadata(bytes: &[u8]) {
    for needle in [
        b"Exif".as_slice(),
        b"xmp",
        b"extended-xmp",
        b"opaque-app1-private",
        b"ICC_PROFILE",
        b"iptc",
        b"comment",
        b"thumbnail",
        b"app15-private",
    ] {
        assert!(
            !contains_ascii(bytes, needle),
            "JPEG metadata survived: {needle:?}"
        );
    }
}

fn assert_no_png_metadata(bytes: &[u8]) {
    let mut offset = PNG_SIGNATURE.len();
    while offset < bytes.len() {
        let Some(length_bytes) = bytes.get(offset..offset + 4) else {
            return;
        };
        let payload_len =
            u32::from_be_bytes(length_bytes.try_into().expect("length slice is 4 bytes")) as usize;
        let chunk_type_start = offset + 4;
        let Some(chunk_type) = bytes.get(chunk_type_start..chunk_type_start + 4) else {
            return;
        };
        assert!(
            chunk_type[0].is_ascii_uppercase(),
            "ancillary PNG chunk survived: {chunk_type:?}"
        );
        let next = chunk_type_start + 4 + payload_len + 4;
        if next <= offset || next > bytes.len() {
            return;
        }
        offset = next;
    }
    for needle in [
        b"eXIf".as_slice(),
        b"iTXt",
        b"tEXt",
        b"zTXt",
        b"tIME",
        b"iCCP",
        b"sRGB",
        b"cHRM",
        b"gAMA",
        b"pHYs",
        b"sPLT",
        b"bKGD",
        b"hIST",
        b"tRNS",
        b"aaAA",
    ] {
        assert!(
            !contains_ascii(bytes, needle),
            "PNG metadata chunk survived: {needle:?}"
        );
    }
}

fn assert_no_webp_metadata(bytes: &[u8]) {
    for needle in [
        b"EXIF".as_slice(),
        b"XMP ",
        b"ICCP",
        b"gps",
        b"caption",
        b"profile",
    ] {
        assert!(
            !contains_ascii(bytes, needle),
            "WebP metadata survived: {needle:?}"
        );
    }
}

fn jpeg_segment(marker: u8, payload: &[u8]) -> Vec<u8> {
    let length = u16::try_from(payload.len() + 2).expect("test JPEG segment length fits");
    let mut bytes = vec![0xff, marker];
    bytes.extend_from_slice(&length.to_be_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

fn jpeg_with_segments(segments: &[Vec<u8>]) -> Vec<u8> {
    let mut bytes = vec![0xff, 0xd8];
    for segment in segments {
        bytes.extend_from_slice(segment);
    }
    bytes.extend_from_slice(&[0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6]);
    bytes.extend_from_slice(b"scan bytes");
    bytes.extend_from_slice(&[0xff, 0xd9]);
    bytes
}

fn jpeg_sof_segment(marker: u8, height: u16, width: u16) -> Vec<u8> {
    let mut payload = vec![8];
    payload.extend_from_slice(&height.to_be_bytes());
    payload.extend_from_slice(&width.to_be_bytes());
    payload.extend_from_slice(&[3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);
    jpeg_segment(marker, &payload)
}

fn png_chunk(kind: [u8; 4], payload: &[u8]) -> Vec<u8> {
    let length = u32::try_from(payload.len()).expect("test PNG chunk length fits");
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&length.to_be_bytes());
    bytes.extend_from_slice(&kind);
    bytes.extend_from_slice(payload);
    bytes.extend_from_slice(&[0, 0, 0, 0]);
    bytes
}

fn png_ihdr_chunk(width: u32, height: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&width.to_be_bytes());
    payload.extend_from_slice(&height.to_be_bytes());
    payload.extend_from_slice(&[8, 2, 0, 0, 0]);
    png_chunk(*b"IHDR", &payload)
}

fn png_with_chunks(chunks: &[Vec<u8>]) -> Vec<u8> {
    let mut bytes = PNG_SIGNATURE.to_vec();
    for chunk in chunks {
        bytes.extend_from_slice(chunk);
    }
    bytes
}

fn webp_chunk(kind: [u8; 4], payload: &[u8]) -> Vec<u8> {
    let length = u32::try_from(payload.len()).expect("test WebP chunk length fits");
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&kind);
    bytes.extend_from_slice(&length.to_le_bytes());
    bytes.extend_from_slice(payload);
    if payload.len() % 2 == 1 {
        bytes.push(0);
    }
    bytes
}

fn webp_with_chunks(chunks: &[Vec<u8>]) -> Vec<u8> {
    let payload_len = chunks.iter().map(Vec::len).sum::<usize>() + 4;
    let riff_size = u32::try_from(payload_len).expect("test RIFF size fits");
    let mut bytes = b"RIFF".to_vec();
    bytes.extend_from_slice(&riff_size.to_le_bytes());
    bytes.extend_from_slice(b"WEBP");
    for chunk in chunks {
        bytes.extend_from_slice(chunk);
    }
    bytes
}

fn webp_vp8_chunk(width: u16, height: u16) -> Vec<u8> {
    let mut payload = vec![0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a];
    payload.extend_from_slice(&(width & 0x3fff).to_le_bytes());
    payload.extend_from_slice(&(height & 0x3fff).to_le_bytes());
    payload.extend_from_slice(b"frame");
    webp_chunk(*b"VP8 ", &payload)
}

fn webp_vp8x_chunk_with_flags(width: u32, height: u32, flags: u8) -> Vec<u8> {
    let width_minus_one = width - 1;
    let height_minus_one = height - 1;
    let mut payload = vec![0; 10];
    payload[0] = flags;
    payload[4..7].copy_from_slice(&width_minus_one.to_le_bytes()[..3]);
    payload[7..10].copy_from_slice(&height_minus_one.to_le_bytes()[..3]);
    webp_chunk(*b"VP8X", &payload)
}

fn webp_vp8x_flags(bytes: &[u8]) -> u8 {
    let chunk_offset = bytes
        .windows(4)
        .position(|candidate| candidate == b"VP8X")
        .expect("VP8X chunk remains");
    bytes[chunk_offset + 8]
}

fn large_icc_payload() -> Vec<u8> {
    let mut payload = b"ICC_PROFILE\0\x01\x01".to_vec();
    payload.extend(std::iter::repeat_n(0x5a, 32 * 1024));
    payload
}

fn malformed_exif_payload() -> Vec<u8> {
    let mut payload = b"Exif\0\0MM\0*\0\0\0\x08".to_vec();
    payload.extend_from_slice(&2_u16.to_be_bytes());
    payload.extend_from_slice(&0x0002_u16.to_be_bytes());
    payload.extend_from_slice(&5_u16.to_be_bytes());
    payload.extend_from_slice(&3_u32.to_be_bytes());
    payload.extend_from_slice(&38_u32.to_be_bytes());
    payload.extend_from_slice(&0x0004_u16.to_be_bytes());
    payload.extend_from_slice(&5_u16.to_be_bytes());
    payload.extend_from_slice(&3_u32.to_be_bytes());
    payload.extend_from_slice(&62_u32.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&91_u32.to_be_bytes());
    payload.extend_from_slice(&1_u32.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&1_u32.to_be_bytes());
    payload.extend_from_slice(&14_u32.to_be_bytes());
    payload.extend_from_slice(&1_u32.to_be_bytes());
    payload.extend_from_slice(&25_u32.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&1_u32.to_be_bytes());
    payload
}

fn contains_ascii(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|candidate| candidate == needle)
}
