import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import initRustWasm from '../../generated/mosaic-wasm/mosaic_wasm.js';
import { stripExifFromBlob } from '../exif-stripper';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');
const CORPUS_DIR = resolve(REPO_ROOT, 'apps', 'web', 'tests', 'fixtures', 'strip-corpus');
const WASM_BYTES_PATH = resolve(REPO_ROOT, 'apps', 'web', 'src', 'generated', 'mosaic-wasm', 'mosaic_wasm_bg.wasm');

function bytes(fileName: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(CORPUS_DIR, fileName)));
}

function blobFromBytes(input: Uint8Array, mimeType: string): Blob {
  return new Blob([new Uint8Array(input)], { type: mimeType });
}

beforeAll(async () => {
  await initRustWasm({ module_or_path: new Uint8Array(readFileSync(WASM_BYTES_PATH)) });
});

describe('stripExifFromBlob', () => {
  it.each([
    ['image/jpeg', 'jpeg-with-appn.jpg', 'jpeg-with-appn.stripped.jpg'],
    ['image/png', 'png-with-text.png', 'png-with-text.stripped.png'],
    ['image/webp', 'webp-with-metadata.webp', 'webp-with-metadata.stripped.webp'],
  ])('strips %s using Rust mosaic-media parity surface', async (mimeType, inputFile, strippedFile) => {
    const input = bytes(inputFile);
    const expected = bytes(strippedFile);

    const result = await stripExifFromBlob(blobFromBytes(input, mimeType), mimeType);

    expect(result.stripped).toBe(true);
    expect(result.skippedReason).toBeUndefined();
    expect(Array.from(result.bytes)).toEqual(Array.from(expected));
  });

  it('returns original bytes when a supported image has no metadata carriers', async () => {
    const input = bytes('jpeg-with-appn.stripped.jpg');

    const result = await stripExifFromBlob(blobFromBytes(input, 'image/jpeg'), 'image/jpeg');

    expect(result.stripped).toBe(false);
    expect(result.skippedReason).toBeUndefined();
    expect(Array.from(result.bytes)).toEqual(Array.from(input));
  });

  it.each([
    ['image/jpeg', 'malformed-jpeg'],
    ['image/png', 'malformed-png'],
    ['image/webp', 'malformed-webp'],
    ['image/heic', 'malformed-heic'],
    ['image/heif', 'malformed-heic'],
    ['image/avif', 'malformed-avif'],
    ['video/mp4', 'malformed-video'],
  ])('maps malformed %s to %s without throwing', async (mimeType, reason) => {
    const input = new Uint8Array([1, 2, 3, 4]);

    const result = await stripExifFromBlob(blobFromBytes(input, mimeType), mimeType);

    expect(result).toEqual({ bytes: input, stripped: false, skippedReason: reason });
  });

  it.each([
    ['image/gif', 'unsupported-mime'],
    ['image/bmp', 'unsupported-mime'],
  ])('classifies unsupported %s as %s', async (mimeType, reason) => {
    const input = new Uint8Array([1]);

    const result = await stripExifFromBlob(blobFromBytes(input, mimeType), mimeType);

    expect(result).toEqual({ bytes: input, stripped: false, skippedReason: reason });
  });
});
