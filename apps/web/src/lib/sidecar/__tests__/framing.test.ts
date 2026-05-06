import { describe, expect, it } from 'vitest';
import {
  decodeFrame,
  encodeFrame,
  FrameDecodeError,
  MAX_ABORT_REASON_BYTES,
  MAX_FILENAME_BYTES,
  type Frame,
} from '../framing';

function roundTrip(frame: Frame): Frame {
  return decodeFrame(encodeFrame(frame));
}

describe('framing', () => {
  it('round-trips fileStart', () => {
    const out = roundTrip({
      kind: 'fileStart',
      photoIdx: 7,
      filename: 'photo-é-😀.jpg',
      size: 12345678901234n,
    });
    expect(out).toEqual({
      kind: 'fileStart',
      photoIdx: 7,
      filename: 'photo-é-😀.jpg',
      size: 12345678901234n,
    });
  });

  it('round-trips fileChunk with 1 MiB payload', () => {
    const payload = new Uint8Array(1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) & 0xff;
    const out = roundTrip({ kind: 'fileChunk', photoIdx: 0, payload });
    expect(out.kind).toBe('fileChunk');
    if (out.kind !== 'fileChunk') throw new Error();
    expect(out.photoIdx).toBe(0);
    expect(out.payload.byteLength).toBe(payload.byteLength);
    // Spot-check first/last bytes for byte-exactness.
    expect(out.payload[0]).toBe(payload[0]);
    expect(out.payload[payload.length - 1]).toBe(payload[payload.length - 1]);
  });

  it('round-trips empty fileChunk', () => {
    const out = roundTrip({ kind: 'fileChunk', photoIdx: 4, payload: new Uint8Array(0) });
    expect(out).toEqual({ kind: 'fileChunk', photoIdx: 4, payload: new Uint8Array(0) });
  });

  it('round-trips fileEnd', () => {
    expect(roundTrip({ kind: 'fileEnd', photoIdx: 99 })).toEqual({ kind: 'fileEnd', photoIdx: 99 });
  });

  it('round-trips sessionEnd', () => {
    expect(roundTrip({ kind: 'sessionEnd' })).toEqual({ kind: 'sessionEnd' });
  });

  it('round-trips abort with reason', () => {
    expect(roundTrip({ kind: 'abort', reason: 'user-cancelled' })).toEqual({
      kind: 'abort',
      reason: 'user-cancelled',
    });
  });

  it('rejects truncated header', () => {
    expect(() => decodeFrame(new Uint8Array([1, 2, 3]))).toThrow(FrameDecodeError);
  });

  it('rejects unknown frame type', () => {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, 0xff, true);
    expect(() => decodeFrame(buf)).toThrow(/unknown frame type/);
  });

  it('rejects truncated fileStart (filename cut off)', () => {
    const ok = encodeFrame({ kind: 'fileStart', photoIdx: 1, filename: 'a.jpg', size: 1n });
    const trunc = ok.subarray(0, ok.length - 5);
    expect(() => decodeFrame(trunc)).toThrow(FrameDecodeError);
  });

  it('rejects fileEnd with extra bytes', () => {
    const ok = encodeFrame({ kind: 'fileEnd', photoIdx: 1 });
    const padded = new Uint8Array(ok.length + 1);
    padded.set(ok);
    expect(() => decodeFrame(padded)).toThrow(/length mismatch/);
  });

  it('rejects sessionEnd with extra bytes', () => {
    const padded = new Uint8Array(8);
    new DataView(padded.buffer).setUint32(0, 0x04, true);
    expect(() => decodeFrame(padded)).toThrow(/length mismatch/);
  });

  it('rejects oversized filename on encode', () => {
    const filename = 'a'.repeat(MAX_FILENAME_BYTES + 1);
    expect(() =>
      encodeFrame({ kind: 'fileStart', photoIdx: 0, filename, size: 0n }),
    ).toThrow(/filename exceeds/);
  });

  it('rejects oversized abort reason on encode', () => {
    const reason = 'x'.repeat(MAX_ABORT_REASON_BYTES + 1);
    expect(() => encodeFrame({ kind: 'abort', reason })).toThrow(/reason exceeds/);
  });

  it('rejects negative photoIdx', () => {
    expect(() => encodeFrame({ kind: 'fileEnd', photoIdx: -1 })).toThrow(RangeError);
  });

  it('decoded fileChunk payload is detached from input buffer', () => {
    const enc = encodeFrame({ kind: 'fileChunk', photoIdx: 0, payload: new Uint8Array([1, 2, 3]) });
    const out = decodeFrame(enc);
    if (out.kind !== 'fileChunk') throw new Error();
    enc.fill(0);
    expect(Array.from(out.payload)).toEqual([1, 2, 3]);
  });
});
