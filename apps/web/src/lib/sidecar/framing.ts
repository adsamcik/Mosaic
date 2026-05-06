/**
 * Sidecar Beacon — wire framing.
 *
 * Each frame is a length-defined record sealed by the AEAD tunnel before it
 * goes onto the WebRTC data channel (or, during handshake, the signaling
 * relay). The receiver decrypts via the tunnel and then runs decodeFrame()
 * on the resulting plaintext.
 *
 * Layout (little-endian):
 *
 *   FILE_START   = [u32 type=1][u32 photo_idx][u16 fn_len][fn_utf8][u64 size]
 *   FILE_CHUNK   = [u32 type=2][u32 photo_idx][bytes...]
 *   FILE_END     = [u32 type=3][u32 photo_idx]
 *   SESSION_END  = [u32 type=4]
 *   ABORT        = [u32 type=5][u16 reason_len][reason_utf8]
 *
 * The sealed envelope provides authenticity + ordering (nonce counter), so
 * the framing layer never carries its own MAC or sequence number.
 *
 * ZK-safe logging policy: this module never logs filenames, payload bytes,
 * abort reasons, or sizes. It returns errors with generic messages.
 */

export const FRAME_TYPE_FILE_START = 0x01;
export const FRAME_TYPE_FILE_CHUNK = 0x02;
export const FRAME_TYPE_FILE_END = 0x03;
export const FRAME_TYPE_SESSION_END = 0x04;
export const FRAME_TYPE_ABORT = 0x05;

/** Maximum filename byte length (after UTF-8 encoding). */
export const MAX_FILENAME_BYTES = 1024;
/** Maximum abort-reason byte length (after UTF-8 encoding). */
export const MAX_ABORT_REASON_BYTES = 256;

export type FrameKind = 'fileStart' | 'fileChunk' | 'fileEnd' | 'sessionEnd' | 'abort';

/** Bytes of frame header overhead per frame type, excluding any variable-length body. */
export const FRAME_HEADER_OVERHEAD: Readonly<Record<FrameKind, number>> = Object.freeze({
  fileStart: 4 + 4 + 2 + 8,
  fileChunk: 4 + 4,
  fileEnd: 4 + 4,
  sessionEnd: 4,
  abort: 4 + 2,
});

export interface FileStartFrame {
  readonly kind: 'fileStart';
  readonly photoIdx: number;
  readonly filename: string;
  readonly size: bigint;
}
export interface FileChunkFrame {
  readonly kind: 'fileChunk';
  readonly photoIdx: number;
  readonly payload: Uint8Array;
}
export interface FileEndFrame {
  readonly kind: 'fileEnd';
  readonly photoIdx: number;
}
export interface SessionEndFrame {
  readonly kind: 'sessionEnd';
}
export interface AbortFrame {
  readonly kind: 'abort';
  readonly reason: string;
}

export type Frame =
  | FileStartFrame
  | FileChunkFrame
  | FileEndFrame
  | SessionEndFrame
  | AbortFrame;

export class FrameDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameDecodeError';
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function assertU32(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError('framing: ' + field + ' must be a u32 (got ' + String(value) + ')');
  }
}

export function encodeFrame(frame: Frame): Uint8Array {
  switch (frame.kind) {
    case 'fileStart': {
      assertU32(frame.photoIdx, 'photoIdx');
      if (frame.size < 0n || frame.size > 0xffff_ffff_ffff_ffffn) {
        throw new RangeError('framing: size must be a u64');
      }
      const fn = textEncoder.encode(frame.filename);
      if (fn.length > MAX_FILENAME_BYTES) {
        throw new RangeError('framing: filename exceeds ' + String(MAX_FILENAME_BYTES) + ' bytes');
      }
      const buf = new ArrayBuffer(4 + 4 + 2 + fn.length + 8);
      const dv = new DataView(buf);
      dv.setUint32(0, FRAME_TYPE_FILE_START, true);
      dv.setUint32(4, frame.photoIdx, true);
      dv.setUint16(8, fn.length, true);
      new Uint8Array(buf, 10, fn.length).set(fn);
      dv.setBigUint64(10 + fn.length, frame.size, true);
      return new Uint8Array(buf);
    }
    case 'fileChunk': {
      assertU32(frame.photoIdx, 'photoIdx');
      const buf = new ArrayBuffer(4 + 4 + frame.payload.byteLength);
      const dv = new DataView(buf);
      dv.setUint32(0, FRAME_TYPE_FILE_CHUNK, true);
      dv.setUint32(4, frame.photoIdx, true);
      new Uint8Array(buf, 8, frame.payload.byteLength).set(frame.payload);
      return new Uint8Array(buf);
    }
    case 'fileEnd': {
      assertU32(frame.photoIdx, 'photoIdx');
      const buf = new ArrayBuffer(4 + 4);
      const dv = new DataView(buf);
      dv.setUint32(0, FRAME_TYPE_FILE_END, true);
      dv.setUint32(4, frame.photoIdx, true);
      return new Uint8Array(buf);
    }
    case 'sessionEnd': {
      const buf = new ArrayBuffer(4);
      new DataView(buf).setUint32(0, FRAME_TYPE_SESSION_END, true);
      return new Uint8Array(buf);
    }
    case 'abort': {
      const r = textEncoder.encode(frame.reason);
      if (r.length > MAX_ABORT_REASON_BYTES) {
        throw new RangeError('framing: abort reason exceeds ' + String(MAX_ABORT_REASON_BYTES) + ' bytes');
      }
      const buf = new ArrayBuffer(4 + 2 + r.length);
      const dv = new DataView(buf);
      dv.setUint32(0, FRAME_TYPE_ABORT, true);
      dv.setUint16(4, r.length, true);
      new Uint8Array(buf, 6, r.length).set(r);
      return new Uint8Array(buf);
    }
    default: {
      const _exhaustive: never = frame;
      throw new Error('framing: unknown kind: ' + String(_exhaustive));
    }
  }
}

export function decodeFrame(bytes: Uint8Array): Frame {
  if (bytes.byteLength < 4) {
    throw new FrameDecodeError('framing: truncated header');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = dv.getUint32(0, true);
  switch (type) {
    case FRAME_TYPE_FILE_START: {
      if (bytes.byteLength < 4 + 4 + 2) throw new FrameDecodeError('framing: truncated FILE_START');
      const photoIdx = dv.getUint32(4, true);
      const fnLen = dv.getUint16(8, true);
      const need = 4 + 4 + 2 + fnLen + 8;
      if (bytes.byteLength !== need) throw new FrameDecodeError('framing: FILE_START length mismatch');
      let filename: string;
      try {
        filename = textDecoder.decode(new Uint8Array(bytes.buffer, bytes.byteOffset + 10, fnLen));
      } catch {
        throw new FrameDecodeError('framing: FILE_START filename not valid UTF-8');
      }
      const size = dv.getBigUint64(10 + fnLen, true);
      return { kind: 'fileStart', photoIdx, filename, size };
    }
    case FRAME_TYPE_FILE_CHUNK: {
      if (bytes.byteLength < 4 + 4) throw new FrameDecodeError('framing: truncated FILE_CHUNK');
      const photoIdx = dv.getUint32(4, true);
      const payloadLen = bytes.byteLength - 8;
      // Detached copy so receivers can retain it even after the input buffer is reused.
      const payload = new Uint8Array(payloadLen);
      payload.set(new Uint8Array(bytes.buffer, bytes.byteOffset + 8, payloadLen));
      return { kind: 'fileChunk', photoIdx, payload };
    }
    case FRAME_TYPE_FILE_END: {
      if (bytes.byteLength !== 4 + 4) throw new FrameDecodeError('framing: FILE_END length mismatch');
      const photoIdx = dv.getUint32(4, true);
      return { kind: 'fileEnd', photoIdx };
    }
    case FRAME_TYPE_SESSION_END: {
      if (bytes.byteLength !== 4) throw new FrameDecodeError('framing: SESSION_END length mismatch');
      return { kind: 'sessionEnd' };
    }
    case FRAME_TYPE_ABORT: {
      if (bytes.byteLength < 4 + 2) throw new FrameDecodeError('framing: truncated ABORT');
      const reasonLen = dv.getUint16(4, true);
      const need = 4 + 2 + reasonLen;
      if (bytes.byteLength !== need) throw new FrameDecodeError('framing: ABORT length mismatch');
      let reason: string;
      try {
        reason = textDecoder.decode(new Uint8Array(bytes.buffer, bytes.byteOffset + 6, reasonLen));
      } catch {
        throw new FrameDecodeError('framing: ABORT reason not valid UTF-8');
      }
      return { kind: 'abort', reason };
    }
    default:
      throw new FrameDecodeError('framing: unknown frame type 0x' + type.toString(16));
  }
}
