#![allow(clippy::expect_used)]

use std::fs;
use std::path::PathBuf;

use mosaic_media::{
    BoxParser, MetadataKind, extract_avif_canonical_sidecar_fields,
    extract_heic_canonical_sidecar_fields, strip_avif_metadata, strip_heic_metadata,
};

#[test]
fn strips_synthetic_avif_exif_xmp_and_icc_to_golden_bytes() {
    let input = corpus_bytes("avif_corpus", "synthetic-with-metadata.avif");
    let expected = corpus_bytes("avif_corpus", "synthetic-with-metadata.stripped.avif");
    assert!(BoxParser::new(&input).parse().is_ok());
    assert!(BoxParser::new(&expected).parse().is_ok());

    let stripped = strip_avif_metadata(&input).expect("synthetic AVIF should strip");

    assert_eq!(
        stripped.removed,
        vec![
            MetadataKind::Exif,
            MetadataKind::Xmp,
            MetadataKind::ColorProfile
        ]
    );
    assert_eq!(stripped.bytes, expected);
    assert_eq!(
        mdat_payload(&stripped.bytes),
        Some(b"av01-image-bytes".as_slice())
    );
    assert!(!stripped.bytes.windows(4).any(|window| window == b"Exif"));
    assert!(
        !stripped
            .bytes
            .windows(b"application/rdf+xml".len())
            .any(|window| window == b"application/rdf+xml")
    );
}

#[test]
fn strips_synthetic_heic_exif_xmp_and_icc_to_golden_bytes() {
    let input = corpus_bytes("heic_corpus", "synthetic-with-metadata.heic");
    let expected = corpus_bytes("heic_corpus", "synthetic-with-metadata.stripped.heic");

    let stripped = strip_heic_metadata(&input).expect("synthetic HEIC should strip");

    assert_eq!(
        stripped.removed,
        vec![
            MetadataKind::Exif,
            MetadataKind::Xmp,
            MetadataKind::ColorProfile
        ]
    );
    assert_eq!(stripped.bytes, expected);
    assert_eq!(
        mdat_payload(&stripped.bytes),
        Some(b"hvc1-image-bytes".as_slice())
    );
    assert!(!stripped.bytes.windows(4).any(|window| window == b"Exif"));
    assert!(
        !stripped
            .bytes
            .windows(b"application/rdf+xml".len())
            .any(|window| window == b"application/rdf+xml")
    );
}

#[test]
fn extracts_avif_exif_item_canonical_camera_fields() {
    let input = iso_with_exif_idat(*b"avif", *b"av01");
    let fields = extract_avif_canonical_sidecar_fields(&input)
        .fields
        .expect("AVIF EXIF item should yield camera fields");

    assert_eq!(fields.camera_make.as_deref(), Some("MosaicCam"));
}

#[test]
fn extracts_heic_exif_item_canonical_camera_fields() {
    let input = iso_with_exif_idat(*b"heic", *b"hvc1");
    let fields = extract_heic_canonical_sidecar_fields(&input)
        .fields
        .expect("HEIC EXIF item should yield camera fields");

    assert_eq!(fields.camera_make.as_deref(), Some("MosaicCam"));
}

fn iso_with_exif_idat(brand: [u8; 4], image_item_type: [u8; 4]) -> Vec<u8> {
    let mut bytes = ftyp_box(brand);
    bytes.extend_from_slice(&meta_box(image_item_type, true, true));
    bytes.extend_from_slice(&bmff_box(*b"mdat", b"image"));
    bytes
}

fn corpus_bytes(dir: &str, name: &str) -> Vec<u8> {
    fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join(dir)
            .join(name),
    )
    .expect("ISO-BMFF corpus fixture should be readable")
}

fn ftyp_box(brand: [u8; 4]) -> Vec<u8> {
    let mut payload = brand.to_vec();
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&brand);
    payload.extend_from_slice(b"mif1");
    bmff_box(*b"ftyp", &payload)
}

fn meta_box(image_item_type: [u8; 4], include_metadata: bool, include_idat: bool) -> Vec<u8> {
    let mut payload = vec![0, 0, 0, 0];
    let mut item_types = vec![(1_u16, image_item_type, None)];
    if include_metadata {
        item_types.push((2, *b"Exif", None));
        item_types.push((3, *b"mime", Some("application/rdf+xml")));
    }
    payload.extend_from_slice(&iinf_box(&item_types));
    payload.extend_from_slice(&iloc_box(
        &item_types
            .iter()
            .map(|(id, _, _)| (*id, include_idat && *id == 2))
            .collect::<Vec<_>>(),
    ));
    payload.extend_from_slice(&iprp_box(include_metadata));
    payload.extend_from_slice(&bmff_box(*b"iref", &[0, 0, 0, 0]));
    if include_idat {
        payload.extend_from_slice(&bmff_box(*b"idat", &heif_exif_payload()));
    }
    bmff_box(*b"meta", &payload)
}

fn iinf_box(entries: &[(u16, [u8; 4], Option<&str>)]) -> Vec<u8> {
    let mut payload = vec![0, 0, 0, 0];
    payload.extend_from_slice(
        &u16::try_from(entries.len())
            .expect("entry count fits")
            .to_be_bytes(),
    );
    for (item_id, item_type, content_type) in entries {
        let mut infe = vec![2, 0, 0, 0];
        infe.extend_from_slice(&item_id.to_be_bytes());
        infe.extend_from_slice(&0_u16.to_be_bytes());
        infe.extend_from_slice(item_type);
        infe.push(0);
        if let Some(content_type) = content_type {
            infe.extend_from_slice(content_type.as_bytes());
            infe.push(0);
        }
        payload.extend_from_slice(&bmff_box(*b"infe", &infe));
    }
    bmff_box(*b"iinf", &payload)
}

fn iloc_box(items: &[(u16, bool)]) -> Vec<u8> {
    let mut payload = vec![0, 0, 0, 0, 0x44, 0x40];
    payload.extend_from_slice(
        &u16::try_from(items.len())
            .expect("item count fits")
            .to_be_bytes(),
    );
    let exif_payload_len = u32::try_from(heif_exif_payload().len()).expect("payload fits");
    for (item_id, has_extent) in items {
        payload.extend_from_slice(&item_id.to_be_bytes());
        payload.extend_from_slice(&0_u16.to_be_bytes());
        payload.extend_from_slice(&0_u32.to_be_bytes());
        payload.extend_from_slice(&u16::from(*has_extent).to_be_bytes());
        if *has_extent {
            payload.extend_from_slice(&0_u32.to_be_bytes());
            payload.extend_from_slice(&exif_payload_len.to_be_bytes());
        }
    }
    bmff_box(*b"iloc", &payload)
}

fn iprp_box(include_icc: bool) -> Vec<u8> {
    let mut ipco = Vec::new();
    ipco.extend_from_slice(&bmff_box(*b"ispe", &[0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1]));
    if include_icc {
        ipco.extend_from_slice(&bmff_box(*b"colr", b"profICC"));
    }
    let mut payload = bmff_box(*b"ipco", &ipco);
    payload.extend_from_slice(&bmff_box(*b"ipma", &[0, 0, 0, 0, 0, 0]));
    bmff_box(*b"iprp", &payload)
}

fn heif_exif_payload() -> Vec<u8> {
    let tiff = tiff_with_camera_make();
    let mut payload = 0_u32.to_be_bytes().to_vec();
    payload.extend_from_slice(&tiff);
    payload
}

fn tiff_with_camera_make() -> Vec<u8> {
    let camera = b"MosaicCam\0";
    let value_offset = 8_u32 + 2 + 12 + 4;
    let mut tiff = b"II".to_vec();
    tiff.extend_from_slice(&42_u16.to_le_bytes());
    tiff.extend_from_slice(&8_u32.to_le_bytes());
    tiff.extend_from_slice(&1_u16.to_le_bytes());
    tiff.extend_from_slice(&0x010f_u16.to_le_bytes());
    tiff.extend_from_slice(&2_u16.to_le_bytes());
    tiff.extend_from_slice(
        &u32::try_from(camera.len())
            .expect("camera string length fits")
            .to_le_bytes(),
    );
    tiff.extend_from_slice(&value_offset.to_le_bytes());
    tiff.extend_from_slice(&0_u32.to_le_bytes());
    tiff.extend_from_slice(camera);
    tiff
}

fn mdat_payload(input: &[u8]) -> Option<&[u8]> {
    let mut offset = 0_usize;
    while offset < input.len() {
        let header = input.get(offset..offset.checked_add(8)?)?;
        let size = usize::try_from(u32::from_be_bytes([
            header[0], header[1], header[2], header[3],
        ]))
        .ok()?;
        let end = offset.checked_add(size)?;
        if header.get(4..8) == Some(b"mdat") {
            return input.get(offset + 8..end);
        }
        offset = end;
    }
    None
}

fn bmff_box(box_type: [u8; 4], payload: &[u8]) -> Vec<u8> {
    let size = u32::try_from(payload.len() + 8).expect("test box size fits");
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&size.to_be_bytes());
    bytes.extend_from_slice(&box_type);
    bytes.extend_from_slice(payload);
    bytes
}
