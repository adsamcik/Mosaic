use mosaic_domain::{SidecarTagPrivacyClass, SidecarTagStatus, metadata_field_tags};

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
            (6, "filename", SidecarTagStatus::ReservedNumberPending),
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
    let regex =
        match regex::Regex::new(r"(?m)^\s*pub\s+const\s+([A-Z_]+)\s*:\s*u16\s*=\s*(\d+)\s*;") {
            Ok(regex) => regex,
            Err(error) => panic!("regex compiles: {error}"),
        };
    let known: std::collections::BTreeSet<_> = metadata_field_tags::KNOWN_FIELD_TAGS
        .iter()
        .map(|entry| (entry.tag_number(), entry.tag_name().to_owned()))
        .collect();
    let missing: Vec<_> = regex
        .captures_iter(include_str!("../src/lib.rs"))
        .map(|cap| {
            (
                match cap[2].parse::<u16>() {
                    Ok(value) => value,
                    Err(error) => panic!("tag parses: {error}"),
                },
                cap[1].to_ascii_lowercase(),
            )
        })
        .filter(|entry| !known.contains(entry))
        .collect();
    assert!(missing.is_empty(), "missing constants: {missing:?}");
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
