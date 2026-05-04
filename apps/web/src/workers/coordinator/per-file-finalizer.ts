import { createLogger } from '../../lib/logger';
import type { JobId, PhotoId } from '../../lib/opfs-staging';
import type { PerFileStrategy } from '../types';

const log = createLogger('PerFileFinalizer');

export interface PerFileFinalizerJobView {
  readonly jobId: JobId;
  readonly entries: ReadonlyArray<{ readonly photoId: PhotoId; readonly filename: string }>;
}

export interface PerFilePhotoPlanEntry {
  readonly photoId: PhotoId;
  readonly filename: string;
  readonly sizeBytes: number;
}

export interface PerFileSaveSink {
  /** Write one photo to its destination. Idempotent; safe to call after abort. */
  writeOne(
    photoId: PhotoId,
    filename: string,
    sizeBytes: number,
    stream: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): Promise<void>;
  /** Finalize: trigger Web Share if applicable; close all open writables. */
  finalize(): Promise<void>;
  /** Abort: cancel all open writables; for Web Share, drop the buffer. */
  abort(): Promise<void>;
}

export interface PerFileFinalizerDeps {
  readPhotoStream: (jobId: JobId, photoId: PhotoId) => Promise<ReadableStream<Uint8Array>>;
  getPhotoFileLength: (jobId: JobId, photoId: PhotoId) => Promise<number | null>;
  openPerFileSaveTarget: (strategy: PerFileStrategy, photos: ReadonlyArray<PerFilePhotoPlanEntry>) => Promise<PerFileSaveSink>;
}

export async function runPerFileFinalizer(
  job: PerFileFinalizerJobView,
  strategy: PerFileStrategy,
  deps: PerFileFinalizerDeps,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (job.entries.length === 0) {
    return;
  }

  const photos = await buildPhotoPlan(job, deps, signal);
  if (photos.length === 0) {
    return;
  }

  const sink = await deps.openPerFileSaveTarget(strategy, photos);
  let completed = false;
  try {
    for (const photo of photos) {
      throwIfAborted(signal);
      try {
        const stream = await deps.readPhotoStream(job.jobId, photo.photoId);
        throwIfAborted(signal);
        await sink.writeOne(photo.photoId, photo.filename, photo.sizeBytes, stream, signal);
      } catch (err) {
        if (signal.aborted || isAbortError(err)) {
          throw new DOMException('Finalizer aborted', 'AbortError');
        }
        log.warn('Per-file photo export failed', {
          jobId: shortId(job.jobId),
          photoId: shortId(photo.photoId),
          strategy,
          errorName: err instanceof Error ? err.name : 'Unknown',
        });
      }
    }
    throwIfAborted(signal);
    await sink.finalize();
    completed = true;
  } finally {
    if (!completed && signal.aborted) {
      await sink.abort().catch(() => undefined);
    }
  }
}

async function buildPhotoPlan(
  job: PerFileFinalizerJobView,
  deps: PerFileFinalizerDeps,
  signal: AbortSignal,
): Promise<PerFilePhotoPlanEntry[]> {
  const photos: PerFilePhotoPlanEntry[] = [];
  for (const entry of job.entries) {
    throwIfAborted(signal);
    let sizeBytes: number | null;
    try {
      sizeBytes = await deps.getPhotoFileLength(job.jobId, entry.photoId);
    } catch (err) {
      log.warn('Per-file photo size unavailable', {
        jobId: shortId(job.jobId),
        photoId: shortId(entry.photoId),
        errorName: err instanceof Error ? err.name : 'Unknown',
      });
      continue;
    }
    if (sizeBytes === null || sizeBytes === 0) {
      continue;
    }
    photos.push({ photoId: entry.photoId, filename: entry.filename, sizeBytes });
  }
  return photos;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Finalizer aborted', 'AbortError');
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function shortId(id: string): string {
  return id.slice(0, 8);
}
