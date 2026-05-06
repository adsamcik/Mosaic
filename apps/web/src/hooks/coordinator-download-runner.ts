import * as Comlink from 'comlink';
import { getOrFetchEpochKey } from '../lib/epoch-key-service';
import type { DownloadSchedule } from '../lib/download-schedule';
import type {
  CoordinatorWorkerApi,
  DownloadOutputMode,
  JobProgressEvent,
  PhotoMeta,
  StartJobInput,
} from '../workers/types';
import type { SourceStrategy } from '../workers/coordinator/source-strategy';

/**
 * Shared helpers for driving the coordinator worker from a React hook.
 *
 * Used by both the authenticated-owner hook (`useAlbumDownload`) and the
 * visitor share-link hook (`useVisitorAlbumDownload`). The two consumers
 * differ only in the `SourceStrategy` they construct.
 */

export interface RunCoordinatorDownloadArgs {
  readonly api: CoordinatorWorkerApi;
  readonly albumId: string;
  readonly albumName: string;
  readonly photos: ReadonlyArray<PhotoMeta>;
  readonly mode: DownloadOutputMode;
  /** Optional source strategy. When omitted, the worker uses its default
   *  authenticated source. Visitor flows MUST pass a `share-link` strategy. */
  readonly source?: SourceStrategy;
  /**
   * Optional conditional schedule. When omitted (or kind === 'immediate')
   * the coordinator dispatches the job right away. Non-trivial schedules
   * are persisted into the v3 snapshot and gated by the in-worker
   * ScheduleManager. The runner still subscribes for progress and resolves
   * once a terminal phase is reached, so callers see the same await
   * semantics regardless of whether the job ran immediately or later.
   */
  readonly schedule?: DownloadSchedule;
  readonly onJobProgress: (event: JobProgressEvent) => void;
  readonly signal: AbortSignal;
  readonly activeJobIdRef: { current: string | null };
}

export async function runCoordinatorDownload(args: RunCoordinatorDownloadArgs): Promise<void> {
  const planInput = await photosToPlanInput(args.albumId, args.photos);
  const suggestedFileName = args.mode.kind === 'zip' ? args.mode.fileName : `${args.albumName}.zip`;
  const baseInput: StartJobInput = args.mode.kind === 'zip'
    ? { ...planInput, outputMode: { kind: 'zip', fileName: suggestedFileName } }
    : { ...planInput, outputMode: args.mode };
  // Comlink-proxy the source so its async methods are callable from the
  // coordinator worker (the strategy holds React-state callbacks).
  const withSource: StartJobInput = args.source
    ? { ...baseInput, source: Comlink.proxy(args.source) }
    : baseInput;
  const startInput: StartJobInput = args.schedule
    ? { ...withSource, schedule: args.schedule }
    : withSource;

  const { jobId } = await args.api.startJob(startInput);
  args.activeJobIdRef.current = jobId;
  await waitForTerminal(args.api, jobId, args.signal, args.onJobProgress);
}

export function isTerminalPhase(phase: JobProgressEvent['phase']): boolean {
  return phase === 'Done' || phase === 'Errored' || phase === 'Cancelled';
}

export async function waitForTerminal(
  api: CoordinatorWorkerApi,
  jobId: string,
  signal: AbortSignal,
  onJobProgress: (event: JobProgressEvent) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    const onAbort = (): void => {
      unsubscribe?.();
      reject(new DOMException('Download aborted', 'AbortError'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });

    api.subscribe(jobId, Comlink.proxy((event: JobProgressEvent) => {
      onJobProgress(event);
      if (isTerminalPhase(event.phase)) {
        signal.removeEventListener('abort', onAbort);
        unsubscribe?.();
        if (event.phase === 'Done') resolve();
        else if (event.phase === 'Cancelled') reject(new DOMException('Download cancelled', 'AbortError'));
        else reject(new Error(`Download failed: ${event.phase}`));
      }
    })).then((subscription) => {
      unsubscribe = subscription.unsubscribe;
      if (signal.aborted) {
        unsubscribe();
        // onAbort already rejected.
      }
    }).catch((err) => {
      signal.removeEventListener('abort', onAbort);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

/**
 * Convert PhotoMeta records into the Rust download-plan input shape.
 *
 * Resolves the per-photo epoch (needed for tier-3 shard fetch). Photos
 * without tier-3 shards are skipped. For visitor (share-link) flows the
 * `getOrFetchEpochKey` warm-up is a best-effort no-op when the visitor has
 * no authenticated epoch service available.
 */
export async function photosToPlanInput(albumId: string, photos: ReadonlyArray<PhotoMeta>): Promise<{
  readonly albumId: string;
  readonly photos: ReadonlyArray<{
    readonly photoId: string;
    readonly filename: string;
    readonly shards: ReadonlyArray<{
      readonly shardId: Uint8Array;
      readonly epochId: number;
      readonly tier: number;
      readonly expectedHash: Uint8Array;
      readonly declaredSize: number;
    }>;
  }>;
}> {
  const out: Array<{
    readonly photoId: string;
    readonly filename: string;
    readonly shards: ReadonlyArray<{
      readonly shardId: Uint8Array;
      readonly epochId: number;
      readonly tier: number;
      readonly expectedHash: Uint8Array;
      readonly declaredSize: number;
    }>;
  }> = [];
  for (const photo of photos) {
    const shardIds = photo.originalShardIds ?? (photo.shardIds.length > 2 ? photo.shardIds.slice(2) : photo.shardIds);
    if (shardIds.length === 0) continue;
    const hashes = photo.originalShardHashes ?? (photo.shardHashes && photo.shardHashes.length > 2 ? photo.shardHashes.slice(2) : []);
    // Best-effort epoch warm-up; safe to ignore failures (visitor flow has
    // no epoch-key service, the call simply rejects and is swallowed).
    void getOrFetchEpochKey(albumId, photo.epochId).catch(() => undefined);
    out.push({
      photoId: photo.id,
      filename: photo.filename || `photo-${photo.id.slice(0, 8)}.jpg`,
      shards: shardIds.map((id, i) => ({
        shardId: hexToBytes(id),
        epochId: photo.epochId,
        tier: 3,
        expectedHash: hashes[i] !== undefined ? hexToBytes(hashes[i]!) : new Uint8Array(32),
        declaredSize: 0,
      })),
    });
  }
  return { albumId, photos: out };
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(Math.ceil(clean.length / 2));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
