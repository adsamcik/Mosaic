import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { StripResult } from '../src/generated/mosaic-wasm/mosaic_wasm.js';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const WASM_BYTES_PATH = resolve(REPO_ROOT, 'apps', 'web', 'src', 'generated', 'mosaic-wasm', 'mosaic_wasm_bg.wasm');
const NAL_PREFIX = new Uint8Array([0x00, 0x00, 0x00, 0x01]);

interface ParsedBox {
  readonly boxType: string;
  readonly payloadStart: number;
  readonly end: number;
}

interface IlocEntry {
  readonly constructionMethod: number;
  readonly extents: readonly ItemExtent[];
}

interface ItemExtent {
  readonly offset: number;
  readonly length: number;
}

let stripAvifMetadata: (bytes: Uint8Array) => StripResult;
let stripHeicMetadata: (bytes: Uint8Array) => StripResult;
let stripVideoMetadata: (bytes: Uint8Array) => StripResult;

beforeAll(async () => {
  vi.unmock('../src/generated/mosaic-wasm/mosaic_wasm.js');
  const wasm = await import('../src/generated/mosaic-wasm/mosaic_wasm.js');
  stripAvifMetadata = wasm.stripAvifMetadata;
  stripHeicMetadata = wasm.stripHeicMetadata;
  stripVideoMetadata = wasm.stripVideoMetadata;
  await wasm.default({ module_or_path: new Uint8Array(readFileSync(WASM_BYTES_PATH)) });
});

describe('AVIF/HEIC/video metadata stripping through Web WASM', () => {
  it('strips AVIF metadata while keeping image item extents inside mdat', () => {
    expectIsoImageStrip(stripAvifMetadata(realWorldLikeIso('avif', 'av01', av1Payload())));
  });

  it('strips HEIC metadata while keeping image item extents inside mdat', () => {
    expectIsoImageStrip(stripHeicMetadata(realWorldLikeIso('heic', 'hvc1', hevcPayload())));
  });

  it('strips MP4 metadata while keeping 32-bit chunk offsets inside mdat', () => {
    const result = stripVideoMetadata(syntheticIsoVideo('mp42', 'stco'));
    try {
      expect(result.code).toBe(0);
      expect(result.removedMetadataCount).toBeGreaterThan(0);
      const stripped = result.strippedBytes;
      expect(hasAscii(stripped, 'ftyp')).toBe(true);
      expect(hasAscii(stripped, 'mdat')).toBe(true);
      expect(hasAscii(stripped, 'Exif')).toBe(false);
      expect(hasAscii(stripped, 'XMP')).toBe(false);
      expect(hasAscii(stripped, 'ICC')).toBe(false);
      expect(hasAscii(stripped, 'camera-metadata')).toBe(false);

      const mdat = findTopLevelBox(stripped, 'mdat');
      const offsets = findChunkOffsets(stripped, 'stco');
      expect(offsets.length).toBeGreaterThan(0);
      for (const offset of offsets) {
        expect(offset).toBeGreaterThanOrEqual(mdat.payloadStart);
        expect(offset).toBeLessThan(mdat.end);
        expect(Array.from(stripped.slice(offset, offset + NAL_PREFIX.byteLength))).toEqual(Array.from(NAL_PREFIX));
      }
    } finally {
      result.free();
    }
  });

  it('strips MP4 metadata while keeping 64-bit chunk offsets inside mdat', () => {
    const result = stripVideoMetadata(syntheticIsoVideo('mp42', 'co64'));
    try {
      expect(result.code).toBe(0);
      expect(result.removedMetadataCount).toBeGreaterThan(0);
      const stripped = result.strippedBytes;
      const mdat = findTopLevelBox(stripped, 'mdat');
      const offsets = findChunkOffsets(stripped, 'co64');
      expect(offsets.length).toBeGreaterThan(0);
      for (const offset of offsets) {
        expect(offset).toBeGreaterThanOrEqual(mdat.payloadStart);
        expect(offset).toBeLessThan(mdat.end);
        expect(Array.from(stripped.slice(offset, offset + NAL_PREFIX.byteLength))).toEqual(Array.from(NAL_PREFIX));
      }
    } finally {
      result.free();
    }
  });
});

function expectIsoImageStrip(result: StripResult): void {
  try {
    expect(result.code).toBe(0);
    expect(result.removedMetadataCount).toBeGreaterThan(0);
    const stripped = result.strippedBytes;
    expect(hasAscii(stripped, 'ftyp')).toBe(true);
    expect(hasAscii(stripped, 'mdat')).toBe(true);
    expect(hasAscii(stripped, 'Exif')).toBe(false);
    expect(hasAscii(stripped, 'XMP')).toBe(false);
    expect(hasAscii(stripped, 'ICC')).toBe(false);

    const ilocEntry = findImageItemIloc(stripped, 1);
    const mdat = findTopLevelBox(stripped, 'mdat');
    expect(ilocEntry.constructionMethod).toBe(0);
    for (const extent of ilocEntry.extents) {
      expect(extent.offset).toBeGreaterThanOrEqual(mdat.payloadStart);
      expect(extent.offset + extent.length).toBeLessThanOrEqual(mdat.end);
    }
  } finally {
    result.free();
  }
}

function realWorldLikeIso(brand: string, imageItemType: string, mediaPayload: Uint8Array): Uint8Array {
  const ftyp = ftypBox(brand, ['mif1']);
  const provisionalMeta = metaBox(imageItemType, 0, mediaPayload.byteLength);
  const mdatPayloadOffset = ftyp.byteLength + provisionalMeta.byteLength + 8;
  const meta = metaBox(imageItemType, mdatPayloadOffset, mediaPayload.byteLength);
  return concatBytes(ftyp, meta, bmffBox('mdat', mediaPayload));
}

function metaBox(imageItemType: string, imageOffset: number, imageLength: number): Uint8Array {
  return bmffBox('meta', concatBytes(
    new Uint8Array([0, 0, 0, 0]),
    iinfBox(imageItemType),
    ilocBox(imageOffset, imageLength),
    iprpBox(),
  ));
}

function iinfBox(imageItemType: string): Uint8Array {
  return bmffBox('iinf', concatBytes(
    new Uint8Array([0, 0, 0, 0]),
    u16be(2),
    infeBox(1, imageItemType),
    infeBox(2, 'Exif'),
  ));
}

function infeBox(itemId: number, itemType: string): Uint8Array {
  return bmffBox('infe', concatBytes(
    new Uint8Array([2, 0, 0, 0]),
    u16be(itemId),
    u16be(0),
    ascii(itemType),
    new Uint8Array([0]),
  ));
}

function ilocBox(imageOffset: number, imageLength: number): Uint8Array {
  return bmffBox('iloc', concatBytes(
    new Uint8Array([1, 0, 0, 0, 0x44, 0x00]),
    u16be(2),
    u16be(1), u16be(0), u16be(0), u16be(1), u32be(imageOffset), u32be(imageLength),
    u16be(2), u16be(0), u16be(0), u16be(0),
  ));
}

function iprpBox(): Uint8Array {
  const ipco = concatBytes(
    bmffBox('ispe', new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1])),
    bmffBox('colr', ascii('profICC')),
  );
  return bmffBox('iprp', concatBytes(bmffBox('ipco', ipco), bmffBox('ipma', new Uint8Array([0, 0, 0, 0, 0, 0]))));
}

function syntheticIsoVideo(brand: string, chunkOffsetBoxType: 'stco' | 'co64'): Uint8Array {
  const frame = concatBytes(NAL_PREFIX, new Uint8Array([0x65, 0x88, 0x84, 0x21, 0xa0, 0x0f, 0xff, 0x80]));
  const ftyp = ftypBox(brand, ['isom']);
  const moovWithZeroOffset = moovBox(0, chunkOffsetBoxType);
  const mdatPayloadStart = ftyp.byteLength + moovWithZeroOffset.byteLength + 8;
  const moov = moovBox(mdatPayloadStart, chunkOffsetBoxType);
  return concatBytes(ftyp, moov, bmffBox('mdat', frame));
}

function moovBox(chunkOffset: number, chunkOffsetBoxType: 'stco' | 'co64'): Uint8Array {
  return bmffBox('moov', concatBytes(
    trakBox(chunkOffset, chunkOffsetBoxType),
    bmffBox('udta', bmffBox('name', ascii('camera-metadata'))),
  ));
}

function trakBox(chunkOffset: number, chunkOffsetBoxType: 'stco' | 'co64'): Uint8Array {
  return bmffBox('trak', bmffBox('mdia', concatBytes(
    hdlrBox(),
    bmffBox('minf', bmffBox('stbl', chunkOffsetBox(chunkOffset, chunkOffsetBoxType))),
  )));
}

function hdlrBox(): Uint8Array {
  return bmffBox('hdlr', concatBytes(new Uint8Array([0, 0, 0, 0]), u32be(0), ascii('vide'), new Uint8Array(12), new Uint8Array([0])));
}

function chunkOffsetBox(chunkOffset: number, boxType: 'stco' | 'co64'): Uint8Array {
  return bmffBox(boxType, concatBytes(
    new Uint8Array([0, 0, 0, 0]),
    u32be(1),
    boxType === 'stco' ? u32be(chunkOffset) : u64be(chunkOffset),
  ));
}

function findImageItemIloc(input: Uint8Array, targetItemId: number): IlocEntry {
  const metaPayload = findTopLevelBox(input, 'meta');
  const ilocPayload = findBoxPayload(input.slice(metaPayload.payloadStart + 4, metaPayload.end), 'iloc');
  expect(ilocPayload[0]).toBe(1);
  const offsetSize = ilocPayload[4] >> 4;
  const lengthSize = ilocPayload[4] & 0x0f;
  const baseOffsetSize = ilocPayload[5] >> 4;
  const indexSize = ilocPayload[5] & 0x0f;
  const itemCount = readU16be(ilocPayload, 6);
  let cursor = 8;
  for (let i = 0; i < itemCount; i += 1) {
    const itemId = readU16be(ilocPayload, cursor);
    cursor += 2;
    const constructionMethod = readU16be(ilocPayload, cursor) & 0x000f;
    cursor += 4 + baseOffsetSize;
    const extentCount = readU16be(ilocPayload, cursor);
    cursor += 2;
    const extents: ItemExtent[] = [];
    for (let extentIndex = 0; extentIndex < extentCount; extentIndex += 1) {
      cursor += indexSize;
      const offset = readSizedUint(ilocPayload, cursor, offsetSize);
      cursor += offsetSize;
      const length = readSizedUint(ilocPayload, cursor, lengthSize);
      cursor += lengthSize;
      extents.push({ offset, length });
    }
    if (itemId === targetItemId) return { constructionMethod, extents };
  }
  throw new Error('image item iloc entry missing');
}

function findChunkOffsets(input: Uint8Array, boxType: string): number[] {
  for (const box of parseChildBoxes(input)) {
    const offsets = findChunkOffsetsInBox(input, box, boxType);
    if (offsets.length > 0) return offsets;
  }
  return [];
}

function findChunkOffsetsInBox(input: Uint8Array, box: ParsedBox, boxType: string): number[] {
  if (box.boxType === boxType) {
    const payload = input.slice(box.payloadStart, box.end);
    const entryCount = readU32be(payload, 4);
    const entrySize = boxType === 'co64' ? 8 : 4;
    return Array.from({ length: entryCount }, (_, index) => (
      boxType === 'co64'
        ? readU64be(payload, 8 + index * entrySize)
        : readU32be(payload, 8 + index * entrySize)
    ));
  }
  if (!['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(box.boxType)) return [];
  for (const child of parseChildBoxes(input.slice(box.payloadStart, box.end))) {
    const offsets = findChunkOffsetsInBox(input, {
      boxType: child.boxType,
      payloadStart: box.payloadStart + child.payloadStart,
      end: box.payloadStart + child.end,
    }, boxType);
    if (offsets.length > 0) return offsets;
  }
  return [];
}

function findTopLevelBox(input: Uint8Array, boxType: string): ParsedBox {
  const found = parseChildBoxes(input).find((box) => box.boxType === boxType);
  if (found === undefined) throw new Error(`${boxType} missing`);
  return found;
}

function findBoxPayload(input: Uint8Array, boxType: string): Uint8Array {
  const box = findTopLevelBox(input, boxType);
  return input.slice(box.payloadStart, box.end);
}

function parseChildBoxes(input: Uint8Array): ParsedBox[] {
  const boxes: ParsedBox[] = [];
  let cursor = 0;
  while (cursor < input.byteLength) {
    const size = readU32be(input, cursor);
    const boxType = text(input.slice(cursor + 4, cursor + 8));
    const end = cursor + size;
    if (size < 8 || end > input.byteLength) throw new Error('invalid box');
    boxes.push({ boxType, payloadStart: cursor + 8, end });
    cursor = end;
  }
  return boxes;
}

function av1Payload(): Uint8Array {
  return concatBytes(ascii('\0\0\0\x01av1-obu0'), new Uint8Array(128).fill(0xaa));
}

function hevcPayload(): Uint8Array {
  return concatBytes(ascii('\0\0\0\x01hvc-obu0'), new Uint8Array(128).fill(0xbb));
}

function ftypBox(brand: string, compatibleBrands: readonly string[]): Uint8Array {
  return bmffBox('ftyp', concatBytes(ascii(brand), u32be(0), ascii(brand), ...compatibleBrands.map(ascii)));
}

function bmffBox(boxType: string, payload: Uint8Array): Uint8Array {
  return concatBytes(u32be(payload.byteLength + 8), ascii(boxType), payload);
}

function readSizedUint(payload: Uint8Array, offset: number, size: number): number {
  if (size === 0) return 0;
  if (size === 4) return readU32be(payload, offset);
  throw new Error('unsupported integer size');
}

function readU16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU32be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] * 0x1000000) + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])) >>> 0;
}

function readU64be(bytes: Uint8Array, offset: number): number {
  return Number(new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, false));
}

function u16be(value: number): Uint8Array {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

function u32be(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function u64be(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
}

function concatBytes(...chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function ascii(value: string): Uint8Array {
  return new Uint8Array(Array.from(value, (character) => character.charCodeAt(0)));
}

function text(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

function hasAscii(bytes: Uint8Array, needle: string): boolean {
  const pattern = ascii(needle);
  return bytes.some((_, index) => index + pattern.byteLength <= bytes.byteLength && pattern.every((value, offset) => bytes[index + offset] === value));
}
