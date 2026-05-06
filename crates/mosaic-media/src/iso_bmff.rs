use std::collections::BTreeSet;

use zeroize::Zeroizing;

use crate::{MetadataKind, MosaicMediaError, StrippedMedia};

const MAX_RECURSION_DEPTH: u8 = 8;
const MAX_BOX_COUNT: u32 = 1024;
const MAX_BOX_PAYLOAD_SIZE: u64 = 100 * 1024 * 1024;
const BOX_HEADER_SIZE: usize = 8;
const EXTENDED_BOX_HEADER_SIZE: usize = 16;
const FULL_BOX_HEADER_SIZE: usize = 4;

const CONTAINER_BOX_TYPES: &[[u8; 4]] = &[
    *b"moov", *b"trak", *b"mdia", *b"minf", *b"stbl", *b"edts", *b"dinf", *b"meta", *b"iprp",
    *b"ipco", *b"moof", *b"traf", *b"mfra", *b"skip", *b"udta",
];

/// Bounded ISO-BMFF box parser.
///
/// Hostile-input safe: max recursion depth, max box count, max payload size.
pub struct BoxParser<'a> {
    input: &'a [u8],
    cursor: usize,
    max_depth: u8,
    max_boxes: u32,
    parsed_boxes: u32,
}

/// Parsed ISO-BMFF box.
pub struct Box<'a> {
    pub box_type: [u8; 4],
    pub payload: &'a [u8],
    pub header_size: usize,
    pub children: Vec<Box<'a>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IsoBmffFormat {
    Avif,
    Heic,
}

impl<'a> BoxParser<'a> {
    #[must_use]
    pub const fn new(input: &'a [u8]) -> Self {
        Self {
            input,
            cursor: 0,
            max_depth: MAX_RECURSION_DEPTH,
            max_boxes: MAX_BOX_COUNT,
            parsed_boxes: 0,
        }
    }

    pub fn parse(mut self) -> Result<Vec<Box<'a>>, MosaicMediaError> {
        self.parse_until(self.input.len(), 0, false)
    }

    fn parse_until(
        &mut self,
        end: usize,
        depth: u8,
        inside_meta: bool,
    ) -> Result<Vec<Box<'a>>, MosaicMediaError> {
        if depth > self.max_depth {
            return Err(MosaicMediaError::UnsupportedFormat);
        }

        let mut boxes = Vec::new();
        while self.cursor < end {
            self.parsed_boxes = self
                .parsed_boxes
                .checked_add(1)
                .ok_or(MosaicMediaError::UnsupportedFormat)?;
            if self.parsed_boxes > self.max_boxes {
                return Err(MosaicMediaError::UnsupportedFormat);
            }

            let header_end = self
                .cursor
                .checked_add(BOX_HEADER_SIZE)
                .ok_or(MosaicMediaError::UnsupportedFormat)?;
            let header = self
                .input
                .get(self.cursor..header_end)
                .ok_or(MosaicMediaError::UnsupportedFormat)?;
            let declared_size = u32::from_be_bytes([header[0], header[1], header[2], header[3]]);
            let box_type = [header[4], header[5], header[6], header[7]];
            if declared_size == 0 {
                return Err(MosaicMediaError::UnsupportedFormat);
            }

            let (box_size, header_size) = if declared_size == 1 {
                let extended_end = self
                    .cursor
                    .checked_add(EXTENDED_BOX_HEADER_SIZE)
                    .ok_or(MosaicMediaError::UnsupportedFormat)?;
                let extended = self
                    .input
                    .get(header_end..extended_end)
                    .ok_or(MosaicMediaError::UnsupportedFormat)?;
                (
                    u64::from_be_bytes([
                        extended[0],
                        extended[1],
                        extended[2],
                        extended[3],
                        extended[4],
                        extended[5],
                        extended[6],
                        extended[7],
                    ]),
                    EXTENDED_BOX_HEADER_SIZE,
                )
            } else {
                (u64::from(declared_size), BOX_HEADER_SIZE)
            };

            let header_size_u64 =
                u64::try_from(header_size).map_err(|_| MosaicMediaError::UnsupportedFormat)?;
            if box_size < header_size_u64 {
                return Err(MosaicMediaError::UnsupportedFormat);
            }
            let payload_size = box_size - header_size_u64;
            if payload_size > MAX_BOX_PAYLOAD_SIZE {
                return Err(MosaicMediaError::UnsupportedFormat);
            }

            let box_size_usize =
                usize::try_from(box_size).map_err(|_| MosaicMediaError::UnsupportedFormat)?;
            let box_end = self
                .cursor
                .checked_add(box_size_usize)
                .ok_or(MosaicMediaError::UnsupportedFormat)?;
            if box_end > end || box_end > self.input.len() {
                return Err(MosaicMediaError::UnsupportedFormat);
            }
            let payload_start = self
                .cursor
                .checked_add(header_size)
                .ok_or(MosaicMediaError::UnsupportedFormat)?;
            let payload = self
                .input
                .get(payload_start..box_end)
                .ok_or(MosaicMediaError::UnsupportedFormat)?;
            if inside_meta && box_type == *b"mdat" {
                return Err(MosaicMediaError::UnsupportedFormat);
            }

            self.cursor = payload_start;
            let children = if is_container_box(box_type) {
                let child_start = if box_type == *b"meta" {
                    if payload.len() < FULL_BOX_HEADER_SIZE {
                        return Err(MosaicMediaError::UnsupportedFormat);
                    }
                    payload_start + FULL_BOX_HEADER_SIZE
                } else {
                    payload_start
                };
                self.cursor = child_start;
                self.parse_until(box_end, depth + 1, inside_meta || box_type == *b"meta")?
            } else {
                Vec::new()
            };
            self.cursor = box_end;

            boxes.push(Box {
                box_type,
                payload,
                header_size,
                children,
            });
        }

        if self.cursor == end {
            Ok(boxes)
        } else {
            Err(MosaicMediaError::UnsupportedFormat)
        }
    }
}

pub fn strip_avif_metadata(input: &[u8]) -> Result<StrippedMedia, MosaicMediaError> {
    strip_iso_bmff_metadata(input, IsoBmffFormat::Avif)
}

pub fn strip_heic_metadata(input: &[u8]) -> Result<StrippedMedia, MosaicMediaError> {
    strip_iso_bmff_metadata(input, IsoBmffFormat::Heic)
}

/// AVIF/HEIC metadata strip. Per R-M1.1, this function:
/// - Walks kept iloc entries with construction_method=0 and rewrites extent_offset
///   to account for upstream box-shrink (typically the meta box losing EXIF/XMP/ICC).
/// - Preserves extended-size (64-bit) box headers from the input, avoiding the
///   8-byte header downgrade that would compound the offset shift.
///
/// CONSTRAINT (extended R-M6.1): P-W2 (WASM exports for media strip) MUST NOT
/// dispatch before BOTH (a) AVIF/HEIC iloc rewrite is verified against a
/// real-encoder fixture (R-M1.1), AND (b) MP4/MOV stco/co64 rewrite is verified
/// against a real-encoder fixture (R-M6.1). Synthetic corpora alone are
/// insufficient.
pub fn strip_iso_bmff_metadata(
    input: &[u8],
    format: IsoBmffFormat,
) -> Result<StrippedMedia, MosaicMediaError> {
    let boxes = BoxParser::new(input).parse()?;
    validate_top_level(&boxes, format)?;

    let mut planned_boxes = Vec::with_capacity(boxes.len());
    for bmff_box in boxes {
        let original_total_size = total_box_size(bmff_box.header_size, bmff_box.payload.len())?;
        if bmff_box.box_type == *b"meta" {
            let stripped = strip_meta_box_payload(bmff_box.payload, format, 0)?;
            let output_total_size = total_box_size(bmff_box.header_size, stripped.payload.len())?;
            planned_boxes.push(PlannedTopBox {
                box_type: bmff_box.box_type,
                original_payload: bmff_box.payload,
                output_payload: stripped.payload,
                header_size: bmff_box.header_size,
                removed: stripped.removed,
                original_total_size,
                output_total_size,
                is_meta: true,
            });
        } else {
            planned_boxes.push(PlannedTopBox {
                box_type: bmff_box.box_type,
                original_payload: bmff_box.payload,
                output_payload: bmff_box.payload.to_vec(),
                header_size: bmff_box.header_size,
                removed: Vec::new(),
                original_total_size,
                output_total_size: original_total_size,
                is_meta: false,
            });
        }
    }

    let box_size_changes = planned_boxes
        .iter()
        .map(|bmff_box| BoxSizeChange {
            box_type: bmff_box.box_type,
            original_total_size: bmff_box.original_total_size,
            output_total_size: bmff_box.output_total_size,
        })
        .collect::<Vec<_>>();
    let bytes_removed_before_mdat = compute_pre_mdat_delta(&box_size_changes)?;
    let mut output: Zeroizing<Vec<u8>> = Zeroizing::new(Vec::with_capacity(input.len()));
    let mut removed = Vec::new();
    for planned_box in planned_boxes {
        if planned_box.is_meta && bytes_removed_before_mdat > 0 {
            let stripped = strip_meta_box_payload(
                planned_box.original_payload,
                format,
                bytes_removed_before_mdat,
            )?;
            append_box(
                &mut output,
                planned_box.box_type,
                &stripped.payload,
                planned_box.header_size,
            )?;
            removed.extend(stripped.removed);
        } else {
            append_box(
                &mut output,
                planned_box.box_type,
                &planned_box.output_payload,
                planned_box.header_size,
            )?;
            removed.extend(planned_box.removed);
        }
    }

    let stripped_bytes = std::mem::take(&mut *output);
    let stripped_boxes = BoxParser::new(&stripped_bytes).parse()?;
    validate_top_level(&stripped_boxes, format)?;

    Ok(StrippedMedia {
        bytes: stripped_bytes,
        removed,
    })
}

pub(crate) fn extract_exif_item_payload(input: &[u8], format: IsoBmffFormat) -> Option<&[u8]> {
    let boxes = BoxParser::new(input).parse().ok()?;
    validate_top_level(&boxes, format).ok()?;
    for bmff_box in boxes {
        if bmff_box.box_type != *b"meta" {
            continue;
        }
        let meta = parse_meta_payload(bmff_box.payload).ok()?;
        let exif_ids = metadata_item_ids(&meta, format)
            .into_iter()
            .filter(|candidate| candidate.kind == MetadataKind::Exif)
            .map(|candidate| candidate.item_id)
            .collect::<BTreeSet<_>>();
        if exif_ids.is_empty() {
            continue;
        }
        if let Some(payload) = first_item_payload(&meta.children, &exif_ids) {
            return Some(payload);
        }
    }
    None
}

struct StrippedMeta {
    payload: Vec<u8>,
    removed: Vec<MetadataKind>,
}

struct PlannedTopBox<'a> {
    box_type: [u8; 4],
    original_payload: &'a [u8],
    output_payload: Vec<u8>,
    header_size: usize,
    removed: Vec<MetadataKind>,
    original_total_size: usize,
    output_total_size: usize,
    is_meta: bool,
}

pub(crate) struct BoxSizeChange {
    pub(crate) box_type: [u8; 4],
    pub(crate) original_total_size: usize,
    pub(crate) output_total_size: usize,
}

struct ParsedMeta<'a> {
    full_box_header: &'a [u8],
    children: Vec<Box<'a>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MetadataItem {
    item_id: u32,
    kind: MetadataKind,
}

fn is_container_box(box_type: [u8; 4]) -> bool {
    CONTAINER_BOX_TYPES.contains(&box_type)
}

pub(crate) fn total_box_size(
    header_size: usize,
    payload_len: usize,
) -> Result<usize, MosaicMediaError> {
    header_size
        .checked_add(payload_len)
        .ok_or(MosaicMediaError::OutputTooLarge)
}

pub(crate) fn compute_pre_mdat_delta(boxes: &[BoxSizeChange]) -> Result<u64, MosaicMediaError> {
    let mut removed = 0_u64;
    for bmff_box in boxes {
        if bmff_box.box_type == *b"mdat" {
            break;
        }
        let box_delta = bmff_box
            .original_total_size
            .checked_sub(bmff_box.output_total_size)
            .ok_or(MosaicMediaError::UnsupportedFormat)?;
        removed = removed
            .checked_add(u64::try_from(box_delta).map_err(|_| MosaicMediaError::OutputTooLarge)?)
            .ok_or(MosaicMediaError::OutputTooLarge)?;
    }
    Ok(removed)
}

pub(crate) fn rewrite_stco_payload(
    payload: &[u8],
    delta: u64,
) -> Result<Vec<u8>, MosaicMediaError> {
    rewrite_chunk_offset_payload(payload, delta, 4)
}

pub(crate) fn rewrite_co64_payload(
    payload: &[u8],
    delta: u64,
) -> Result<Vec<u8>, MosaicMediaError> {
    rewrite_chunk_offset_payload(payload, delta, 8)
}

fn rewrite_chunk_offset_payload(
    payload: &[u8],
    delta: u64,
    entry_size: usize,
) -> Result<Vec<u8>, MosaicMediaError> {
    payload
        .get(..8)
        .ok_or(MosaicMediaError::UnsupportedFormat)?;
    let entry_count = u32::from_be_bytes([payload[4], payload[5], payload[6], payload[7]]);
    let entries_len = usize::try_from(entry_count)
        .map_err(|_| MosaicMediaError::UnsupportedFormat)?
        .checked_mul(entry_size)
        .ok_or(MosaicMediaError::UnsupportedFormat)?;
    let expected_len = 8_usize
        .checked_add(entries_len)
        .ok_or(MosaicMediaError::UnsupportedFormat)?;
    if payload.len() != expected_len {
        return Err(MosaicMediaError::UnsupportedFormat);
    }
    if delta == 0 {
        return Ok(payload.to_vec());
    }

    let mut output = payload.to_vec();
    for entry_index in
        0..usize::try_from(entry_count).map_err(|_| MosaicMediaError::UnsupportedFormat)?
    {
        let offset = 8_usize
            .checked_add(
                entry_index
                    .checked_mul(entry_size)
                    .ok_or(MosaicMediaError::UnsupportedFormat)?,
            )
            .ok_or(MosaicMediaError::UnsupportedFormat)?;
        if entry_size == 4 {
            let value = u64::from(u32::from_be_bytes([
                payload[offset],
                payload[offset + 1],
                payload[offset + 2],
                payload[offset + 3],
            ]));
            let rewritten = value
                .checked_sub(delta)
                .ok_or(MosaicMediaError::UnsupportedFormat)?;
            let rewritten =
                u32::try_from(rewritten).map_err(|_| MosaicMediaError::UnsupportedFormat)?;
            output[offset..offset + 4].copy_from_slice(&rewritten.to_be_bytes());
        } else {
            let value = u64::from_be_bytes([
                payload[offset],
                payload[offset + 1],
                payload[offset + 2],
                payload[offset + 3],
                payload[offset + 4],
                payload[offset + 5],
                payload[offset + 6],
                payload[offset + 7],
            ]);
            let rewritten = value
                .checked_sub(delta)
                .ok_or(MosaicMediaError::UnsupportedFormat)?;
            output[offset..offset + 8].copy_from_slice(&rewritten.to_be_bytes());
        }
    }
    Ok(output)
}

fn strip_meta_box_payload(
    payload: &[u8],
    format: IsoBmffFormat,
    iloc_offset_delta: u64,
) -> Result<StrippedMeta, MosaicMediaError> {
    let meta = parse_meta_payload(payload)?;
    let metadata_items = metadata_item_ids(&meta, format);
    let metadata_item_ids = metadata_items
        .iter()
        .map(|item| item.item_id)
        .collect::<BTreeSet<_>>();
    let mut removed = metadata_items
        .iter()
        .map(|item| item.kind)
        .collect::<Vec<_>>();

    let mut output = Vec::with_capacity(payload.len());
    output.extend_from_slice(meta.full_box_header);
    for child in meta.children {
        match child.box_type {
            kind if kind == *b"iinf" => {
                let stripped = strip_iinf_payload(child.payload, &metadata_item_ids)?;
                append_box(&mut output, child.box_type, &stripped, child.header_size)?;
            }
            kind if kind == *b"iloc" => {
                let stripped =
                    strip_iloc_payload(child.payload, &metadata_item_ids, iloc_offset_delta)?;
                append_box(&mut output, child.box_type, &stripped, child.header_size)?;
            }
            kind if kind == *b"iprp" => {
                let stripped = strip_iprp_payload(child.payload)?;
                removed.extend(stripped.removed);
                append_box(
                    &mut output,
                    child.box_type,
                    &stripped.payload,
                    child.header_size,
                )?;
            }
            _ => append_box(
                &mut output,
                child.box_type,
                child.payload,
                child.header_size,
            )?,
        }
    }

    Ok(StrippedMeta {
        payload: output,
        removed,
    })
}

fn parse_meta_payload(payload: &[u8]) -> Result<ParsedMeta<'_>, MosaicMediaError> {
    let full_box_header = payload
        .get(..FULL_BOX_HEADER_SIZE)
        .ok_or(MosaicMediaError::UnsupportedFormat)?;
    let children = BoxParser::new(&payload[FULL_BOX_HEADER_SIZE..]).parse()?;
    Ok(ParsedMeta {
        full_box_header,
        children,
    })
}

fn metadata_item_ids(meta: &ParsedMeta<'_>, format: IsoBmffFormat) -> Vec<MetadataItem> {
    meta.children
        .iter()
        .find(|child| child.box_type == *b"iinf")
        .map(|iinf| metadata_items_from_iinf(iinf.payload, format))
        .unwrap_or_default()
}

fn metadata_items_from_iinf(payload: &[u8], format: IsoBmffFormat) -> Vec<MetadataItem> {
    let Some((_, entries)) = parse_iinf_entries(payload).ok() else {
        return Vec::new();
    };

    entries
        .into_iter()
        .filter_map(|entry| {
            let info = parse_infe(entry.payload)?;
            if is_image_item_type(info.item_type, format) {
                return None;
            }
            classify_infe_metadata(info).map(|kind| MetadataItem {
                item_id: info.item_id,
                kind,
            })
        })
        .collect()
}

#[derive(Clone, Copy)]
struct InfeInfo<'a> {
    item_id: u32,
    item_type: [u8; 4],
    content_type: Option<&'a [u8]>,
}

fn parse_infe(payload: &[u8]) -> Option<InfeInfo<'_>> {
    let version = *payload.first()?;
    let mut offset = FULL_BOX_HEADER_SIZE;
    let item_id = if version >= 3 {
        let raw = payload.get(offset..offset.checked_add(4)?)?;
        offset += 4;
        u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]])
    } else if version == 2 {
        let raw = payload.get(offset..offset.checked_add(2)?)?;
        offset += 2;
        u32::from(u16::from_be_bytes([raw[0], raw[1]]))
    } else {
        return None;
    };
    offset = offset.checked_add(2)?;
    let raw_type = payload.get(offset..offset.checked_add(4)?)?;
    offset += 4;
    let item_type = [raw_type[0], raw_type[1], raw_type[2], raw_type[3]];
    let name_end = payload[offset..]
        .iter()
        .position(|byte| *byte == 0)
        .map(|relative| offset + relative)?;
    offset = name_end.checked_add(1)?;
    let content_type = if item_type == *b"mime" {
        let end = payload[offset..]
            .iter()
            .position(|byte| *byte == 0)
            .map(|relative| offset + relative)
            .unwrap_or(payload.len());
        Some(payload.get(offset..end)?)
    } else {
        None
    };
    Some(InfeInfo {
        item_id,
        item_type,
        content_type,
    })
}

fn classify_infe_metadata(info: InfeInfo<'_>) -> Option<MetadataKind> {
    match info.item_type {
        kind if kind == *b"Exif" => Some(MetadataKind::Exif),
        kind if kind == *b"xml " => Some(MetadataKind::Xmp),
        kind if kind == *b"mime" && info.content_type == Some(b"application/rdf+xml") => {
            Some(MetadataKind::Xmp)
        }
        _ => None,
    }
}

fn is_image_item_type(item_type: [u8; 4], format: IsoBmffFormat) -> bool {
    match format {
        IsoBmffFormat::Avif => matches!(item_type, kind if kind == *b"av01" || kind == *b"av1C"),
        IsoBmffFormat::Heic => matches!(item_type, kind if kind == *b"hvc1" || kind == *b"hev1"),
    }
}

fn strip_iinf_payload(
    payload: &[u8],
    metadata_item_ids: &BTreeSet<u32>,
) -> Result<Vec<u8>, MosaicMediaError> {
    let (version, entries) = parse_iinf_entries(payload)?;
    let header_len = FULL_BOX_HEADER_SIZE + if version == 0 { 2 } else { 4 };
    let mut output = Vec::with_capacity(payload.len());
    output.extend_from_slice(
        payload
            .get(..FULL_BOX_HEADER_SIZE)
            .ok_or(MosaicMediaError::UnsupportedFormat)?,
    );
    let kept_entries = entries
        .into_iter()
        .filter(|entry| {
            parse_infe(entry.payload)
                .map(|info| !metadata_item_ids.contains(&info.item_id))
                .unwrap_or(true)
        })
        .collect::<Vec<_>>();

    if version == 0 {
        let count =
            u16::try_from(kept_entries.len()).map_err(|_| MosaicMediaError::OutputTooLarge)?;
        output.extend_from_slice(&count.to_be_bytes());
    } else {
        let count =
            u32::try_from(kept_entries.len()).map_err(|_| MosaicMediaError::OutputTooLarge)?;
        output.extend_from_slice(&count.to_be_bytes());
    }

    for entry in kept_entries {
        append_box(
            &mut output,
            entry.box_type,
            entry.payload,
            entry.header_size,
        )?;
    }

    if payload.len() < header_len {
        return Err(MosaicMediaError::UnsupportedFormat);
    }
    Ok(output)
}

fn parse_iinf_entries(payload: &[u8]) -> Result<(u8, Vec<Box<'_>>), MosaicMediaError> {
    let version = *payload.first().ok_or(MosaicMediaError::UnsupportedFormat)?;
    let count_offset = FULL_BOX_HEADER_SIZE;
    let entries_offset = if version == 0 {
        count_offset + 2
    } else {
        count_offset + 4
    };
    payload
        .get(..entries_offset)
        .ok_or(MosaicMediaError::UnsupportedFormat)?;
    let entries = BoxParser::new(&payload[entries_offset..]).parse()?;
    Ok((version, entries))
}

fn strip_iloc_payload(
    payload: &[u8],
    metadata_item_ids: &BTreeSet<u32>,
    iloc_offset_delta: u64,
) -> Result<Vec<u8>, MosaicMediaError> {
    if metadata_item_ids.is_empty() && iloc_offset_delta == 0 {
        return Ok(payload.to_vec());
    }
    let version = *payload.first().ok_or(MosaicMediaError::UnsupportedFormat)?;
    let mut cursor = FULL_BOX_HEADER_SIZE;
    let sizes = *payload
        .get(cursor)
        .ok_or(MosaicMediaError::UnsupportedFormat)?;
    cursor += 1;
    let offset_size = sizes >> 4;
    let length_size = sizes & 0x0f;
    let base_sizes = *payload
        .get(cursor)
        .ok_or(MosaicMediaError::UnsupportedFormat)?;
    cursor += 1;
    let base_offset_size = base_sizes >> 4;
    let index_size = if version == 1 || version == 2 {
        base_sizes & 0x0f
    } else {
        0
    };
    let item_count = if version < 2 {
        let raw = read_bytes(payload, cursor, 2)?;
        cursor += 2;
        u32::from(u16::from_be_bytes([raw[0], raw[1]]))
    } else {
        let raw = read_bytes(payload, cursor, 4)?;
        cursor += 4;
        u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]])
    };

    let mut entries = Vec::new();
    for _ in 0..item_count {
        let entry_start = cursor;
        let item_id = if version < 2 {
            let raw = read_bytes(payload, cursor, 2)?;
            cursor += 2;
            u32::from(u16::from_be_bytes([raw[0], raw[1]]))
        } else {
            let raw = read_bytes(payload, cursor, 4)?;
            cursor += 4;
            u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]])
        };
        let construction_method = if version == 1 || version == 2 {
            let raw = read_bytes(payload, cursor, 2)?;
            cursor += 2;
            u16::from_be_bytes([raw[0], raw[1]]) & 0x000f
        } else {
            0
        };
        cursor += 2;
        read_bytes(payload, cursor - 2, 2)?;
        cursor += usize::from(base_offset_size);
        read_bytes(
            payload,
            cursor - usize::from(base_offset_size),
            usize::from(base_offset_size),
        )?;
        let extent_count_raw = read_bytes(payload, cursor, 2)?;
        cursor += 2;
        let extent_count = u16::from_be_bytes([extent_count_raw[0], extent_count_raw[1]]);
        let mut extent_offset_positions = Vec::with_capacity(usize::from(extent_count));
        for _ in 0..extent_count {
            if (version == 1 || version == 2) && index_size > 0 {
                cursor += usize::from(index_size);
                read_bytes(
                    payload,
                    cursor - usize::from(index_size),
                    usize::from(index_size),
                )?;
            }
            extent_offset_positions.push(cursor);
            cursor += usize::from(offset_size);
            read_bytes(
                payload,
                cursor - usize::from(offset_size),
                usize::from(offset_size),
            )?;
            cursor += usize::from(length_size);
            read_bytes(
                payload,
                cursor - usize::from(length_size),
                usize::from(length_size),
            )?;
        }
        entries.push(IlocEntry {
            item_id,
            construction_method,
            start: entry_start,
            end: cursor,
            extent_offset_positions,
        });
    }

    if cursor != payload.len() {
        return Err(MosaicMediaError::UnsupportedFormat);
    }

    let kept_entries = entries
        .iter()
        .filter(|entry| !metadata_item_ids.contains(&entry.item_id))
        .collect::<Vec<_>>();
    let mut output = Vec::with_capacity(payload.len());
    output.extend_from_slice(&payload[..if version < 2 { 8 } else { 10 }]);
    if version < 2 {
        let count =
            u16::try_from(kept_entries.len()).map_err(|_| MosaicMediaError::OutputTooLarge)?;
        output[6..8].copy_from_slice(&count.to_be_bytes());
    } else {
        let count =
            u32::try_from(kept_entries.len()).map_err(|_| MosaicMediaError::OutputTooLarge)?;
        output[6..10].copy_from_slice(&count.to_be_bytes());
    }
    for entry in kept_entries {
        let mut entry_bytes = payload[entry.start..entry.end].to_vec();
        if entry.construction_method == 0 && iloc_offset_delta > 0 {
            for offset_position in &entry.extent_offset_positions {
                let rewritten = read_sized_uint(payload, *offset_position, offset_size)?
                    .checked_sub(iloc_offset_delta)
                    .ok_or(MosaicMediaError::UnsupportedFormat)?;
                write_sized_uint(
                    &mut entry_bytes,
                    offset_position
                        .checked_sub(entry.start)
                        .ok_or(MosaicMediaError::UnsupportedFormat)?,
                    offset_size,
                    rewritten,
                )?;
            }
        } else if !matches!(entry.construction_method, 0..=2) {
            return Err(MosaicMediaError::UnsupportedFormat);
        }
        output.extend_from_slice(&entry_bytes);
    }
    Ok(output)
}

struct IlocEntry {
    item_id: u32,
    construction_method: u16,
    start: usize,
    end: usize,
    extent_offset_positions: Vec<usize>,
}

fn strip_iprp_payload(payload: &[u8]) -> Result<StrippedMeta, MosaicMediaError> {
    let children = BoxParser::new(payload).parse()?;
    let mut output = Vec::with_capacity(payload.len());
    let mut removed = Vec::new();
    for child in children {
        if child.box_type == *b"ipco" {
            let stripped = strip_ipco_payload(child.payload)?;
            removed.extend(stripped.removed);
            append_box(
                &mut output,
                child.box_type,
                &stripped.payload,
                child.header_size,
            )?;
        } else {
            append_box(
                &mut output,
                child.box_type,
                child.payload,
                child.header_size,
            )?;
        }
    }
    Ok(StrippedMeta {
        payload: output,
        removed,
    })
}

fn strip_ipco_payload(payload: &[u8]) -> Result<StrippedMeta, MosaicMediaError> {
    let children = BoxParser::new(payload).parse()?;
    let mut output = Vec::with_capacity(payload.len());
    let mut removed = Vec::new();
    for child in children {
        if child.box_type == *b"colr" && matches!(child.payload.get(..4), Some(b"prof" | b"rICC")) {
            removed.push(MetadataKind::ColorProfile);
            continue;
        }
        append_box(
            &mut output,
            child.box_type,
            child.payload,
            child.header_size,
        )?;
    }
    Ok(StrippedMeta {
        payload: output,
        removed,
    })
}

fn first_item_payload<'a>(children: &[Box<'a>], item_ids: &BTreeSet<u32>) -> Option<&'a [u8]> {
    let iloc = children.iter().find(|child| child.box_type == *b"iloc")?;
    let mdat = children.iter().find(|child| child.box_type == *b"idat")?;
    let extents = iloc_item_extents(iloc.payload, item_ids).ok()?;
    let first_extent = extents.first()?;
    mdat.payload
        .get(first_extent.offset..first_extent.offset.checked_add(first_extent.length)?)
}

#[derive(Debug, Clone, Copy)]
struct ItemExtent {
    offset: usize,
    length: usize,
}

fn iloc_item_extents(
    payload: &[u8],
    item_ids: &BTreeSet<u32>,
) -> Result<Vec<ItemExtent>, MosaicMediaError> {
    let version = *payload.first().ok_or(MosaicMediaError::UnsupportedFormat)?;
    let mut cursor = FULL_BOX_HEADER_SIZE;
    let sizes = *payload
        .get(cursor)
        .ok_or(MosaicMediaError::UnsupportedFormat)?;
    cursor += 1;
    let offset_size = sizes >> 4;
    let length_size = sizes & 0x0f;
    let base_sizes = *payload
        .get(cursor)
        .ok_or(MosaicMediaError::UnsupportedFormat)?;
    cursor += 1;
    let base_offset_size = base_sizes >> 4;
    let index_size = if version == 1 || version == 2 {
        base_sizes & 0x0f
    } else {
        0
    };
    let item_count = if version < 2 {
        let raw = read_bytes(payload, cursor, 2)?;
        cursor += 2;
        u32::from(u16::from_be_bytes([raw[0], raw[1]]))
    } else {
        let raw = read_bytes(payload, cursor, 4)?;
        cursor += 4;
        u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]])
    };

    let mut extents = Vec::new();
    for _ in 0..item_count {
        let item_id = if version < 2 {
            let raw = read_bytes(payload, cursor, 2)?;
            cursor += 2;
            u32::from(u16::from_be_bytes([raw[0], raw[1]]))
        } else {
            let raw = read_bytes(payload, cursor, 4)?;
            cursor += 4;
            u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]])
        };
        if version == 1 || version == 2 {
            cursor += 2;
            read_bytes(payload, cursor - 2, 2)?;
        }
        cursor += 2;
        read_bytes(payload, cursor - 2, 2)?;
        let base_offset = read_sized_uint(payload, cursor, base_offset_size)?;
        cursor += usize::from(base_offset_size);
        let extent_count_raw = read_bytes(payload, cursor, 2)?;
        cursor += 2;
        let extent_count = u16::from_be_bytes([extent_count_raw[0], extent_count_raw[1]]);
        for _ in 0..extent_count {
            if (version == 1 || version == 2) && index_size > 0 {
                cursor += usize::from(index_size);
                read_bytes(
                    payload,
                    cursor - usize::from(index_size),
                    usize::from(index_size),
                )?;
            }
            let extent_offset = read_sized_uint(payload, cursor, offset_size)?;
            cursor += usize::from(offset_size);
            let extent_length = read_sized_uint(payload, cursor, length_size)?;
            cursor += usize::from(length_size);
            if item_ids.contains(&item_id) {
                let offset = usize::try_from(base_offset.saturating_add(extent_offset))
                    .map_err(|_| MosaicMediaError::UnsupportedFormat)?;
                let length = usize::try_from(extent_length)
                    .map_err(|_| MosaicMediaError::UnsupportedFormat)?;
                extents.push(ItemExtent { offset, length });
            }
        }
    }
    Ok(extents)
}

fn read_sized_uint(payload: &[u8], offset: usize, size: u8) -> Result<u64, MosaicMediaError> {
    let bytes = read_bytes(payload, offset, usize::from(size))?;
    match size {
        0 => Ok(0),
        4 => Ok(u64::from(u32::from_be_bytes([
            bytes[0], bytes[1], bytes[2], bytes[3],
        ]))),
        8 => Ok(u64::from_be_bytes([
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        ])),
        _ => Err(MosaicMediaError::UnsupportedFormat),
    }
}

fn write_sized_uint(
    payload: &mut [u8],
    offset: usize,
    size: u8,
    value: u64,
) -> Result<(), MosaicMediaError> {
    let output = payload
        .get_mut(
            offset
                ..offset
                    .checked_add(usize::from(size))
                    .ok_or(MosaicMediaError::UnsupportedFormat)?,
        )
        .ok_or(MosaicMediaError::UnsupportedFormat)?;
    match size {
        0 => {
            if value == 0 {
                Ok(())
            } else {
                Err(MosaicMediaError::UnsupportedFormat)
            }
        }
        4 => {
            let value = u32::try_from(value).map_err(|_| MosaicMediaError::UnsupportedFormat)?;
            output.copy_from_slice(&value.to_be_bytes());
            Ok(())
        }
        8 => {
            output.copy_from_slice(&value.to_be_bytes());
            Ok(())
        }
        _ => Err(MosaicMediaError::UnsupportedFormat),
    }
}

fn read_bytes(payload: &[u8], offset: usize, len: usize) -> Result<&[u8], MosaicMediaError> {
    payload
        .get(
            offset
                ..offset
                    .checked_add(len)
                    .ok_or(MosaicMediaError::UnsupportedFormat)?,
        )
        .ok_or(MosaicMediaError::UnsupportedFormat)
}

fn validate_top_level(boxes: &[Box<'_>], format: IsoBmffFormat) -> Result<(), MosaicMediaError> {
    let has_ftyp = boxes
        .iter()
        .any(|candidate| candidate.box_type == *b"ftyp" && ftyp_matches(candidate.payload, format));
    let has_mdat = boxes.iter().any(|candidate| candidate.box_type == *b"mdat");
    if has_ftyp && has_mdat {
        Ok(())
    } else {
        Err(MosaicMediaError::UnsupportedFormat)
    }
}

fn ftyp_matches(payload: &[u8], format: IsoBmffFormat) -> bool {
    if payload.len() < 8 {
        return false;
    }
    brands(payload).any(|brand| match format {
        IsoBmffFormat::Avif => matches!(brand, b"avif" | b"avis"),
        IsoBmffFormat::Heic => matches!(
            brand,
            b"heic" | b"heix" | b"hevc" | b"hevx" | b"heim" | b"heis" | b"mif1" | b"msf1"
        ),
    })
}

fn brands(payload: &[u8]) -> impl Iterator<Item = &[u8]> {
    std::iter::once(&payload[..4]).chain(payload[8..].chunks_exact(4))
}

pub(crate) fn append_box(
    output: &mut Vec<u8>,
    box_type: [u8; 4],
    payload: &[u8],
    header_size: usize,
) -> Result<(), MosaicMediaError> {
    let size = payload
        .len()
        .checked_add(header_size)
        .ok_or(MosaicMediaError::OutputTooLarge)?;
    match header_size {
        BOX_HEADER_SIZE => {
            let size = u32::try_from(size).map_err(|_| MosaicMediaError::OutputTooLarge)?;
            output.extend_from_slice(&size.to_be_bytes());
            output.extend_from_slice(&box_type);
        }
        EXTENDED_BOX_HEADER_SIZE => {
            let size = u64::try_from(size).map_err(|_| MosaicMediaError::OutputTooLarge)?;
            output.extend_from_slice(&1_u32.to_be_bytes());
            output.extend_from_slice(&box_type);
            output.extend_from_slice(&size.to_be_bytes());
        }
        _ => return Err(MosaicMediaError::UnsupportedFormat),
    }
    output.extend_from_slice(payload);
    Ok(())
}
