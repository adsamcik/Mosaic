import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import initRustWasm, { initSync } from '../../generated/mosaic-wasm/mosaic_wasm.js';
import { computeContentHash } from '../content-hash';
import { isRecord } from '../type-guards';

const WASM_BYTES_PATH = resolve(
  process.cwd(),
  'src',
  'generated',
  'mosaic-wasm',
  'mosaic_wasm_bg.wasm',
);
const CONTENT_HASH_VECTOR_PATH = resolve(
  process.cwd(),
  '..',
  '..',
  'tests',
  'vectors',
  'content_hash_dedup.json',
);

type ContentHashFixture = {
  sourceFileBytes: Uint8Array;
  expectedPlaintextSha256Hex: string;
};

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`content-hash fixture field ${field} must be an object`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`content-hash fixture field ${field} must be a string`);
  }
  return value;
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/u.test(hex)) {
    throw new Error('content-hash fixture sourceFileBytesHex must be lowercase even-length hex');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function loadContentHashFixture(): ContentHashFixture {
  const parsed: unknown = JSON.parse(readFileSync(CONTENT_HASH_VECTOR_PATH, 'utf8'));
  const document = requireRecord(parsed, 'root');
  const inputs = requireRecord(document.inputs, 'inputs');
  const expected = requireRecord(document.expected, 'expected');
  const sourceFileBytesHex = requireString(inputs.sourceFileBytesHex, 'inputs.sourceFileBytesHex');
  const expectedPlaintextSha256Hex = requireString(
    expected.plaintextSha256Hex,
    'expected.plaintextSha256Hex',
  );
  if (!/^[0-9a-f]{64}$/u.test(expectedPlaintextSha256Hex)) {
    throw new Error('content-hash fixture plaintextSha256Hex must be 64 lowercase hex characters');
  }
  return {
    sourceFileBytes: hexToBytes(sourceFileBytesHex),
    expectedPlaintextSha256Hex,
  };
}

beforeAll(async () => {
  initSync({ module: readFileSync(WASM_BYTES_PATH) });
  await initRustWasm();
});

describe('content-hash upload caller parity', () => {
  it('hashes source-of-truth File.arrayBuffer bytes with the golden content-hash vector', async () => {
    const fixture = loadContentHashFixture();
    const pickedFile = new File([new Uint8Array(fixture.sourceFileBytes)], 'fixture-with-exif.jpg', {
      type: 'image/jpeg',
    });

    const sourceBytesFromWebUpload = new Uint8Array(await pickedFile.arrayBuffer());
    const contentHashHex = await computeContentHash(sourceBytesFromWebUpload);

    expect(Array.from(sourceBytesFromWebUpload)).toEqual(Array.from(fixture.sourceFileBytes));
    expect(contentHashHex).toBe(fixture.expectedPlaintextSha256Hex);
  });
});
