/**
 * Sidecar Beacon — receive-side save sink.
 *
 * Drives a {@link PerFileSaveTarget} (the existing per-file save abstraction
 * used by the primary save flow) from a stream of decoded {@link Frame}s.
 *
 * State machine:
 *
 *   idle ─ fileStart ─▶ inFile(idx, writer)
 *   inFile ─ fileChunk(idx) ─▶ inFile (writes payload, increments bytesWritten)
 *   inFile ─ fileEnd(idx)   ─▶ idle  (closes writer, fires onPhotoComplete)
 *   idle|inFile ─ abort     ─▶ aborted (aborts in-flight writer; drops further frames)
 *   idle ─ sessionEnd       ─▶ ended  (calls finalize(), fires onSessionEnd)
 *
 * Out-of-state transitions throw {@link SidecarReceiveError}. Receivers should
 * abort the connection on these errors — they indicate a malformed / hostile
 * sender.
 *
 * ZK-safe: this module never logs filenames, photo bytes, or sizes.
 */

import type { PerFileSaveTarget } from '../save-target';
import type { Frame } from './framing';

export class SidecarReceiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SidecarReceiveError';
  }
}

export interface SidecarReceiveSinkOptions {
  readonly saveTarget: PerFileSaveTarget;
  readonly onProgress?: (photoIdx: number, bytesWritten: bigint, totalBytes: bigint) => void;
  readonly onPhotoComplete?: (photoIdx: number, filename: string) => void;
  readonly onSessionEnd?: () => void;
  readonly onAbort?: (reason: string) => void;
}

export interface SidecarReceiveSink {
  /**
   * Feed a decoded frame into the sink. Returns when the frame is fully
   * processed (writer.write() awaited).
   */
  process(frame: Frame): Promise<void>;
  /**
   * Abort any in-flight file and dispose the underlying save target. Idempotent.
   */
  close(): Promise<void>;
}

type State =
  | { readonly tag: 'idle' }
  | {
      readonly tag: 'inFile';
      readonly photoIdx: number;
      readonly filename: string;
      readonly totalBytes: bigint;
      readonly writer: WritableStreamDefaultWriter<Uint8Array>;
      bytesWritten: bigint;
    }
  | { readonly tag: 'ended' }
  | { readonly tag: 'aborted' }
  | { readonly tag: 'closed' };

export function createSidecarReceiveSink(opts: SidecarReceiveSinkOptions): SidecarReceiveSink {
  let state: State = { tag: 'idle' };

  async function abortInFlight(reason: string): Promise<void> {
    if (state.tag === 'inFile') {
      const w = state.writer;
      try {
        await w.abort(reason);
      } catch {
        /* swallow: already errored */
      }
      try {
        w.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }

  return {
    async process(frame: Frame): Promise<void> {
      if (state.tag === 'closed') {
        throw new SidecarReceiveError('sink: process after close');
      }
      if (state.tag === 'aborted') {
        // Silently drop — sender already signalled abort, ignore stragglers.
        return;
      }
      if (state.tag === 'ended') {
        throw new SidecarReceiveError('sink: frame after sessionEnd');
      }

      switch (frame.kind) {
        case 'fileStart': {
          if (state.tag !== 'idle') {
            throw new SidecarReceiveError('sink: fileStart while another file is in progress');
          }
          const stream = await opts.saveTarget.openOne(
            frame.filename,
            // openOne wants `number`. u64 photos cap at Number.MAX_SAFE_INTEGER (~8 PiB);
            // anything larger is rejected up-front.
            (() => {
              if (frame.size > BigInt(Number.MAX_SAFE_INTEGER)) {
                throw new SidecarReceiveError('sink: file size exceeds Number.MAX_SAFE_INTEGER');
              }
              return Number(frame.size);
            })(),
          );
          const writer = stream.getWriter();
          state = {
            tag: 'inFile',
            photoIdx: frame.photoIdx,
            filename: frame.filename,
            totalBytes: frame.size,
            writer,
            bytesWritten: 0n,
          };
          return;
        }
        case 'fileChunk': {
          if (state.tag !== 'inFile') {
            throw new SidecarReceiveError('sink: fileChunk without preceding fileStart');
          }
          if (frame.photoIdx !== state.photoIdx) {
            throw new SidecarReceiveError('sink: fileChunk photoIdx mismatch');
          }
          await state.writer.write(frame.payload);
          state.bytesWritten += BigInt(frame.payload.byteLength);
          if (state.bytesWritten > state.totalBytes) {
            // Sender wrote more bytes than declared. This is malformed.
            const w = state.writer;
            state = { tag: 'aborted' };
            try { await w.abort('size-exceeded'); } catch { /* swallow */ }
            try { w.releaseLock(); } catch { /* ignore */ }
            try { await opts.saveTarget.abort(); } catch { /* swallow */ }
            opts.onAbort?.('size-exceeded');
            throw new SidecarReceiveError('sink: chunk overflows declared file size');
          }
          opts.onProgress?.(state.photoIdx, state.bytesWritten, state.totalBytes);
          return;
        }
        case 'fileEnd': {
          if (state.tag !== 'inFile') {
            throw new SidecarReceiveError('sink: fileEnd without active file');
          }
          if (frame.photoIdx !== state.photoIdx) {
            throw new SidecarReceiveError('sink: fileEnd photoIdx mismatch');
          }
          if (state.bytesWritten !== state.totalBytes) {
            // Truncated transfer. Abort the partial.
            const w = state.writer;
            const cur = state;
            state = { tag: 'aborted' };
            try { await w.abort('truncated'); } catch { /* swallow */ }
            try { w.releaseLock(); } catch { /* ignore */ }
            opts.onAbort?.('truncated');
            void cur;
            throw new SidecarReceiveError('sink: fileEnd before all declared bytes received');
          }
          const { writer, photoIdx, filename } = state;
          await writer.close();
          try { writer.releaseLock(); } catch { /* ignore */ }
          state = { tag: 'idle' };
          opts.onPhotoComplete?.(photoIdx, filename);
          return;
        }
        case 'sessionEnd': {
          if (state.tag === 'inFile') {
            throw new SidecarReceiveError('sink: sessionEnd while file in progress');
          }
          await opts.saveTarget.finalize();
          state = { tag: 'ended' };
          opts.onSessionEnd?.();
          return;
        }
        case 'abort': {
          await abortInFlight(frame.reason);
          try { await opts.saveTarget.abort(); } catch { /* swallow */ }
          state = { tag: 'aborted' };
          opts.onAbort?.(frame.reason);
          return;
        }
        default: {
          const _exhaustive: never = frame;
          throw new SidecarReceiveError('sink: unknown frame kind ' + String(_exhaustive));
        }
      }
    },

    async close(): Promise<void> {
      if (state.tag === 'closed') return;
      if (state.tag === 'inFile') {
        await abortInFlight('sink-closed');
        try { await opts.saveTarget.abort(); } catch { /* swallow */ }
      } else if (state.tag === 'idle' || state.tag === 'aborted') {
        try { await opts.saveTarget.abort(); } catch { /* swallow */ }
      }
      // 'ended' state already finalized; do not call abort.
      state = { tag: 'closed' };
    },
  };
}

