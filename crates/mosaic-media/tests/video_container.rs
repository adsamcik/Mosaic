#![allow(clippy::expect_used, clippy::too_many_arguments)]

use mosaic_media::{
    MetadataKind, Orientation, VideoCodec, VideoContainer, inspect_video_container,
    strip_video_metadata, video_metadata_sidecar_fields,
};

#[test]
fn inspect_synthetic_mp4_h264_video_track() {
    let input = synthetic_mp4(*b"isom", *b"avc1", 1920, 1080, 90_000, 180_000, 30, None);

    let result = inspect_video_container(&input);

    assert_eq!(result.code, 0);
    assert_eq!(result.container, VideoContainer::Mp4);
    assert_eq!(result.video_codec, Some(VideoCodec::H264));
    assert_eq!((result.width_px, result.height_px), (1920, 1080));
    assert_eq!(result.duration_ms, 2000);
    assert_eq!(
        result.frame_rate_fps.map(|fps| fps.round() as u32),
        Some(30)
    );
}

#[test]
fn inspect_synthetic_mov_h265_video_track_with_orientation() {
    let input = synthetic_mp4(
        *b"qt  ",
        *b"hvc1",
        1080,
        1920,
        600,
        1200,
        60,
        Some(Orientation::Rotate90),
    );

    let result = inspect_video_container(&input);

    assert_eq!(result.code, 0);
    assert_eq!(result.container, VideoContainer::Mov);
    assert_eq!(result.video_codec, Some(VideoCodec::H265));
    assert_eq!(result.orientation, Some(Orientation::Rotate90));
    assert_eq!(
        result.frame_rate_fps.map(|fps| fps.round() as u32),
        Some(60)
    );
}

#[test]
fn inspect_synthetic_webm_vp9_video_track() {
    let input = synthetic_ebml("webm", b"V_VP9", 1280, 720, 12_345.0, Some(33_333_333));

    let result = inspect_video_container(&input);

    assert_eq!(result.code, 0);
    assert_eq!(result.container, VideoContainer::WebM);
    assert_eq!(result.video_codec, Some(VideoCodec::VP9));
    assert_eq!((result.width_px, result.height_px), (1280, 720));
    assert_eq!(result.duration_ms, 12_345);
    assert_eq!(
        result.frame_rate_fps.map(|fps| fps.round() as u32),
        Some(30)
    );
}

#[test]
fn inspect_synthetic_matroska_av1_video_track() {
    let input = synthetic_ebml("matroska", b"V_AV1", 3840, 2160, 1000.0, None);

    let result = inspect_video_container(&input);

    assert_eq!(result.code, 0);
    assert_eq!(result.container, VideoContainer::Matroska);
    assert_eq!(result.video_codec, Some(VideoCodec::AV1));
    assert_eq!((result.width_px, result.height_px), (3840, 2160));
    assert_eq!(result.frame_rate_fps, None);
}

#[test]
fn video_sidecar_fields_use_active_canonical_layouts() {
    let result = inspect_video_container(&synthetic_mp4(
        *b"isom",
        *b"avc1",
        1920,
        1080,
        90_000,
        180_000,
        30,
        Some(Orientation::Rotate90),
    ));

    let fields = video_metadata_sidecar_fields(&result);

    assert_eq!(
        fields.iter().map(|(tag, _)| *tag).collect::<Vec<_>>(),
        vec![10, 11, 12, 13, 14, 15]
    );
    assert_eq!(fields[0].1, vec![1]);
    assert_eq!(fields[1].1, 2_000_u64.to_le_bytes());
    assert_eq!(fields[2].1, 30_000_u32.to_le_bytes());
    assert_eq!(fields[3].1, vec![1]);
    assert_eq!(
        fields[4].1,
        [1920_u32.to_le_bytes(), 1080_u32.to_le_bytes()].concat()
    );
    assert_eq!(fields[5].1, vec![1]);
}

#[test]
fn strip_synthetic_mp4_removes_udta_and_meta_preserves_mdat() {
    let input = synthetic_mp4(*b"isom", *b"avc1", 640, 480, 1_000, 1_000, 25, None);

    let stripped = strip_video_metadata(&input).expect("synthetic MP4 should strip");

    assert_eq!(
        stripped.removed,
        vec![MetadataKind::VideoMetadata, MetadataKind::VideoMetadata]
    );
    assert!(
        stripped
            .bytes
            .windows(b"video-frames".len())
            .any(|w| w == b"video-frames")
    );
    assert!(
        !stripped
            .bytes
            .windows(b"metadata".len())
            .any(|w| w == b"metadata")
    );
}

#[test]
fn strip_synthetic_webm_removes_tags_and_attachments_preserves_cluster() {
    let input = synthetic_ebml("webm", b"V_VP9", 640, 360, 500.0, Some(40_000_000));

    let stripped = strip_video_metadata(&input).expect("synthetic WebM should strip");

    assert_eq!(
        stripped.removed,
        vec![MetadataKind::VideoMetadata, MetadataKind::Attachment]
    );
    assert!(
        stripped
            .bytes
            .windows(b"cluster-frames".len())
            .any(|w| w == b"cluster-frames")
    );
    assert!(
        !stripped
            .bytes
            .windows(b"tag-metadata".len())
            .any(|w| w == b"tag-metadata")
    );
    assert!(
        !stripped
            .bytes
            .windows(b"cover-art".len())
            .any(|w| w == b"cover-art")
    );
}

#[test]
fn inspect_truncated_iso_container_returns_error_code() {
    let result =
        inspect_video_container(&synthetic_mp4(*b"isom", *b"avc1", 1, 1, 1, 1, 1, None)[..12]);

    assert_ne!(result.code, 0);
}

#[test]
fn inspect_iso_box_claiming_size_beyond_input_returns_error_code() {
    let input = bmff_box_with_declared_size(*b"ftyp", b"isom\0\0\0\0isom", 4096);

    let result = inspect_video_container(&input);

    assert_ne!(result.code, 0);
}

#[test]
fn inspect_iso_unknown_codec_returns_error_code_cleanly() {
    let input = synthetic_mp4(*b"isom", *b"zzzz", 320, 240, 1_000, 1_000, 25, None);

    let result = inspect_video_container(&input);

    assert_ne!(result.code, 0);
    assert_eq!(result.container, VideoContainer::Mp4);
    assert_eq!(result.video_codec, None);
}

#[test]
fn inspect_truncated_ebml_container_returns_error_code() {
    let result = inspect_video_container(&[0x1a, 0x45, 0xdf]);

    assert_ne!(result.code, 0);
}

#[test]
fn inspect_ebml_element_claiming_size_beyond_input_returns_error_code() {
    let input = vec![0x1a, 0x45, 0xdf, 0xa3, 0xff];

    let result = inspect_video_container(&input);

    assert_ne!(result.code, 0);
}

#[test]
fn inspect_ebml_unknown_codec_returns_error_code_cleanly() {
    let input = synthetic_ebml("webm", b"V_UNKNOWN", 640, 360, 500.0, None);

    let result = inspect_video_container(&input);

    assert_ne!(result.code, 0);
    assert_eq!(result.container, VideoContainer::WebM);
    assert_eq!(result.video_codec, None);
}

#[test]
fn inspect_recursive_ebml_containers_are_bounded() {
    let mut payload = ebml_element(&[0x42, 0x82], b"webm");
    for _ in 0..12 {
        payload = ebml_element(&[0xae], &payload);
    }
    let input = ebml_element(&[0x1a, 0x45, 0xdf, 0xa3], &payload);

    let result = inspect_video_container(&input);

    assert_ne!(result.code, 0);
}

fn synthetic_mp4(
    brand: [u8; 4],
    codec: [u8; 4],
    width: u32,
    height: u32,
    timescale: u32,
    duration: u32,
    fps: u32,
    orientation: Option<Orientation>,
) -> Vec<u8> {
    let mut bytes = ftyp_box(brand);
    let trak = trak_box(codec, width, height, timescale, duration, fps, orientation);
    let mut moov_payload = Vec::new();
    moov_payload.extend_from_slice(&trak);
    moov_payload.extend_from_slice(&bmff_box(*b"udta", &bmff_box(*b"name", b"metadata")));
    moov_payload.extend_from_slice(&bmff_box(*b"meta", &[0, 0, 0, 0]));
    bytes.extend_from_slice(&bmff_box(*b"moov", &moov_payload));
    bytes.extend_from_slice(&bmff_box(*b"mdat", b"video-frames"));
    bytes
}

fn ftyp_box(brand: [u8; 4]) -> Vec<u8> {
    let mut payload = brand.to_vec();
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&brand);
    if brand != *b"qt  " {
        payload.extend_from_slice(b"mp42");
    }
    bmff_box(*b"ftyp", &payload)
}

fn trak_box(
    codec: [u8; 4],
    width: u32,
    height: u32,
    timescale: u32,
    duration: u32,
    fps: u32,
    orientation: Option<Orientation>,
) -> Vec<u8> {
    let mut mdia = Vec::new();
    mdia.extend_from_slice(&mdhd_box(timescale, duration));
    mdia.extend_from_slice(&hdlr_box());
    mdia.extend_from_slice(&bmff_box(
        *b"minf",
        &bmff_box(*b"stbl", &stbl_box(codec, timescale / fps)),
    ));
    let mut trak = tkhd_box(width, height, orientation);
    trak.extend_from_slice(&bmff_box(*b"mdia", &mdia));
    bmff_box(*b"trak", &trak)
}

fn tkhd_box(width: u32, height: u32, orientation: Option<Orientation>) -> Vec<u8> {
    let mut payload = vec![0, 0, 0, 0];
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&1_u32.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&[0; 8]);
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&matrix(orientation.unwrap_or(Orientation::Rotate0)));
    payload.extend_from_slice(&(width << 16).to_be_bytes());
    payload.extend_from_slice(&(height << 16).to_be_bytes());
    bmff_box(*b"tkhd", &payload)
}

fn matrix(orientation: Orientation) -> Vec<u8> {
    let values: [i32; 9] = match orientation {
        Orientation::Rotate0 => [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000],
        Orientation::Rotate90 => [0, 0x0001_0000, 0, -0x0001_0000, 0, 0, 0, 0, 0x4000_0000],
        Orientation::Rotate180 => [-0x0001_0000, 0, 0, 0, -0x0001_0000, 0, 0, 0, 0x4000_0000],
        Orientation::Rotate270 => [0, -0x0001_0000, 0, 0x0001_0000, 0, 0, 0, 0, 0x4000_0000],
    };
    values
        .into_iter()
        .flat_map(i32::to_be_bytes)
        .collect::<Vec<_>>()
}

fn mdhd_box(timescale: u32, duration: u32) -> Vec<u8> {
    let mut payload = vec![0, 0, 0, 0];
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&timescale.to_be_bytes());
    payload.extend_from_slice(&duration.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    bmff_box(*b"mdhd", &payload)
}

fn hdlr_box() -> Vec<u8> {
    let mut payload = vec![0, 0, 0, 0];
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(b"vide");
    payload.extend_from_slice(&[0; 12]);
    payload.push(0);
    bmff_box(*b"hdlr", &payload)
}

fn stbl_box(codec: [u8; 4], sample_delta: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&stsd_box(codec));
    payload.extend_from_slice(&stts_box(60, sample_delta));
    payload
}

fn stsd_box(codec: [u8; 4]) -> Vec<u8> {
    let mut payload = vec![0, 0, 0, 0];
    payload.extend_from_slice(&1_u32.to_be_bytes());
    payload.extend_from_slice(&86_u32.to_be_bytes());
    payload.extend_from_slice(&codec);
    payload.extend_from_slice(&[0; 78]);
    bmff_box(*b"stsd", &payload)
}

fn stts_box(sample_count: u32, sample_delta: u32) -> Vec<u8> {
    let mut payload = vec![0, 0, 0, 0];
    payload.extend_from_slice(&1_u32.to_be_bytes());
    payload.extend_from_slice(&sample_count.to_be_bytes());
    payload.extend_from_slice(&sample_delta.to_be_bytes());
    bmff_box(*b"stts", &payload)
}

fn bmff_box(box_type: [u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::new();
    let size = u32::try_from(payload.len() + 8).expect("box size fits");
    bytes.extend_from_slice(&size.to_be_bytes());
    bytes.extend_from_slice(&box_type);
    bytes.extend_from_slice(payload);
    bytes
}

fn bmff_box_with_declared_size(box_type: [u8; 4], payload: &[u8], size: u32) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&size.to_be_bytes());
    bytes.extend_from_slice(&box_type);
    bytes.extend_from_slice(payload);
    bytes
}

fn synthetic_ebml(
    doc_type: &str,
    codec: &[u8],
    width: u32,
    height: u32,
    duration: f64,
    default_duration_ns: Option<u64>,
) -> Vec<u8> {
    let ebml_header = ebml_element(
        &[0x1a, 0x45, 0xdf, 0xa3],
        &ebml_element(&[0x42, 0x82], doc_type.as_bytes()),
    );
    let mut info_payload = ebml_element(&[0x2a, 0xd7, 0xb1], &uint_bytes(1_000_000));
    info_payload.extend_from_slice(&ebml_element(&[0x44, 0x89], &duration.to_be_bytes()));
    let info = ebml_element(&[0x15, 0x49, 0xa9, 0x66], &info_payload);
    let mut video_payload = ebml_element(&[0xb0], &uint_bytes(u64::from(width)));
    video_payload.extend_from_slice(&ebml_element(&[0xba], &uint_bytes(u64::from(height))));
    let mut track_payload = ebml_element(&[0x83], &[1]);
    track_payload.extend_from_slice(&ebml_element(&[0x86], codec));
    if let Some(default_duration_ns) = default_duration_ns {
        track_payload.extend_from_slice(&ebml_element(
            &[0x23, 0xe3, 0x83],
            &uint_bytes(default_duration_ns),
        ));
    }
    track_payload.extend_from_slice(&ebml_element(&[0xe0], &video_payload));
    let tracks = ebml_element(
        &[0x16, 0x54, 0xae, 0x6b],
        &ebml_element(&[0xae], &track_payload),
    );
    let tags = ebml_element(&[0x12, 0x54, 0xc3, 0x67], b"tag-metadata");
    let attachments = ebml_element(&[0x19, 0x41, 0xa4, 0x69], b"cover-art");
    let cluster = ebml_element(&[0x1f, 0x43, 0xb6, 0x75], b"cluster-frames");
    let mut segment_payload = info;
    segment_payload.extend_from_slice(&tracks);
    segment_payload.extend_from_slice(&tags);
    segment_payload.extend_from_slice(&attachments);
    segment_payload.extend_from_slice(&cluster);
    let segment = ebml_element(&[0x18, 0x53, 0x80, 0x67], &segment_payload);
    [ebml_header, segment].concat()
}

fn ebml_element(id: &[u8], payload: &[u8]) -> Vec<u8> {
    let mut bytes = id.to_vec();
    bytes.extend_from_slice(&ebml_size(payload.len()));
    bytes.extend_from_slice(payload);
    bytes
}

fn ebml_size(size: usize) -> Vec<u8> {
    if size <= 0x7f {
        vec![0x80 | u8::try_from(size).expect("one-byte vint size fits")]
    } else {
        let value = 0x4000 | u16::try_from(size).expect("two-byte vint size fits");
        value.to_be_bytes().to_vec()
    }
}

fn uint_bytes(value: u64) -> Vec<u8> {
    let bytes = value.to_be_bytes();
    let first = bytes
        .iter()
        .position(|byte| *byte != 0)
        .unwrap_or(bytes.len() - 1);
    bytes[first..].to_vec()
}
