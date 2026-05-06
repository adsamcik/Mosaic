#![allow(clippy::expect_used)]

use mosaic_media::{strip_avif_metadata, strip_heic_metadata};

#[derive(Debug)]
struct IlocEntry {
    construction_method: u16,
    extents: Vec<ItemExtent>,
}

#[derive(Debug)]
struct ItemExtent {
    offset: usize,
    length: usize,
}

#[test]
fn avif_strip_preserves_image_decodability() {
    let input = real_world_like_iso(*b"avif", *b"av01", av1_payload());
    let stripped = strip_avif_metadata(&input).expect("strip");

    let iloc_entry = find_image_item_iloc(&stripped.bytes, 1);
    let mdat_range = find_mdat_range(&stripped.bytes);
    assert_eq!(iloc_entry.construction_method, 0);

    for extent in &iloc_entry.extents {
        let extent_end = extent.offset + extent.length;
        assert!(extent.offset >= mdat_range.0, "extent before mdat");
        assert!(extent_end <= mdat_range.1, "extent past mdat end");
    }

    let first_extent = &iloc_entry.extents[0];
    let first_bytes = &stripped.bytes[first_extent.offset..first_extent.offset + 12];
    assert!(first_bytes.starts_with(&[0x00, 0x00, 0x00]));
    assert_eq!(first_bytes, &av1_payload()[..12]);
}

#[test]
fn heic_strip_preserves_image_decodability() {
    let input = real_world_like_iso(*b"heic", *b"hvc1", hevc_payload());
    let stripped = strip_heic_metadata(&input).expect("strip");

    let iloc_entry = find_image_item_iloc(&stripped.bytes, 1);
    let mdat_range = find_mdat_range(&stripped.bytes);
    assert_eq!(iloc_entry.construction_method, 0);

    for extent in &iloc_entry.extents {
        let extent_end = extent.offset + extent.length;
        assert!(extent.offset >= mdat_range.0, "extent before mdat");
        assert!(extent_end <= mdat_range.1, "extent past mdat end");
    }

    let first_extent = &iloc_entry.extents[0];
    let first_bytes = &stripped.bytes[first_extent.offset..first_extent.offset + 12];
    assert!(first_bytes.starts_with(&[0x00, 0x00, 0x00]));
    assert_eq!(first_bytes, &hevc_payload()[..12]);
}

fn real_world_like_iso(
    brand: [u8; 4],
    image_item_type: [u8; 4],
    media_payload: Vec<u8>,
) -> Vec<u8> {
    let ftyp = ftyp_box(brand);
    let provisional_meta = meta_box(image_item_type, 0, media_payload.len());
    let mdat_payload_offset = ftyp.len() + provisional_meta.len() + 8;
    let meta = meta_box(image_item_type, mdat_payload_offset, media_payload.len());

    let mut bytes = ftyp;
    bytes.extend_from_slice(&meta);
    bytes.extend_from_slice(&bmff_box(*b"mdat", &media_payload));
    bytes
}

fn ftyp_box(brand: [u8; 4]) -> Vec<u8> {
    let mut payload = brand.to_vec();
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&brand);
    payload.extend_from_slice(b"mif1");
    bmff_box(*b"ftyp", &payload)
}

fn meta_box(image_item_type: [u8; 4], image_offset: usize, image_len: usize) -> Vec<u8> {
    let mut payload = vec![0, 0, 0, 0];
    payload.extend_from_slice(&iinf_box(image_item_type));
    payload.extend_from_slice(&iloc_box(image_offset, image_len));
    payload.extend_from_slice(&iprp_box());
    bmff_box(*b"meta", &payload)
}

fn iinf_box(image_item_type: [u8; 4]) -> Vec<u8> {
    let mut payload = vec![0, 0, 0, 0];
    payload.extend_from_slice(&2_u16.to_be_bytes());
    payload.extend_from_slice(&infe_box(1, image_item_type));
    payload.extend_from_slice(&infe_box(2, *b"Exif"));
    bmff_box(*b"iinf", &payload)
}

fn infe_box(item_id: u16, item_type: [u8; 4]) -> Vec<u8> {
    let mut payload = vec![2, 0, 0, 0];
    payload.extend_from_slice(&item_id.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&item_type);
    payload.push(0);
    bmff_box(*b"infe", &payload)
}

fn iloc_box(image_offset: usize, image_len: usize) -> Vec<u8> {
    let mut payload = vec![1, 0, 0, 0, 0x44, 0x00];
    payload.extend_from_slice(&2_u16.to_be_bytes());

    payload.extend_from_slice(&1_u16.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&1_u16.to_be_bytes());
    payload.extend_from_slice(
        &u32::try_from(image_offset)
            .expect("image offset fits")
            .to_be_bytes(),
    );
    payload.extend_from_slice(
        &u32::try_from(image_len)
            .expect("image length fits")
            .to_be_bytes(),
    );

    payload.extend_from_slice(&2_u16.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());

    bmff_box(*b"iloc", &payload)
}

fn iprp_box() -> Vec<u8> {
    let mut ipco = Vec::new();
    ipco.extend_from_slice(&bmff_box(*b"ispe", &[0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1]));
    ipco.extend_from_slice(&bmff_box(*b"colr", b"profICC"));
    let mut payload = bmff_box(*b"ipco", &ipco);
    payload.extend_from_slice(&bmff_box(*b"ipma", &[0, 0, 0, 0, 0, 0]));
    bmff_box(*b"iprp", &payload)
}

fn av1_payload() -> Vec<u8> {
    let mut payload = b"\0\0\0\x01av1-obu0".to_vec();
    payload.extend([0xaa; 128]);
    payload
}

fn hevc_payload() -> Vec<u8> {
    let mut payload = b"\0\0\0\x01hvc-obu0".to_vec();
    payload.extend([0xbb; 128]);
    payload
}

fn find_image_item_iloc(input: &[u8], target_item_id: u32) -> IlocEntry {
    let meta_payload = find_box_payload(input, *b"meta").expect("meta box");
    let iloc_payload = find_box_payload(&meta_payload[4..], *b"iloc").expect("iloc box");
    let version = iloc_payload[0];
    assert_eq!(version, 1);
    let offset_size = iloc_payload[4] >> 4;
    let length_size = iloc_payload[4] & 0x0f;
    let base_offset_size = iloc_payload[5] >> 4;
    let index_size = iloc_payload[5] & 0x0f;
    let item_count = u16::from_be_bytes([iloc_payload[6], iloc_payload[7]]);
    let mut cursor = 8_usize;

    for _ in 0..item_count {
        let item_id = u32::from(u16::from_be_bytes([
            iloc_payload[cursor],
            iloc_payload[cursor + 1],
        ]));
        cursor += 2;
        let construction_method =
            u16::from_be_bytes([iloc_payload[cursor], iloc_payload[cursor + 1]]) & 0x000f;
        cursor += 2;
        cursor += 2;
        cursor += usize::from(base_offset_size);
        let extent_count = u16::from_be_bytes([iloc_payload[cursor], iloc_payload[cursor + 1]]);
        cursor += 2;

        let mut extents = Vec::new();
        for _ in 0..extent_count {
            cursor += usize::from(index_size);
            let offset = read_sized_uint(iloc_payload, cursor, offset_size);
            cursor += usize::from(offset_size);
            let length = read_sized_uint(iloc_payload, cursor, length_size);
            cursor += usize::from(length_size);
            extents.push(ItemExtent { offset, length });
        }

        if item_id == target_item_id {
            assert_eq!(construction_method, 0);
            return IlocEntry {
                construction_method,
                extents,
            };
        }
    }

    panic!("image item iloc entry missing");
}

fn find_mdat_range(input: &[u8]) -> (usize, usize) {
    let mut cursor = 0_usize;
    while cursor < input.len() {
        let (box_type, payload_start, end) = read_box_header(input, cursor).expect("valid box");
        if box_type == *b"mdat" {
            return (payload_start, end);
        }
        cursor = end;
    }
    panic!("mdat missing");
}

fn find_box_payload(input: &[u8], expected_type: [u8; 4]) -> Option<&[u8]> {
    let mut cursor = 0_usize;
    while cursor < input.len() {
        let (box_type, payload_start, end) = read_box_header(input, cursor)?;
        if box_type == expected_type {
            return input.get(payload_start..end);
        }
        cursor = end;
    }
    None
}

fn read_box_header(input: &[u8], cursor: usize) -> Option<([u8; 4], usize, usize)> {
    let header = input.get(cursor..cursor.checked_add(8)?)?;
    let declared_size = u32::from_be_bytes([header[0], header[1], header[2], header[3]]);
    let box_type = [header[4], header[5], header[6], header[7]];
    let (box_size, header_size) = if declared_size == 1 {
        let extended = input.get(cursor.checked_add(8)?..cursor.checked_add(16)?)?;
        (
            usize::try_from(u64::from_be_bytes([
                extended[0],
                extended[1],
                extended[2],
                extended[3],
                extended[4],
                extended[5],
                extended[6],
                extended[7],
            ]))
            .ok()?,
            16,
        )
    } else {
        (usize::try_from(declared_size).ok()?, 8)
    };
    let payload_start = cursor.checked_add(header_size)?;
    let end = cursor.checked_add(box_size)?;
    Some((box_type, payload_start, end))
}

fn read_sized_uint(payload: &[u8], offset: usize, size: u8) -> usize {
    match size {
        0 => 0,
        4 => usize::try_from(u32::from_be_bytes([
            payload[offset],
            payload[offset + 1],
            payload[offset + 2],
            payload[offset + 3],
        ]))
        .expect("u32 fits usize"),
        8 => usize::try_from(u64::from_be_bytes([
            payload[offset],
            payload[offset + 1],
            payload[offset + 2],
            payload[offset + 3],
            payload[offset + 4],
            payload[offset + 5],
            payload[offset + 6],
            payload[offset + 7],
        ]))
        .expect("u64 fits usize"),
        _ => panic!("unsupported iloc integer size"),
    }
}

fn bmff_box(box_type: [u8; 4], payload: &[u8]) -> Vec<u8> {
    let size = u32::try_from(payload.len() + 8).expect("test box size fits");
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&size.to_be_bytes());
    bytes.extend_from_slice(&box_type);
    bytes.extend_from_slice(payload);
    bytes
}
