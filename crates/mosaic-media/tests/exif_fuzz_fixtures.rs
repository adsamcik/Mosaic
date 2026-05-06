#![allow(clippy::expect_used)]

use mosaic_media::{ExtractedGpsFields, MediaFormat, extract_canonical_sidecar_fields};

#[test]
fn extract_gps_from_well_formed_jpeg() {
    let jpeg = jpeg_with_exif(&exif_tiff(
        Some(gps_ifd(&[
            ascii_entry(0x0001, "N"),
            rational_entry(0x0002, &[(50, 1), (5, 1), (30, 1)]),
            ascii_entry(0x0003, "E"),
            rational_entry(0x0004, &[(14, 1), (25, 1), (0, 1)]),
            byte_entry(0x0005, 0),
            rational_entry(0x0006, &[(250, 1)]),
            rational_entry(0x001f, &[(7, 1)]),
        ])),
        None,
        &[],
        0,
    ));

    let fields = extract_fields(&jpeg);

    assert_eq!(
        fields.gps,
        Some(ExtractedGpsFields {
            lat_microdegrees: 50_091_667,
            lon_microdegrees: 14_416_667,
            altitude_meters: 250,
            accuracy_meters: 7,
        })
    );
}

#[test]
fn extract_gps_rejects_zero_denominator() {
    let jpeg = jpeg_with_exif(&exif_tiff(
        Some(gps_ifd(&[
            ascii_entry(0x0001, "N"),
            rational_entry(0x0002, &[(50, 1), (5, 0), (30, 1)]),
            ascii_entry(0x0003, "E"),
            rational_entry(0x0004, &[(14, 1), (25, 1), (0, 1)]),
        ])),
        None,
        &[],
        0,
    ));

    assert_eq!(
        extract_canonical_sidecar_fields(&jpeg, MediaFormat::Jpeg).code,
        0
    );
    assert!(
        extract_canonical_sidecar_fields(&jpeg, MediaFormat::Jpeg)
            .fields
            .is_none()
    );
}

#[test]
fn extract_gps_rejects_out_of_range_lat() {
    let jpeg = jpeg_with_exif(&exif_tiff(
        Some(gps_ifd(&[
            ascii_entry(0x0001, "N"),
            rational_entry(0x0002, &[(91, 1), (0, 1), (0, 1)]),
            ascii_entry(0x0003, "E"),
            rational_entry(0x0004, &[(14, 1), (25, 1), (0, 1)]),
        ])),
        None,
        &[],
        0,
    ));

    assert!(
        extract_canonical_sidecar_fields(&jpeg, MediaFormat::Jpeg)
            .fields
            .is_none()
    );
}

#[test]
fn extract_gps_handles_recursive_ifd() {
    let tiff = exif_tiff(None, None, &[ascii_entry(0x010f, "LoopCam")], 8);
    let jpeg = jpeg_with_exif(&tiff);

    let fields = extract_fields(&jpeg);

    assert_eq!(fields.camera_make.as_deref(), Some("LoopCam"));
    assert!(fields.gps.is_none());
}

#[test]
fn extract_camera_info_from_well_formed_jpeg() {
    let jpeg = jpeg_with_exif(&exif_tiff(
        None,
        Some(exif_ifd(&[
            ascii_entry(0x9003, "2024:01:02 03:04:05"),
            ascii_entry(0x9011, "+02:00"),
        ])),
        &[
            ascii_entry(0x010f, "MosaicCam"),
            ascii_entry(0x0110, "Model Z"),
        ],
        0,
    ));

    let fields = extract_fields(&jpeg);

    assert_eq!(fields.camera_make.as_deref(), Some("MosaicCam"));
    assert_eq!(fields.camera_model.as_deref(), Some("Model Z"));
    assert_eq!(fields.device_timestamp_ms, Some(1_704_157_445_000));
}

#[test]
fn extract_subseconds() {
    let jpeg = jpeg_with_exif(&exif_tiff(
        None,
        Some(exif_ifd(&[
            ascii_entry(0x9003, "2024:01:02 03:04:05"),
            ascii_entry(0x9011, "+02:00"),
            ascii_entry(0x9291, "123456"),
        ])),
        &[],
        0,
    ));

    let fields = extract_fields(&jpeg);

    assert_eq!(fields.subseconds_ms, Some(123));
    assert_eq!(fields.device_timestamp_ms, Some(1_704_157_445_123));
}

#[test]
fn extract_returns_partial_when_some_fields_malformed() {
    let jpeg = jpeg_with_exif(&exif_tiff(
        Some(gps_ifd(&[
            ascii_entry(0x0001, "N"),
            rational_entry(0x0002, &[(50, 1), (5, 0), (30, 1)]),
            ascii_entry(0x0003, "E"),
            rational_entry(0x0004, &[(14, 1), (25, 1), (0, 1)]),
        ])),
        None,
        &[ascii_entry(0x010f, "PartialCam")],
        0,
    ));

    let fields = extract_fields(&jpeg);

    assert_eq!(fields.camera_make.as_deref(), Some("PartialCam"));
    assert!(fields.gps.is_none());
}

#[test]
fn extract_handles_oversized_and_truncated_exif_blobs_without_panic() {
    let oversized = jpeg_with_exif(&exif_tiff(
        None,
        Some(exif_ifd(&[ascii_entry(0x9291, &"9".repeat(2000))])),
        &[ascii_entry(0x010f, &"A".repeat(100))],
        0,
    ));
    let truncated = vec![0xff, 0xd8, 0xff, 0xe1, 0x00, 0x20, b'E', b'x'];

    let oversized_fields = extract_fields(&oversized);
    assert_eq!(
        oversized_fields.camera_make.as_deref(),
        Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
    );
    assert!(oversized_fields.subseconds_ms.is_none());
    assert_eq!(
        extract_canonical_sidecar_fields(&truncated, MediaFormat::Jpeg).code,
        1
    );
}

fn extract_fields(jpeg: &[u8]) -> mosaic_media::ExtractedSidecarFields {
    let result = extract_canonical_sidecar_fields(jpeg, MediaFormat::Jpeg);
    assert_eq!(result.code, 0);
    result
        .fields
        .expect("fixture should produce at least one field")
}

#[derive(Clone)]
struct Entry {
    tag: u16,
    value_type: u16,
    count: u32,
    value: Vec<u8>,
}

fn ascii_entry(tag: u16, value: &str) -> Entry {
    let mut bytes = value.as_bytes().to_vec();
    bytes.push(0);
    Entry {
        tag,
        value_type: 2,
        count: u32::try_from(bytes.len()).expect("ASCII test value length fits"),
        value: bytes,
    }
}

fn byte_entry(tag: u16, value: u8) -> Entry {
    Entry {
        tag,
        value_type: 1,
        count: 1,
        value: vec![value],
    }
}

fn long_entry(tag: u16, value: u32) -> Entry {
    Entry {
        tag,
        value_type: 4,
        count: 1,
        value: value.to_le_bytes().to_vec(),
    }
}

fn rational_entry(tag: u16, values: &[(u32, u32)]) -> Entry {
    let mut bytes = Vec::new();
    for (numerator, denominator) in values {
        bytes.extend_from_slice(&numerator.to_le_bytes());
        bytes.extend_from_slice(&denominator.to_le_bytes());
    }
    Entry {
        tag,
        value_type: 5,
        count: u32::try_from(values.len()).expect("rational test count fits"),
        value: bytes,
    }
}

fn gps_ifd(entries: &[Entry]) -> Vec<Entry> {
    entries.to_vec()
}

fn exif_ifd(entries: &[Entry]) -> Vec<Entry> {
    entries.to_vec()
}

fn exif_tiff(
    gps_entries: Option<Vec<Entry>>,
    exif_entries: Option<Vec<Entry>>,
    ifd0_entries: &[Entry],
    next_ifd_offset: u32,
) -> Vec<u8> {
    let mut ifd0_entry_count = ifd0_entries.len();
    if gps_entries.is_some() {
        ifd0_entry_count += 1;
    }
    if exif_entries.is_some() {
        ifd0_entry_count += 1;
    }

    let ifd0_extra_len: usize = ifd0_entries
        .iter()
        .map(|entry| {
            if entry.value.len() > 4 {
                entry.value.len()
            } else {
                0
            }
        })
        .sum();
    let ifd0_len = 2 + ifd0_entry_count * 12 + 4 + ifd0_extra_len;
    let exif_offset = 8 + ifd0_len;
    let exif_ifd = exif_entries
        .as_ref()
        .map(|entries| build_ifd(entries, exif_offset, 0))
        .unwrap_or_default();
    let gps_offset = exif_offset + exif_ifd.len();
    let gps_ifd = gps_entries
        .as_ref()
        .map(|entries| build_ifd(entries, gps_offset, 0))
        .unwrap_or_default();

    let mut ifd0 = ifd0_entries.to_vec();
    if exif_entries.is_some() {
        ifd0.push(long_entry(
            0x8769,
            u32::try_from(exif_offset).expect("EXIF offset fits"),
        ));
    }
    if gps_entries.is_some() {
        ifd0.push(long_entry(
            0x8825,
            u32::try_from(gps_offset).expect("GPS offset fits"),
        ));
    }
    ifd0.sort_by_key(|entry| entry.tag);

    let mut tiff = b"II".to_vec();
    tiff.extend_from_slice(&42_u16.to_le_bytes());
    tiff.extend_from_slice(&8_u32.to_le_bytes());
    tiff.extend_from_slice(&build_ifd(&ifd0, 8, next_ifd_offset));
    tiff.extend_from_slice(&exif_ifd);
    tiff.extend_from_slice(&gps_ifd);
    tiff
}

fn build_ifd(entries: &[Entry], base_offset: usize, next_ifd_offset: u32) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut extra = Vec::new();
    bytes.extend_from_slice(
        &u16::try_from(entries.len())
            .expect("IFD entry count fits")
            .to_le_bytes(),
    );
    let value_base = base_offset + 2 + entries.len() * 12 + 4;
    for entry in entries {
        bytes.extend_from_slice(&entry.tag.to_le_bytes());
        bytes.extend_from_slice(&entry.value_type.to_le_bytes());
        bytes.extend_from_slice(&entry.count.to_le_bytes());
        if entry.value.len() <= 4 {
            let mut inline = [0_u8; 4];
            inline[..entry.value.len()].copy_from_slice(&entry.value);
            bytes.extend_from_slice(&inline);
        } else {
            let offset = value_base + extra.len();
            bytes.extend_from_slice(
                &u32::try_from(offset)
                    .expect("IFD value offset fits")
                    .to_le_bytes(),
            );
            extra.extend_from_slice(&entry.value);
        }
    }
    bytes.extend_from_slice(&next_ifd_offset.to_le_bytes());
    bytes.extend_from_slice(&extra);
    bytes
}

fn jpeg_with_exif(tiff: &[u8]) -> Vec<u8> {
    let mut payload = b"Exif\0\0".to_vec();
    payload.extend_from_slice(tiff);
    let mut bytes = vec![0xff, 0xd8, 0xff, 0xe1];
    bytes.extend_from_slice(
        &u16::try_from(payload.len() + 2)
            .expect("EXIF segment length fits")
            .to_be_bytes(),
    );
    bytes.extend_from_slice(&payload);
    bytes.extend_from_slice(&[0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6]);
    bytes.extend_from_slice(b"scan bytes");
    bytes.extend_from_slice(&[0xff, 0xd9]);
    bytes
}
