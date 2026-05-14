import { describe, expect, it } from 'vitest';

import { normalizeManifestFilename } from '../manifest-filename';

describe('normalizeManifestFilename', () => {
  it('leaves NFC filenames unchanged', () => {
    const filename = 'café';

    expect(normalizeManifestFilename(filename)).toBe(filename);
  });

  it('normalizes NFD filenames to NFC', () => {
    const nfd = 'cafe\u0301';

    expect(normalizeManifestFilename(nfd)).toBe('café');
    expect([...normalizeManifestFilename(nfd)].map((char) => char.codePointAt(0))).toEqual([
      0x63,
      0x61,
      0x66,
      0xe9,
    ]);
  });

  it('truncates very long ASCII filenames to 1024 UTF-8 bytes', () => {
    const filename = 'a'.repeat(2048);
    const normalized = normalizeManifestFilename(filename);

    expect(new TextEncoder().encode(normalized)).toHaveLength(1024);
    expect(normalized).toBe('a'.repeat(1024));
  });

  it('leaves already-short names unchanged', () => {
    const filename = 'vacation-2024.jpg';

    expect(normalizeManifestFilename(filename)).toBe(filename);
  });

  it('does not return invalid UTF-16 when truncating within a multi-byte sequence', () => {
    const filename = `${'a'.repeat(1023)}é-suffix.jpg`;
    const normalized = normalizeManifestFilename(filename);

    expect(new TextEncoder().encode(normalized)).toHaveLength(1023);
    expect(normalized).not.toContain('\uD800');
    expect(normalized).not.toContain('\uDFFF');
    expect(normalized).toBe('a'.repeat(1023));
  });
});
