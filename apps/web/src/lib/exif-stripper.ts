/**
 * JPEG EXIF / metadata stripper.
 *
 * Walks a JPEG byte stream and removes APP1 (Exif / XMP) and APP13 (IPTC /
 * Photoshop) marker segments while preserving:
 *   - the SOI / EOI envelope,
 *   - APP0 (JFIF) and all other APPn segments,
 *   - SOFn / DHT / DQT / DRI segments,
 *   - the entropy-coded scan data after SOS (which is not segment-structured
 *     and may itself contain `FF 00` byte stuffing or restart markers).
 *
 * Format-coverage gap (intentional for this fix):
 *   - HEIC, PNG, WebP, AVIF inputs are passed through unchanged with
 *     `skippedReason = 'unsupported-mime'`. Stripping metadata from those
 *     containers is materially more complex (HEIC is a box-structured ISO-BMFF
 *     container; PNG carries metadata in tEXt/iTXt/zTXt/eXIf chunks; WebP and
 *     AVIF carry it in `EXIF` / `XMP ` chunks inside RIFF / ISO-BMFF boxes)
 *     and is left for a follow-up. JPEG covers the bulk of camera-output
 *     privacy leaks today (DSLRs, point-and-shoots, and most phones with
 *     "JPEG" capture mode).
 *
 * The stripper never throws: malformed JPEG returns the original bytes with
 * `skippedReason = 'malformed-jpeg'`. Callers can safely fall back to the
 * unstripped bytes with no special-case error handling.
 */

export interface StripExifResult {
  /** The (possibly stripped) bytes. Same reference as input if no work done. */
  bytes: Uint8Array;
  /** True if at least one APP1 or APP13 segment was removed. */
  stripped: boolean;
  /** Set when the input was passed through unchanged. */
  skippedReason?: string;
}

const JPEG_MIME_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/pjpeg']);

const SOI_HI = 0xff;
const SOI_LO = 0xd8;
const APP1 = 0xe1; // Exif, XMP
const APP13 = 0xed; // IPTC / Photoshop
const SOS = 0xda;
const EOI = 0xd9;

/**
 * Strip EXIF / IPTC metadata from a JPEG blob.
 *
 * @param blob - Image bytes to inspect.
 * @param mimeType - Caller-asserted MIME type (e.g. `image/jpeg`,
 *   `image/avif`). Used to decide whether to attempt stripping. The function
 *   does not re-sniff the MIME from the bytes.
 * @returns A {@link StripExifResult} describing what happened.
 */
export async function stripExifFromBlob(
  blob: Blob,
  mimeType: string,
): Promise<StripExifResult> {
  const bytes = new Uint8Array(await blob.arrayBuffer());

  if (!JPEG_MIME_TYPES.has(mimeType.toLowerCase())) {
    return { bytes, stripped: false, skippedReason: 'unsupported-mime' };
  }

  return stripJpeg(bytes);
}

/**
 * Walk a JPEG byte stream and emit a copy with APP1 / APP13 segments removed.
 * Returns `{ bytes: input, stripped: false, skippedReason: 'malformed-jpeg' }`
 * for any structural anomaly so callers can fall back safely.
 */
function stripJpeg(input: Uint8Array): StripExifResult {
  const malformed = (): StripExifResult => ({
    bytes: input,
    stripped: false,
    skippedReason: 'malformed-jpeg',
  });

  if (input.length < 4 || input[0] !== SOI_HI || input[1] !== SOI_LO) {
    return malformed();
  }

  // Output cannot exceed the input in size since we only ever drop bytes.
  const out = new Uint8Array(input.length);
  let outPos = 0;

  // Copy SOI verbatim.
  out[outPos++] = SOI_HI;
  out[outPos++] = SOI_LO;

  let pos = 2;
  let stripped = false;

  while (pos < input.length) {
    // Each marker begins with one or more 0xFF bytes; consume any padding.
    if (input[pos] !== 0xff) {
      return malformed();
    }
    const markerStart = pos;
    while (pos < input.length && input[pos] === 0xff) {
      pos++;
    }
    if (pos >= input.length) {
      return malformed();
    }

    const markerByte = input[pos++];
    if (markerByte === undefined) {
      return malformed();
    }

    // Start of Scan: from the first 0xFF of the SOS marker onward, the data
    // is entropy-coded and may legally contain 0xFF 0x00 byte stuffing and
    // RST markers. Dump the rest of the file unchanged and stop parsing.
    if (markerByte === SOS) {
      const rest = input.subarray(markerStart);
      out.set(rest, outPos);
      outPos += rest.length;
      return { bytes: out.slice(0, outPos), stripped };
    }

    // EOI before SOS — unusual but treat it as a clean terminator.
    if (markerByte === EOI) {
      out[outPos++] = 0xff;
      out[outPos++] = EOI;
      return { bytes: out.slice(0, outPos), stripped };
    }

    // All other markers we expect here carry a 2-byte big-endian length
    // (which counts itself, so length must be >= 2).
    if (pos + 1 >= input.length) {
      return malformed();
    }
    const lenHi = input[pos];
    const lenLo = input[pos + 1];
    if (lenHi === undefined || lenLo === undefined) {
      return malformed();
    }
    const segmentLength = (lenHi << 8) | lenLo;
    if (segmentLength < 2 || pos + segmentLength > input.length) {
      return malformed();
    }

    if (markerByte === APP1 || markerByte === APP13) {
      // Drop the segment entirely (its FF + marker byte were already past
      // outPos, so just advance the input cursor).
      pos += segmentLength;
      stripped = true;
      continue;
    }

    // Preserve segment: emit FF + marker + length-bytes + payload verbatim.
    out[outPos++] = 0xff;
    out[outPos++] = markerByte;
    out.set(input.subarray(pos, pos + segmentLength), outPos);
    outPos += segmentLength;
    pos += segmentLength;
  }

  // Walked off the end without seeing SOS or EOI — treat as malformed.
  return malformed();
}
