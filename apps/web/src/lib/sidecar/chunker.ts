/**
 * Sidecar Beacon — photo chunker.
 *
 * Splits a single file's bytes (presented as a `ReadableStream<Uint8Array>`)
 * into a sequence of frames suitable for the framing layer. Yields:
 *
 *   fileStart  →  fileChunk × N  →  fileEnd
 *
 * The caller is responsible for sealing each frame via the AEAD tunnel and
 * forwarding it to the data channel; this module is pure.
 *
 * Chunk-size derivation (documented per SIDECAR.md):
 *
 *   maxChunkBytes = min(sctp.maxMessageSize, 64 KiB)
 *                 - aead overhead (16-byte tag, nonce is implicit in counter)
 *                 - frame header overhead (FILE_CHUNK = 8 bytes)
 *                 - safety slack (16 bytes)
 *
 * The caller computes that and passes it in via {@link ChunkerOptions}.
 */

import type { Frame } from './framing';

export interface ChunkerOptions {
  /** Maximum payload bytes per `fileChunk` frame. Must be >= 1. */
  readonly maxChunkBytes: number;
}

/**
 * Stream a photo as framing-ready frames. Pulls from `body` lazily — at most
 * one chunk worth of bytes is buffered in memory at any time.
 */
export async function* chunkPhoto(
  photoIdx: number,
  filename: string,
  size: bigint,
  body: ReadableStream<Uint8Array>,
  opts: ChunkerOptions,
): AsyncGenerator<Frame, void, void> {
  if (!Number.isInteger(opts.maxChunkBytes) || opts.maxChunkBytes < 1) {
    throw new RangeError('chunker: maxChunkBytes must be a positive integer');
  }
  yield { kind: 'fileStart', photoIdx, filename, size };

  const reader = body.getReader();
  const max = opts.maxChunkBytes;
  // Carry buffer for upstream chunks larger than max; we slice into <=max pieces.
  let carry: Uint8Array | null = null;
  try {
    // Outer loop: keep reading until the upstream is done AND carry is drained.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Drain any carry first.
      if (carry && carry.byteLength >= max) {
        const out = carry.subarray(0, max);
        // Detach into a new buffer so downstream can retain.
        const payload = new Uint8Array(out.byteLength);
        payload.set(out);
        yield { kind: 'fileChunk', photoIdx, payload };
        carry = carry.byteLength === max ? null : carry.subarray(max);
        continue;
      }

      const { value, done } = await reader.read();
      if (done) {
        // Flush any short tail.
        if (carry && carry.byteLength > 0) {
          const payload = new Uint8Array(carry.byteLength);
          payload.set(carry);
          yield { kind: 'fileChunk', photoIdx, payload };
          carry = null;
        }
        break;
      }
      if (!value || value.byteLength === 0) continue;

      if (!carry) {
        carry = value;
      } else {
        // Concatenate carry + value.
        const merged: Uint8Array = new Uint8Array(carry.byteLength + value.byteLength);
        merged.set(carry, 0);
        merged.set(value, carry.byteLength);
        carry = merged;
      }
    }
  } finally {
    // Best-effort release — releaseLock throws if a read is mid-flight, so guard.
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }

  yield { kind: 'fileEnd', photoIdx };
}
