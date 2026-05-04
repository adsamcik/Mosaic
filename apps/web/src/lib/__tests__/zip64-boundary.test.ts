import { downloadZip } from 'client-zip';
import { describe, expect, it } from 'vitest';

const ZIP64_FILE_SIZE = 4_500_000_000;
const ZIP64_FILE_SIZE_BIGINT = BigInt(ZIP64_FILE_SIZE);
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;

const LOCAL_FILE_HEADER = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
const CENTRAL_DIRECTORY_HEADER = new Uint8Array([0x50, 0x4b, 0x01, 0x02]);
const EOCD = new Uint8Array([0x50, 0x4b, 0x05, 0x06]);
const ZIP64_EOCD = new Uint8Array([0x50, 0x4b, 0x06, 0x06]);
const ZIP64_EOCD_LOCATOR = new Uint8Array([0x50, 0x4b, 0x06, 0x07]);

type ByteArray = Uint8Array<ArrayBufferLike>;

interface TailInspectionResult {
  readonly totalBytes: bigint;
  readonly tail: ByteArray;
}

interface ParsedZipEntry {
  readonly name: string;
  readonly content: ByteArray;
}

function createZeroStream(totalBytes: number, chunkSize = DEFAULT_CHUNK_SIZE): ReadableStream<Uint8Array> {
  let emitted = 0;
  const fullChunk = new Uint8Array(chunkSize);

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted >= totalBytes) {
        controller.close();
        return;
      }

      const remaining = totalBytes - emitted;
      const nextSize = Math.min(chunkSize, remaining);
      emitted += nextSize;
      controller.enqueue(nextSize === chunkSize ? fullChunk : new Uint8Array(nextSize));
    },
  });
}

function requireBody(response: Response): ReadableStream<Uint8Array> {
  if (response.body === null) {
    throw new Error('ZIP response body is missing');
  }
  return response.body;
}

async function inspectTail(response: Response, tailSize: number): Promise<TailInspectionResult> {
  const reader = requireBody(response).getReader();
  let totalBytes = 0n;
  let tail: ByteArray = new Uint8Array(0);

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;

    totalBytes += BigInt(value.byteLength);
    tail = appendToTail(tail, value, tailSize);
  }

  return { totalBytes, tail };
}

async function readResponseBytes(response: Response): Promise<ByteArray> {
  const reader = requireBody(response).getReader();
  const chunks: ByteArray[] = [];
  let totalLength = 0;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;

    chunks.push(value);
    totalLength += value.byteLength;
  }

  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function appendToTail(currentTail: ByteArray, chunk: ByteArray, tailSize: number): ByteArray {
  if (chunk.byteLength >= tailSize) {
    const nextTail = new Uint8Array(tailSize);
    nextTail.set(chunk.subarray(chunk.byteLength - tailSize));
    return nextTail;
  }

  const combinedLength = Math.min(tailSize, currentTail.byteLength + chunk.byteLength);
  const combined = new Uint8Array(combinedLength);
  const tailBytesToKeep = combinedLength - chunk.byteLength;

  combined.set(currentTail.slice(currentTail.byteLength - tailBytesToKeep), 0);
  combined.set(chunk, tailBytesToKeep);
  return combined;
}

function indexOfBytes(haystack: ByteArray, needle: ByteArray, startAt = 0): number {
  const lastStart = haystack.byteLength - needle.byteLength;
  for (let i = startAt; i <= lastStart; i++) {
    let matches = true;
    for (let j = 0; j < needle.byteLength; j++) {
      if (haystack[i + j] !== needle[j]) {
        matches = false;
        break;
      }
    }
    if (matches) return i;
  }
  return -1;
}

function lastIndexOfBytes(haystack: ByteArray, needle: ByteArray): number {
  for (let i = haystack.byteLength - needle.byteLength; i >= 0; i--) {
    let matches = true;
    for (let j = 0; j < needle.byteLength; j++) {
      if (haystack[i + j] !== needle[j]) {
        matches = false;
        break;
      }
    }
    if (matches) return i;
  }
  return -1;
}

function readUint16(bytes: ByteArray, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function readUint32(bytes: ByteArray, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function readBigUint64(bytes: ByteArray, offset: number): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, true);
}

function findZip64ExtraField(extraFields: ByteArray): ByteArray | null {
  let offset = 0;
  while (offset + 4 <= extraFields.byteLength) {
    const headerId = readUint16(extraFields, offset);
    const dataSize = readUint16(extraFields, offset + 2);
    const dataStart = offset + 4;
    const dataEnd = dataStart + dataSize;
    if (dataEnd > extraFields.byteLength) return null;
    if (headerId === 0x0001) return extraFields.slice(dataStart, dataEnd);
    offset = dataEnd;
  }
  return null;
}

function parseCentralDirectoryZip64Extra(bytes: ByteArray): ByteArray {
  const centralDirectoryOffset = indexOfBytes(bytes, CENTRAL_DIRECTORY_HEADER);
  expect(centralDirectoryOffset).toBeGreaterThanOrEqual(0);

  const nameLength = readUint16(bytes, centralDirectoryOffset + 28);
  const extraLength = readUint16(bytes, centralDirectoryOffset + 30);
  const extraStart = centralDirectoryOffset + 46 + nameLength;
  const extraEnd = extraStart + extraLength;
  const zip64Extra = findZip64ExtraField(bytes.slice(extraStart, extraEnd));

  expect(zip64Extra).not.toBeNull();
  return zip64Extra ?? new Uint8Array(0);
}

function parseStoredZipEntries(bytes: ByteArray): ParsedZipEntry[] {
  const eocdOffset = lastIndexOfBytes(bytes, EOCD);
  expect(eocdOffset).toBeGreaterThanOrEqual(0);

  const entryCount = readUint16(bytes, eocdOffset + 10);
  const centralDirectoryOffset = readUint32(bytes, eocdOffset + 16);
  const decoder = new TextDecoder();
  const entries: ParsedZipEntry[] = [];
  let offset = centralDirectoryOffset;

  for (let entryIndex = 0; entryIndex < entryCount; entryIndex++) {
    expect(indexOfBytes(bytes, CENTRAL_DIRECTORY_HEADER, offset)).toBe(offset);

    const compressionMethod = readUint16(bytes, offset + 10);
    const compressedSize = readUint32(bytes, offset + 20);
    const nameLength = readUint16(bytes, offset + 28);
    const extraLength = readUint16(bytes, offset + 30);
    const commentLength = readUint16(bytes, offset + 32);
    const localHeaderOffset = readUint32(bytes, offset + 42);
    const nameStart = offset + 46;
    const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));

    expect(compressionMethod).toBe(0);
    expect(indexOfBytes(bytes, LOCAL_FILE_HEADER, localHeaderOffset)).toBe(localHeaderOffset);

    const localNameLength = readUint16(bytes, localHeaderOffset + 26);
    const localExtraLength = readUint16(bytes, localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const content = bytes.slice(dataStart, dataStart + compressedSize);

    entries.push({ name, content });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function expectTextContent(entries: ParsedZipEntry[], name: string, content: string): void {
  const entry = entries.find((candidate) => candidate.name === name);
  expect(entry).toBeDefined();
  expect(new TextDecoder().decode(entry?.content)).toBe(content);
}

describe('client-zip ZIP64 boundaries', () => {
  it('emits ZIP64 EOCD records in an archive larger than 4 GB', { timeout: 120_000 }, async () => {
    const response = downloadZip([{ name: 'big.bin', input: createZeroStream(ZIP64_FILE_SIZE), lastModified: new Date(0), size: ZIP64_FILE_SIZE }]);

    const { totalBytes, tail } = await inspectTail(response, 512);

    expect(totalBytes).toBeGreaterThanOrEqual(ZIP64_FILE_SIZE_BIGINT);
    expect(indexOfBytes(tail, ZIP64_EOCD)).toBeGreaterThanOrEqual(0);
    expect(indexOfBytes(tail, ZIP64_EOCD_LOCATOR)).toBeGreaterThanOrEqual(0);
  });

  it('does not emit ZIP64 records for a small archive', async () => {
    const response = downloadZip([{ name: 'small.bin', input: new Uint8Array(1024), lastModified: new Date(0) }]);

    const { tail } = await inspectTail(response, 256);

    expect(indexOfBytes(tail, EOCD)).toBeGreaterThanOrEqual(0);
    expect(indexOfBytes(tail, ZIP64_EOCD)).toBe(-1);
    expect(indexOfBytes(tail, ZIP64_EOCD_LOCATOR)).toBe(-1);
  });

  it('emits a per-file ZIP64 extra field for a file larger than 4 GB', { timeout: 120_000 }, async () => {
    const response = downloadZip([{ name: 'big.bin', input: createZeroStream(ZIP64_FILE_SIZE), lastModified: new Date(0), size: ZIP64_FILE_SIZE }]);

    const { tail } = await inspectTail(response, 4096);
    const zip64Extra = parseCentralDirectoryZip64Extra(tail);

    expect(zip64Extra.byteLength).toBeGreaterThanOrEqual(16);
    expect(readBigUint64(zip64Extra, 0)).toBe(ZIP64_FILE_SIZE_BIGINT);
    expect(readBigUint64(zip64Extra, 8)).toBe(ZIP64_FILE_SIZE_BIGINT);
  });

  it('records ZIP64 entry counts when a ZIP64 archive contains more than 65535 entries', { timeout: 180_000 }, async () => {
    async function* generateEntries(): AsyncGenerator<{ name: string; input: Uint8Array | ReadableStream<Uint8Array>; lastModified: Date; size?: number }> {
      yield { name: 'big.bin', input: createZeroStream(ZIP64_FILE_SIZE), lastModified: new Date(0), size: ZIP64_FILE_SIZE };
      const singleByte = new Uint8Array([0]);
      for (let i = 1; i < 65_536; i++) {
        yield { name: `f${i}.bin`, input: singleByte, lastModified: new Date(0) };
      }
    }

    const response = downloadZip(generateEntries());

    const { tail } = await inspectTail(response, 4096);
    const eocdOffset = lastIndexOfBytes(tail, EOCD);
    const zip64EocdOffset = indexOfBytes(tail, ZIP64_EOCD);

    expect(eocdOffset).toBeGreaterThanOrEqual(0);
    expect(zip64EocdOffset).toBeGreaterThanOrEqual(0);
    expect(readUint16(tail, eocdOffset + 8)).toBe(0xffff);
    expect(readUint16(tail, eocdOffset + 10)).toBe(0xffff);
    expect(readBigUint64(tail, zip64EocdOffset + 24)).toBe(65_536n);
    expect(readBigUint64(tail, zip64EocdOffset + 32)).toBe(65_536n);
  });

  it('round-trips a small archive through a minimal ZIP parser', async () => {
    const response = downloadZip([
      { name: 'a.txt', input: new TextEncoder().encode('alpha'), lastModified: new Date(0) },
      { name: 'b.txt', input: new TextEncoder().encode('bravo'), lastModified: new Date(0) },
      { name: 'c.txt', input: new TextEncoder().encode('charlie'), lastModified: new Date(0) },
    ]);

    const bytes = await readResponseBytes(response);
    const entries = parseStoredZipEntries(bytes);

    expect(entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expectTextContent(entries, 'a.txt', 'alpha');
    expectTextContent(entries, 'b.txt', 'bravo');
    expectTextContent(entries, 'c.txt', 'charlie');
  });
});
