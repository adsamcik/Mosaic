import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StripResult } from '../src/generated/mosaic-wasm/mosaic_wasm.js';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const CORPUS_DIR = resolve(REPO_ROOT, 'apps', 'web', 'tests', 'fixtures', 'strip-corpus');
const WASM_BYTES_PATH = resolve(REPO_ROOT, 'apps', 'web', 'src', 'generated', 'mosaic-wasm', 'mosaic_wasm_bg.wasm');

interface CorpusCase {
  readonly name: string;
  readonly inputFile: string;
  readonly strippedFile: string;
  readonly strip: () => (bytes: Uint8Array) => StripResult;
  readonly removedMetadataCount: number;
}

let stripJpegMetadata: (bytes: Uint8Array) => StripResult;
let stripPngMetadata: (bytes: Uint8Array) => StripResult;
let stripWebpMetadata: (bytes: Uint8Array) => StripResult;

function loadBytes(fileName: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(CORPUS_DIR, fileName)));
}

function expectStripResult(result: StripResult, expectedBytes: Uint8Array, expectedRemovedMetadataCount: number): void {
  try {
    expect(result.code).toBe(0);
    expect(result.removedMetadataCount).toBe(expectedRemovedMetadataCount);
    expect(Array.from(result.strippedBytes)).toEqual(Array.from(expectedBytes));
  } finally {
    result.free();
  }
}

beforeAll(async () => {
  vi.unmock('../src/generated/mosaic-wasm/mosaic_wasm.js');
  const wasm = await import('../src/generated/mosaic-wasm/mosaic_wasm.js');
  stripJpegMetadata = wasm.stripJpegMetadata;
  stripPngMetadata = wasm.stripPngMetadata;
  stripWebpMetadata = wasm.stripWebpMetadata;
  const wasmBytes = new Uint8Array(readFileSync(WASM_BYTES_PATH));
  await wasm.default({ module_or_path: wasmBytes });
});

describe('metadata stripping golden parity through Web WASM', () => {
  const cases: readonly CorpusCase[] = [
    { name: 'JPEG strips Exif, ICC, and IPTC APP segments while preserving scan bytes', inputFile: 'jpeg-with-appn.jpg', strippedFile: 'jpeg-with-appn.stripped.jpg', strip: () => stripJpegMetadata, removedMetadataCount: 3 },
    { name: 'PNG strips iTXt, tIME, and iCCP metadata chunks', inputFile: 'png-with-text.png', strippedFile: 'png-with-text.stripped.png', strip: () => stripPngMetadata, removedMetadataCount: 3 },
    { name: 'WebP strips ICC/Exif/XMP chunks and clears VP8X metadata flags', inputFile: 'webp-with-metadata.webp', strippedFile: 'webp-with-metadata.stripped.webp', strip: () => stripWebpMetadata, removedMetadataCount: 3 },
  ];

  it.each(cases)('$name', ({ inputFile, strippedFile, strip, removedMetadataCount }) => {
    const input = loadBytes(inputFile);
    const expected = loadBytes(strippedFile);

    expectStripResult(strip()(input), expected, removedMetadataCount);
  });
});
