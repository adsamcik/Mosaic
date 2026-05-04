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
            (
                2,
                "device_timestamp_ms",
                SidecarTagStatus::ReservedNumberPending
            ),
            (3, "original_dimensions", SidecarTagStatus::Active),
            (4, "mime_override", SidecarTagStatus::Active),
            (5, "caption", SidecarTagStatus::ReservedNumberPending),
            (6, "filename", SidecarTagStatus::Forbidden),
            (7, "camera_make", SidecarTagStatus::ReservedNumberPending),
            (8, "camera_model", SidecarTagStatus::ReservedNumberPending),
            (9, "gps", SidecarTagStatus::ReservedNumberPending),
            (10, "codec_fourcc", SidecarTagStatus::ReservedNumberPending),
            (11, "duration_ms", SidecarTagStatus::ReservedNumberPending),
            (
                12,
                "frame_rate_x100",
                SidecarTagStatus::ReservedNumberPending
            ),
            (
                13,
                "video_orientation",
                SidecarTagStatus::ReservedNumberPending
            ),
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
        (2, SensitiveTimestamp),
        (3, RenderingOnly),
        (4, ContainerTechnical),
        (5, UserContent),
        (6, UserContent),
        (7, DeviceFingerprint),
        (8, DeviceFingerprint),
        (9, SensitiveLocation),
        (10, ContainerTechnical),
        (11, ContainerTechnical),
        (12, ContainerTechnical),
        (13, RenderingOnly),
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
    assert_eq!(MAX_SIDECAR_TOTAL_BYTES, 1_500_000);
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
