//! Lock test for the canonical sidecar tag registry.
//! Pins every (tag_number, tag_name, layout_class) tuple. Any change without
//! a corresponding entry update fails CI. Append-only; existing entries
//! immutable.
//!
//! Governance: docs/adr/ADR-017-sidecar-tag-registry-policy.md
//! Reference: docs/specs/SPEC-CanonicalSidecarTags.md

use std::collections::BTreeSet;

use mosaic_domain::metadata_field_tags::{
    CAMERA_MAKE, CAMERA_MODEL, CAPTION, DEVICE_TIMESTAMP_MS, FILENAME, GPS, KNOWN_FIELD_TAGS,
    MIME_OVERRIDE, ORIENTATION, ORIGINAL_DIMENSIONS,
};

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum LayoutClass {
    /// Layout finalized in this lock-test entry.
    Active,
    /// Number reserved; layout to be finalized by a future ADR/PR.
    /// `R-M5` allocates the slot; `R-M3` / `R-M4` / `R-M7` (etc.) promote to Active.
    ReservedAwaitingLayout,
    /// Range reserved by ADR-017 for vendor / future / high-bit allocations; never directly used.
    ReservedRange,
}

#[derive(Debug, PartialEq, Eq, Clone)]
struct RegistryEntry {
    tag_number: u16,
    tag_name: String,
    layout_class: LayoutClass,
    layout_detail: Option<LayoutDetail>,
}
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum LayoutDetail {
    U16LeExifOrientationRange1To8,
    U32LeWidthThenHeightNonZero,
    Utf8BytesNoRegistryCapU32Length,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
struct ReservedRange {
    start: u16,
    end: u16,
    name: &'static str,
}

const RESERVED_RANGES: [ReservedRange; 10] = [
    ReservedRange {
        start: 0,
        end: 0,
        name: "zero_never_allocated",
    },
    ReservedRange {
        start: 1,
        end: 4,
        name: "v1_image_class",
    },
    ReservedRange {
        start: 5,
        end: 6,
        name: "caption_filename",
    },
    ReservedRange {
        start: 7,
        end: 9,
        name: "image_extensions",
    },
    ReservedRange {
        start: 10,
        end: 13,
        name: "video_class",
    },
    ReservedRange {
        start: 14,
        end: 127,
        name: "media_extensions",
    },
    ReservedRange {
        start: 128,
        end: 255,
        name: "non_media_structured",
    },
    ReservedRange {
        start: 256,
        end: 4095,
        name: "vendor_experimental",
    },
    ReservedRange {
        start: 4096,
        end: 32767,
        name: "future_protocol_extensions",
    },
    ReservedRange {
        start: 32768,
        end: 65535,
        name: "high_bit_skippable_optional",
    },
];

fn entry(
    tag_number: u16,
    tag_name: impl Into<String>,
    layout_class: LayoutClass,
    layout_detail: Option<LayoutDetail>,
) -> RegistryEntry {
    RegistryEntry {
        tag_number,
        tag_name: tag_name.into(),
        layout_class,
        layout_detail,
    }
}

fn reserved_range_boundary_entries() -> Vec<RegistryEntry> {
    RESERVED_RANGES
        .iter()
        .filter(|range| range.start >= 14)
        .flat_map(|range| {
            [
                entry(
                    range.start,
                    format!("reserved_{}_start", range.name),
                    LayoutClass::ReservedRange,
                    None,
                ),
                entry(
                    range.end,
                    format!("reserved_{}_end", range.name),
                    LayoutClass::ReservedRange,
                    None,
                ),
            ]
        })
        .collect()
}

fn ranges_are_pairwise_disjoint(ranges: &[ReservedRange]) -> bool {
    ranges.iter().all(|range| range.start <= range.end)
        && ranges.iter().enumerate().all(|(i, left)| {
            ranges
                .iter()
                .skip(i + 1)
                .all(|right| left.end < right.start || right.end < left.start)
        })
}

fn expected_table() -> Vec<RegistryEntry> {
    use LayoutClass::{Active, ReservedAwaitingLayout, ReservedRange};

    let mut table = vec![
        entry(0, "reserved_zero", ReservedRange, None),
        entry(
            1,
            "orientation",
            Active,
            Some(LayoutDetail::U16LeExifOrientationRange1To8),
        ),
        entry(2, "device_timestamp_ms", ReservedAwaitingLayout, None),
        entry(
            3,
            "original_dimensions",
            Active,
            Some(LayoutDetail::U32LeWidthThenHeightNonZero),
        ),
        entry(
            4,
            "mime_override",
            Active,
            Some(LayoutDetail::Utf8BytesNoRegistryCapU32Length),
        ),
        entry(5, "caption", ReservedAwaitingLayout, None),
        entry(6, "filename", ReservedAwaitingLayout, None),
        entry(7, "camera_make", ReservedAwaitingLayout, None),
        entry(8, "camera_model", ReservedAwaitingLayout, None),
        entry(9, "gps", ReservedAwaitingLayout, None),
        entry(10, "codec_fourcc", ReservedAwaitingLayout, None),
        entry(11, "duration_ms", ReservedAwaitingLayout, None),
        entry(12, "frame_rate_x100", ReservedAwaitingLayout, None),
        entry(13, "video_orientation", ReservedAwaitingLayout, None),
    ];
    table.extend(reserved_range_boundary_entries());
    table
}

fn live_table() -> Vec<RegistryEntry> {
    use LayoutClass::{Active, ReservedAwaitingLayout, ReservedRange};

    let mut table = vec![
        entry(0, "reserved_zero", ReservedRange, None),
        entry(
            ORIENTATION,
            "orientation",
            Active,
            Some(LayoutDetail::U16LeExifOrientationRange1To8),
        ),
        entry(
            DEVICE_TIMESTAMP_MS,
            "device_timestamp_ms",
            ReservedAwaitingLayout,
            None,
        ),
        entry(
            ORIGINAL_DIMENSIONS,
            "original_dimensions",
            Active,
            Some(LayoutDetail::U32LeWidthThenHeightNonZero),
        ),
        entry(
            MIME_OVERRIDE,
            "mime_override",
            Active,
            Some(LayoutDetail::Utf8BytesNoRegistryCapU32Length),
        ),
        entry(CAPTION, "caption", ReservedAwaitingLayout, None),
        entry(FILENAME, "filename", ReservedAwaitingLayout, None),
        entry(CAMERA_MAKE, "camera_make", ReservedAwaitingLayout, None),
        entry(CAMERA_MODEL, "camera_model", ReservedAwaitingLayout, None),
        entry(GPS, "gps", ReservedAwaitingLayout, None),
        entry(10, "codec_fourcc", ReservedAwaitingLayout, None),
        entry(11, "duration_ms", ReservedAwaitingLayout, None),
        entry(12, "frame_rate_x100", ReservedAwaitingLayout, None),
        entry(13, "video_orientation", ReservedAwaitingLayout, None),
    ];
    table.extend(reserved_range_boundary_entries());
    table
}

#[test]
fn registry_is_append_only_and_consistent_with_constants() {
    let expected = expected_table();
    let live = live_table();

    assert_eq!(
        expected.len(),
        live.len(),
        "Sidecar tag registry length drifted. Additive changes require ADR-017 \
         amendment or a new ADR, SPEC-CanonicalSidecarTags update, and lock-test \
         update; existing rows are append-only and immutable."
    );

    for (expected_entry, live_entry) in expected.iter().zip(&live) {
        assert_eq!(
            expected_entry, live_entry,
            "Sidecar tag registry entry drifted: expected {expected_entry:?}, \
             live {live_entry:?}. Existing (tag_number, tag_name, layout_class) \
             tuples are immutable per ADR-017."
        );
    }
}

#[test]
fn no_duplicate_numbers() {
    let live = live_table();
    let mut seen = BTreeSet::new();

    for entry in &live {
        assert!(
            seen.insert(entry.tag_number),
            "Sidecar tag table contains duplicate tag number {} at {}",
            entry.tag_number,
            entry.tag_name
        );
    }
}

#[test]
fn known_field_tags_cover_every_metadata_field_constant() {
    let expected_known_tags: Vec<(u16, String)> = expected_table()
        .into_iter()
        .filter(|entry| entry.layout_class != LayoutClass::ReservedRange)
        .map(|entry| (entry.tag_number, entry.tag_name))
        .collect();
    let known_tags: Vec<(u16, String)> = KNOWN_FIELD_TAGS
        .iter()
        .map(|(tag_number, tag_name)| (*tag_number, (*tag_name).to_owned()))
        .collect();

    assert_eq!(known_tags, expected_known_tags);
}

#[test]
fn known_field_tags_list_every_pub_const_in_metadata_field_tags() {
    let source = include_str!("../src/lib.rs");
    let Some(module) = source
        .split("pub mod metadata_field_tags {")
        .nth(1)
        .and_then(|remaining| remaining.split("}\n\n/// Domain-level parse").next())
    else {
        panic!("metadata_field_tags module should be parseable by the lock test");
    };

    let public_u16_consts: Vec<(u16, String)> = module
        .lines()
        .filter_map(|line| line.trim().strip_prefix("pub const "))
        .filter(|line| line.contains(": u16 ="))
        .map(|line| match line.split_once(':') {
            Some((name, remainder)) => {
                let Some((_, value_with_semicolon)) = remainder.split_once('=') else {
                    panic!("metadata field const should have a value separator");
                };
                let value = match value_with_semicolon
                    .trim()
                    .trim_end_matches(';')
                    .parse::<u16>()
                {
                    Ok(value) => value,
                    Err(_) => panic!("metadata field const should have a numeric u16 value"),
                };
                (value, name.to_ascii_lowercase())
            }
            None => panic!("metadata field const should have a type separator"),
        })
        .collect();
    let known_tags: BTreeSet<(u16, String)> = KNOWN_FIELD_TAGS
        .iter()
        .map(|(tag_number, tag_name)| (*tag_number, (*tag_name).to_owned()))
        .collect();
    let missing_constants: Vec<(u16, String)> = public_u16_consts
        .into_iter()
        .filter(|entry| !known_tags.contains(entry))
        .collect();

    assert!(
        missing_constants.is_empty(),
        "Every pub const u16 in metadata_field_tags must be listed in \
         KNOWN_FIELD_TAGS and pinned by sidecar_tag_table.rs: {missing_constants:?}"
    );
}

#[test]
fn pairwise_range_check_catches_out_of_order_overlap() {
    const OUT_OF_ORDER_OVERLAP: [ReservedRange; 3] = [
        ReservedRange {
            start: 0,
            end: 10,
            name: "first",
        },
        ReservedRange {
            start: 20,
            end: 30,
            name: "second",
        },
        ReservedRange {
            start: 5,
            end: 6,
            name: "third_overlaps_first",
        },
    ];

    assert!(!ranges_are_pairwise_disjoint(&OUT_OF_ORDER_OVERLAP));
}

#[test]
fn reserved_ranges_are_disjoint() {
    // 0; 1-4; 5-6; 7-9; 10-13; 14-127; 128-255; 256-4095; 4096-32767; 32768-65535.
    // Verify disjointness mathematically without relying on RESERVED_RANGES sort order.
    for range in RESERVED_RANGES {
        assert!(
            range.start <= range.end,
            "Reserved range {} has inverted bounds: {}..={}",
            range.name,
            range.start,
            range.end
        );
    }

    for (left_index, left) in RESERVED_RANGES.iter().enumerate() {
        for right in RESERVED_RANGES.iter().skip(left_index + 1) {
            assert!(
                left.end < right.start || right.end < left.start,
                "Reserved ranges {} ({}..={}) and {} ({}..={}) overlap",
                left.name,
                left.start,
                left.end,
                right.name,
                right.start,
                right.end
            );
        }
    }
}

#[test]
fn high_bit_range_is_disjoint_from_4096_range() {
    // ADR-017 §"Reserved tag-number ranges" — the two reserved ranges
    // (4096-32767 and 32768-65535) are explicitly separated by the high-bit
    // policy. This test documents and enforces the separation.
    let future_protocol = RESERVED_RANGES
        .iter()
        .find(|range| range.name == "future_protocol_extensions")
        .copied();
    let high_bit = RESERVED_RANGES
        .iter()
        .find(|range| range.name == "high_bit_skippable_optional")
        .copied();

    assert_eq!(
        future_protocol,
        Some(ReservedRange {
            start: 4096,
            end: 32767,
            name: "future_protocol_extensions"
        })
    );
    assert_eq!(
        high_bit,
        Some(ReservedRange {
            start: 32768,
            end: 65535,
            name: "high_bit_skippable_optional"
        })
    );
    assert!(
        future_protocol
            .zip(high_bit)
            .is_some_and(|(future_protocol, high_bit)| future_protocol.end < high_bit.start)
    );
}
