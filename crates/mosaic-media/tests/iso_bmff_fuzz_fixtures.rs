#![allow(clippy::expect_used)]

use mosaic_media::{BoxParser, strip_avif_metadata};

#[test]
fn iso_bmff_rejects_truncated_container_without_panic() {
    let mut meta = vec![0, 0, 0, 0];
    meta.extend_from_slice(&[0, 0, 0]);

    assert!(BoxParser::new(&bmff_box(*b"meta", &meta)).parse().is_err());
}

#[test]
fn iso_bmff_rejects_box_claiming_size_beyond_input() {
    let input = vec![0, 0, 0, 100, b'f', b't', b'y', b'p', b'a', b'v', b'i', b'f'];

    assert!(BoxParser::new(&input).parse().is_err());
}

#[test]
fn iso_bmff_rejects_recursive_container_depth() {
    let mut payload = bmff_box(*b"mdat", b"image");
    for _ in 0..10 {
        payload = bmff_box(*b"moov", &payload);
    }

    assert!(BoxParser::new(&payload).parse().is_err());
}

#[test]
fn iso_bmff_rejects_zero_length_box() {
    let input = vec![0, 0, 0, 0, b'f', b't', b'y', b'p'];

    assert!(BoxParser::new(&input).parse().is_err());
}

#[test]
fn iso_bmff_rejects_oversized_extended_size_field() {
    let mut input = Vec::new();
    input.extend_from_slice(&1_u32.to_be_bytes());
    input.extend_from_slice(b"free");
    input.extend_from_slice(&(100_u64 * 1024 * 1024 + 17).to_be_bytes());

    assert!(BoxParser::new(&input).parse().is_err());
}

#[test]
fn avif_strip_rejects_container_with_no_mdat() {
    let input = bmff_file_without_mdat();

    assert!(strip_avif_metadata(&input).is_err());
}

#[test]
fn iso_bmff_rejects_mdat_embedded_inside_meta() {
    let mut meta = vec![0, 0, 0, 0];
    meta.extend_from_slice(&bmff_box(*b"mdat", b"nested"));
    let input = bmff_box(*b"meta", &meta);

    assert!(BoxParser::new(&input).parse().is_err());
}

fn bmff_file_without_mdat() -> Vec<u8> {
    let mut input = bmff_box(*b"ftyp", b"avif\0\0\0\0avifmif1");
    input.extend_from_slice(&bmff_box(*b"meta", &[0, 0, 0, 0]));
    input
}

fn bmff_box(box_type: [u8; 4], payload: &[u8]) -> Vec<u8> {
    let size = u32::try_from(payload.len() + 8).expect("test box size fits");
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&size.to_be_bytes());
    bytes.extend_from_slice(&box_type);
    bytes.extend_from_slice(payload);
    bytes
}
