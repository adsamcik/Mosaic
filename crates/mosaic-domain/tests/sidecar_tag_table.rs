use mosaic_domain::{
    MAX_SIDECAR_TOTAL_BYTES, MetadataSidecar, MetadataSidecarError, MetadataSidecarField,
    SidecarTagPrivacyClass, SidecarTagStatus, canonical_metadata_sidecar_bytes,
    metadata_field_tags,
};

const ALBUM_ID: [u8; 16] = [0x11; 16];
const PHOTO_ID: [u8; 16] = [0x22; 16];

fn pub_u16_consts(source: &str) -> Vec<(u16, String)> {
    let regex = match regex::Regex::new(
        r"(?m)^\s*pub\s+const\s+([A-Z_][A-Z0-9_]*)\s*:\s*u16\s*=\s*((?:0x[0-9A-Fa-f_]+|\d[\d_]*)(?:_?u16)?)\s*;",
    ) {
        Ok(regex) => regex,
        Err(error) => panic!("regex compiles: {error}"),
    };

    regex
        .captures_iter(source)
        .map(|cap| {
            let literal = cap[2]
                .trim_end_matches("u16")
                .trim_end_matches('_')
                .replace('_', "");
            let value = if let Some(hex) = literal.strip_prefix("0x") {
                match u16::from_str_radix(hex, 16) {
                    Ok(value) => value,
                    Err(error) => panic!("hex tag parses: {error}"),
                }
            } else {
                match literal.parse::<u16>() {
                    Ok(value) => value,
                    Err(error) => panic!("decimal tag parses: {error}"),
                }
            };
            (value, cap[1].to_ascii_lowercase())
        })
        .collect()
}

#[test]
fn expected_and_live_tables_agree() {
    let live: Vec<(u16, &str, SidecarTagStatus)> = metadata_field_tags::KNOWN_FIELD_TAGS
        .iter()
        .map(|entry| (entry.tag_number(), entry.tag_name(), entry.status()))
        .collect();
    assert_eq!(
        live,
        vec![
            (1, "orientation", SidecarTagStatus::Active),
            (2, "original_dimensions", SidecarTagStatus::Active),
            (3, "device_timestamp_ms", SidecarTagStatus::Active),
            (4, "mime_override", SidecarTagStatus::Active),
            (5, "camera_make", SidecarTagStatus::Active),
            (6, "filename", SidecarTagStatus::Forbidden),
            (7, "camera_model", SidecarTagStatus::Active),
            (8, "subseconds_ms", SidecarTagStatus::Active),
            (9, "gps", SidecarTagStatus::Active),
            (10, "codec_fourcc", SidecarTagStatus::Active),
            (11, "duration_ms", SidecarTagStatus::Active),
            (12, "frame_rate_x100", SidecarTagStatus::Active),
            (13, "video_orientation", SidecarTagStatus::Active),
            (14, "video_dimensions", SidecarTagStatus::Active),
            (15, "video_container_format", SidecarTagStatus::Active),
        ]
    );
}

#[test]
fn known_field_tags_list_every_pub_const_in_metadata_field_tags() {
    let known: std::collections::BTreeSet<_> = metadata_field_tags::KNOWN_FIELD_TAGS
        .iter()
        .map(|entry| (entry.tag_number(), entry.tag_name().to_owned()))
        .collect();
    let missing: Vec<_> = pub_u16_consts(include_str!("../src/lib.rs"))
        .into_iter()
        .filter(|entry| !known.contains(entry))
        .collect();
    assert!(missing.is_empty(), "missing constants: {missing:?}");
}

#[test]
fn pub_u16_const_parser_handles_hex_and_typed_suffix_literals() {
    let source = r"
        pub const HEX_TAG: u16 = 0x0E;
        pub const TYPED_TAG: u16 = 14u16;
        pub const UNDERSCORED_TYPED_TAG: u16 = 14_u16;
        pub const DECIMAL_WITH_SEPARATOR: u16 = 1_024;
        pub const LOWER_HEX: u16 = 0xa6;
        pub const UPPER_HEX: u16 = 0xA6;
        pub const HEX_TYPED: u16 = 0x10u16;
        pub const HEX_UNDERSCORE_TYPED: u16 = 0x10_u16;
    ";

    assert_eq!(
        pub_u16_consts(source),
        vec![
            (14, "hex_tag".to_owned()),
            (14, "typed_tag".to_owned()),
            (14, "underscored_typed_tag".to_owned()),
            (1024, "decimal_with_separator".to_owned()),
            (166, "lower_hex".to_owned()),
            (166, "upper_hex".to_owned()),
            (16, "hex_typed".to_owned()),
            (16, "hex_underscore_typed".to_owned()),
        ]
    );
}

#[test]
fn sidecar_tag_privacy_classes_match_spec_table() {
    use SidecarTagPrivacyClass::*;
    let expected = [
        (1, RenderingOnly),
        (2, RenderingOnly),
        (3, SensitiveTimestamp),
        (4, ContainerTechnical),
        (5, DeviceFingerprint),
        (6, UserContent),
        (7, DeviceFingerprint),
        (8, SensitiveTimestamp),
        (9, SensitiveLocation),
        (10, ContainerTechnical),
        (11, ContainerTechnical),
        (12, ContainerTechnical),
        (13, RenderingOnly),
        (14, RenderingOnly),
        (15, ContainerTechnical),
    ];
    for (tag, class) in expected {
        assert_eq!(metadata_field_tags::privacy_class(tag), Some(class));
    }
}

#[test]
fn reserved_ranges_are_disjoint() {
    let low_end = 4095_u16;
    let future_start = 4096_u16;
    let future_end = 32767_u16;
    let high_start = 32768_u16;
    assert!(low_end < future_start);
    assert!(future_end < high_start);
}
#[test]
fn high_bit_range_is_disjoint_from_4096_range() {
    let future_end = 32767_u16;
    let high_start = 32768_u16;
    assert!(future_end < high_start);
}
#[test]
fn no_duplicate_numbers() {
    let mut seen = std::collections::BTreeSet::new();
    for entry in metadata_field_tags::KNOWN_FIELD_TAGS {
        assert!(seen.insert(entry.tag_number()));
    }
}

#[test]
fn max_sidecar_total_bytes_is_frozen() {
    assert_eq!(MAX_SIDECAR_TOTAL_BYTES, 65_536);
}

#[test]
fn lock_test_for_every_forbidden_tag() {
    let forbidden_tags: Vec<_> = metadata_field_tags::KNOWN_FIELD_TAGS
        .iter()
        .filter(|entry| entry.status() == SidecarTagStatus::Forbidden)
        .map(|entry| entry.tag_number())
        .collect();

    assert_eq!(forbidden_tags, vec![6]);

    for tag in forbidden_tags {
        let fields = [MetadataSidecarField::new(tag, b"forbidden")];
        assert_eq!(
            canonical_metadata_sidecar_bytes(&MetadataSidecar::new(ALBUM_ID, PHOTO_ID, 1, &fields)),
            Err(MetadataSidecarError::ForbiddenTag { tag })
        );
    }
}

#[test]
fn rm3_rm4_promoted_tags_are_active() {
    for tag in [
        metadata_field_tags::DEVICE_TIMESTAMP_MS,
        metadata_field_tags::CAMERA_MAKE,
        metadata_field_tags::CAMERA_MODEL,
        metadata_field_tags::SUBSECONDS_MS,
        metadata_field_tags::GPS,
    ] {
        assert_eq!(
            metadata_field_tags::status(tag),
            Some(SidecarTagStatus::Active)
        );
    }
}

#[test]
fn max_length_camera_make_and_model_encode() {
    let make = [b'M'; 64];
    let model = [b'Z'; 64];
    let fields = [
        MetadataSidecarField::new(metadata_field_tags::CAMERA_MAKE, &make),
        MetadataSidecarField::new(metadata_field_tags::CAMERA_MODEL, &model),
    ];

    let bytes = match canonical_metadata_sidecar_bytes(&MetadataSidecar::new(
        ALBUM_ID, PHOTO_ID, 1, &fields,
    )) {
        Ok(bytes) => bytes,
        Err(error) => panic!("max-length camera fields should encode: {error:?}"),
    };

    assert_eq!(bytes.len(), 59 + (2 * 6) + 64 + 64);
}

#[test]
fn each_active_tag_encodes_through_canonical_sidecar_builder() {
    let orientation = 1_u16.to_le_bytes();
    let mut dimensions = [0_u8; 8];
    dimensions[..4].copy_from_slice(&4032_u32.to_le_bytes());
    dimensions[4..].copy_from_slice(&3024_u32.to_le_bytes());
    let timestamp = 1_704_157_445_123_u64.to_le_bytes();
    let mime = b"image/jpeg";
    let make = b"MosaicCam";
    let model = b"Model Z";
    let subseconds = 123_u32.to_le_bytes();
    let mut gps = [0_u8; 14];
    gps[..4].copy_from_slice(&50_091_667_i32.to_le_bytes());
    gps[4..8].copy_from_slice(&14_416_667_i32.to_le_bytes());
    gps[8..12].copy_from_slice(&250_i32.to_le_bytes());
    gps[12..14].copy_from_slice(&7_u16.to_le_bytes());
    let codec = [1_u8];
    let video_duration = 12_345_u64.to_le_bytes();
    let frame_rate = 29_970_u32.to_le_bytes();
    let video_orientation = [1_u8];
    let mut video_dimensions = [0_u8; 8];
    video_dimensions[..4].copy_from_slice(&1920_u32.to_le_bytes());
    video_dimensions[4..].copy_from_slice(&1080_u32.to_le_bytes());
    let video_container = [1_u8];
    let fields = [
        MetadataSidecarField::new(metadata_field_tags::ORIENTATION, &orientation),
        MetadataSidecarField::new(metadata_field_tags::ORIGINAL_DIMENSIONS, &dimensions),
        MetadataSidecarField::new(metadata_field_tags::DEVICE_TIMESTAMP_MS, &timestamp),
        MetadataSidecarField::new(metadata_field_tags::MIME_OVERRIDE, mime),
        MetadataSidecarField::new(metadata_field_tags::CAMERA_MAKE, make),
        MetadataSidecarField::new(metadata_field_tags::CAMERA_MODEL, model),
        MetadataSidecarField::new(metadata_field_tags::SUBSECONDS_MS, &subseconds),
        MetadataSidecarField::new(metadata_field_tags::GPS, &gps),
        MetadataSidecarField::new(metadata_field_tags::CODEC_FOURCC, &codec),
        MetadataSidecarField::new(metadata_field_tags::DURATION_MS, &video_duration),
        MetadataSidecarField::new(metadata_field_tags::FRAME_RATE_X100, &frame_rate),
        MetadataSidecarField::new(metadata_field_tags::VIDEO_ORIENTATION, &video_orientation),
        MetadataSidecarField::new(metadata_field_tags::VIDEO_DIMENSIONS, &video_dimensions),
        MetadataSidecarField::new(
            metadata_field_tags::VIDEO_CONTAINER_FORMAT,
            &video_container,
        ),
    ];

    let bytes = match canonical_metadata_sidecar_bytes(&MetadataSidecar::new(
        ALBUM_ID, PHOTO_ID, 1, &fields,
    )) {
        Ok(bytes) => bytes,
        Err(error) => panic!("all active tags should encode: {error:?}"),
    };

    assert_eq!(
        bytes.len(),
        59 + (14 * 6) + 2 + 8 + 8 + 10 + 9 + 7 + 4 + 14 + 1 + 8 + 4 + 1 + 8 + 1
    );
}
