#![allow(clippy::expect_used)]

use mosaic_media::strip_video_metadata;

const NAL_PREFIX: &[u8] = &[0x00, 0x00, 0x00, 0x01];

#[test]
fn mp4_strip_preserves_chunk_offsets_under_moov_shrink() {
    let input = synthetic_iso_video(*b"mp42", OffsetBox::Stco, BoxHeader::Compact);

    let stripped = strip_video_metadata(&input).expect("strip MP4 metadata");
    let mdat = find_top_level_box(&stripped.bytes, *b"mdat").expect("mdat");
    let offsets = find_chunk_offsets(&stripped.bytes, *b"stco").expect("stco offsets");

    assert_eq!(offsets.len(), 1);
    for offset in offsets {
        let offset = usize::try_from(offset).expect("offset fits usize");
        assert!(offset >= mdat.payload_start, "stco offset before mdat");
        assert!(offset < mdat.end, "stco offset past mdat end");
        assert!(
            stripped.bytes[offset..].starts_with(NAL_PREFIX),
            "stco offset must point at NAL prefix"
        );
    }
}

#[test]
fn mov_strip_preserves_chunk_offsets_co64() {
    let input = synthetic_iso_video(*b"qt  ", OffsetBox::Co64, BoxHeader::Extended);

    let stripped = strip_video_metadata(&input).expect("strip MOV metadata");
    assert_eq!(
        stripped.bytes.get(..8),
        Some(&[0, 0, 0, 20, b'f', b't', b'y', b'p'][..])
    );
    assert_eq!(
        stripped.bytes.get(20..28),
        Some(&[0, 0, 0, 1, b'm', b'o', b'o', b'v'][..])
    );
    let mdat = find_top_level_box(&stripped.bytes, *b"mdat").expect("mdat");
    let offsets = find_chunk_offsets(&stripped.bytes, *b"co64").expect("co64 offsets");

    assert_eq!(offsets.len(), 1);
    for offset in offsets {
        let offset = usize::try_from(offset).expect("offset fits usize");
        assert!(offset >= mdat.payload_start, "co64 offset before mdat");
        assert!(offset < mdat.end, "co64 offset past mdat end");
        assert!(
            stripped.bytes[offset..].starts_with(NAL_PREFIX),
            "co64 offset must point at NAL prefix"
        );
    }
}

#[derive(Clone, Copy)]
enum OffsetBox {
    Stco,
    Co64,
}

#[derive(Clone, Copy)]
enum BoxHeader {
    Compact,
    Extended,
}

#[derive(Debug, Clone, Copy)]
struct ParsedBox {
    box_type: [u8; 4],
    payload_start: usize,
    end: usize,
}

fn synthetic_iso_video(brand: [u8; 4], offset_box: OffsetBox, moov_header: BoxHeader) -> Vec<u8> {
    let frame = [
        NAL_PREFIX,
        &[0x65, 0x88, 0x84, 0x21, 0xa0, 0x0f, 0xff, 0x80],
    ]
    .concat();
    let ftyp = ftyp_box(brand);
    let moov_with_zero_offset = moov_box(0, offset_box, moov_header);
    let mdat_payload_start = ftyp.len() + moov_with_zero_offset.len() + 8;
    let moov = moov_box(
        u64::try_from(mdat_payload_start).expect("mdat offset fits"),
        offset_box,
        moov_header,
    );

    [ftyp, moov, bmff_box(*b"mdat", &frame)].concat()
}

fn ftyp_box(brand: [u8; 4]) -> Vec<u8> {
    let mut payload = brand.to_vec();
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&brand);
    if brand != *b"qt  " {
        payload.extend_from_slice(b"isom");
    }
    bmff_box(*b"ftyp", &payload)
}

fn moov_box(chunk_offset: u64, offset_box: OffsetBox, header: BoxHeader) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&trak_box(chunk_offset, offset_box));
    payload.extend_from_slice(&bmff_box(*b"udta", &bmff_box(*b"name", b"camera-metadata")));
    match header {
        BoxHeader::Compact => bmff_box(*b"moov", &payload),
        BoxHeader::Extended => extended_bmff_box(*b"moov", &payload),
    }
}

fn trak_box(chunk_offset: u64, offset_box: OffsetBox) -> Vec<u8> {
    let offset_table = match offset_box {
        OffsetBox::Stco => stco_box(u32::try_from(chunk_offset).expect("stco offset fits")),
        OffsetBox::Co64 => co64_box(chunk_offset),
    };
    let stbl = bmff_box(*b"stbl", &offset_table);
    let minf = bmff_box(*b"minf", &stbl);
    let mut mdia_payload = hdlr_box();
    mdia_payload.extend_from_slice(&minf);
    let mdia = bmff_box(*b"mdia", &mdia_payload);
    bmff_box(*b"trak", &mdia)
}

fn hdlr_box() -> Vec<u8> {
    let mut payload = vec![0, 0, 0, 0];
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(b"vide");
    payload.extend_from_slice(&[0; 12]);
    payload.push(0);
    bmff_box(*b"hdlr", &payload)
}

fn stco_box(chunk_offset: u32) -> Vec<u8> {
    let mut payload = vec![0, 0, 0, 0];
    payload.extend_from_slice(&1_u32.to_be_bytes());
    payload.extend_from_slice(&chunk_offset.to_be_bytes());
    bmff_box(*b"stco", &payload)
}

fn co64_box(chunk_offset: u64) -> Vec<u8> {
    let mut payload = vec![0, 0, 0, 0];
    payload.extend_from_slice(&1_u32.to_be_bytes());
    payload.extend_from_slice(&chunk_offset.to_be_bytes());
    bmff_box(*b"co64", &payload)
}

fn bmff_box(box_type: [u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::new();
    let size = u32::try_from(payload.len() + 8).expect("box size fits");
    bytes.extend_from_slice(&size.to_be_bytes());
    bytes.extend_from_slice(&box_type);
    bytes.extend_from_slice(payload);
    bytes
}

fn extended_bmff_box(box_type: [u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::new();
    let size = u64::try_from(payload.len() + 16).expect("extended box size fits");
    bytes.extend_from_slice(&1_u32.to_be_bytes());
    bytes.extend_from_slice(&box_type);
    bytes.extend_from_slice(&size.to_be_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

fn find_top_level_box(input: &[u8], box_type: [u8; 4]) -> Option<ParsedBox> {
    parse_child_boxes(input)
        .ok()?
        .into_iter()
        .find(|candidate| candidate.box_type == box_type)
}

fn find_chunk_offsets(input: &[u8], box_type: [u8; 4]) -> Option<Vec<u64>> {
    parse_child_boxes(input)
        .ok()?
        .into_iter()
        .find_map(|bmff_box| find_chunk_offsets_in_box(input, bmff_box, box_type))
}

fn find_chunk_offsets_in_box(
    input: &[u8],
    bmff_box: ParsedBox,
    box_type: [u8; 4],
) -> Option<Vec<u64>> {
    if bmff_box.box_type == box_type {
        return Some(parse_chunk_offsets(
            &input[bmff_box.payload_start..bmff_box.end],
            box_type,
        ));
    }
    if !matches!(
        &bmff_box.box_type,
        b"moov" | b"trak" | b"mdia" | b"minf" | b"stbl"
    ) {
        return None;
    }
    parse_child_boxes(&input[bmff_box.payload_start..bmff_box.end])
        .ok()?
        .into_iter()
        .find_map(|child| {
            let absolute = ParsedBox {
                box_type: child.box_type,
                payload_start: bmff_box.payload_start + child.payload_start,
                end: bmff_box.payload_start + child.end,
            };
            find_chunk_offsets_in_box(input, absolute, box_type)
        })
}

fn parse_chunk_offsets(payload: &[u8], box_type: [u8; 4]) -> Vec<u64> {
    let entry_count = u32::from_be_bytes(payload[4..8].try_into().expect("entry count"));
    let entry_size = if box_type == *b"co64" { 8 } else { 4 };
    (0..usize::try_from(entry_count).expect("entry count fits"))
        .map(|index| {
            let start = 8 + index * entry_size;
            if entry_size == 8 {
                u64::from_be_bytes(payload[start..start + 8].try_into().expect("co64 entry"))
            } else {
                u64::from(u32::from_be_bytes(
                    payload[start..start + 4].try_into().expect("stco entry"),
                ))
            }
        })
        .collect()
}

fn parse_child_boxes(input: &[u8]) -> Result<Vec<ParsedBox>, ()> {
    let mut cursor = 0_usize;
    let mut boxes = Vec::new();
    while cursor < input.len() {
        let header = input.get(cursor..cursor + 8).ok_or(())?;
        let size = u32::from_be_bytes(header[0..4].try_into().map_err(|_| ())?);
        if size == 0 {
            return Err(());
        }
        let (box_size, header_size) = if size == 1 {
            let extended = input.get(cursor + 8..cursor + 16).ok_or(())?;
            (
                usize::try_from(u64::from_be_bytes(extended.try_into().map_err(|_| ())?))
                    .map_err(|_| ())?,
                16,
            )
        } else {
            (usize::try_from(size).map_err(|_| ())?, 8)
        };
        let end = cursor.checked_add(box_size).ok_or(())?;
        if box_size < header_size || end > input.len() {
            return Err(());
        }
        boxes.push(ParsedBox {
            box_type: header[4..8].try_into().map_err(|_| ())?,
            payload_start: cursor + header_size,
            end,
        });
        cursor = end;
    }
    Ok(boxes)
}
