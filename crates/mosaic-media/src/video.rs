use zeroize::Zeroizing;

use crate::{
    MetadataKind, MosaicMediaError, Orientation, StrippedMedia,
    iso_bmff::{Box as IsoBox, BoxParser},
};

const EBML_HEADER_ID: u64 = 0x1a45dfa3;
const EBML_DOC_TYPE_ID: u64 = 0x4282;
const MATROSKA_SEGMENT_ID: u64 = 0x18538067;
const MATROSKA_INFO_ID: u64 = 0x1549a966;
const MATROSKA_DURATION_ID: u64 = 0x4489;
const MATROSKA_TIMECODE_SCALE_ID: u64 = 0x2ad7b1;
const MATROSKA_TRACKS_ID: u64 = 0x1654ae6b;
const MATROSKA_TRACK_ENTRY_ID: u64 = 0xae;
const MATROSKA_TRACK_TYPE_ID: u64 = 0x83;
const MATROSKA_CODEC_ID_ID: u64 = 0x86;
const MATROSKA_VIDEO_ID: u64 = 0xe0;
const MATROSKA_PIXEL_WIDTH_ID: u64 = 0xb0;
const MATROSKA_PIXEL_HEIGHT_ID: u64 = 0xba;
const MATROSKA_DEFAULT_DURATION_ID: u64 = 0x23e383;
const MATROSKA_TAGS_ID: u64 = 0x1254c367;
const MATROSKA_ATTACHMENTS_ID: u64 = 0x1941a469;

const MAX_EBML_DEPTH: u8 = 8;
const MAX_EBML_ELEMENTS: u32 = 2048;
const MAX_EBML_PAYLOAD_SIZE: usize = 100 * 1024 * 1024;

/// Supported video container formats.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoContainer {
    Mp4,
    Mov,
    WebM,
    Matroska,
}

/// Canonical video codec identifiers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoCodec {
    H264,
    H265,
    AV1,
    VP8,
    VP9,
}

/// Hostile-safe video container inspection result.
#[derive(Debug, Clone, PartialEq)]
pub struct VideoInspectResult {
    pub code: u16,
    pub container: VideoContainer,
    pub video_codec: Option<VideoCodec>,
    pub width_px: u32,
    pub height_px: u32,
    pub duration_ms: u64,
    pub frame_rate_fps: Option<f32>,
    pub orientation: Option<Orientation>,
}

#[derive(Debug, Clone, Copy)]
struct IsoTrack {
    is_video: bool,
    width_px: u32,
    height_px: u32,
    duration_ms: u64,
    codec: Option<VideoCodec>,
    frame_rate_fps: Option<f32>,
    orientation: Option<Orientation>,
}

#[derive(Debug, Clone, Copy, Default)]
struct EbmlTrack {
    is_video: bool,
    width_px: u32,
    height_px: u32,
    codec: Option<VideoCodec>,
    frame_rate_fps: Option<f32>,
}

#[derive(Debug, Clone, Copy)]
struct EbmlElement<'a> {
    id: u64,
    id_bytes: &'a [u8],
    payload: &'a [u8],
    total: &'a [u8],
}

#[derive(Debug, Default)]
struct EbmlBudget {
    elements: u32,
}

/// Detects and inspects supported video containers without decoding frames.
#[must_use]
pub fn inspect_video_container(input: &[u8]) -> VideoInspectResult {
    match inspect_video_container_inner(input) {
        Ok(result) => result,
        Err(_) => VideoInspectResult {
            code: 1,
            container: detect_video_container(input).unwrap_or(VideoContainer::Mp4),
            video_codec: None,
            width_px: 0,
            height_px: 0,
            duration_ms: 0,
            frame_rate_fps: None,
            orientation: None,
        },
    }
}

/// Builds active canonical sidecar fields for inspected video metadata.
///
/// Layouts: tag 10 codec `u8`, tag 11 duration `u64`, tag 12 milli-fps `u32`,
/// tag 13 orientation `u8`, tag 14 dimensions `[u32; 2]`, tag 15 container `u8`.
#[must_use]
pub fn video_metadata_sidecar_fields(result: &VideoInspectResult) -> Vec<(u16, Vec<u8>)> {
    if result.code != 0 {
        return Vec::new();
    }
    let mut fields = Vec::new();
    if let Some(codec) = result.video_codec {
        fields.push((
            mosaic_domain::metadata_field_tags::CODEC_FOURCC,
            vec![codec_byte(codec)],
        ));
    }
    fields.push((
        mosaic_domain::metadata_field_tags::DURATION_MS,
        result.duration_ms.to_le_bytes().to_vec(),
    ));
    if let Some(frame_rate) = result.frame_rate_fps {
        let milli_fps = (frame_rate * 1000.0).round().clamp(0.0, u32::MAX as f32) as u32;
        fields.push((
            mosaic_domain::metadata_field_tags::FRAME_RATE_X100,
            milli_fps.to_le_bytes().to_vec(),
        ));
    }
    if let Some(orientation) = result.orientation {
        fields.push((
            mosaic_domain::metadata_field_tags::VIDEO_ORIENTATION,
            vec![orientation_byte(orientation)],
        ));
    }
    let mut dimensions = Vec::with_capacity(8);
    dimensions.extend_from_slice(&result.width_px.to_le_bytes());
    dimensions.extend_from_slice(&result.height_px.to_le_bytes());
    fields.push((
        mosaic_domain::metadata_field_tags::VIDEO_DIMENSIONS,
        dimensions,
    ));
    fields.push((
        mosaic_domain::metadata_field_tags::VIDEO_CONTAINER_FORMAT,
        vec![container_byte(result.container)],
    ));
    fields.sort_by_key(|(tag, _)| *tag);
    fields
}

/// Removes video metadata boxes/elements without re-encoding frame payloads.
pub fn strip_video_metadata(input: &[u8]) -> Result<StrippedMedia, MosaicMediaError> {
    match detect_video_container(input).ok_or(MosaicMediaError::UnsupportedFormat)? {
        VideoContainer::Mp4 | VideoContainer::Mov => strip_iso_video_metadata(input),
        VideoContainer::WebM | VideoContainer::Matroska => strip_ebml_video_metadata(input),
    }
}

fn inspect_video_container_inner(input: &[u8]) -> Result<VideoInspectResult, MosaicMediaError> {
    match detect_video_container(input).ok_or(MosaicMediaError::UnsupportedFormat)? {
        VideoContainer::Mp4 | VideoContainer::Mov => inspect_iso_video(input),
        VideoContainer::WebM | VideoContainer::Matroska => inspect_ebml_video(input),
    }
}

fn detect_video_container(input: &[u8]) -> Option<VideoContainer> {
    if input.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        return detect_ebml_container(input).ok().flatten();
    }
    let boxes = BoxParser::new(input).parse().ok()?;
    let ftyp = boxes
        .iter()
        .find(|candidate| candidate.box_type == *b"ftyp")?;
    iso_container_from_ftyp(ftyp.payload)
}

fn iso_container_from_ftyp(payload: &[u8]) -> Option<VideoContainer> {
    if payload.len() < 8 {
        return None;
    }
    if iso_brands(payload).any(|brand| brand == b"qt  ") {
        return Some(VideoContainer::Mov);
    }
    if iso_brands(payload).any(|brand| {
        matches!(
            brand,
            b"isom" | b"iso2" | b"mp41" | b"mp42" | b"avc1" | b"iso5" | b"iso6"
        )
    }) {
        Some(VideoContainer::Mp4)
    } else {
        None
    }
}

fn iso_brands(payload: &[u8]) -> impl Iterator<Item = &[u8]> {
    std::iter::once(&payload[..4]).chain(payload[8..].chunks_exact(4))
}

fn inspect_iso_video(input: &[u8]) -> Result<VideoInspectResult, MosaicMediaError> {
    let boxes = BoxParser::new(input).parse()?;
    let container = boxes
        .iter()
        .find(|candidate| candidate.box_type == *b"ftyp")
        .and_then(|ftyp| iso_container_from_ftyp(ftyp.payload))
        .ok_or(MosaicMediaError::UnsupportedFormat)?;
    let moov = boxes
        .iter()
        .find(|candidate| candidate.box_type == *b"moov")
        .ok_or(MosaicMediaError::UnsupportedFormat)?;
    let track = moov
        .children
        .iter()
        .filter(|child| child.box_type == *b"trak")
        .filter_map(parse_iso_track)
        .find(|track| track.is_video)
        .ok_or(MosaicMediaError::UnsupportedFormat)?;

    if track.codec.is_none() {
        return Ok(VideoInspectResult {
            code: 2,
            container,
            video_codec: None,
            width_px: track.width_px,
            height_px: track.height_px,
            duration_ms: track.duration_ms,
            frame_rate_fps: track.frame_rate_fps,
            orientation: track.orientation,
        });
    }

    Ok(VideoInspectResult {
        code: 0,
        container,
        video_codec: track.codec,
        width_px: track.width_px,
        height_px: track.height_px,
        duration_ms: track.duration_ms,
        frame_rate_fps: track.frame_rate_fps,
        orientation: track.orientation,
    })
}

fn parse_iso_track(track: &IsoBox<'_>) -> Option<IsoTrack> {
    let tkhd = find_child(track, *b"tkhd").and_then(parse_tkhd);
    let mdia = find_child(track, *b"mdia")?;
    let is_video = find_child(mdia, *b"hdlr").is_some_and(is_video_handler);
    let mdhd = find_child(mdia, *b"mdhd").and_then(parse_mdhd);
    let stbl = find_child(find_child(mdia, *b"minf")?, *b"stbl")?;
    let codec = find_child(stbl, *b"stsd").and_then(parse_stsd_codec);
    let frame_rate_fps = find_child(stbl, *b"stts").and_then(|stts| {
        let (timescale, duration_units) = mdhd?;
        parse_stts_frame_rate(stts.payload, timescale, duration_units)
    });
    let duration_ms = mdhd.map_or(0, |(timescale, duration)| {
        if timescale == 0 {
            0
        } else {
            duration.saturating_mul(1000) / u64::from(timescale)
        }
    });
    let (width_px, height_px, orientation) = tkhd.unwrap_or((0, 0, None));
    Some(IsoTrack {
        is_video,
        width_px,
        height_px,
        duration_ms,
        codec,
        frame_rate_fps,
        orientation,
    })
}

fn find_child<'a>(parent: &'a IsoBox<'a>, box_type: [u8; 4]) -> Option<&'a IsoBox<'a>> {
    parent
        .children
        .iter()
        .find(|candidate| candidate.box_type == box_type)
}

fn is_video_handler(hdlr: &IsoBox<'_>) -> bool {
    hdlr.payload.get(8..12) == Some(b"vide")
}

fn parse_tkhd(tkhd: &IsoBox<'_>) -> Option<(u32, u32, Option<Orientation>)> {
    let version = *tkhd.payload.first()?;
    let (matrix_offset, width_offset): (usize, usize) =
        if version == 1 { (52, 88) } else { (40, 76) };
    let matrix = parse_matrix(
        tkhd.payload
            .get(matrix_offset..matrix_offset.checked_add(36)?)?,
    );
    let width_raw = be_u32(tkhd.payload, width_offset)?;
    let height_raw = be_u32(tkhd.payload, width_offset.checked_add(4)?)?;
    Some((width_raw >> 16, height_raw >> 16, matrix))
}

fn parse_matrix(bytes: &[u8]) -> Option<Orientation> {
    let a = be_i32(bytes, 0)?;
    let b = be_i32(bytes, 4)?;
    let c = be_i32(bytes, 12)?;
    let d = be_i32(bytes, 16)?;
    match (a, b, c, d) {
        (0x0001_0000, 0, 0, 0x0001_0000) => Some(Orientation::Rotate0),
        (0, 0x0001_0000, -0x0001_0000, 0) => Some(Orientation::Rotate90),
        (-0x0001_0000, 0, 0, -0x0001_0000) => Some(Orientation::Rotate180),
        (0, -0x0001_0000, 0x0001_0000, 0) => Some(Orientation::Rotate270),
        _ => None,
    }
}

fn parse_mdhd(mdhd: &IsoBox<'_>) -> Option<(u32, u64)> {
    let version = *mdhd.payload.first()?;
    if version == 1 {
        let timescale = be_u32(mdhd.payload, 20)?;
        let duration = be_u64(mdhd.payload, 24)?;
        Some((timescale, duration))
    } else {
        let timescale = be_u32(mdhd.payload, 12)?;
        let duration = u64::from(be_u32(mdhd.payload, 16)?);
        Some((timescale, duration))
    }
}

fn parse_stsd_codec(stsd: &IsoBox<'_>) -> Option<VideoCodec> {
    let entry_count = be_u32(stsd.payload, 4)?;
    if entry_count == 0 {
        return None;
    }
    codec_from_sample_entry(stsd.payload.get(12..16)?)
}

fn codec_from_sample_entry(entry_type: &[u8]) -> Option<VideoCodec> {
    match entry_type {
        b"avc1" | b"avc3" => Some(VideoCodec::H264),
        b"hvc1" | b"hev1" => Some(VideoCodec::H265),
        b"av01" => Some(VideoCodec::AV1),
        b"vp08" => Some(VideoCodec::VP8),
        b"vp09" => Some(VideoCodec::VP9),
        _ => None,
    }
}

fn parse_stts_frame_rate(payload: &[u8], timescale: u32, duration_units: u64) -> Option<f32> {
    let entry_count = be_u32(payload, 4)?;
    if entry_count == 0 || timescale == 0 || duration_units == 0 {
        return None;
    }
    let mut offset = 8_usize;
    let mut sample_count = 0_u64;
    let mut sample_duration = 0_u64;
    for _ in 0..entry_count {
        let count = u64::from(be_u32(payload, offset)?);
        let delta = u64::from(be_u32(payload, offset.checked_add(4)?)?);
        sample_count = sample_count.checked_add(count)?;
        sample_duration = sample_duration.checked_add(count.checked_mul(delta)?)?;
        offset = offset.checked_add(8)?;
    }
    if sample_count == 0 || sample_duration == 0 {
        return None;
    }
    Some((sample_count as f64 / (sample_duration as f64 / f64::from(timescale))) as f32)
}

fn strip_iso_video_metadata(input: &[u8]) -> Result<StrippedMedia, MosaicMediaError> {
    let boxes = BoxParser::new(input).parse()?;
    if !boxes.iter().any(|candidate| candidate.box_type == *b"mdat")
        || !boxes.iter().any(|candidate| {
            candidate.box_type == *b"ftyp" && iso_container_from_ftyp(candidate.payload).is_some()
        })
    {
        return Err(MosaicMediaError::UnsupportedFormat);
    }
    let mut removed = Vec::new();
    let mut output: Zeroizing<Vec<u8>> = Zeroizing::new(Vec::with_capacity(input.len()));
    for bmff_box in &boxes {
        append_iso_video_box(&mut output, bmff_box, &mut removed)?;
    }
    Ok(StrippedMedia {
        bytes: std::mem::take(&mut *output),
        removed,
    })
}

fn append_iso_video_box(
    output: &mut Vec<u8>,
    bmff_box: &IsoBox<'_>,
    removed: &mut Vec<MetadataKind>,
) -> Result<(), MosaicMediaError> {
    if bmff_box.box_type == *b"udta" || bmff_box.box_type == *b"meta" {
        removed.push(MetadataKind::VideoMetadata);
        return Ok(());
    }
    if bmff_box.children.is_empty() {
        append_bmff_box(output, bmff_box.box_type, bmff_box.payload)
    } else {
        let mut payload = Vec::with_capacity(bmff_box.payload.len());
        if bmff_box.box_type == *b"meta" {
            payload.extend_from_slice(
                bmff_box
                    .payload
                    .get(..4)
                    .ok_or(MosaicMediaError::UnsupportedFormat)?,
            );
        }
        for child in &bmff_box.children {
            append_iso_video_box(&mut payload, child, removed)?;
        }
        append_bmff_box(output, bmff_box.box_type, &payload)
    }
}

fn append_bmff_box(
    output: &mut Vec<u8>,
    box_type: [u8; 4],
    payload: &[u8],
) -> Result<(), MosaicMediaError> {
    let size = payload
        .len()
        .checked_add(8)
        .ok_or(MosaicMediaError::OutputTooLarge)?;
    let size = u32::try_from(size).map_err(|_| MosaicMediaError::OutputTooLarge)?;
    output.extend_from_slice(&size.to_be_bytes());
    output.extend_from_slice(&box_type);
    output.extend_from_slice(payload);
    Ok(())
}

fn detect_ebml_container(input: &[u8]) -> Result<Option<VideoContainer>, MosaicMediaError> {
    let mut budget = EbmlBudget::default();
    let elements = parse_ebml_elements(input, 0, &mut budget)?;
    for element in elements {
        if element.id != EBML_HEADER_ID {
            continue;
        }
        let header = parse_ebml_elements(element.payload, 1, &mut budget)?;
        for child in header {
            if child.id == EBML_DOC_TYPE_ID {
                return match child.payload {
                    b"webm" => Ok(Some(VideoContainer::WebM)),
                    b"matroska" => Ok(Some(VideoContainer::Matroska)),
                    _ => Ok(None),
                };
            }
        }
    }
    Ok(None)
}

fn inspect_ebml_video(input: &[u8]) -> Result<VideoInspectResult, MosaicMediaError> {
    let container = detect_ebml_container(input)?.ok_or(MosaicMediaError::UnsupportedFormat)?;
    let mut budget = EbmlBudget::default();
    let elements = parse_ebml_elements(input, 0, &mut budget)?;
    let segment = elements
        .iter()
        .find(|element| element.id == MATROSKA_SEGMENT_ID)
        .ok_or(MosaicMediaError::UnsupportedFormat)?;
    let segment_children = parse_ebml_elements(segment.payload, 1, &mut budget)?;
    let mut duration_ms = 0_u64;
    let mut timecode_scale_ns = 1_000_000_u64;
    let mut video_track = None;
    for child in &segment_children {
        match child.id {
            MATROSKA_INFO_ID => {
                for info_child in parse_ebml_elements(child.payload, 2, &mut budget)? {
                    match info_child.id {
                        MATROSKA_TIMECODE_SCALE_ID => {
                            timecode_scale_ns =
                                read_ebml_uint(info_child.payload).unwrap_or(1_000_000);
                        }
                        MATROSKA_DURATION_ID => {
                            let duration = read_ebml_float(info_child.payload).unwrap_or(0.0);
                            duration_ms = ((duration * timecode_scale_ns as f64) / 1_000_000.0)
                                .round() as u64;
                        }
                        _ => {}
                    }
                }
            }
            MATROSKA_TRACKS_ID => {
                video_track = parse_ebml_video_track(child.payload, &mut budget)?;
            }
            _ => {}
        }
    }
    let track = video_track.ok_or(MosaicMediaError::UnsupportedFormat)?;
    if track.codec.is_none() {
        return Ok(VideoInspectResult {
            code: 2,
            container,
            video_codec: None,
            width_px: track.width_px,
            height_px: track.height_px,
            duration_ms,
            frame_rate_fps: track.frame_rate_fps,
            orientation: None,
        });
    }
    Ok(VideoInspectResult {
        code: 0,
        container,
        video_codec: track.codec,
        width_px: track.width_px,
        height_px: track.height_px,
        duration_ms,
        frame_rate_fps: track.frame_rate_fps,
        orientation: None,
    })
}

fn parse_ebml_video_track(
    tracks_payload: &[u8],
    budget: &mut EbmlBudget,
) -> Result<Option<EbmlTrack>, MosaicMediaError> {
    for track in parse_ebml_elements(tracks_payload, 2, budget)? {
        if track.id != MATROSKA_TRACK_ENTRY_ID {
            continue;
        }
        let mut parsed = EbmlTrack::default();
        for child in parse_ebml_elements(track.payload, 3, budget)? {
            match child.id {
                MATROSKA_TRACK_TYPE_ID => {
                    parsed.is_video = read_ebml_uint(child.payload) == Some(1)
                }
                MATROSKA_CODEC_ID_ID => parsed.codec = codec_from_ebml_id(child.payload),
                MATROSKA_DEFAULT_DURATION_ID => {
                    if let Some(ns) = read_ebml_uint(child.payload).filter(|value| *value > 0) {
                        parsed.frame_rate_fps = Some(1_000_000_000.0_f32 / ns as f32);
                    }
                }
                MATROSKA_VIDEO_ID => {
                    for video_child in parse_ebml_elements(child.payload, 4, budget)? {
                        match video_child.id {
                            MATROSKA_PIXEL_WIDTH_ID => {
                                parsed.width_px =
                                    u32::try_from(read_ebml_uint(video_child.payload).unwrap_or(0))
                                        .unwrap_or(0);
                            }
                            MATROSKA_PIXEL_HEIGHT_ID => {
                                parsed.height_px =
                                    u32::try_from(read_ebml_uint(video_child.payload).unwrap_or(0))
                                        .unwrap_or(0);
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }
        if parsed.is_video {
            return Ok(Some(parsed));
        }
    }
    Ok(None)
}

fn codec_from_ebml_id(codec_id: &[u8]) -> Option<VideoCodec> {
    match codec_id {
        b"V_MPEG4/ISO/AVC" => Some(VideoCodec::H264),
        b"V_MPEGH/ISO/HEVC" => Some(VideoCodec::H265),
        b"V_AV1" => Some(VideoCodec::AV1),
        b"V_VP8" => Some(VideoCodec::VP8),
        b"V_VP9" => Some(VideoCodec::VP9),
        _ => None,
    }
}

fn strip_ebml_video_metadata(input: &[u8]) -> Result<StrippedMedia, MosaicMediaError> {
    detect_ebml_container(input)?.ok_or(MosaicMediaError::UnsupportedFormat)?;
    let mut budget = EbmlBudget::default();
    let elements = parse_ebml_elements(input, 0, &mut budget)?;
    let mut removed = Vec::new();
    let mut output: Zeroizing<Vec<u8>> = Zeroizing::new(Vec::with_capacity(input.len()));
    for element in elements {
        append_stripped_ebml_element(&mut output, element, 0, &mut removed)?;
    }
    Ok(StrippedMedia {
        bytes: std::mem::take(&mut *output),
        removed,
    })
}

fn append_stripped_ebml_element(
    output: &mut Vec<u8>,
    element: EbmlElement<'_>,
    depth: u8,
    removed: &mut Vec<MetadataKind>,
) -> Result<(), MosaicMediaError> {
    if depth > MAX_EBML_DEPTH {
        return Err(MosaicMediaError::UnsupportedFormat);
    }
    if element.id == MATROSKA_TAGS_ID {
        removed.push(MetadataKind::VideoMetadata);
        return Ok(());
    }
    if element.id == MATROSKA_ATTACHMENTS_ID {
        removed.push(MetadataKind::Attachment);
        return Ok(());
    }
    if matches!(
        element.id,
        EBML_HEADER_ID
            | MATROSKA_INFO_ID
            | MATROSKA_TRACKS_ID
            | MATROSKA_TRACK_ENTRY_ID
            | MATROSKA_VIDEO_ID
            | MATROSKA_SEGMENT_ID
    ) {
        let mut budget = EbmlBudget::default();
        let children = parse_ebml_elements(element.payload, depth.saturating_add(1), &mut budget)?;
        let mut payload = Vec::with_capacity(element.payload.len());
        for child in children {
            append_stripped_ebml_element(&mut payload, child, depth.saturating_add(1), removed)?;
        }
        output.extend_from_slice(element.id_bytes);
        append_ebml_size(output, payload.len())?;
        output.extend_from_slice(&payload);
    } else {
        output.extend_from_slice(element.total);
    }
    Ok(())
}

fn parse_ebml_elements<'a>(
    input: &'a [u8],
    depth: u8,
    budget: &mut EbmlBudget,
) -> Result<Vec<EbmlElement<'a>>, MosaicMediaError> {
    if depth > MAX_EBML_DEPTH {
        return Err(MosaicMediaError::UnsupportedFormat);
    }
    let mut cursor = 0_usize;
    let mut elements = Vec::new();
    while cursor < input.len() {
        budget.elements = budget
            .elements
            .checked_add(1)
            .ok_or(MosaicMediaError::UnsupportedFormat)?;
        if budget.elements > MAX_EBML_ELEMENTS {
            return Err(MosaicMediaError::UnsupportedFormat);
        }
        let start = cursor;
        let (id, id_len) = read_ebml_id(input, cursor)?;
        cursor = cursor
            .checked_add(id_len)
            .ok_or(MosaicMediaError::UnsupportedFormat)?;
        let (size, size_len) = read_ebml_size(input, cursor)?;
        cursor = cursor
            .checked_add(size_len)
            .ok_or(MosaicMediaError::UnsupportedFormat)?;
        if size > MAX_EBML_PAYLOAD_SIZE {
            return Err(MosaicMediaError::UnsupportedFormat);
        }
        let end = cursor
            .checked_add(size)
            .ok_or(MosaicMediaError::UnsupportedFormat)?;
        let payload = input
            .get(cursor..end)
            .ok_or(MosaicMediaError::UnsupportedFormat)?;
        let total = input
            .get(start..end)
            .ok_or(MosaicMediaError::UnsupportedFormat)?;
        elements.push(EbmlElement {
            id,
            id_bytes: &input[start..start + id_len],
            payload,
            total,
        });
        cursor = end;
    }
    Ok(elements)
}

fn read_ebml_id(input: &[u8], offset: usize) -> Result<(u64, usize), MosaicMediaError> {
    let first = *input
        .get(offset)
        .ok_or(MosaicMediaError::UnsupportedFormat)?;
    let len = vint_len(first).ok_or(MosaicMediaError::UnsupportedFormat)?;
    if len > 4 {
        return Err(MosaicMediaError::UnsupportedFormat);
    }
    let bytes = input
        .get(offset..offset + len)
        .ok_or(MosaicMediaError::UnsupportedFormat)?;
    let mut id = 0_u64;
    for byte in bytes {
        id = (id << 8) | u64::from(*byte);
    }
    Ok((id, len))
}

fn read_ebml_size(input: &[u8], offset: usize) -> Result<(usize, usize), MosaicMediaError> {
    let first = *input
        .get(offset)
        .ok_or(MosaicMediaError::UnsupportedFormat)?;
    let len = vint_len(first).ok_or(MosaicMediaError::UnsupportedFormat)?;
    if len > 8 {
        return Err(MosaicMediaError::UnsupportedFormat);
    }
    let bytes = input
        .get(offset..offset + len)
        .ok_or(MosaicMediaError::UnsupportedFormat)?;
    let marker_mask = 1_u8 << (8 - len);
    let mut value = u64::from(first & !marker_mask);
    for byte in &bytes[1..] {
        value = (value << 8) | u64::from(*byte);
    }
    let unknown = (1_u64 << (7 * len)) - 1;
    if value == unknown {
        return Err(MosaicMediaError::UnsupportedFormat);
    }
    let value = usize::try_from(value).map_err(|_| MosaicMediaError::UnsupportedFormat)?;
    Ok((value, len))
}

fn vint_len(first: u8) -> Option<usize> {
    (0..8)
        .find(|bit| first & (0x80 >> bit) != 0)
        .map(|bit| bit + 1)
}

fn append_ebml_size(output: &mut Vec<u8>, size: usize) -> Result<(), MosaicMediaError> {
    if size <= 0x7f {
        output.push(0x80 | u8::try_from(size).map_err(|_| MosaicMediaError::OutputTooLarge)?);
    } else if size <= 0x3fff {
        let value = 0x4000 | u16::try_from(size).map_err(|_| MosaicMediaError::OutputTooLarge)?;
        output.extend_from_slice(&value.to_be_bytes());
    } else if size <= 0x1f_ffff {
        let value =
            0x20_0000 | u32::try_from(size).map_err(|_| MosaicMediaError::OutputTooLarge)?;
        output.extend_from_slice(&value.to_be_bytes()[1..]);
    } else {
        return Err(MosaicMediaError::OutputTooLarge);
    }
    Ok(())
}

fn read_ebml_uint(bytes: &[u8]) -> Option<u64> {
    if bytes.len() > 8 {
        return None;
    }
    Some(
        bytes
            .iter()
            .fold(0_u64, |acc, byte| (acc << 8) | u64::from(*byte)),
    )
}

fn read_ebml_float(bytes: &[u8]) -> Option<f64> {
    match bytes.len() {
        4 => Some(f32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f64),
        8 => Some(f64::from_be_bytes([
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        ])),
        _ => None,
    }
}

fn be_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    let data = bytes.get(offset..offset.checked_add(4)?)?;
    Some(u32::from_be_bytes([data[0], data[1], data[2], data[3]]))
}

fn be_u64(bytes: &[u8], offset: usize) -> Option<u64> {
    let data = bytes.get(offset..offset.checked_add(8)?)?;
    Some(u64::from_be_bytes([
        data[0], data[1], data[2], data[3], data[4], data[5], data[6], data[7],
    ]))
}

fn be_i32(bytes: &[u8], offset: usize) -> Option<i32> {
    let data = bytes.get(offset..offset.checked_add(4)?)?;
    Some(i32::from_be_bytes([data[0], data[1], data[2], data[3]]))
}

fn codec_byte(codec: VideoCodec) -> u8 {
    match codec {
        VideoCodec::H264 => 1,
        VideoCodec::H265 => 2,
        VideoCodec::AV1 => 3,
        VideoCodec::VP8 => 4,
        VideoCodec::VP9 => 5,
    }
}

fn container_byte(container: VideoContainer) -> u8 {
    match container {
        VideoContainer::Mp4 => 1,
        VideoContainer::Mov => 2,
        VideoContainer::WebM => 3,
        VideoContainer::Matroska => 4,
    }
}

fn orientation_byte(orientation: Orientation) -> u8 {
    match orientation {
        Orientation::Rotate0 => 0,
        Orientation::Rotate90 => 1,
        Orientation::Rotate180 => 2,
        Orientation::Rotate270 => 3,
    }
}
