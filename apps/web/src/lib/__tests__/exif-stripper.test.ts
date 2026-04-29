/**
 * Tests for the JPEG EXIF stripper.
 *
 * The stripper walks JPEG marker segments and removes APP1 (Exif/XMP) and
 * APP13 (IPTC) segments while preserving the SOI/EOI envelope, all other
 * APP markers (notably APP0 / JFIF), and the entropy-coded scan data after
 * SOS unchanged. Non-JPEG inputs and malformed JPEGs are returned
 * unchanged with a `skippedReason` set; the stripper never throws.
 */

import { describe, it, expect } from 'vitest';
import { stripExifFromBlob } from '../exif-stripper';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Concatenate Uint8Array fragments into a single Uint8Array. */
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Build a JPEG marker segment header (FF + marker code + 2-byte BE length). */
function makeSegment(markerByte: number, payload: Uint8Array): Uint8Array {
  const segmentLength = payload.length + 2; // length field counts itself
  const header = new Uint8Array([
    0xff,
    markerByte,
    (segmentLength >> 8) & 0xff,
    segmentLength & 0xff,
  ]);
  return concatBytes(header, payload);
}

const SOI = new Uint8Array([0xff, 0xd8]);
const EOI = new Uint8Array([0xff, 0xd9]);

/** Minimal SOS segment + 1-byte scan data. SOS payload here is empty (length=2). */
const SOS_AND_SCAN = concatBytes(
  new Uint8Array([0xff, 0xda, 0x00, 0x02]),
  new Uint8Array([0x00]),
);

/** A 14-byte APP1 payload starting with the standard "Exif\0\0" identifier. */
const APP1_EXIF_PAYLOAD = new Uint8Array([
  0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
  0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04,
]);

/** A 5-byte APP0 / JFIF payload (truncated, but enough to round-trip). */
const APP0_JFIF_PAYLOAD = new Uint8Array([0x4a, 0x46, 0x49, 0x46, 0x00]);

const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function blobFromBytes(
  bytes: Uint8Array,
  mimeType: string = 'application/octet-stream',
): Blob {
  // Wrap with a fresh Uint8Array to satisfy strict BlobPart typing under
  // TypeScript's stricter ArrayBufferLike-vs-ArrayBuffer rules.
  return new Blob([new Uint8Array(bytes)], { type: mimeType });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stripExifFromBlob', () => {
  describe('JPEG happy path', () => {
    it('strips APP1 (Exif) while preserving SOI/EOI and SOS scan data', async () => {
      const app1 = makeSegment(0xe1, APP1_EXIF_PAYLOAD);
      const input = concatBytes(SOI, app1, SOS_AND_SCAN, EOI);
      const expected = concatBytes(SOI, SOS_AND_SCAN, EOI);

      const result = await stripExifFromBlob(
        blobFromBytes(input, 'image/jpeg'),
        'image/jpeg',
      );

      expect(result.stripped).toBe(true);
      expect(result.skippedReason).toBeUndefined();
      expect(Array.from(result.bytes)).toEqual(Array.from(expected));
    });

    it('strips multiple APP1 segments', async () => {
      const app1a = makeSegment(0xe1, APP1_EXIF_PAYLOAD);
      const app1b = makeSegment(
        0xe1,
        new Uint8Array([0x68, 0x74, 0x74, 0x70, 0x3a, 0x2f, 0x2f, 0x78]), // "http://x" (XMP-ish)
      );
      const input = concatBytes(SOI, app1a, app1b, SOS_AND_SCAN, EOI);
      const expected = concatBytes(SOI, SOS_AND_SCAN, EOI);

      const result = await stripExifFromBlob(
        blobFromBytes(input, 'image/jpeg'),
        'image/jpeg',
      );

      expect(result.stripped).toBe(true);
      expect(Array.from(result.bytes)).toEqual(Array.from(expected));
    });

    it('strips APP13 (IPTC) segments', async () => {
      const app13 = makeSegment(
        0xed,
        new Uint8Array([0x50, 0x68, 0x6f, 0x74, 0x6f, 0x73, 0x68, 0x6f, 0x70]),
      );
      const input = concatBytes(SOI, app13, SOS_AND_SCAN, EOI);
      const expected = concatBytes(SOI, SOS_AND_SCAN, EOI);

      const result = await stripExifFromBlob(
        blobFromBytes(input, 'image/jpeg'),
        'image/jpeg',
      );

      expect(result.stripped).toBe(true);
      expect(Array.from(result.bytes)).toEqual(Array.from(expected));
    });

    it('preserves APP0 (JFIF) — required by some viewers', async () => {
      const app0 = makeSegment(0xe0, APP0_JFIF_PAYLOAD);
      const app1 = makeSegment(0xe1, APP1_EXIF_PAYLOAD);
      const input = concatBytes(SOI, app0, app1, SOS_AND_SCAN, EOI);
      // APP0 stays, APP1 goes
      const expected = concatBytes(SOI, app0, SOS_AND_SCAN, EOI);

      const result = await stripExifFromBlob(
        blobFromBytes(input, 'image/jpeg'),
        'image/jpeg',
      );

      expect(result.stripped).toBe(true);
      expect(Array.from(result.bytes)).toEqual(Array.from(expected));
    });

    it('returns stripped=false (and identical bytes) when no APP1/APP13 present', async () => {
      const app0 = makeSegment(0xe0, APP0_JFIF_PAYLOAD);
      const input = concatBytes(SOI, app0, SOS_AND_SCAN, EOI);

      const result = await stripExifFromBlob(
        blobFromBytes(input, 'image/jpeg'),
        'image/jpeg',
      );

      expect(result.stripped).toBe(false);
      expect(result.skippedReason).toBeUndefined();
      expect(Array.from(result.bytes)).toEqual(Array.from(input));
    });

    it('preserves the entire entropy-coded scan stream after SOS unchanged', async () => {
      // Embed bytes in scan that look like markers (FF 00 byte stuffing, RST markers).
      const scanWithStuffing = new Uint8Array([
        0x00, 0xff, 0x00, 0xab, 0xcd, 0xff, 0xd0, 0xff, 0x00, 0x12,
      ]);
      const sosWithRichScan = concatBytes(
        new Uint8Array([0xff, 0xda, 0x00, 0x02]),
        scanWithStuffing,
      );
      const app1 = makeSegment(0xe1, APP1_EXIF_PAYLOAD);
      const input = concatBytes(SOI, app1, sosWithRichScan, EOI);
      const expected = concatBytes(SOI, sosWithRichScan, EOI);

      const result = await stripExifFromBlob(
        blobFromBytes(input, 'image/jpeg'),
        'image/jpeg',
      );

      expect(result.stripped).toBe(true);
      expect(Array.from(result.bytes)).toEqual(Array.from(expected));
    });
  });

  describe('non-JPEG passthrough', () => {
    it('returns PNG bytes unchanged with skippedReason=unsupported-mime', async () => {
      const png = concatBytes(
        PNG_SIGNATURE,
        new Uint8Array([0x00, 0x01, 0x02, 0x03]),
      );

      const result = await stripExifFromBlob(
        blobFromBytes(png, 'image/png'),
        'image/png',
      );

      expect(result.stripped).toBe(false);
      expect(result.skippedReason).toBe('unsupported-mime');
      expect(Array.from(result.bytes)).toEqual(Array.from(png));
    });

    it('returns AVIF bytes unchanged with skippedReason=unsupported-mime', async () => {
      const avif = new Uint8Array([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
        0x61, 0x76, 0x69, 0x66,
      ]);

      const result = await stripExifFromBlob(
        blobFromBytes(avif, 'image/avif'),
        'image/avif',
      );

      expect(result.stripped).toBe(false);
      expect(result.skippedReason).toBe('unsupported-mime');
      expect(Array.from(result.bytes)).toEqual(Array.from(avif));
    });
  });

  describe('malformed input is safe', () => {
    it('does not throw on random bytes lacking SOI', async () => {
      const random = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]);

      const result = await stripExifFromBlob(
        blobFromBytes(random, 'image/jpeg'),
        'image/jpeg',
      );

      expect(result.stripped).toBe(false);
      expect(result.skippedReason).toBe('malformed-jpeg');
      expect(Array.from(result.bytes)).toEqual(Array.from(random));
    });

    it('does not throw on too-short input', async () => {
      const tiny = new Uint8Array([0xff]);

      const result = await stripExifFromBlob(
        blobFromBytes(tiny, 'image/jpeg'),
        'image/jpeg',
      );

      expect(result.stripped).toBe(false);
      expect(result.skippedReason).toBe('malformed-jpeg');
      expect(Array.from(result.bytes)).toEqual(Array.from(tiny));
    });

    it('does not throw on truncated APP1 segment', async () => {
      // SOI + start of APP1 with declared length 0x40 but no payload follows
      const truncated = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x40, 0x45]);

      const result = await stripExifFromBlob(
        blobFromBytes(truncated, 'image/jpeg'),
        'image/jpeg',
      );

      expect(result.stripped).toBe(false);
      expect(result.skippedReason).toBe('malformed-jpeg');
      expect(Array.from(result.bytes)).toEqual(Array.from(truncated));
    });

    it('does not throw on bogus segment length < 2', async () => {
      // Length field of 0x0001 is illegal (must be ≥ 2 since it counts itself)
      const bogus = concatBytes(
        SOI,
        new Uint8Array([0xff, 0xe1, 0x00, 0x01, 0x00]),
        SOS_AND_SCAN,
        EOI,
      );

      const result = await stripExifFromBlob(
        blobFromBytes(bogus, 'image/jpeg'),
        'image/jpeg',
      );

      expect(result.stripped).toBe(false);
      expect(result.skippedReason).toBe('malformed-jpeg');
      expect(Array.from(result.bytes)).toEqual(Array.from(bogus));
    });
  });
});
