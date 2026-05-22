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
    type Subscription = { unsubscribe: () => void | Promise<void> };
    // v1.0.1 isolated-v3-10-subscribe-unserializable: the worker now returns
    // the subscription as a whole-object Comlink proxy. Calling
    // `subscription.unsubscribe()` is a remote round-trip, and the proxy
    // itself owns a worker-side MessagePort handle that must be released
    // after the unsubscribe round-trip completes — otherwise the handle
    // leaks for every job and the worker accretes ports across the session.
    //
    // v1.0.1 security-review-2026-05-22-02 (HIGH): release MUST be
    // idempotent and MUST cover the abort-before-subscribe-resolves race.
    // Previously, if `signal.aborted` was observed in the `.then` AFTER
    // the cleanup path (`onAbort`) had already run, only `unsubscribe()`
    // was called and the subscription proxy itself leaked across the
    // worker boundary. Repeated abort/restart cycles accreted Comlink
    // ports until the worker thread DoS'd.
    let activeSubscription: Subscription | null = null;
    let cleanedUp = false;

    const releaseSubscriptionProxy = (sub: Subscription | null): void => {
      if (sub === null) return;
      try {
        (sub as unknown as { [Comlink.releaseProxy]?: () => void })[
          Comlink.releaseProxy
        ]?.();
      } catch {
        // Best-effort release; never throw from cleanup paths.
      }
    };

    // Idempotent, all-paths cleanup. Removes the abort listener (so the
    // success path doesn't leak an event listener), disposes the
    // callback guard, then awaits the worker-side unsubscribe round-trip
    // before releasing both proxies — callback AND subscription. Safe to
    // call repeatedly; only the first invocation does work.
    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      signal.removeEventListener('abort', onAbort);
      guarded.dispose();
      const sub = activeSubscription;
      activeSubscription = null;
      void Promise.resolve(sub?.unsubscribe())
        .catch(() => undefined)
        .finally(() => {
          releaseSubscriptionProxy(sub);
          guarded.releaseProxy();
        });
    };

    // Guard the progress callback so any worker→main message arriving
    // after we tear down (terminal phase, abort, subscribe error) lands
    // on a typed `WorkerCryptoError(ClosedHandle)` instead of producing
    // the `rawValue.apply is not a function` unhandled rejection burst
    // observed in the P0-IDENTITY-STRESS validation gate.
    const guarded = guardComlinkProxy((event: JobProgressEvent) => {
      onJobProgress(event);
      if (isTerminalPhase(event.phase)) {
        cleanup();
        if (event.phase === 'Done') resolve();
        else if (event.phase === 'Cancelled') reject(new DOMException('Download cancelled', 'AbortError'));
        else reject(new Error(`Download failed: ${event.phase}`));
      }
    }, 'waitForTerminal.progress');

    function onAbort(): void {
      cleanup();
      reject(new DOMException('Download aborted', 'AbortError'));
    }

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });

    api.subscribe(jobId, guarded.proxy).then((subscription) => {
      if (cleanedUp) {
        // Abort-before-resolve race (security-review-2026-05-22-02): the
        // signal aborted BEFORE this `.then` ran, so `cleanup()` already
        // released the callback proxy but `activeSubscription` was still
        // null at that point. The subscription that just resolved is a
        // late-arriving worker MessagePort with no other reference — we
        // MUST unsubscribe AND release its proxy here or it leaks.
        void Promise.resolve(subscription.unsubscribe())
          .catch(() => undefined)
          .finally(() => releaseSubscriptionProxy(subscription));
        return;
      }
      activeSubscription = subscription;
    }).catch((err) => {
      cleanup();
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
        expectedHash: decodeShardHash(hashes[i]),
        // PhotoMeta does not carry per-shard encrypted sizes, so we pass a
        // generous upper bound (1 TiB) instead of 0. The rust snapshot
        // validator rejects any snapshot where `photo.bytes_written` exceeds
        // the plan's total declared size, so a 0 here makes the very first
        // commit-after-write fail with rust code 723 (DownloadSnapshotCorrupt).
        // 1 TiB per shard keeps the sum well within u64 even for thousands
        // of shards while never being undershot by a real photo.
        declaredSize: 2 ** 40,
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

/**
 * Thrown when a manifest carries a shard-hash value that is present but
 * cannot be decoded to a 32-byte SHA-256 digest (wrong length, invalid
 * charset, or otherwise malformed). The download plan MUST fail closed
 * in this case rather than silently substituting a zero digest — a zero
 * substitute would mask server-side data corruption or supply-chain
 * tampering as a generic decrypt failure, hiding the integrity signal.
 *
 * Remediates HIGH `security-review-2026-05-22-01` (GPT-5.5 review on
 * commit 7d112149).
 */
export class CorruptShardHashError extends Error {
  public readonly value: string;
  constructor(value: string) {
    // Truncate the offending value in the message so we never echo a
    // potentially attacker-controlled large blob into logs, and never
    // log key/PII-sized payloads.
    super(`Shard hash is corrupt or malformed: ${value.slice(0, 32)}`);
    this.name = 'CorruptShardHashError';
    this.value = value;
  }
}

// `originalShardHashes` / `shardHashes` are base64url-encoded SHA-256 digests
// produced by the upload pipeline (`encryptUploadShardWithEpochHandle` calls
// `sha256Base64Url`). Older test fixtures / legacy manifests may store hex,
// so accept both — but always emit a 32-byte buffer so the rust
// download-plan decoder (`bytes_32_from_value`) doesn't reject the input
// with `DownloadSnapshotCorrupt` (rust code 723).
//
// Behaviour for `value`:
//   - `null` / `undefined` / empty string → 32 zero bytes (explicit legacy
//     "missing hash" path; the integrity check downstream will still
//     reject any real shard against a zero digest because its SHA-256
//     will never equal zero).
//   - Valid 64-char hex or 32-byte base64url → decoded digest.
//   - Anything else → throw `CorruptShardHashError`. Fail closed so that
//     malformed metadata cannot be silently coerced into a zero digest
//     and masked as a generic decrypt failure later.
function decodeShardHash(value: string | null | undefined): Uint8Array {
  if (value === null || value === undefined || value === '') {
    return new Uint8Array(32);
  }
  const clean = value.startsWith('0x') ? value.slice(2) : value;
  if (clean.length === 64 && HEX_RE.test(clean)) {
    return hexToBytes(clean);
  }
  if (BASE64URL_RE.test(clean)) {
    const decoded = base64UrlToBytes(clean);
    if (decoded.length === 32) return decoded;
  }
  throw new CorruptShardHashError(value);
}
