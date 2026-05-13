import { downloadZip } from 'client-zip';
import type { JobId, PhotoId } from '../../lib/opfs-staging';

/**
 * Reasonable epoch for ZIP entries when we don't know the photo's actual
 * mtime in the worker context. Using the unix epoch keeps timestamps stable
 * across runs (helpful for byte-exact tests) and avoids leaking host clock
 * time. Real per-photo mtimes can be wired in once we plumb metadata into
 * the staged plan entry.
 */
const ZIP_DEFAULT_LAST_MODIFIED = new Date(0);

/** Plain plan-entry view the finalizer needs (avoids leaking the full Rust plan shape). */
export interface ZipFinalizerJobView {
  readonly jobId: JobId;
  readonly entries: ReadonlyArray<{ readonly photoId: PhotoId; readonly filename: string }>;
}

/** Side-effecting dependencies injected by the coordinator. */
export interface ZipFinalizerDeps {
  /** Read a staged photo as a streamable byte source. */
  readPhotoStream: (jobId: JobId, photoId: PhotoId) => Promise<ReadableStream<Uint8Array>>;
  /** Read photo file length in bytes for ZIP64 size declaration; null if unknown/missing. */
  getPhotoFileLength: (jobId: JobId, photoId: PhotoId) => Promise<number | null>;
  /**
   * Open a writable byte sink for the produced archive. The finalizer pipes
   * the streaming ZIP bytes into the returned stream and closes it.
   */
  openSaveTarget: (fileName: string) => Promise<WritableStream<Uint8Array>>;
}

/**
 * Stream a ZIP archive containing the staged photos for a finished download
 * job to the provided save target.
 *
 * - Uses `client-zip` (Phase 1 ZIP64-verified) with per-file streaming inputs
 *   and explicit `size` declarations so client-zip emits ZIP64 extra fields
 *   for files larger than 4 GiB.
 * - Photos missing from OPFS or whose size cannot be determined are skipped
 *   with a logged warning instead of failing the whole archive.
 * - Honours `signal`: aborting cancels both the source streams and the save
 *   target.
 *
 * @param job        Plan view (jobId + per-entry filenames) to archive.
 * @param fileName   Suggested archive filename (purely informational; the
 *                   actual save dialog is owned by `openSaveTarget`).
 * @param deps       Injected I/O dependencies.
 * @param signal     Abort signal observed during archive streaming.
 */
/**
 * Thrown by ZIP/per-file finalizers when one or more expected photos
 * could not be included in the produced output (missing OPFS file,
 * unreadable stream, per-photo write failure). Surfaces a clear failure
 * to the coordinator so the job phase becomes `Errored` instead of
 * `Done`, preventing the user from believing they have a complete
 * archive when they don't.
 *
 * The `missing` array is for the coordinator's failure log; it is NOT
 * displayed to the user verbatim — IDs are opaque internal handles.
 */
export class PartialExportError extends Error {
  constructor(
    message: string,
    public readonly missing: ReadonlyArray<PhotoId>,
  ) {
    super(message);
    this.name = 'PartialExportError';
  }
}

export async function runZipFinalizer(
  job: ZipFinalizerJobView,
  fileName: string,
  deps: ZipFinalizerDeps,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    throw new DOMException('Finalizer aborted', 'AbortError');
  }

  // Track every photo that was expected in the ZIP but could not be
  // streamed. The generator below populates this list. After the pipe
  // completes successfully we promote a non-empty list into a
  // PartialExportError so the coordinator can mark the job Errored.
  const missing: PhotoId[] = [];

  const target = await deps.openSaveTarget(fileName);
  const zipResponse = downloadZip(generateFiles(job, deps, signal, missing));
  const body = zipResponse.body;
  if (!body) {
    await target.close();
    if (missing.length > 0) {
      throw new PartialExportError(
        `ZIP export incomplete: ${String(missing.length)} of ${String(job.entries.length)} photos missing or unreadable`,
        missing,
      );
    }
    return;
  }

  // pipeTo({signal}) handles cancellation of both ends. We don't manually
  // call body.cancel()/target.abort() because the stream spec already does it
  // when the signal aborts, and double-cancelling produces unhandled rejections
  // in some runtimes.
  if (signal.aborted) {
    target.abort("Finalizer aborted").catch(() => undefined);
    throw new DOMException('Finalizer aborted', 'AbortError');
  }
  await body.pipeTo(target, { signal });

  if (missing.length > 0) {
    throw new PartialExportError(
      `ZIP export incomplete: ${String(missing.length)} of ${String(job.entries.length)} photos missing or unreadable`,
      missing,
    );
  }
}

interface ZipFileInput {
  readonly name: string;
  readonly lastModified: Date;
  readonly input: ReadableStream<Uint8Array>;
  readonly size: number;
}

async function* generateFiles(
  job: ZipFinalizerJobView,
  deps: ZipFinalizerDeps,
  signal: AbortSignal,
  missing: PhotoId[],
): AsyncGenerator<ZipFileInput> {
  for (const entry of job.entries) {
    if (signal.aborted) {
      return;
    }
    const size = await deps.getPhotoFileLength(job.jobId, entry.photoId);
    if (size === null || size === 0) {
      // Photo wasn't successfully staged. Track and continue so the rest
      // of the album still produces a usable archive — but the caller
      // throws PartialExportError after pipeTo so the job overall is
      // marked Errored rather than silently Done.
      missing.push(entry.photoId);
      continue;
    }
    let input: ReadableStream<Uint8Array>;
    try {
      input = await deps.readPhotoStream(job.jobId, entry.photoId);
    } catch {
      missing.push(entry.photoId);
      continue;
    }
    yield {
      name: entry.filename,
      lastModified: ZIP_DEFAULT_LAST_MODIFIED,
      input,
      size,
    };
  }
}
