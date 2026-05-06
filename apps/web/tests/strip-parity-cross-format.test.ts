import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StripResult } from '../src/generated/mosaic-wasm/mosaic_wasm.js';
import initRustWasm, {
  stripAvifMetadata,
  stripHeicMetadata,
  stripJpegMetadata,
  stripPngMetadata,
  stripWebpMetadata,
} from '../src/generated/mosaic-wasm/mosaic_wasm.js';
import { stripExifFromBlob } from '../src/lib/exif-stripper';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const CORPUS_DIR = resolve(REPO_ROOT, 'apps', 'web', 'tests', 'fixtures', 'strip-corpus');
const WASM_BYTES_PATH = resolve(REPO_ROOT, 'apps', 'web', 'src', 'generated', 'mosaic-wasm', 'mosaic_wasm_bg.wasm');

interface CrossFormatCase {
  readonly mimeType: string;
  readonly input: () => Uint8Array;
  readonly strip: (bytes: Uint8Array) => StripResult;
}

function loadBytes(fileName: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(CORPUS_DIR, fileName)));
}

function strippedBytes(result: StripResult): Uint8Array {
  try {
    expect(result.code).toBe(0);
    expect(result.removedMetadataCount).toBeGreaterThan(0);
    return new Uint8Array(result.strippedBytes);
  } finally {
    result.free();
  }
}

beforeAll(async () => {
  vi.unmock('../src/generated/mosaic-wasm/mosaic_wasm.js');
  await initRustWasm({ module_or_path: new Uint8Array(readFileSync(WASM_BYTES_PATH)) });
});

describe('cross-format metadata strip migration parity', () => {
  const cases: readonly CrossFormatCase[] = [
    {
      mimeType: 'image/jpeg',
      input: () => loadBytes('jpeg-with-appn.jpg'),
      strip: stripJpegMetadata,
    },
    {
      mimeType: 'image/png',
      input: () => loadBytes('png-with-text.png'),
      strip: stripPngMetadata,
    },
    {
      mimeType: 'image/webp',
      input: () => loadBytes('webp-with-metadata.webp'),
      strip: stripWebpMetadata,
    },
    {
      mimeType: 'image/avif',
      input: () => realWorldLikeIso('avif', 'av01', concatBytes(ascii('\0\0\0\x01av1-obu0'), new Uint8Array(128).fill(0xaa))),
      strip: stripAvifMetadata,
    },
    {
      mimeType: 'image/heic',
      input: () => realWorldLikeIso('heic', 'hvc1', concatBytes(ascii('\0\0\0\x01hvc-obu0'), new Uint8Array(128).fill(0xbb))),
      strip: stripHeicMetadata,
    },
  ];

  it.each(cases)('matches direct Rust WASM stripped bytes for %s', async ({ mimeType, input, strip }) => {
    const source = input();
    const expected = strippedBytes(strip(source));

    const migrated = await stripExifFromBlob(new Blob([source]), mimeType);

    expect(migrated.stripped).toBe(true);
    expect(migrated.skippedReason).toBeUndefined();
    expect(Array.from(migrated.bytes)).toEqual(Array.from(expected));
  });
});

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
  return bmffBox('iprp', concatBytes(
    bmffBox('ipco', ipco),
    bmffBox('ipma', new Uint8Array([0, 0, 0, 0, 0, 0])),
  ));
}

function ftypBox(brand: string, compatibleBrands: readonly string[]): Uint8Array {
  return bmffBox('ftyp', concatBytes(ascii(brand), u32be(0), ascii(brand), ...compatibleBrands.map(ascii)));
}

function bmffBox(boxType: string, payload: Uint8Array): Uint8Array {
  return concatBytes(u32be(payload.byteLength + 8), ascii(boxType), payload);
}

function u16be(value: number): Uint8Array {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

function u32be(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
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
