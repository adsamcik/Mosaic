import { describe, expect, it, vi } from 'vitest';
import type { PerFileSaveTarget } from '../../save-target';
import { createSidecarReceiveSink, SidecarReceiveError } from '../sink';
import type { Frame } from '../framing';

interface OpenedFile {
  readonly filename: string;
  readonly sizeBytes: number;
  readonly chunks: Uint8Array[];
  closed: boolean;
  aborted: boolean;
}

function makeFakeTarget(): { target: PerFileSaveTarget; opened: OpenedFile[]; finalized: { value: boolean }; abortedTarget: { value: boolean } } {
  const opened: OpenedFile[] = [];
  const finalized = { value: false };
  const abortedTarget = { value: false };
  const target: PerFileSaveTarget = {
    async openOne(filename, sizeBytes) {
      const file: OpenedFile = { filename, sizeBytes, chunks: [], closed: false, aborted: false };
      opened.push(file);
      return new WritableStream<Uint8Array>({
        write(chunk) {
          // Defensive copy: callers may reuse the buffer.
          const c = new Uint8Array(chunk.byteLength);
          c.set(chunk);
          file.chunks.push(c);
        },
        close() {
          file.closed = true;
        },
        abort() {
          file.aborted = true;
        },
      });
    },
    async finalize() {
      finalized.value = true;
    },
    async abort() {
      abortedTarget.value = true;
    },
  };
  return { target, opened, finalized, abortedTarget };
}

function fileBytes(file: OpenedFile): Uint8Array {
  const total = file.chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of file.chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

describe('sink', () => {
  it('happy path: writes a file across multiple chunks', async () => {
    const { target, opened, finalized } = makeFakeTarget();
    const onPhotoComplete = vi.fn();
    const onSessionEnd = vi.fn();
    const onProgress = vi.fn();
    const sink = createSidecarReceiveSink({ saveTarget: target, onPhotoComplete, onSessionEnd, onProgress });

    const data = new Uint8Array(15);
    for (let i = 0; i < 15; i++) data[i] = i;

    const frames: Frame[] = [
      { kind: 'fileStart', photoIdx: 3, filename: 'a.jpg', size: 15n },
      { kind: 'fileChunk', photoIdx: 3, payload: data.slice(0, 5) },
      { kind: 'fileChunk', photoIdx: 3, payload: data.slice(5, 10) },
      { kind: 'fileChunk', photoIdx: 3, payload: data.slice(10, 15) },
      { kind: 'fileEnd', photoIdx: 3 },
      { kind: 'sessionEnd' },
    ];
    for (const f of frames) await sink.process(f);

    expect(opened).toHaveLength(1);
    expect(opened[0]!.filename).toBe('a.jpg');
    expect(opened[0]!.sizeBytes).toBe(15);
    expect(opened[0]!.closed).toBe(true);
    expect(Array.from(fileBytes(opened[0]!))).toEqual(Array.from(data));
    expect(onPhotoComplete).toHaveBeenCalledWith(3, 'a.jpg');
    expect(onSessionEnd).toHaveBeenCalledOnce();
    expect(finalized.value).toBe(true);
    expect(onProgress).toHaveBeenCalledTimes(3);
  });

  it('multi-file session', async () => {
    const { target, opened } = makeFakeTarget();
    const sink = createSidecarReceiveSink({ saveTarget: target });
    const frames: Frame[] = [
      { kind: 'fileStart', photoIdx: 0, filename: 'x.jpg', size: 1n },
      { kind: 'fileChunk', photoIdx: 0, payload: new Uint8Array([1]) },
      { kind: 'fileEnd', photoIdx: 0 },
      { kind: 'fileStart', photoIdx: 1, filename: 'y.jpg', size: 2n },
      { kind: 'fileChunk', photoIdx: 1, payload: new Uint8Array([9, 8]) },
      { kind: 'fileEnd', photoIdx: 1 },
      { kind: 'sessionEnd' },
    ];
    for (const f of frames) await sink.process(f);
    expect(opened.map((f) => f.filename)).toEqual(['x.jpg', 'y.jpg']);
    expect(Array.from(fileBytes(opened[0]!))).toEqual([1]);
    expect(Array.from(fileBytes(opened[1]!))).toEqual([9, 8]);
  });

  it('rejects fileChunk without preceding fileStart', async () => {
    const { target } = makeFakeTarget();
    const sink = createSidecarReceiveSink({ saveTarget: target });
    await expect(
      sink.process({ kind: 'fileChunk', photoIdx: 0, payload: new Uint8Array([1]) }),
    ).rejects.toThrow(SidecarReceiveError);
  });

  it('rejects fileEnd without active file', async () => {
    const { target } = makeFakeTarget();
    const sink = createSidecarReceiveSink({ saveTarget: target });
    await expect(sink.process({ kind: 'fileEnd', photoIdx: 0 })).rejects.toThrow(SidecarReceiveError);
  });

  it('rejects fileStart while a file is already in progress', async () => {
    const { target } = makeFakeTarget();
    const sink = createSidecarReceiveSink({ saveTarget: target });
    await sink.process({ kind: 'fileStart', photoIdx: 0, filename: 'a.jpg', size: 5n });
    await expect(
      sink.process({ kind: 'fileStart', photoIdx: 1, filename: 'b.jpg', size: 5n }),
    ).rejects.toThrow(SidecarReceiveError);
  });

  it('rejects sessionEnd while a file is in progress', async () => {
    const { target } = makeFakeTarget();
    const sink = createSidecarReceiveSink({ saveTarget: target });
    await sink.process({ kind: 'fileStart', photoIdx: 0, filename: 'a.jpg', size: 5n });
    await expect(sink.process({ kind: 'sessionEnd' })).rejects.toThrow(SidecarReceiveError);
  });

  it('rejects fileChunk with mismatched photoIdx', async () => {
    const { target } = makeFakeTarget();
    const sink = createSidecarReceiveSink({ saveTarget: target });
    await sink.process({ kind: 'fileStart', photoIdx: 0, filename: 'a.jpg', size: 5n });
    await expect(
      sink.process({ kind: 'fileChunk', photoIdx: 1, payload: new Uint8Array([1]) }),
    ).rejects.toThrow(SidecarReceiveError);
  });

  it('abort frame: aborts in-flight writer + target and drops further frames', async () => {
    const { target, opened, abortedTarget } = makeFakeTarget();
    const onAbort = vi.fn();
    const sink = createSidecarReceiveSink({ saveTarget: target, onAbort });
    await sink.process({ kind: 'fileStart', photoIdx: 0, filename: 'a.jpg', size: 5n });
    await sink.process({ kind: 'fileChunk', photoIdx: 0, payload: new Uint8Array([1, 2]) });
    await sink.process({ kind: 'abort', reason: 'user-cancelled' });
    expect(opened[0]!.aborted).toBe(true);
    expect(abortedTarget.value).toBe(true);
    expect(onAbort).toHaveBeenCalledWith('user-cancelled');
    // Subsequent frames are silently dropped.
    await sink.process({ kind: 'fileChunk', photoIdx: 0, payload: new Uint8Array([3]) });
  });

  it('fileEnd before all declared bytes throws and aborts', async () => {
    const { target, opened } = makeFakeTarget();
    const onAbort = vi.fn();
    const sink = createSidecarReceiveSink({ saveTarget: target, onAbort });
    await sink.process({ kind: 'fileStart', photoIdx: 0, filename: 'a.jpg', size: 10n });
    await sink.process({ kind: 'fileChunk', photoIdx: 0, payload: new Uint8Array([1, 2, 3]) });
    await expect(sink.process({ kind: 'fileEnd', photoIdx: 0 })).rejects.toThrow(SidecarReceiveError);
    expect(opened[0]!.aborted).toBe(true);
    expect(onAbort).toHaveBeenCalledWith('truncated');
  });

  it('chunk that overflows declared size throws and aborts', async () => {
    const { target, opened } = makeFakeTarget();
    const sink = createSidecarReceiveSink({ saveTarget: target });
    await sink.process({ kind: 'fileStart', photoIdx: 0, filename: 'a.jpg', size: 3n });
    await expect(
      sink.process({ kind: 'fileChunk', photoIdx: 0, payload: new Uint8Array([1, 2, 3, 4]) }),
    ).rejects.toThrow(SidecarReceiveError);
    expect(opened[0]!.aborted).toBe(true);
  });

  it('process after sessionEnd throws', async () => {
    const { target } = makeFakeTarget();
    const sink = createSidecarReceiveSink({ saveTarget: target });
    await sink.process({ kind: 'sessionEnd' });
    await expect(
      sink.process({ kind: 'fileStart', photoIdx: 0, filename: 'a.jpg', size: 0n }),
    ).rejects.toThrow(SidecarReceiveError);
  });

  it('close is idempotent', async () => {
    const { target } = makeFakeTarget();
    const sink = createSidecarReceiveSink({ saveTarget: target });
    await sink.close();
    await sink.close();
  });

  it('close mid-file aborts the in-flight writer', async () => {
    const { target, opened, abortedTarget } = makeFakeTarget();
    const sink = createSidecarReceiveSink({ saveTarget: target });
    await sink.process({ kind: 'fileStart', photoIdx: 0, filename: 'a.jpg', size: 100n });
    await sink.close();
    expect(opened[0]!.aborted).toBe(true);
    expect(abortedTarget.value).toBe(true);
  });

  it('process after close throws', async () => {
    const { target } = makeFakeTarget();
    const sink = createSidecarReceiveSink({ saveTarget: target });
    await sink.close();
    await expect(
      sink.process({ kind: 'fileStart', photoIdx: 0, filename: 'a.jpg', size: 0n }),
    ).rejects.toThrow(SidecarReceiveError);
  });
});
