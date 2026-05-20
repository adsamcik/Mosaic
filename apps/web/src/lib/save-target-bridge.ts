import * as Comlink from 'comlink';
import type { PerFilePhotoMeta, PerFileStrategy, RemoteByteSink, RemotePerFileSaveSink, RemoteSaveTargetProvider } from '../workers/types';
import { WorkerCryptoError } from '../workers/types';
import { WorkerCryptoErrorCode } from '../workers/worker-crypto-error-code.generated';
import { openPerFileSaveTarget, openZipSaveTarget } from './save-target';

/**
 * Adapt a main-thread `WritableStream<Uint8Array>` into a Comlink-friendly
 * {@link RemoteByteSink} the coordinator worker can drive across the boundary.
 *
 * The returned sink carries an internal `closed` flag so any worker-issued
 * `write()` that lands after a `close()`/`abort()` (a normal race when the
 * coordinator pipelines writes) is rejected with a typed
 * `WorkerCryptoError(ClosedHandle)` instead of surfacing as Comlink's
 * cryptic `TypeError: rawValue.apply is not a function` unhandled rejection
 * (P0-IDENTITY-STRESS validation gate).
 */
export function makeRemoteByteSink(stream: WritableStream<Uint8Array>): RemoteByteSink {
  const writer = stream.getWriter();
  let closed = false;
  const guard = (label: string): void => {
    if (closed) {
      throw new WorkerCryptoError(
        WorkerCryptoErrorCode.ClosedHandle,
        `RemoteByteSink ${label} after close/abort`,
      );
    }
  };
  return {
    async write(chunk: Uint8Array): Promise<void> {
      guard('write');
      await writer.ready;
      await writer.write(chunk);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await writer.close();
    },
    async abort(reason?: string): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        await writer.abort(reason ?? 'aborted');
      } catch {
        // Aborting a closed stream throws; swallow.
      }
    },
  };
}

/** Default save-target provider used by `useAlbumDownload`. */
export const defaultSaveTargetProvider: RemoteSaveTargetProvider = {
  async openZipSaveTarget(fileName: string): Promise<RemoteByteSink> {
    const stream = await openZipSaveTarget(fileName);
    return Comlink.proxy(makeRemoteByteSink(stream));
  },

  async openPerFileSaveTarget(
    strategy: PerFileStrategy,
    photos: ReadonlyArray<PerFilePhotoMeta>,
  ): Promise<RemotePerFileSaveSink> {
    const target = await openPerFileSaveTarget(strategy, photos);
    // Per-file save-target state flag: parallel to RemoteByteSink's
    // `closed` flag, this guards `openOne()` after `finalize()`/`abort()`
    // so a late worker-side call lands on a typed ClosedHandle error.
    let closed = false;
    return Comlink.proxy({
      async openOne(_photoId: string, filename: string, sizeBytes: number): Promise<RemoteByteSink> {
        if (closed) {
          throw new WorkerCryptoError(
            WorkerCryptoErrorCode.ClosedHandle,
            'RemotePerFileSaveSink openOne after finalize/abort',
          );
        }
        const stream = await target.openOne(filename, sizeBytes);
        return Comlink.proxy(makeRemoteByteSink(stream));
      },
      async finalize(): Promise<void> {
        if (closed) return;
        closed = true;
        await target.finalize();
      },
      async abort(): Promise<void> {
        if (closed) return;
        closed = true;
        await target.abort();
      },
    });
  },
};
