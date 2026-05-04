import * as Comlink from 'comlink';
import type { PerFilePhotoMeta, PerFileStrategy, RemoteByteSink, RemotePerFileSaveSink, RemoteSaveTargetProvider } from '../workers/types';
import { openPerFileSaveTarget, openZipSaveTarget } from './save-target';

/**
 * Adapt a main-thread `WritableStream<Uint8Array>` into a Comlink-friendly
 * {@link RemoteByteSink} the coordinator worker can drive across the boundary.
 */
export function makeRemoteByteSink(stream: WritableStream<Uint8Array>): RemoteByteSink {
  const writer = stream.getWriter();
  return {
    async write(chunk: Uint8Array): Promise<void> {
      await writer.ready;
      await writer.write(chunk);
    },
    async close(): Promise<void> {
      await writer.close();
    },
    async abort(reason?: string): Promise<void> {
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
    return Comlink.proxy({
      async openOne(_photoId: string, filename: string, sizeBytes: number): Promise<RemoteByteSink> {
        const stream = await target.openOne(filename, sizeBytes);
        return Comlink.proxy(makeRemoteByteSink(stream));
      },
      async finalize(): Promise<void> {
        await target.finalize();
      },
      async abort(): Promise<void> {
        await target.abort();
      },
    });
  },
};
