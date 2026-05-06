import { describe, expect, it } from 'vitest';
import { chunkPhoto } from '../chunker';
import type { Frame } from '../framing';

function streamFrom(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < parts.length) {
        controller.enqueue(parts[i]!);
        i++;
      } else {
        controller.close();
      }
    },
  });
}

async function collect(it: AsyncIterable<Frame>): Promise<Frame[]> {
  const out: Frame[] = [];
  for await (const f of it) out.push(f);
  return out;
}

describe('chunker', () => {
  it('empty body yields fileStart + fileEnd only', async () => {
    const stream = streamFrom([]);
    const frames = await collect(chunkPhoto(0, 'a.jpg', 0n, stream, { maxChunkBytes: 64 }));
    expect(frames.map((f) => f.kind)).toEqual(['fileStart', 'fileEnd']);
  });

  it('body smaller than chunk size yields a single chunk', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const frames = await collect(
      chunkPhoto(2, 'small.jpg', 5n, streamFrom([data]), { maxChunkBytes: 64 }),
    );
    expect(frames.map((f) => f.kind)).toEqual(['fileStart', 'fileChunk', 'fileEnd']);
    const chunk = frames[1];
    if (chunk?.kind !== 'fileChunk') throw new Error();
    expect(Array.from(chunk.payload)).toEqual([1, 2, 3, 4, 5]);
    expect(chunk.photoIdx).toBe(2);
  });

  it('body larger than chunk size splits into multiple chunks; last may be short', async () => {
    const data = new Uint8Array(250);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
    const frames = await collect(
      chunkPhoto(7, 'big.jpg', 250n, streamFrom([data]), { maxChunkBytes: 100 }),
    );
    expect(frames[0]?.kind).toBe('fileStart');
    expect(frames[frames.length - 1]?.kind).toBe('fileEnd');
    const chunks = frames.filter((f) => f.kind === 'fileChunk');
    expect(chunks).toHaveLength(3);
    if (chunks[0]?.kind !== 'fileChunk') throw new Error();
    if (chunks[1]?.kind !== 'fileChunk') throw new Error();
    if (chunks[2]?.kind !== 'fileChunk') throw new Error();
    expect(chunks[0].payload.byteLength).toBe(100);
    expect(chunks[1].payload.byteLength).toBe(100);
    expect(chunks[2].payload.byteLength).toBe(50);
    // Reassemble and assert byte-equality.
    const reassembled = new Uint8Array(250);
    let off = 0;
    for (const c of chunks) {
      if (c.kind !== 'fileChunk') continue;
      reassembled.set(c.payload, off);
      off += c.payload.byteLength;
    }
    expect(Array.from(reassembled)).toEqual(Array.from(data));
  });

  it('upstream chunks larger than maxChunkBytes are split', async () => {
    const big = new Uint8Array(300).fill(7);
    const frames = await collect(
      chunkPhoto(0, 'a.jpg', 300n, streamFrom([big]), { maxChunkBytes: 100 }),
    );
    const chunks = frames.filter((f): f is Extract<Frame, { kind: 'fileChunk' }> => f.kind === 'fileChunk');
    expect(chunks.map((c) => c.payload.byteLength)).toEqual([100, 100, 100]);
  });

  it('multiple small upstream chunks are coalesced up to maxChunkBytes', async () => {
    const parts = [new Uint8Array([1, 2]), new Uint8Array([3, 4]), new Uint8Array([5, 6, 7])];
    const frames = await collect(
      chunkPhoto(0, 'a.jpg', 7n, streamFrom(parts), { maxChunkBytes: 4 }),
    );
    const chunks = frames.filter((f): f is Extract<Frame, { kind: 'fileChunk' }> => f.kind === 'fileChunk');
    // Greedy fill: [1,2,3,4] then [5,6,7]
    expect(chunks.map((c) => Array.from(c.payload))).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7],
    ]);
  });

  it('lazy: does not pull next upstream chunk until consumer asks for next frame', async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls < 4) {
          controller.enqueue(new Uint8Array(10).fill(pulls));
        } else {
          controller.close();
        }
      },
    });
    const gen = chunkPhoto(0, 'a.jpg', 30n, stream, { maxChunkBytes: 10 });
    // Consume only fileStart; chunker has not yet read the upstream.
    const first = await gen.next();
    expect(first.value && first.value.kind).toBe('fileStart');
    const pullsAfterStart = pulls;
    // Now ask for one more frame; chunker should pull at least one upstream chunk but
    // not necessarily all of them.
    await gen.next();
    expect(pulls).toBeGreaterThan(pullsAfterStart);
    expect(pulls).toBeLessThanOrEqual(2);
    // Drain the rest cleanly.
    while (!(await gen.next()).done) { /* drain */ }
  });

  it('rejects invalid maxChunkBytes', async () => {
    await expect(async () => {
      const gen = chunkPhoto(0, 'a.jpg', 0n, streamFrom([]), { maxChunkBytes: 0 });
      await gen.next();
    }).rejects.toThrow(RangeError);
  });
});
