import { describe, expect, it, vi } from 'vitest';
import { runZipFinalizer, type ZipFinalizerDeps } from '../zip-finalizer';

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes); controller.close(); },
  });
}

interface CapturedTarget {
  readonly written: Uint8Array[];
  readonly closed: { value: boolean };
  readonly aborted: { value: boolean };
  readonly stream: WritableStream<Uint8Array>;
}

function makeTarget(): CapturedTarget {
  const written: Uint8Array[] = [];
  const closed = { value: false };
  const aborted = { value: false };
  const stream = new WritableStream<Uint8Array>({
    write(chunk) { written.push(chunk); },
    close() { closed.value = true; },
    abort() { aborted.value = true; },
  });
  return { written, closed, aborted, stream };
}

function deps(target: CapturedTarget, photos: ReadonlyArray<{ id: string; bytes: Uint8Array }>): ZipFinalizerDeps {
  const byId = new Map(photos.map((p) => [p.id, p.bytes]));
  return {
    readPhotoStream: async (_jobId, photoId) => {
      const b = byId.get(photoId);
      if (!b) throw new Error('not staged');
      return streamFromBytes(b);
    },
    getPhotoFileLength: async (_jobId, photoId) => byId.get(photoId)?.byteLength ?? null,
    openSaveTarget: async () => target.stream,
  };
}

function concatChunks(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

const ZIP_EOCD_SIGNATURE = [0x50, 0x4b, 0x05, 0x06];

function findSubsequence(haystack: Uint8Array, needle: ReadonlyArray<number>): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

describe('runZipFinalizer', () => {
  it('streams a ZIP archive ending with EOCD when given staged photos', async () => {
    const target = makeTarget();
    const photos = [
      { id: 'p1', bytes: new Uint8Array([1, 2, 3, 4]) },
      { id: 'p2', bytes: new Uint8Array([5, 6, 7]) },
      { id: 'p3', bytes: new Uint8Array([8, 9]) },
    ];
    await runZipFinalizer(
      { jobId: 'job-a', entries: [
        { photoId: 'p1', filename: 'one.jpg' },
        { photoId: 'p2', filename: 'two.jpg' },
        { photoId: 'p3', filename: 'three.jpg' },
      ] },
      'album.zip',
      deps(target, photos),
      new AbortController().signal,
    );
    expect(target.closed.value).toBe(true);
    const archive = concatChunks(target.written);
    expect(archive.byteLength).toBeGreaterThan(0);
    expect(findSubsequence(archive, ZIP_EOCD_SIGNATURE)).toBeGreaterThan(0);
  });

  it('skips photos missing from staging without aborting the archive', async () => {
    const target = makeTarget();
    const photos = [{ id: 'p1', bytes: new Uint8Array([1, 2, 3, 4]) }];
    await runZipFinalizer(
      { jobId: 'j', entries: [
        { photoId: 'p1', filename: 'one.jpg' },
        { photoId: 'p2', filename: 'missing.jpg' },
      ] },
      'a.zip',
      deps(target, photos),
      new AbortController().signal,
    );
    expect(target.closed.value).toBe(true);
    const archive = concatChunks(target.written);
    expect(findSubsequence(archive, ZIP_EOCD_SIGNATURE)).toBeGreaterThan(0);
  });

  it('aborts gracefully when the abort signal fires before pipeTo completes', async () => {
    const target = makeTarget();
    const ac = new AbortController();
    const photos = [{ id: 'p1', bytes: new Uint8Array([1, 2, 3, 4]) }];
    const deps2: ZipFinalizerDeps = {
      ...deps(target, photos),
      openSaveTarget: async () => { ac.abort(); return target.stream; },
    };
    await expect(runZipFinalizer(
      { jobId: 'j', entries: [{ photoId: 'p1', filename: 'one.jpg' }] },
      'x.zip',
      deps2,
      ac.signal,
    )).rejects.toBeDefined();
  });

  it('throws AbortError when signal already aborted before open', async () => {
    const ac = new AbortController();
    ac.abort();
    const openSpy = vi.fn();
    await expect(runZipFinalizer(
      { jobId: 'j', entries: [] },
      'x.zip',
      {
        readPhotoStream: vi.fn(),
        getPhotoFileLength: vi.fn(),
        openSaveTarget: openSpy as unknown as ZipFinalizerDeps['openSaveTarget'],
      },
      ac.signal,
    )).rejects.toThrow(/abort/i);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('opens then closes target with empty plan (zero-entry archive)', async () => {
    const target = makeTarget();
    await runZipFinalizer(
      { jobId: 'j', entries: [] },
      'empty.zip',
      deps(target, []),
      new AbortController().signal,
    );
    expect(target.closed.value).toBe(true);
    const archive = concatChunks(target.written);
    expect(findSubsequence(archive, ZIP_EOCD_SIGNATURE)).toBeGreaterThan(-1);
  });
});
