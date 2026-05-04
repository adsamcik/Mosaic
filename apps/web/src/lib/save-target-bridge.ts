import * as Comlink from 'comlink';
import type { RemoteByteSink, RemoteSaveTargetProvider } from '../workers/types';
import { openZipSaveTarget } from './save-target';

/**
 * Adapt a main-thread `WritableStream<Uint8Array>` into a Comlink-friendly
 * {@link RemoteByteSink} the coordinator worker can drive across the boundary.
 *
 * Each chunk is structured-cloned across the worker boundary; large archives
 * therefore copy chunk-by-chunk (typical client-zip chunk sizes are small,
 * so total RAM overhead is bounded by the chunk size, not the archive size).
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

/**
 * Default save-target provider used by `useAlbumDownload`. Wraps
 * `openZipSaveTarget` and adapts its `WritableStream` into a
 * {@link RemoteByteSink} so the coordinator can write across the worker
 * boundary via Comlink.
 */
export const defaultSaveTargetProvider: RemoteSaveTargetProvider = async (fileName: string) => {
  const stream = await openZipSaveTarget(fileName);
  return Comlink.proxy(makeRemoteByteSink(stream));
};
