import * as Comlink from 'comlink';
import { guardComlinkProxy } from '../lib/comlink-proxy-guard';
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
  const startInput: StartJobInput = args.schedule
    ? { ...baseInput, schedule: args.schedule }
    : baseInput;
  // Comlink-proxy the source so its async methods are callable from the
  // coordinator worker (the strategy holds React-state callbacks). The
  // proxy registers a worker-side handle that survives until we release
  // it explicitly via `[Comlink.releaseProxy]()` — the audit
  // "perf-slo H1" found that without this every cancel/restart leaked
  // worker memory. We release in a finally so the cleanup runs on success,
  // failure, AND abort.
  //
  // v1.0.1 isolated-v3-10 (W-A6-6): the strategy is passed as a SEPARATE
  // top-level argument to `startJob`. Comlink only honors the proxy marker
  // on top-level args; a strategy nested in `StartJobInput.source` would
  // be structured-cloned and crash with `DataCloneError` on its function
  // members. See `visitor-strategy-postmessage.test.ts`.
  let sourceProxy: SourceStrategy | null = null;
  if (args.source) {
    sourceProxy = Comlink.proxy(args.source) as unknown as SourceStrategy;
  }

  try {
    const { jobId } = sourceProxy
      ? await args.api.startJob(startInput, sourceProxy)
      : await args.api.startJob(startInput);
    args.activeJobIdRef.current = jobId;
    await waitForTerminal(args.api, jobId, args.signal, args.onJobProgress);
  } finally {
    if (sourceProxy) {
      try {
        (sourceProxy as unknown as { [Comlink.releaseProxy]?: () => void })[
          Comlink.releaseProxy
        ]?.();
      } catch {
        // Best-effort release; never block job completion on cleanup.
      }
    }
  }
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
    let activeSubscription: { unsubscribe: () => void | Promise<void> } | null = null;
    const callUnsubscribe = (): void => {
      void activeSubscription?.unsubscribe();
    };
    // Guard the progress callback so any worker→main message arriving
    // after we tear down (terminal phase, abort, subscribe error) lands
    // on a typed `WorkerCryptoError(ClosedHandle)` instead of producing
    // the `rawValue.apply is not a function` unhandled rejection burst
    // observed in the P0-IDENTITY-STRESS validation gate.
    const guarded = guardComlinkProxy((event: JobProgressEvent) => {
      onJobProgress(event);
      if (isTerminalPhase(event.phase)) {
        signal.removeEventListener('abort', onAbort);
        callUnsubscribe();
        guarded.dispose();
        // Defer release until after the worker has acknowledged the
        // unsubscribe so in-flight progress messages land on the
        // dispose-guard, not a released proxy slot.
        void Promise.resolve(activeSubscription?.unsubscribe())
          .catch(() => undefined)
          .finally(() => guarded.releaseProxy());
        if (event.phase === 'Done') resolve();
        else if (event.phase === 'Cancelled') reject(new DOMException('Download cancelled', 'AbortError'));
        else reject(new Error(`Download failed: ${event.phase}`));
      }
    }, 'waitForTerminal.progress');
    const onAbort = (): void => {
      callUnsubscribe();
      guarded.dispose();
      void Promise.resolve(activeSubscription?.unsubscribe())
        .catch(() => undefined)
        .finally(() => guarded.releaseProxy());
      reject(new DOMException('Download aborted', 'AbortError'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });

    api.subscribe(jobId, guarded.proxy).then((subscription) => {
      activeSubscription = subscription;
      if (signal.aborted) {
        callUnsubscribe();
        // onAbort already rejected.
      }
    }).catch((err) => {
      signal.removeEventListener('abort', onAbort);
      guarded.dispose();
      guarded.releaseProxy();
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
        shardId: decodeShardId(id),
        epochId: photo.epochId,
        tier: 3,
        expectedHash: hashes[i] !== undefined ? decodeShardHash(hashes[i]!) : new Uint8Array(32),
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

const HEX_RE = /^[0-9a-fA-F]+$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function base64UrlToBytes(value: string): Uint8Array {
  const padLen = (4 - (value.length % 4)) % 4;
  const padded =
    value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

// Shard IDs are produced by tusdotnet's GuidFileIdProvider as 32 hex chars
// (no dashes). Keep a base64url fallback for forward-compatibility with any
// alternate provider that emits 22-char base64url IDs.
function decodeShardId(value: string): Uint8Array {
  const clean = value.startsWith('0x') ? value.slice(2) : value;
  if (clean.length === 32 && HEX_RE.test(clean)) {
    return hexToBytes(clean);
  }
  if (BASE64URL_RE.test(clean)) {
    const decoded = base64UrlToBytes(clean);
    if (decoded.length === 16) return decoded;
  }
  // Last-resort: legacy hex path (still 16 bytes when input is 32 hex chars).
  return hexToBytes(clean);
}

// `originalShardHashes` / `shardHashes` are base64url-encoded SHA-256 digests
// produced by the upload pipeline (`encryptUploadShardWithEpochHandle` calls
// `sha256Base64Url`). Older test fixtures / legacy manifests may store hex,
// so accept both — but always emit a 32-byte buffer so the rust
// download-plan decoder (`bytes_32_from_value`) doesn't reject the input
// with `DownloadSnapshotCorrupt` (rust code 723).
function decodeShardHash(value: string): Uint8Array {
  const clean = value.startsWith('0x') ? value.slice(2) : value;
  if (clean.length === 64 && HEX_RE.test(clean)) {
    return hexToBytes(clean);
  }
  if (BASE64URL_RE.test(clean)) {
    const decoded = base64UrlToBytes(clean);
    if (decoded.length === 32) return decoded;
  }
  // Malformed hash — return zeros so the rust decoder still gets 32 bytes;
  // shard-integrity verification later will catch the mismatch with a
  // clearer error than a CBOR-shape failure.
  return new Uint8Array(32);
}
