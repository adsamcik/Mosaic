use mosaic_media::strip_avif_metadata;

#[test]
fn iloc_construction_method_0_rewrites_file_offsets_after_metadata_strip() {
    let input = iso_with_image_construction_method(0);
    let stripped = match strip_avif_metadata(&input) {
        Ok(stripped) => stripped,
        Err(error) => panic!("cm=0 file offsets should strip: {error:?}"),
    };
    let entry = find_item_iloc(&stripped.bytes, 1);
    let (mdat_start, _) = find_mdat_range(&stripped.bytes);

    assert_eq!(entry.construction_method, 0);
    assert_eq!(
        entry.extents,
        vec![ItemExtent {
            offset: mdat_start,
            length: 5
        }]
    );
}

#[test]
fn iloc_construction_method_1_idat_offsets_are_preserved_without_file_rewrite() {
    let input = iso_with_image_construction_method(1);
    let stripped = match strip_avif_metadata(&input) {
        Ok(stripped) => stripped,
        Err(error) => panic!("cm=1 idat offsets should remain supported: {error:?}"),
    };
    let entry = find_item_iloc(&stripped.bytes, 1);

    assert_eq!(entry.construction_method, 1);
    assert_eq!(
        entry.extents,
        vec![ItemExtent {
            offset: 0,
            length: 5
        }]
    );
}

#[test]
fn iloc_construction_method_2_item_offsets_are_preserved_without_file_rewrite() {
    let input = iso_with_image_construction_method(2);
    let stripped = match strip_avif_metadata(&input) {
        Ok(stripped) => stripped,
        Err(error) => panic!("cm=2 item offsets should remain supported: {error:?}"),
    };
    let entry = find_item_iloc(&stripped.bytes, 1);

    assert_eq!(entry.construction_method, 2);
    assert_eq!(
        entry.extents,
        vec![ItemExtent {
            offset: 0,
            length: 5
        }]
    );
}

#[test]
fn iloc_construction_method_3_reserved_is_rejected_as_malformed() {
    let input = iso_with_image_construction_method(3);

    assert!(
        strip_avif_metadata(&input).is_err(),
        "cm>=3 reserved iloc construction methods must be rejected"
    );
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct IlocEntry {
    construction_method: u16,
    extents: Vec<ItemExtent>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ItemExtent {
    offset: usize,
    length: usize,
}

fn iso_with_image_construction_method(construction_method: u16) -> Vec<u8> {
    let ftyp = ftyp_box(*b"avif");
    let initial_meta = meta_box(*b"av01", construction_method, 0);
    let image_offset = if construction_method == 0 {
        ftyp.len() + initial_meta.len() + 8
    } else {
        0
    };
    let meta = meta_box(*b"av01", construction_method, image_offset);
    let mut bytes = ftyp;
    bytes.extend_from_slice(&meta);
    bytes.extend_from_slice(&bmff_box(*b"mdat", b"image"));
    bytes
}

fn ftyp_box(brand: [u8; 4]) -> Vec<u8> {
    let mut payload = brand.to_vec();
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&brand);
    payload.extend_from_slice(b"mif1");
    bmff_box(*b"ftyp", &payload)
}

fn meta_box(image_item_type: [u8; 4], construction_method: u16, image_offset: usize) -> Vec<u8> {
    let mut payload = vec![0, 0, 0, 0];
    payload.extend_from_slice(&iinf_box(image_item_type));
    payload.extend_from_slice(&iloc_box(construction_method, image_offset));
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

fn iloc_box(construction_method: u16, image_offset: usize) -> Vec<u8> {
    let mut payload = vec![1, 0, 0, 0, 0x44, 0x00];
    payload.extend_from_slice(&2_u16.to_be_bytes());

    payload.extend_from_slice(&1_u16.to_be_bytes());
    payload.extend_from_slice(&(construction_method & 0x000f).to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&1_u16.to_be_bytes());
    let image_offset = match u32::try_from(image_offset) {
        Ok(image_offset) => image_offset,
        Err(error) => panic!("image offset does not fit: {error:?}"),
    };
    payload.extend_from_slice(&image_offset.to_be_bytes());
    payload.extend_from_slice(&5_u32.to_be_bytes());

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

fn find_item_iloc(input: &[u8], target_item_id: u32) -> IlocEntry {
    let meta_payload = match find_box_payload(input, *b"meta") {
        Some(meta_payload) => meta_payload,
        None => panic!("meta box missing"),
    };
    let iloc_payload = match find_box_payload(&meta_payload[4..], *b"iloc") {
        Some(iloc_payload) => iloc_payload,
        None => panic!("iloc box missing"),
    };
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
        let (box_type, payload_start, end) = match read_box_header(input, cursor) {
            Some(header) => header,
            None => panic!("invalid box at cursor {cursor}"),
        };
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
    let box_size = usize::try_from(declared_size).ok()?;
    let payload_start = cursor.checked_add(8)?;
    let end = cursor.checked_add(box_size)?;
    Some((box_type, payload_start, end))
}

fn read_sized_uint(payload: &[u8], offset: usize, size: u8) -> usize {
    match size {
        0 => 0,
        4 => match usize::try_from(u32::from_be_bytes([
            payload[offset],
            payload[offset + 1],
            payload[offset + 2],
            payload[offset + 3],
        ])) {
            Ok(value) => value,
            Err(error) => panic!("u32 does not fit usize: {error:?}"),
        },
        8 => match usize::try_from(u64::from_be_bytes([
            payload[offset],
            payload[offset + 1],
            payload[offset + 2],
            payload[offset + 3],
            payload[offset + 4],
            payload[offset + 5],
            payload[offset + 6],
            payload[offset + 7],
        ])) {
            Ok(value) => value,
            Err(error) => panic!("u64 does not fit usize: {error:?}"),
        },
        _ => panic!("unsupported iloc integer size"),
    }
}

fn bmff_box(box_type: [u8; 4], payload: &[u8]) -> Vec<u8> {
    let size = match u32::try_from(payload.len() + 8) {
        Ok(size) => size,
        Err(error) => panic!("test box size does not fit: {error:?}"),
    };
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&size.to_be_bytes());
    bytes.extend_from_slice(&box_type);
    bytes.extend_from_slice(payload);
    bytes
}
