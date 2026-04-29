//! Targeted kill tests for `cargo-mutants` mutants that survived the
//! existing `#[cfg(test)] mod tests` suite in `crates/mosaic-media/src/lib.rs`.
//!
//! Each test here is anchored to specific source line numbers and asserts
//! byte-exact / value-exact properties so a single-character mutation
//! observably changes the result.
//!
//! ## Mutants intentionally NOT killed here
//!
//! * `crates/mosaic-media/src/lib.rs:11:57: replace | with ^` and
//!   `crates/mosaic-media/src/lib.rs:11:79: replace | with ^` —
//!   `WEBP_VP8X_METADATA_FLAGS = WEBP_VP8X_ICC_FLAG | WEBP_VP8X_EXIF_FLAG |
//!    WEBP_VP8X_XMP_FLAG`. The three flag bits (0x20, 0x04, 0x01) are
//!   non-overlapping, so XOR yields the same value (0x25) as OR. The XOR
//!   mutation is provably equivalent to the original.
//!
//! * `crates/mosaic-media/src/lib.rs:562:16: replace += with *=`,
//!   `:723:16: replace += with *=`, `:949:16: replace += with *=` —
//!   the `offset += 1` immediately before the inner skip-FF loop. The skip
//!   loop is the only work that needs to advance past the leading 0xff fill
//!   byte, so the outer increment is redundant. Equivalent.
//!
//! * `crates/mosaic-media/src/lib.rs:719:18`, `:752:24`, `:767:30`,
//!   `:826:20`, `:831:18`, `:897:22`, `:1113:20` — `<` to `<=` boundary
//!   mutations on JPEG/PNG/WebP container bound checks. In each case the
//!   loop body or `bytes.get(...)` call is properly bounded for the
//!   one-extra iteration that the mutation enables, producing the same
//!   `Err(InvalidJpeg/Png/WebP)` outcome.
//!
//! * `crates/mosaic-media/src/lib.rs:928:25` and `:928:54` — `|` to `^` in
//!   `read_u24_le` (`u32::from(bytes[0]) | (u32::from(bytes[1]) << 8) |
//!   (u32::from(bytes[2]) << 16)`). The three byte ranges occupy disjoint
//!   bit positions, so XOR and OR produce identical u32 values. Equivalent.

#![forbid(unsafe_code)]
#![allow(clippy::expect_used, clippy::unwrap_used)]

use mosaic_domain::ShardTier;
use mosaic_media::{
    MAX_IMAGE_PIXELS, MediaFormat, MediaSidecarIds, MosaicMediaError, NORMAL_EXIF_ORIENTATION,
    PREVIEW_MAX_DIMENSION, THUMBNAIL_MAX_DIMENSION, canonical_media_metadata_sidecar_bytes,
    crate_name, extract_exif_orientation, generate_tiers, generate_tiers_with_metadata,
    generate_tiers_with_sidecar, inspect_image, normalize_dimensions_by_orientation,
    plan_tier_layout, protocol_version, strip_known_metadata,
};
use std::cell::RefCell;

fn jpeg_segment(marker: u8, payload: &[u8]) -> Vec<u8> {
    let length = u16::try_from(payload.len() + 2).expect("test segment length fits");
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

fn tiff_orientation_payload(
    orientation: u16,
    little_endian: bool,
    value_type: u16,
    value_count: u32,
) -> Vec<u8> {
    let mut payload = b"Exif\0\0".to_vec();
    if little_endian {
        payload.extend_from_slice(b"II");
        payload.extend_from_slice(&42_u16.to_le_bytes());
        payload.extend_from_slice(&8_u32.to_le_bytes());
        payload.extend_from_slice(&1_u16.to_le_bytes());
        payload.extend_from_slice(&0x0112_u16.to_le_bytes());
        payload.extend_from_slice(&value_type.to_le_bytes());
        payload.extend_from_slice(&value_count.to_le_bytes());
        payload.extend_from_slice(&orientation.to_le_bytes());
        payload.extend_from_slice(&[0, 0]);
        payload.extend_from_slice(&0_u32.to_le_bytes());
    } else {
        payload.extend_from_slice(b"MM");
        payload.extend_from_slice(&42_u16.to_be_bytes());
        payload.extend_from_slice(&8_u32.to_be_bytes());
        payload.extend_from_slice(&1_u16.to_be_bytes());
        payload.extend_from_slice(&0x0112_u16.to_be_bytes());
        payload.extend_from_slice(&value_type.to_be_bytes());
        payload.extend_from_slice(&value_count.to_be_bytes());
        payload.extend_from_slice(&orientation.to_be_bytes());
        payload.extend_from_slice(&[0, 0]);
        payload.extend_from_slice(&0_u32.to_be_bytes());
    }
    payload
}

fn jpeg_exif_orientation_segment(orientation: u16, little_endian: bool) -> Vec<u8> {
    let payload = tiff_orientation_payload(orientation, little_endian, 3, 1);
    jpeg_segment(0xe1, &payload)
}

fn webp_chunk(kind: [u8; 4], payload: &[u8]) -> Vec<u8> {
    let length = u32::try_from(payload.len()).expect("test chunk length fits");
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

fn read_vp8x_flag_byte(bytes: &[u8]) -> u8 {
    let chunk_offset = bytes
        .windows(4)
        .position(|candidate| candidate == b"VP8X")
        .expect("stripped WebP should still contain a VP8X chunk");
    bytes[chunk_offset + 8]
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
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    for chunk in chunks {
        bytes.extend_from_slice(chunk);
    }
    bytes
}

#[test]
fn public_constants_have_fixed_protocol_values() {
    assert_eq!(MAX_IMAGE_PIXELS, 32 * 1024 * 1024);
    assert_eq!(MAX_IMAGE_PIXELS, 33_554_432);
    assert_eq!(THUMBNAIL_MAX_DIMENSION, 256);
    assert_eq!(PREVIEW_MAX_DIMENSION, 1024);
    assert_eq!(NORMAL_EXIF_ORIENTATION, 1);
}

#[test]
fn crate_name_and_protocol_version_are_byte_exact() {
    assert_eq!(crate_name(), "mosaic-media");
    assert_eq!(crate_name().len(), 12);
    assert_eq!(protocol_version(), "mosaic-v1");
    assert_eq!(protocol_version().len(), 9);
}

#[test]
fn media_format_mime_type_is_byte_exact_for_each_variant() {
    assert_eq!(MediaFormat::Jpeg.mime_type(), "image/jpeg");
    assert_eq!(MediaFormat::Png.mime_type(), "image/png");
    assert_eq!(MediaFormat::WebP.mime_type(), "image/webp");
    assert_ne!(MediaFormat::Jpeg.mime_type(), MediaFormat::Png.mime_type());
    assert_ne!(MediaFormat::Png.mime_type(), MediaFormat::WebP.mime_type());
    assert_ne!(MediaFormat::Jpeg.mime_type(), MediaFormat::WebP.mime_type());
}

#[test]
fn plan_tier_layout_rejects_dimensions_whose_pixel_product_exceeds_budget() {
    assert_eq!(
        plan_tier_layout(8192, 8192),
        Err(MosaicMediaError::InvalidDimensions)
    );

    assert!(plan_tier_layout(4096, 4096).is_ok());
    assert!(plan_tier_layout(MAX_IMAGE_PIXELS, 1).is_ok());
    assert!(plan_tier_layout(1, MAX_IMAGE_PIXELS).is_ok());

    assert_eq!(
        plan_tier_layout(MAX_IMAGE_PIXELS / 2 + 1, 2),
        Err(MosaicMediaError::InvalidDimensions)
    );
}

#[test]
fn plan_tier_layout_uses_proportional_integer_scaling_for_secondary_dimension() {
    let layout = plan_tier_layout(4096, 1024).expect("4096x1024 fits the budget");

    assert_eq!(layout.thumbnail.width, THUMBNAIL_MAX_DIMENSION);
    assert_eq!(layout.thumbnail.height, 64);
    assert_eq!(layout.preview.width, PREVIEW_MAX_DIMENSION);
    assert_eq!(layout.preview.height, 256);
    assert_eq!(layout.original.width, 4096);
    assert_eq!(layout.original.height, 1024);
}

#[test]
fn jpeg_orientation_only_parsed_from_app1_segment_with_exif_prefix() {
    let exif_like_payload = tiff_orientation_payload(6, true, 3, 1);
    let comment_segment = jpeg_segment(0xfe, &exif_like_payload);
    let bytes = jpeg_with_segments(&[comment_segment, jpeg_sof_segment(0xc0, 100, 100)]);

    let metadata =
        inspect_image(&bytes).expect("JPEG with stray Exif-prefixed comment should parse");
    assert_eq!(metadata.orientation, NORMAL_EXIF_ORIENTATION);
    assert_eq!(metadata.orientation, 1);

    assert_eq!(
        extract_exif_orientation(MediaFormat::Jpeg, &bytes),
        Ok(NORMAL_EXIF_ORIENTATION)
    );
}

#[test]
fn jpeg_orientation_is_parsed_from_real_app1_exif_segment() {
    let bytes = jpeg_with_segments(&[
        jpeg_exif_orientation_segment(6, true),
        jpeg_sof_segment(0xc0, 100, 100),
    ]);

    let metadata = inspect_image(&bytes).expect("EXIF JPEG should parse");
    assert_eq!(metadata.orientation, 6);
}

#[test]
fn jpeg_orientation_inner_fill_byte_skip_advances_forward() {
    let mut bytes = vec![0xff, 0xd8];
    bytes.push(0xff);
    bytes.extend_from_slice(&jpeg_sof_segment(0xc0, 100, 100));
    bytes.extend_from_slice(&[0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6]);
    bytes.extend_from_slice(b"scan bytes");
    bytes.extend_from_slice(&[0xff, 0xd9]);

    assert_eq!(
        extract_exif_orientation(MediaFormat::Jpeg, &bytes),
        Ok(NORMAL_EXIF_ORIENTATION)
    );

    let mut bytes = vec![0xff, 0xd8];
    bytes.push(0xff);
    bytes.push(0xff);
    bytes.extend_from_slice(&jpeg_sof_segment(0xc0, 100, 100));
    bytes.extend_from_slice(&[0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6]);
    bytes.extend_from_slice(b"scan bytes");
    bytes.extend_from_slice(&[0xff, 0xd9]);
    assert_eq!(
        extract_exif_orientation(MediaFormat::Jpeg, &bytes),
        Ok(NORMAL_EXIF_ORIENTATION)
    );
}

#[test]
fn tiff_orientation_parses_at_max_supported_entry_count() {
    let mut tiff = Vec::new();
    tiff.extend_from_slice(b"II");
    tiff.extend_from_slice(&42_u16.to_le_bytes());
    tiff.extend_from_slice(&8_u32.to_le_bytes());
    tiff.extend_from_slice(&256_u16.to_le_bytes());

    tiff.extend_from_slice(&0x0112_u16.to_le_bytes());
    tiff.extend_from_slice(&3_u16.to_le_bytes());
    tiff.extend_from_slice(&1_u32.to_le_bytes());
    tiff.extend_from_slice(&6_u16.to_le_bytes());
    tiff.extend_from_slice(&[0, 0]);
    tiff.extend_from_slice(&0_u32.to_le_bytes());

    for _ in 1..256 {
        tiff.extend_from_slice(&[0_u8; 12]);
    }

    let segment = jpeg_segment(0xe1, &{
        let mut payload = b"Exif\0\0".to_vec();
        payload.extend_from_slice(&tiff);
        payload
    });
    let bytes = jpeg_with_segments(&[segment, jpeg_sof_segment(0xc0, 100, 100)]);

    let orientation =
        extract_exif_orientation(MediaFormat::Jpeg, &bytes).expect("max-IFD JPEG should parse");
    assert_eq!(orientation, 6);
}

#[test]
fn tiff_orientation_is_normal_when_ifd_entry_count_exceeds_cap() {
    let mut tiff = Vec::new();
    tiff.extend_from_slice(b"II");
    tiff.extend_from_slice(&42_u16.to_le_bytes());
    tiff.extend_from_slice(&8_u32.to_le_bytes());
    tiff.extend_from_slice(&257_u16.to_le_bytes());

    tiff.extend_from_slice(&0x0112_u16.to_le_bytes());
    tiff.extend_from_slice(&3_u16.to_le_bytes());
    tiff.extend_from_slice(&1_u32.to_le_bytes());
    tiff.extend_from_slice(&6_u16.to_le_bytes());
    tiff.extend_from_slice(&[0, 0]);
    tiff.extend_from_slice(&0_u32.to_le_bytes());
    for _ in 1..257 {
        tiff.extend_from_slice(&[0_u8; 12]);
    }

    let segment = jpeg_segment(0xe1, &{
        let mut payload = b"Exif\0\0".to_vec();
        payload.extend_from_slice(&tiff);
        payload
    });
    let bytes = jpeg_with_segments(&[segment, jpeg_sof_segment(0xc0, 100, 100)]);

    let orientation = extract_exif_orientation(MediaFormat::Jpeg, &bytes)
        .expect("over-cap JPEG should still parse the JPEG container");
    assert_eq!(orientation, NORMAL_EXIF_ORIENTATION);
}

#[test]
fn tiff_orientation_rejects_entry_with_wrong_value_type_even_when_count_is_correct() {
    let mut tiff = Vec::new();
    tiff.extend_from_slice(b"II");
    tiff.extend_from_slice(&42_u16.to_le_bytes());
    tiff.extend_from_slice(&8_u32.to_le_bytes());
    tiff.extend_from_slice(&1_u16.to_le_bytes());

    tiff.extend_from_slice(&0x0112_u16.to_le_bytes());
    tiff.extend_from_slice(&4_u16.to_le_bytes());
    tiff.extend_from_slice(&1_u32.to_le_bytes());
    tiff.extend_from_slice(&6_u32.to_le_bytes());

    let segment = jpeg_segment(0xe1, &{
        let mut payload = b"Exif\0\0".to_vec();
        payload.extend_from_slice(&tiff);
        payload
    });
    let bytes = jpeg_with_segments(&[segment, jpeg_sof_segment(0xc0, 100, 100)]);

    let orientation = extract_exif_orientation(MediaFormat::Jpeg, &bytes)
        .expect("wrong-type orientation should fall back gracefully");
    assert_eq!(orientation, NORMAL_EXIF_ORIENTATION);
}

#[test]
fn tiff_orientation_rejects_entry_with_wrong_value_count_even_when_type_is_correct() {
    let mut tiff = Vec::new();
    tiff.extend_from_slice(b"II");
    tiff.extend_from_slice(&42_u16.to_le_bytes());
    tiff.extend_from_slice(&8_u32.to_le_bytes());
    tiff.extend_from_slice(&1_u16.to_le_bytes());

    tiff.extend_from_slice(&0x0112_u16.to_le_bytes());
    tiff.extend_from_slice(&3_u16.to_le_bytes());
    tiff.extend_from_slice(&2_u32.to_le_bytes());
    tiff.extend_from_slice(&6_u16.to_le_bytes());
    tiff.extend_from_slice(&[0, 0]);
    tiff.extend_from_slice(&0_u32.to_le_bytes());

    let segment = jpeg_segment(0xe1, &{
        let mut payload = b"Exif\0\0".to_vec();
        payload.extend_from_slice(&tiff);
        payload
    });
    let bytes = jpeg_with_segments(&[segment, jpeg_sof_segment(0xc0, 100, 100)]);

    let orientation = extract_exif_orientation(MediaFormat::Jpeg, &bytes)
        .expect("wrong-count orientation should fall back gracefully");
    assert_eq!(orientation, NORMAL_EXIF_ORIENTATION);
}

#[test]
fn stripped_webp_clears_all_three_metadata_presence_bits_with_literal_masks() {
    let all_flags = 0x20 | 0x04 | 0x01;
    assert_eq!(all_flags, 0x25);

    let chunks = vec![
        webp_vp8x_chunk_with_flags(64, 64, all_flags),
        webp_vp8_chunk(64, 64),
        webp_chunk(*b"EXIF", b"gps"),
        webp_chunk(*b"XMP ", b"caption"),
        webp_chunk(*b"ICCP", b"profile"),
    ];
    let bytes = webp_with_chunks(&chunks);

    let stripped =
        strip_known_metadata(MediaFormat::WebP, &bytes).expect("VP8X-flagged WebP should strip");

    let stripped_flags = read_vp8x_flag_byte(&stripped.bytes);
    assert_eq!(stripped_flags & 0x20, 0, "ICC bit must be cleared");
    assert_eq!(stripped_flags & 0x04, 0, "EXIF bit must be cleared");
    assert_eq!(stripped_flags & 0x01, 0, "XMP bit must be cleared");

    assert_eq!(stripped_flags & 0xda, 0);
}

#[test]
fn orientation_normalization_swaps_only_transposed_orientations() {
    for orientation in 1_u8..=4 {
        assert_eq!(
            normalize_dimensions_by_orientation(640, 480, orientation),
            Ok((640, 480)),
            "orientation {orientation} should keep landscape dimensions"
        );
    }
    for orientation in 5_u8..=8 {
        assert_eq!(
            normalize_dimensions_by_orientation(640, 480, orientation),
            Ok((480, 640)),
            "orientation {orientation} should transpose dimensions"
        );
    }
    assert_eq!(
        normalize_dimensions_by_orientation(640, 480, 0),
        Ok((640, 480))
    );
    assert_eq!(
        normalize_dimensions_by_orientation(640, 480, 9),
        Ok((640, 480))
    );
    assert_eq!(
        normalize_dimensions_by_orientation(640, 480, 200),
        Ok((640, 480))
    );
}

#[test]
fn plan_tier_layout_rejects_zero_dimensions() {
    assert_eq!(
        plan_tier_layout(0, 1),
        Err(MosaicMediaError::InvalidDimensions)
    );
    assert_eq!(
        plan_tier_layout(1, 0),
        Err(MosaicMediaError::InvalidDimensions)
    );
    assert_eq!(
        plan_tier_layout(0, 0),
        Err(MosaicMediaError::InvalidDimensions)
    );
}

#[test]
fn canonical_media_metadata_sidecar_encodes_orientation_dimensions_and_mime_in_order() {
    let ids = MediaSidecarIds {
        album_id: [0xa0; 16],
        photo_id: [0xb0; 16],
        epoch_id: 9,
    };
    let metadata = mosaic_media::ImageMetadata {
        format: MediaFormat::Jpeg,
        mime_type: "image/jpeg",
        width: 4032,
        height: 3024,
        orientation: 6,
    };

    let sidecar =
        canonical_media_metadata_sidecar_bytes(ids, metadata).expect("sidecar should serialize");

    let orientation = u16::from(6_u8).to_le_bytes();
    let mut dimensions = [0_u8; 8];
    dimensions[..4].copy_from_slice(&4032_u32.to_le_bytes());
    dimensions[4..].copy_from_slice(&3024_u32.to_le_bytes());
    let fields = [
        mosaic_domain::MetadataSidecarField::new(
            mosaic_domain::metadata_field_tags::ORIENTATION,
            &orientation,
        ),
        mosaic_domain::MetadataSidecarField::new(
            mosaic_domain::metadata_field_tags::ORIGINAL_DIMENSIONS,
            &dimensions,
        ),
        mosaic_domain::MetadataSidecarField::new(
            mosaic_domain::metadata_field_tags::MIME_OVERRIDE,
            b"image/jpeg",
        ),
    ];
    let expected = mosaic_domain::canonical_metadata_sidecar_bytes(
        &mosaic_domain::MetadataSidecar::new(ids.album_id, ids.photo_id, ids.epoch_id, &fields),
    )
    .expect("expected sidecar bytes should serialize");

    assert_eq!(sidecar, expected);

    assert!(
        sidecar
            .windows(8)
            .any(|window| window[..4] == 4032_u32.to_le_bytes()
                && window[4..] == 3024_u32.to_le_bytes()),
        "sidecar should contain width then height in canonical order"
    );
}

#[derive(Default)]
struct CapturingEncoder {
    requests: RefCell<Vec<mosaic_media::TierDimensions>>,
}

impl mosaic_media::MediaTierEncoder for CapturingEncoder {
    fn encode_tier(
        &self,
        _source: &[u8],
        _metadata: mosaic_media::ImageMetadata,
        dimensions: mosaic_media::TierDimensions,
    ) -> Result<mosaic_media::TierOutput, MosaicMediaError> {
        self.requests.borrow_mut().push(dimensions);
        Ok(mosaic_media::TierOutput {
            tier: dimensions.tier,
            width: dimensions.width,
            height: dimensions.height,
            bytes: vec![dimensions.tier.to_byte(); 4],
        })
    }
}

#[test]
fn generate_tiers_invokes_encoder_for_thumbnail_then_preview_in_order() {
    let bytes = png_with_chunks(&[
        png_ihdr_chunk(640, 480),
        png_chunk(*b"IDAT", b"pixel"),
        png_chunk(*b"IEND", b""),
    ]);
    let encoder = CapturingEncoder::default();

    let generated = generate_tiers(&bytes, &encoder).expect("PNG should generate tiers");

    let requests = encoder.requests.borrow().clone();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].tier, ShardTier::Thumbnail);
    assert_eq!(requests[1].tier, ShardTier::Preview);
    assert_eq!(requests[0].width, 256);
    assert_eq!(requests[0].height, 192);
    assert_eq!(requests[1].width, 640);
    assert_eq!(requests[1].height, 480);

    let tiers = generated.tiers();
    assert_eq!(tiers[0].tier, ShardTier::Thumbnail);
    assert_eq!(tiers[1].tier, ShardTier::Preview);
    assert_eq!(tiers[2].tier, ShardTier::Original);
}

#[test]
fn generate_tiers_with_metadata_rejects_supplied_metadata_that_disagrees_with_source() {
    let bytes = png_with_chunks(&[
        png_ihdr_chunk(640, 480),
        png_chunk(*b"IDAT", b"pixel"),
        png_chunk(*b"IEND", b""),
    ]);
    let encoder = CapturingEncoder::default();

    let stale_metadata = mosaic_media::ImageMetadata {
        format: MediaFormat::Png,
        mime_type: "image/png",
        width: 320,
        height: 240,
        orientation: NORMAL_EXIF_ORIENTATION,
    };
    assert_eq!(
        generate_tiers_with_metadata(&bytes, stale_metadata, &encoder),
        Err(MosaicMediaError::ImageMetadataMismatch)
    );
    assert!(encoder.requests.borrow().is_empty());
}

#[test]
fn generate_tiers_with_sidecar_emits_inspected_orientation_in_sidecar() {
    let bytes = jpeg_with_segments(&[
        jpeg_exif_orientation_segment(8, true),
        jpeg_sof_segment(0xc0, 100, 200),
    ]);
    let ids = MediaSidecarIds {
        album_id: [0x11; 16],
        photo_id: [0x22; 16],
        epoch_id: 0x99_88_77_66,
    };
    let encoder = CapturingEncoder::default();

    let generated =
        generate_tiers_with_sidecar(&bytes, ids, &encoder).expect("JPEG should generate sidecar");

    let inspected = inspect_image(&bytes).expect("source JPEG should inspect");
    let expected_sidecar =
        canonical_media_metadata_sidecar_bytes(ids, inspected).expect("sidecar should serialize");
    assert_eq!(generated.metadata_sidecar(), expected_sidecar);
    assert_eq!(inspected.orientation, 8);
}
