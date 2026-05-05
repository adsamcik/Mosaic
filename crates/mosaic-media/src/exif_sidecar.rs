use super::{MAX_TIFF_IFD_ENTRIES, MediaFormat};

const MAX_TIFF_IFD_DEPTH: u8 = 4;
const MAX_EXIF_STRING_BYTES: usize = 1024;
const MAX_CANONICAL_CAMERA_BYTES: usize = 64;
const MAX_SUBSECONDS_BYTES: usize = 16;

/// Packed canonical GPS value for sidecar tag 9.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExtractedGpsFields {
    pub lat_microdegrees: i32,
    pub lon_microdegrees: i32,
    pub altitude_meters: i32,
    pub accuracy_meters: u16,
}

impl ExtractedGpsFields {
    /// Encodes tag 9 as `lat:i32, lon:i32, altitude:i32, accuracy:u16`, all little-endian.
    #[must_use]
    pub fn to_tag_value_bytes(self) -> [u8; 14] {
        let mut bytes = [0_u8; 14];
        bytes[..4].copy_from_slice(&self.lat_microdegrees.to_le_bytes());
        bytes[4..8].copy_from_slice(&self.lon_microdegrees.to_le_bytes());
        bytes[8..12].copy_from_slice(&self.altitude_meters.to_le_bytes());
        bytes[12..14].copy_from_slice(&self.accuracy_meters.to_le_bytes());
        bytes
    }
}

/// Canonical sidecar fields extracted from EXIF before metadata stripping.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ExtractedSidecarFields {
    pub device_timestamp_ms: Option<u64>,
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub subseconds_ms: Option<u32>,
    pub gps: Option<ExtractedGpsFields>,
}

/// Hostile-safe EXIF sidecar extraction result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidecarExtractResult {
    pub code: u16,
    pub fields: Option<ExtractedSidecarFields>,
}

/// Extract canonical sidecar fields from EXIF metadata before stripping.
///
/// Returns optional GPS, timestamp, camera make/model, and subseconds fields. This
/// parser treats EXIF as hostile input: malformed tags are skipped, rational
/// denominators of zero are rejected, IFD pointer chasing is depth-limited, and
/// oversized strings are capped before being promoted to sidecar fields.
#[must_use]
pub fn extract_canonical_sidecar_fields(input: &[u8], format: MediaFormat) -> SidecarExtractResult {
    match format {
        MediaFormat::Jpeg => extract_jpeg_canonical_sidecar_fields(input),
        MediaFormat::Png | MediaFormat::WebP => SidecarExtractResult {
            code: 0,
            fields: None,
        },
    }
}

#[derive(Default)]
struct ExifParseState {
    fields: ExtractedSidecarFields,
    date_time: Option<String>,
    date_time_original: Option<String>,
    date_time_digitized: Option<String>,
    offset_time: Option<i16>,
    offset_time_original: Option<i16>,
    offset_time_digitized: Option<i16>,
}

#[derive(Clone, Copy)]
struct TiffReader<'a> {
    bytes: &'a [u8],
    little_endian: bool,
}

#[derive(Clone, Copy)]
struct TiffEntry {
    tag: u16,
    value_type: u16,
    count: u32,
    value_offset_field: usize,
}

fn extract_jpeg_canonical_sidecar_fields(bytes: &[u8]) -> SidecarExtractResult {
    if !bytes.starts_with(&[0xff, 0xd8]) {
        return SidecarExtractResult {
            code: 1,
            fields: None,
        };
    }

    let mut offset = 2;
    while offset < bytes.len() {
        if bytes.get(offset) != Some(&0xff) {
            return SidecarExtractResult {
                code: 1,
                fields: None,
            };
        }
        offset += 1;

        while bytes.get(offset) == Some(&0xff) {
            offset += 1;
        }

        let marker = match bytes.get(offset) {
            Some(value) => *value,
            None => {
                return SidecarExtractResult {
                    code: 1,
                    fields: None,
                };
            }
        };
        offset += 1;

        if marker == 0xda || marker == 0xd9 {
            break;
        }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }

        let length_end = match offset.checked_add(2) {
            Some(value) => value,
            None => {
                return SidecarExtractResult {
                    code: 1,
                    fields: None,
                };
            }
        };
        let length_bytes = match bytes.get(offset..length_end) {
            Some(value) => value,
            None => {
                return SidecarExtractResult {
                    code: 1,
                    fields: None,
                };
            }
        };
        let segment_len = usize::from(u16::from_be_bytes([length_bytes[0], length_bytes[1]]));
        if segment_len < 2 {
            return SidecarExtractResult {
                code: 1,
                fields: None,
            };
        }
        let segment_end = match offset.checked_add(segment_len) {
            Some(value) => value,
            None => {
                return SidecarExtractResult {
                    code: 1,
                    fields: None,
                };
            }
        };
        let payload_start = offset + 2;
        let payload = match bytes.get(payload_start..segment_end) {
            Some(value) => value,
            None => {
                return SidecarExtractResult {
                    code: 1,
                    fields: None,
                };
            }
        };

        if marker == 0xe1 && payload.starts_with(b"Exif\0\0") {
            let fields = parse_tiff_canonical_sidecar_fields(&payload[6..]);
            return SidecarExtractResult { code: 0, fields };
        }

        offset = segment_end;
    }

    SidecarExtractResult {
        code: 0,
        fields: None,
    }
}

fn parse_tiff_canonical_sidecar_fields(tiff: &[u8]) -> Option<ExtractedSidecarFields> {
    let little_endian = match tiff.get(0..2) {
        Some(b"II") => true,
        Some(b"MM") => false,
        _ => return None,
    };
    let reader = TiffReader {
        bytes: tiff,
        little_endian,
    };
    if reader.u16(2) != Some(42) {
        return None;
    }
    let ifd_offset = usize::try_from(reader.u32(4)?).ok()?;
    let mut state = ExifParseState::default();
    parse_tiff_ifd(reader, ifd_offset, 0, &mut state);
    finalize_timestamp(&mut state);
    if state.fields.device_timestamp_ms.is_some()
        || state.fields.camera_make.is_some()
        || state.fields.camera_model.is_some()
        || state.fields.subseconds_ms.is_some()
        || state.fields.gps.is_some()
    {
        Some(state.fields)
    } else {
        None
    }
}

fn parse_tiff_ifd(
    reader: TiffReader<'_>,
    ifd_offset: usize,
    depth: u8,
    state: &mut ExifParseState,
) {
    if depth >= MAX_TIFF_IFD_DEPTH {
        return;
    }
    let entry_count = match reader.u16(ifd_offset) {
        Some(value) if value <= MAX_TIFF_IFD_ENTRIES => value,
        _ => return,
    };
    let entries_start = match ifd_offset.checked_add(2) {
        Some(value) => value,
        None => return,
    };

    for entry_index in 0..entry_count {
        let entry_offset = match entries_start.checked_add(usize::from(entry_index) * 12) {
            Some(value) => value,
            None => return,
        };
        let entry = match reader.entry(entry_offset) {
            Some(value) => value,
            None => return,
        };
        match entry.tag {
            0x010f => assign_string_field(reader, entry, &mut state.fields.camera_make),
            0x0110 => assign_string_field(reader, entry, &mut state.fields.camera_model),
            0x0132 => state.date_time = read_exif_ascii(reader, entry, MAX_EXIF_STRING_BYTES),
            0x8769 => {
                if let Some(offset) = entry_u32_value(reader, entry)
                    && let Ok(offset) = usize::try_from(offset)
                {
                    parse_exif_sub_ifd(reader, offset, depth + 1, state);
                }
            }
            0x8825 => {
                if let Some(offset) = entry_u32_value(reader, entry)
                    && let Ok(offset) = usize::try_from(offset)
                    && let Some(gps) = parse_gps_ifd(reader, offset, depth + 1)
                {
                    state.fields.gps = Some(gps);
                }
            }
            _ => {}
        }
    }

    let next_ifd_field = match entries_start.checked_add(usize::from(entry_count) * 12) {
        Some(value) => value,
        None => return,
    };
    if let Some(next_ifd) = reader
        .u32(next_ifd_field)
        .and_then(|value| usize::try_from(value).ok())
        && next_ifd != 0
    {
        parse_tiff_ifd(reader, next_ifd, depth + 1, state);
    }
}

fn parse_exif_sub_ifd(
    reader: TiffReader<'_>,
    ifd_offset: usize,
    depth: u8,
    state: &mut ExifParseState,
) {
    if depth >= MAX_TIFF_IFD_DEPTH {
        return;
    }
    let entry_count = match reader.u16(ifd_offset) {
        Some(value) if value <= MAX_TIFF_IFD_ENTRIES => value,
        _ => return,
    };
    let entries_start = match ifd_offset.checked_add(2) {
        Some(value) => value,
        None => return,
    };
    for entry_index in 0..entry_count {
        let entry_offset = match entries_start.checked_add(usize::from(entry_index) * 12) {
            Some(value) => value,
            None => return,
        };
        let entry = match reader.entry(entry_offset) {
            Some(value) => value,
            None => return,
        };
        match entry.tag {
            0x9003 => {
                state.date_time_original = read_exif_ascii(reader, entry, MAX_EXIF_STRING_BYTES);
            }
            0x9004 => {
                state.date_time_digitized = read_exif_ascii(reader, entry, MAX_EXIF_STRING_BYTES);
            }
            0x9010 => state.offset_time = read_exif_offset_minutes(reader, entry),
            0x9011 => state.offset_time_original = read_exif_offset_minutes(reader, entry),
            0x9012 => state.offset_time_digitized = read_exif_offset_minutes(reader, entry),
            0x9290 | 0x9291 => {
                if state.fields.subseconds_ms.is_none() {
                    state.fields.subseconds_ms = read_exif_subseconds(reader, entry);
                }
            }
            _ => {}
        }
    }
}

fn parse_gps_ifd(
    reader: TiffReader<'_>,
    ifd_offset: usize,
    depth: u8,
) -> Option<ExtractedGpsFields> {
    if depth >= MAX_TIFF_IFD_DEPTH {
        return None;
    }
    let entry_count = match reader.u16(ifd_offset) {
        Some(value) if value <= MAX_TIFF_IFD_ENTRIES => value,
        _ => return None,
    };
    let entries_start = ifd_offset.checked_add(2)?;
    let mut lat_ref = None;
    let mut lon_ref = None;
    let mut lat = None;
    let mut lon = None;
    let mut altitude_ref = 0_u8;
    let mut altitude = None;
    let mut accuracy = 0_u16;

    for entry_index in 0..entry_count {
        let entry_offset = entries_start.checked_add(usize::from(entry_index) * 12)?;
        let entry = reader.entry(entry_offset)?;
        match entry.tag {
            0x0001 => {
                lat_ref = read_exif_ascii(reader, entry, 2).and_then(|value| value.bytes().next());
            }
            0x0002 => lat = read_gps_degrees(reader, entry),
            0x0003 => {
                lon_ref = read_exif_ascii(reader, entry, 2).and_then(|value| value.bytes().next());
            }
            0x0004 => lon = read_gps_degrees(reader, entry),
            0x0005 => altitude_ref = read_gps_altitude_ref(reader, entry).unwrap_or(0),
            0x0006 => altitude = read_gps_rational(reader, entry),
            0x001f => {
                if let Some(value) = read_gps_rational(reader, entry) {
                    accuracy = value.round().clamp(0.0, f64::from(u16::MAX)) as u16;
                }
            }
            _ => {}
        }
    }

    let mut lat = lat?;
    let mut lon = lon?;
    match lat_ref {
        Some(b'N') => {}
        Some(b'S') => lat = -lat,
        _ => return None,
    }
    match lon_ref {
        Some(b'E') => {}
        Some(b'W') => lon = -lon,
        _ => return None,
    }
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
        return None;
    }
    let altitude_meters = altitude
        .unwrap_or(0.0)
        .round()
        .clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32;
    let altitude_meters = if altitude_ref == 1 {
        altitude_meters.saturating_neg()
    } else {
        altitude_meters
    };

    Some(ExtractedGpsFields {
        lat_microdegrees: (lat * 1_000_000.0).round() as i32,
        lon_microdegrees: (lon * 1_000_000.0).round() as i32,
        altitude_meters,
        accuracy_meters: accuracy,
    })
}

impl<'a> TiffReader<'a> {
    fn u16(self, offset: usize) -> Option<u16> {
        let data = self.bytes.get(offset..offset.checked_add(2)?)?;
        let raw = [data[0], data[1]];
        Some(if self.little_endian {
            u16::from_le_bytes(raw)
        } else {
            u16::from_be_bytes(raw)
        })
    }

    fn u32(self, offset: usize) -> Option<u32> {
        let data = self.bytes.get(offset..offset.checked_add(4)?)?;
        let raw = [data[0], data[1], data[2], data[3]];
        Some(if self.little_endian {
            u32::from_le_bytes(raw)
        } else {
            u32::from_be_bytes(raw)
        })
    }

    fn entry(self, offset: usize) -> Option<TiffEntry> {
        self.bytes.get(offset..offset.checked_add(12)?)?;
        Some(TiffEntry {
            tag: self.u16(offset)?,
            value_type: self.u16(offset + 2)?,
            count: self.u32(offset + 4)?,
            value_offset_field: offset + 8,
        })
    }

    fn value_bytes(self, entry: TiffEntry) -> Option<&'a [u8]> {
        let type_size = tiff_type_size(entry.value_type)?;
        let count = usize::try_from(entry.count).ok()?;
        let total_size = type_size.checked_mul(count)?;
        if total_size > MAX_EXIF_STRING_BYTES && !matches!(entry.value_type, 5 | 10) {
            return None;
        }
        if total_size <= 4 {
            return self
                .bytes
                .get(entry.value_offset_field..entry.value_offset_field.checked_add(total_size)?);
        }
        let value_offset = usize::try_from(self.u32(entry.value_offset_field)?).ok()?;
        self.bytes
            .get(value_offset..value_offset.checked_add(total_size)?)
    }
}

fn tiff_type_size(value_type: u16) -> Option<usize> {
    match value_type {
        1 | 2 | 7 => Some(1),
        3 => Some(2),
        4 | 9 => Some(4),
        5 | 10 => Some(8),
        _ => None,
    }
}

fn entry_u32_value(reader: TiffReader<'_>, entry: TiffEntry) -> Option<u32> {
    match (entry.value_type, entry.count) {
        (4, 1) => reader.u32(entry.value_offset_field),
        (3, 1) => reader.u16(entry.value_offset_field).map(u32::from),
        _ => None,
    }
}

fn assign_string_field(reader: TiffReader<'_>, entry: TiffEntry, target: &mut Option<String>) {
    if let Some(value) = read_exif_ascii(reader, entry, MAX_CANONICAL_CAMERA_BYTES) {
        *target = Some(value);
    }
}

fn read_exif_ascii(reader: TiffReader<'_>, entry: TiffEntry, max_len: usize) -> Option<String> {
    if entry.value_type != 2 || entry.count == 0 {
        return None;
    }
    let bytes = reader.value_bytes(entry)?;
    let nul = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    let trimmed = trim_ascii_spaces(&bytes[..nul]);
    if trimmed.is_empty() {
        return None;
    }
    let capped = if trimmed.len() > max_len {
        &trimmed[..max_len]
    } else {
        trimmed
    };
    std::str::from_utf8(capped).ok().map(str::to_owned)
}

fn trim_ascii_spaces(bytes: &[u8]) -> &[u8] {
    let mut start = 0;
    let mut end = bytes.len();
    while start < end && bytes[start].is_ascii_whitespace() {
        start += 1;
    }
    while end > start && bytes[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    &bytes[start..end]
}

fn read_exif_offset_minutes(reader: TiffReader<'_>, entry: TiffEntry) -> Option<i16> {
    let value = read_exif_ascii(reader, entry, 6)?;
    let bytes = value.as_bytes();
    if bytes.len() != 6 || bytes[3] != b':' {
        return None;
    }
    let sign = match bytes[0] {
        b'+' => 1_i16,
        b'-' => -1_i16,
        _ => return None,
    };
    let hours = parse_two_digits(&bytes[1..3])?;
    let minutes = parse_two_digits(&bytes[4..6])?;
    if hours > 23 || minutes > 59 {
        return None;
    }
    Some(sign * (i16::from(hours) * 60 + i16::from(minutes)))
}

fn read_exif_subseconds(reader: TiffReader<'_>, entry: TiffEntry) -> Option<u32> {
    let value = read_exif_ascii(reader, entry, MAX_SUBSECONDS_BYTES)?;
    let mut digits = value.bytes().filter(u8::is_ascii_digit);
    let first = u32::from(digits.next()?.saturating_sub(b'0'));
    let second = u32::from(digits.next().unwrap_or(b'0').saturating_sub(b'0'));
    let third = u32::from(digits.next().unwrap_or(b'0').saturating_sub(b'0'));
    Some(first * 100 + second * 10 + third)
}

fn read_gps_altitude_ref(reader: TiffReader<'_>, entry: TiffEntry) -> Option<u8> {
    if entry.value_type != 1 || entry.count != 1 {
        return None;
    }
    reader
        .value_bytes(entry)
        .and_then(|bytes| bytes.first().copied())
}

fn read_gps_degrees(reader: TiffReader<'_>, entry: TiffEntry) -> Option<f64> {
    if entry.value_type != 5 || entry.count != 3 {
        return None;
    }
    let bytes = reader.value_bytes(entry)?;
    let degrees = rational_at(reader, bytes, 0)?;
    let minutes = rational_at(reader, bytes, 8)?;
    let seconds = rational_at(reader, bytes, 16)?;
    Some(degrees + minutes / 60.0 + seconds / 3600.0)
}

fn read_gps_rational(reader: TiffReader<'_>, entry: TiffEntry) -> Option<f64> {
    if entry.value_type != 5 || entry.count != 1 {
        return None;
    }
    rational_at(reader, reader.value_bytes(entry)?, 0)
}

fn rational_at(reader: TiffReader<'_>, bytes: &[u8], offset: usize) -> Option<f64> {
    let numerator = read_u32_from(bytes, offset, reader.little_endian)?;
    let denominator = read_u32_from(bytes, offset.checked_add(4)?, reader.little_endian)?;
    if denominator == 0 {
        return None;
    }
    Some(f64::from(numerator) / f64::from(denominator))
}

fn read_u32_from(bytes: &[u8], offset: usize, little_endian: bool) -> Option<u32> {
    let data = bytes.get(offset..offset.checked_add(4)?)?;
    let raw = [data[0], data[1], data[2], data[3]];
    Some(if little_endian {
        u32::from_le_bytes(raw)
    } else {
        u32::from_be_bytes(raw)
    })
}

fn finalize_timestamp(state: &mut ExifParseState) {
    let selected = state
        .date_time_original
        .as_deref()
        .zip(Some(state.offset_time_original))
        .or_else(|| {
            state
                .date_time_digitized
                .as_deref()
                .zip(Some(state.offset_time_digitized))
        })
        .or_else(|| state.date_time.as_deref().zip(Some(state.offset_time)));
    let Some((value, offset)) = selected else {
        return;
    };
    let subsecond_ms = state.fields.subseconds_ms.unwrap_or(0);
    state.fields.device_timestamp_ms = parse_exif_timestamp_ms(value, offset, subsecond_ms);
}

fn parse_exif_timestamp_ms(
    value: &str,
    offset_minutes: Option<i16>,
    subsecond_ms: u32,
) -> Option<u64> {
    let bytes = value.as_bytes();
    if bytes.len() < 19
        || bytes[4] != b':'
        || bytes[7] != b':'
        || bytes[10] != b' '
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let year = i32::from(parse_four_digits(&bytes[0..4])?);
    let month = u32::from(parse_two_digits(&bytes[5..7])?);
    let day = u32::from(parse_two_digits(&bytes[8..10])?);
    let hour = u32::from(parse_two_digits(&bytes[11..13])?);
    let minute = u32::from(parse_two_digits(&bytes[14..16])?);
    let second = u32::from(parse_two_digits(&bytes[17..19])?);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
        || subsecond_ms > 999
    {
        return None;
    }
    let days = days_from_civil(year, month, day)?;
    let seconds = days
        .checked_mul(86_400)?
        .checked_add(i64::from(hour) * 3_600 + i64::from(minute) * 60 + i64::from(second))?
        .checked_sub(i64::from(offset_minutes.unwrap_or(0)) * 60)?;
    let millis = seconds
        .checked_mul(1_000)?
        .checked_add(i64::from(subsecond_ms))?;
    u64::try_from(millis).ok()
}

fn parse_two_digits(bytes: &[u8]) -> Option<u8> {
    if bytes.len() != 2 || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some((bytes[0] - b'0') * 10 + (bytes[1] - b'0'))
}

fn parse_four_digits(bytes: &[u8]) -> Option<u16> {
    if bytes.len() != 4 || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some(
        u16::from(bytes[0] - b'0') * 1000
            + u16::from(bytes[1] - b'0') * 100
            + u16::from(bytes[2] - b'0') * 10
            + u16::from(bytes[3] - b'0'),
    )
}

fn days_from_civil(year: i32, month: u32, day: u32) -> Option<i64> {
    if day > days_in_month(year, month)? {
        return None;
    }
    let mut y = i64::from(year);
    let m = i64::from(month);
    let d = i64::from(day);
    if m <= 2 {
        y -= 1;
    }
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = m + if m > 2 { -3 } else { 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

fn days_in_month(year: i32, month: u32) -> Option<u32> {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => Some(31),
        4 | 6 | 9 | 11 => Some(30),
        2 if is_leap_year(year) => Some(29),
        2 => Some(28),
        _ => None,
    }
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}
