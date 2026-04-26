//! Gated media processing boundary crate for Mosaic.

#![forbid(unsafe_code)]

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

/// Supported image container formats for dependency-free media boundary checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaFormat {
    Jpeg,
    Png,
    WebP,
}

/// Recognized metadata categories stripped from gallery tier bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetadataKind {
    Exif,
    Xmp,
    Iptc,
    Comment,
    Text,
    Timestamp,
    ColorProfile,
    PhysicalDimensions,
    SuggestedPalette,
    RenderingHint,
}

/// Media processing errors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MosaicMediaError {
    InvalidJpeg,
    InvalidPng,
    InvalidWebP,
    OutputTooLarge,
}

/// Result of stripping recognized metadata from an image container.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StrippedMedia {
    /// Media bytes with recognized metadata carriers removed.
    pub bytes: Vec<u8>,
    /// Metadata categories removed, in encounter order.
    pub removed: Vec<MetadataKind>,
}

/// Removes recognized metadata carriers from supported image containers.
///
/// This does not decode or transform pixels. It is the dependency-free first
/// gate for normalized gallery tiers before encryption: server-bound media bytes
/// must not carry EXIF/GPS, XMP, IPTC, comments, textual chunks, timestamps,
/// physical-resolution hints, suggested palettes, rendering hints, or embedded
/// color profiles unless explicitly re-embedded during a controlled export flow.
///
/// # Errors
/// Returns a format-specific error when container boundaries are malformed.
pub fn strip_known_metadata(
    format: MediaFormat,
    bytes: &[u8],
) -> Result<StrippedMedia, MosaicMediaError> {
    match format {
        MediaFormat::Jpeg => strip_jpeg_metadata(bytes),
        MediaFormat::Png => strip_png_metadata(bytes),
        MediaFormat::WebP => strip_webp_metadata(bytes),
    }
}

/// Returns the crate name for smoke tests and media prototype diagnostics.
#[must_use]
pub const fn crate_name() -> &'static str {
    "mosaic-media"
}

/// Returns the domain protocol version this media crate is compiled against.
#[must_use]
pub const fn protocol_version() -> &'static str {
    mosaic_domain::PROTOCOL_VERSION
}

fn strip_jpeg_metadata(bytes: &[u8]) -> Result<StrippedMedia, MosaicMediaError> {
    if !bytes.starts_with(&[0xff, 0xd8]) {
        return Err(MosaicMediaError::InvalidJpeg);
    }

    let mut output = Vec::with_capacity(bytes.len());
    let mut removed = Vec::new();
    output.extend_from_slice(&bytes[..2]);

    let mut offset = 2;
    while offset < bytes.len() {
        let marker_start = offset;
        if bytes.get(offset) != Some(&0xff) {
            return Err(MosaicMediaError::InvalidJpeg);
        }
        offset += 1;

        while bytes.get(offset) == Some(&0xff) {
            offset += 1;
        }

        let marker = match bytes.get(offset) {
            Some(value) => *value,
            None => return Err(MosaicMediaError::InvalidJpeg),
        };
        offset += 1;

        if marker == 0xda {
            output.extend_from_slice(&bytes[marker_start..]);
            return Ok(StrippedMedia {
                bytes: output,
                removed,
            });
        }

        if marker == 0xd9 || marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            output.extend_from_slice(&bytes[marker_start..offset]);
            continue;
        }

        let length_end = match offset.checked_add(2) {
            Some(value) => value,
            None => return Err(MosaicMediaError::InvalidJpeg),
        };
        let length_bytes = match bytes.get(offset..length_end) {
            Some(value) => value,
            None => return Err(MosaicMediaError::InvalidJpeg),
        };
        let segment_len = usize::from(u16::from_be_bytes([length_bytes[0], length_bytes[1]]));
        if segment_len < 2 {
            return Err(MosaicMediaError::InvalidJpeg);
        }

        let segment_end = match offset.checked_add(segment_len) {
            Some(value) => value,
            None => return Err(MosaicMediaError::InvalidJpeg),
        };
        let payload_start = offset + 2;
        let payload = match bytes.get(payload_start..segment_end) {
            Some(value) => value,
            None => return Err(MosaicMediaError::InvalidJpeg),
        };

        if let Some(kind) = classify_jpeg_metadata(marker, payload) {
            removed.push(kind);
        } else {
            output.extend_from_slice(&bytes[marker_start..segment_end]);
        }
        offset = segment_end;
    }

    Ok(StrippedMedia {
        bytes: output,
        removed,
    })
}

fn classify_jpeg_metadata(marker: u8, payload: &[u8]) -> Option<MetadataKind> {
    match marker {
        0xe1 if payload.starts_with(b"Exif\0\0") => Some(MetadataKind::Exif),
        0xe1 if payload.starts_with(b"http://ns.adobe.com/xap/1.0/") => Some(MetadataKind::Xmp),
        0xe1 if payload.starts_with(b"http://ns.adobe.com/xmp/extension/\0") => {
            Some(MetadataKind::Xmp)
        }
        0xe2 if payload.starts_with(b"ICC_PROFILE\0") => Some(MetadataKind::ColorProfile),
        0xed => Some(MetadataKind::Iptc),
        0xfe => Some(MetadataKind::Comment),
        _ => None,
    }
}

fn strip_png_metadata(bytes: &[u8]) -> Result<StrippedMedia, MosaicMediaError> {
    if !bytes.starts_with(PNG_SIGNATURE) {
        return Err(MosaicMediaError::InvalidPng);
    }

    let mut output = Vec::with_capacity(bytes.len());
    let mut removed = Vec::new();
    output.extend_from_slice(PNG_SIGNATURE);

    let mut offset = PNG_SIGNATURE.len();
    while offset < bytes.len() {
        let chunk_start = offset;
        let length_end = match offset.checked_add(4) {
            Some(value) => value,
            None => return Err(MosaicMediaError::InvalidPng),
        };
        let length_bytes = match bytes.get(offset..length_end) {
            Some(value) => value,
            None => return Err(MosaicMediaError::InvalidPng),
        };
        let payload_len_u32 = u32::from_be_bytes([
            length_bytes[0],
            length_bytes[1],
            length_bytes[2],
            length_bytes[3],
        ]);
        let payload_len = match usize::try_from(payload_len_u32) {
            Ok(value) => value,
            Err(_) => return Err(MosaicMediaError::InvalidPng),
        };
        offset = length_end;

        let chunk_type_end = match offset.checked_add(4) {
            Some(value) => value,
            None => return Err(MosaicMediaError::InvalidPng),
        };
        let chunk_type = match bytes.get(offset..chunk_type_end) {
            Some(value) => value,
            None => return Err(MosaicMediaError::InvalidPng),
        };
        offset = chunk_type_end;

        let payload_end = match offset.checked_add(payload_len) {
            Some(value) => value,
            None => return Err(MosaicMediaError::InvalidPng),
        };
        let crc_end = match payload_end.checked_add(4) {
            Some(value) => value,
            None => return Err(MosaicMediaError::InvalidPng),
        };
        if bytes.get(offset..payload_end).is_none() || bytes.get(payload_end..crc_end).is_none() {
            return Err(MosaicMediaError::InvalidPng);
        }

        if let Some(kind) = classify_png_metadata(chunk_type) {
            removed.push(kind);
        } else {
            output.extend_from_slice(&bytes[chunk_start..crc_end]);
        }
        offset = crc_end;
    }

    Ok(StrippedMedia {
        bytes: output,
        removed,
    })
}

fn classify_png_metadata(chunk_type: &[u8]) -> Option<MetadataKind> {
    match chunk_type {
        b"eXIf" => Some(MetadataKind::Exif),
        b"iTXt" | b"tEXt" | b"zTXt" => Some(MetadataKind::Text),
        b"tIME" => Some(MetadataKind::Timestamp),
        b"iCCP" | b"sRGB" | b"cHRM" | b"gAMA" => Some(MetadataKind::ColorProfile),
        b"pHYs" => Some(MetadataKind::PhysicalDimensions),
        b"sPLT" => Some(MetadataKind::SuggestedPalette),
        b"bKGD" | b"hIST" => Some(MetadataKind::RenderingHint),
        _ => None,
    }
}

fn strip_webp_metadata(bytes: &[u8]) -> Result<StrippedMedia, MosaicMediaError> {
    if bytes.len() < 12 || !bytes.starts_with(b"RIFF") || bytes.get(8..12) != Some(b"WEBP") {
        return Err(MosaicMediaError::InvalidWebP);
    }

    let mut output = b"RIFF\0\0\0\0WEBP".to_vec();
    let mut removed = Vec::new();
    let mut offset = 12;

    while offset < bytes.len() {
        let chunk_start = offset;
        let kind_end = match offset.checked_add(4) {
            Some(value) => value,
            None => return Err(MosaicMediaError::InvalidWebP),
        };
        let chunk_type = match bytes.get(offset..kind_end) {
            Some(value) => value,
            None => return Err(MosaicMediaError::InvalidWebP),
        };
        offset = kind_end;

        let size_end = match offset.checked_add(4) {
            Some(value) => value,
            None => return Err(MosaicMediaError::InvalidWebP),
        };
        let size_bytes = match bytes.get(offset..size_end) {
            Some(value) => value,
            None => return Err(MosaicMediaError::InvalidWebP),
        };
        let payload_len_u32 =
            u32::from_le_bytes([size_bytes[0], size_bytes[1], size_bytes[2], size_bytes[3]]);
        let payload_len = match usize::try_from(payload_len_u32) {
            Ok(value) => value,
            Err(_) => return Err(MosaicMediaError::InvalidWebP),
        };
        offset = size_end;

        let payload_end = match offset.checked_add(payload_len) {
            Some(value) => value,
            None => return Err(MosaicMediaError::InvalidWebP),
        };
        let padded_end = match payload_end.checked_add(payload_len % 2) {
            Some(value) => value,
            None => return Err(MosaicMediaError::InvalidWebP),
        };
        if bytes.get(offset..payload_end).is_none() || bytes.get(payload_end..padded_end).is_none()
        {
            return Err(MosaicMediaError::InvalidWebP);
        }

        if let Some(kind) = classify_webp_metadata(chunk_type) {
            removed.push(kind);
        } else {
            output.extend_from_slice(&bytes[chunk_start..padded_end]);
        }
        offset = padded_end;
    }

    let riff_size = match u32::try_from(output.len() - 8) {
        Ok(value) => value,
        Err(_) => return Err(MosaicMediaError::OutputTooLarge),
    };
    output[4..8].copy_from_slice(&riff_size.to_le_bytes());

    Ok(StrippedMedia {
        bytes: output,
        removed,
    })
}

fn classify_webp_metadata(chunk_type: &[u8]) -> Option<MetadataKind> {
    match chunk_type {
        b"EXIF" => Some(MetadataKind::Exif),
        b"XMP " => Some(MetadataKind::Xmp),
        b"ICCP" => Some(MetadataKind::ColorProfile),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{MediaFormat, MetadataKind, strip_known_metadata};

    #[test]
    fn uses_domain_protocol_version() {
        assert_eq!(super::protocol_version(), "mosaic-v1");
    }

    #[test]
    fn strips_jpeg_exif_xmp_iptc_and_comment_segments_before_scan() {
        let input = jpeg_with_segments(&[
            jpeg_segment(0xe1, b"Exif\0\0gps coordinates"),
            jpeg_segment(0xe1, b"http://ns.adobe.com/xap/1.0/\0xmp payload"),
            jpeg_segment(
                0xe1,
                b"http://ns.adobe.com/xmp/extension/\0extended xmp payload",
            ),
            jpeg_segment(0xed, b"Photoshop 3.0\0iptc caption"),
            jpeg_segment(0xfe, b"plain comment"),
            jpeg_segment(0xdb, &[0_u8; 65]),
        ]);

        let stripped = match strip_known_metadata(MediaFormat::Jpeg, &input) {
            Ok(value) => value,
            Err(error) => panic!("JPEG metadata should strip: {error:?}"),
        };

        assert_eq!(
            stripped.removed,
            vec![
                MetadataKind::Exif,
                MetadataKind::Xmp,
                MetadataKind::Xmp,
                MetadataKind::Iptc,
                MetadataKind::Comment,
            ]
        );
        assert!(!contains_ascii(&stripped.bytes, b"Exif"));
        assert!(!contains_ascii(&stripped.bytes, b"xmp payload"));
        assert!(!contains_ascii(&stripped.bytes, b"extended xmp payload"));
        assert!(!contains_ascii(&stripped.bytes, b"iptc caption"));
        assert!(!contains_ascii(&stripped.bytes, b"plain comment"));
        assert!(contains_ascii(&stripped.bytes, b"scan bytes"));
    }

    #[test]
    fn strips_png_text_exif_time_and_color_profile_chunks() {
        let input = png_with_chunks(&[
            png_chunk(*b"IHDR", b"\0\0\0\x01\0\0\0\x01\x08\x02\0\0\0"),
            png_chunk(*b"eXIf", b"gps coordinates"),
            png_chunk(*b"iTXt", b"caption\0\0\0\0\0Hello"),
            png_chunk(*b"tIME", &[1, 2, 3, 4, 5, 6, 7]),
            png_chunk(*b"iCCP", b"profile\0\0payload"),
            png_chunk(*b"pHYs", &[0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1]),
            png_chunk(*b"sPLT", b"editing palette\0\x08"),
            png_chunk(*b"bKGD", &[0, 1, 0, 2, 0, 3]),
            png_chunk(*b"hIST", &[0, 1, 0, 2]),
            png_chunk(*b"tRNS", b"rendering transparency"),
            png_chunk(*b"IDAT", b"pixel bytes"),
            png_chunk(*b"IEND", b""),
        ]);

        let stripped = match strip_known_metadata(MediaFormat::Png, &input) {
            Ok(value) => value,
            Err(error) => panic!("PNG metadata should strip: {error:?}"),
        };

        assert_eq!(
            stripped.removed,
            vec![
                MetadataKind::Exif,
                MetadataKind::Text,
                MetadataKind::Timestamp,
                MetadataKind::ColorProfile,
                MetadataKind::PhysicalDimensions,
                MetadataKind::SuggestedPalette,
                MetadataKind::RenderingHint,
                MetadataKind::RenderingHint,
            ]
        );
        assert!(!contains_ascii(&stripped.bytes, b"eXIf"));
        assert!(!contains_ascii(&stripped.bytes, b"caption"));
        assert!(!contains_ascii(&stripped.bytes, b"iCCP"));
        assert!(!contains_ascii(&stripped.bytes, b"pHYs"));
        assert!(!contains_ascii(&stripped.bytes, b"editing palette"));
        assert!(!contains_ascii(&stripped.bytes, b"bKGD"));
        assert!(!contains_ascii(&stripped.bytes, b"hIST"));
        assert!(contains_ascii(&stripped.bytes, b"tRNS"));
        assert!(contains_ascii(&stripped.bytes, b"rendering transparency"));
        assert!(contains_ascii(&stripped.bytes, b"IDAT"));
        assert!(contains_ascii(&stripped.bytes, b"pixel bytes"));
    }

    #[test]
    fn strips_webp_exif_xmp_and_color_profile_chunks_and_updates_riff_size() {
        let input = webp_with_chunks(&[
            webp_chunk(*b"VP8 ", b"image bytes"),
            webp_chunk(*b"EXIF", b"gps coordinates"),
            webp_chunk(*b"XMP ", b"xmp caption"),
            webp_chunk(*b"ICCP", b"profile"),
        ]);

        let stripped = match strip_known_metadata(MediaFormat::WebP, &input) {
            Ok(value) => value,
            Err(error) => panic!("WebP metadata should strip: {error:?}"),
        };

        assert_eq!(
            stripped.removed,
            vec![
                MetadataKind::Exif,
                MetadataKind::Xmp,
                MetadataKind::ColorProfile,
            ]
        );
        assert!(!contains_ascii(&stripped.bytes, b"EXIF"));
        assert!(!contains_ascii(&stripped.bytes, b"xmp caption"));
        assert!(!contains_ascii(&stripped.bytes, b"ICCP"));
        assert!(contains_ascii(&stripped.bytes, b"VP8 "));
        assert!(contains_ascii(&stripped.bytes, b"image bytes"));

        let declared_size = u32::from_le_bytes([
            stripped.bytes[4],
            stripped.bytes[5],
            stripped.bytes[6],
            stripped.bytes[7],
        ]);
        assert_eq!(usize::try_from(declared_size), Ok(stripped.bytes.len() - 8));
    }

    fn jpeg_segment(marker: u8, payload: &[u8]) -> Vec<u8> {
        let length = match u16::try_from(payload.len() + 2) {
            Ok(value) => value,
            Err(error) => panic!("test JPEG segment length should fit: {error:?}"),
        };
        let mut bytes = vec![0xff, marker];
        bytes.extend_from_slice(&length.to_be_bytes());
        bytes.extend_from_slice(payload);
        bytes
    }

    fn jpeg_with_segments(segments: &[Vec<u8>]) -> Vec<u8> {
        let mut bytes = vec![0xff, 0xd8];
        for segment in segments {
            bytes.extend_from_slice(segment);
        }
        bytes.extend_from_slice(&[0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6]);
        bytes.extend_from_slice(b"scan bytes");
        bytes.extend_from_slice(&[0xff, 0xd9]);
        bytes
    }

    fn png_chunk(kind: [u8; 4], payload: &[u8]) -> Vec<u8> {
        let length = match u32::try_from(payload.len()) {
            Ok(value) => value,
            Err(error) => panic!("test PNG chunk length should fit: {error:?}"),
        };
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&length.to_be_bytes());
        bytes.extend_from_slice(&kind);
        bytes.extend_from_slice(payload);
        bytes.extend_from_slice(&[0, 0, 0, 0]);
        bytes
    }

    fn png_with_chunks(chunks: &[Vec<u8>]) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        for chunk in chunks {
            bytes.extend_from_slice(chunk);
        }
        bytes
    }

    fn webp_chunk(kind: [u8; 4], payload: &[u8]) -> Vec<u8> {
        let length = match u32::try_from(payload.len()) {
            Ok(value) => value,
            Err(error) => panic!("test WebP chunk length should fit: {error:?}"),
        };
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&kind);
        bytes.extend_from_slice(&length.to_le_bytes());
        bytes.extend_from_slice(payload);
        if payload.len() % 2 == 1 {
            bytes.push(0);
        }
        bytes
    }

    fn webp_with_chunks(chunks: &[Vec<u8>]) -> Vec<u8> {
        let payload_len = chunks.iter().map(Vec::len).sum::<usize>() + 4;
        let riff_size = match u32::try_from(payload_len) {
            Ok(value) => value,
            Err(error) => panic!("test WebP RIFF size should fit: {error:?}"),
        };
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&riff_size.to_le_bytes());
        bytes.extend_from_slice(b"WEBP");
        for chunk in chunks {
            bytes.extend_from_slice(chunk);
        }
        bytes
    }

    fn contains_ascii(haystack: &[u8], needle: &[u8]) -> bool {
        haystack
            .windows(needle.len())
            .any(|candidate| candidate == needle)
    }
}
