import { ApiError } from '../../lib/api';
import { ShardDownloadError } from '../../lib/shard-service';
import type { CryptoPool, DownloadErrorCode } from '../crypto-pool';
import { DownloadError } from '../crypto-pool';

/** A download plan entry in the coordinator's per-photo pipeline. */
export interface DownloadPlanEntry {
  readonly photoId: string;
  readonly epochId: number;
  readonly tier: number;
  readonly shardIds: readonly string[];
  readonly expectedHashes: readonly Uint8Array[];
  readonly filename: string;
  readonly totalBytes: number;
}

/** Injection seams for authenticated and share-link download strategies. */
export interface PhotoPipelineDeps {
  readonly pool: CryptoPool;
  readonly fetchShards: (shardIds: string[], signal: AbortSignal) => Promise<Uint8Array[]>;
  readonly getEpochSeed: (albumId: string, epochId: number) => Promise<Uint8Array>;
  readonly writePhotoChunk: (jobId: string, photoId: string, offset: number, bytes: Uint8Array) => Promise<void>;
  readonly truncatePhoto: (jobId: string, photoId: string, length: number) => Promise<void>;
  readonly getPhotoFileLength: (jobId: string, photoId: string) => Promise<number | null>;
  /** Report cumulative bytes written for this photo; coordinator owns persistence rate-limiting. */
  readonly reportBytesWritten?: (jobId: string, photoId: string, bytesWritten: number) => void;
}

/** Stable reasons for non-fatal per-photo skips. */
export type SkipReason = 'NotFound' | 'UserExcluded';

/** Outcome of one per-photo download pipeline execution. */
export type PhotoOutcome =
  | { readonly kind: 'done'; readonly bytesWritten: number }
  | { readonly kind: 'failed'; readonly code: DownloadErrorCode; readonly retryAfterMs?: number }
  | { readonly kind: 'skipped'; readonly reason: SkipReason };

/** Inputs for one photo's download task. */
export interface PhotoTaskInput {
  readonly jobId: string;
  readonly albumId: string;
  readonly entry: DownloadPlanEntry;
  readonly resumeFromBytes?: number;
  readonly signal: AbortSignal;
}

const MAX_NETWORK_ATTEMPTS = 3;
const MAX_INTEGRITY_ATTEMPTS = 2;

/** Execute one photo's full fetch → verify → decrypt → OPFS staging pipeline. */
export async function executePhotoTask(input: PhotoTaskInput, deps: PhotoPipelineDeps): Promise<PhotoOutcome> {
  try {
    await reconcileResumeBytes(input, deps);
    throwIfAborted(input.signal);

    if (input.entry.totalBytes === 0 && input.entry.shardIds.length === 0) {
      await deps.writePhotoChunk(input.jobId, input.entry.photoId, 0, new Uint8Array());
      deps.reportBytesWritten?.(input.jobId, input.entry.photoId, 0);
      return { kind: 'done', bytesWritten: 0 };
    }

    const epochSeed = await deps.getEpochSeed(input.albumId, input.entry.epochId);
    let lastTransientRetryAfterMs = backoffMs(1);

    for (let attempt = 1; attempt <= MAX_NETWORK_ATTEMPTS; attempt += 1) {
      try {
        const encryptedShards = await deps.fetchShards([...input.entry.shardIds], input.signal);
        throwIfAborted(input.signal);
        const verifyOutcome = await verifyAndDecrypt(encryptedShards, epochSeed, input, deps);
        if (verifyOutcome.kind !== 'done') {
          return verifyOutcome;
        }
        await deps.writePhotoChunk(input.jobId, input.entry.photoId, 0, verifyOutcome.bytes);
        deps.reportBytesWritten?.(input.jobId, input.entry.photoId, verifyOutcome.bytes.byteLength);
        return { kind: 'done', bytesWritten: verifyOutcome.bytes.byteLength };
      } catch (error) {
        const classified = classifyPipelineError(error);
        if (classified === 'Cancelled') {
          return { kind: 'failed', code: 'Cancelled' };
        }
        if (classified === 'NotFound') {
          return { kind: 'skipped', reason: 'NotFound' };
        }
        if (classified === 'Quota') {
          return { kind: 'failed', code: 'Quota' };
        }
        if (classified === 'AuthorizationChanged' || classified === 'AccessRevoked') {
          return { kind: 'failed', code: classified };
        }
        if (classified === 'TransientNetwork') {
          lastTransientRetryAfterMs = backoffMs(attempt);
          if (attempt < MAX_NETWORK_ATTEMPTS) {
            continue;
          }
          return { kind: 'failed', code: 'TransientNetwork', retryAfterMs: lastTransientRetryAfterMs };
        }
        if (classified === 'Decrypt') {
          return { kind: 'failed', code: 'Decrypt' };
        }
        if (classified === 'Integrity') {
          return { kind: 'failed', code: 'Integrity' };
        }
        return { kind: 'failed', code: 'IllegalState' };
      }
    }

    return { kind: 'failed', code: 'TransientNetwork', retryAfterMs: lastTransientRetryAfterMs };
  } catch (error) {
    const classified = classifyPipelineError(error);
    if (classified === 'Quota') {
      return { kind: 'failed', code: 'Quota' };
    }
    if (classified === 'Cancelled') {
      return { kind: 'failed', code: 'Cancelled' };
    }
    return { kind: 'failed', code: classified };
  }
}

async function verifyAndDecrypt(
  encryptedShards: readonly Uint8Array[],
  epochSeed: Uint8Array,
  input: PhotoTaskInput,
  deps: PhotoPipelineDeps,
): Promise<{ readonly kind: 'done'; readonly bytes: Uint8Array } | { readonly kind: 'failed'; readonly code: DownloadErrorCode }> {
  if (encryptedShards.length !== input.entry.expectedHashes.length) {
    return { kind: 'failed', code: 'IllegalState' };
  }

  for (let attempt = 1; attempt <= MAX_INTEGRITY_ATTEMPTS; attempt += 1) {
    try {
      for (let index = 0; index < encryptedShards.length; index += 1) {
        throwIfAborted(input.signal);
        const shard = encryptedShards[index];
        const hash = input.entry.expectedHashes[index];
        if (!shard || !hash) {
          return { kind: 'failed', code: 'IllegalState' };
        }
        await deps.pool.verifyShard(shard, hash);
      }
      const plaintextShards: Uint8Array[] = [];
      for (const shard of encryptedShards) {
        throwIfAborted(input.signal);
        plaintextShards.push(await deps.pool.decryptShard(shard, epochSeed));
      }
      return { kind: 'done', bytes: concatBytes(plaintextShards) };
    } catch (error) {
      const classified = classifyPipelineError(error);
      if (classified === 'Integrity' && attempt < MAX_INTEGRITY_ATTEMPTS) {
        continue;
      }
      return { kind: 'failed', code: classified };
    }
  }
  return { kind: 'failed', code: 'Integrity' };
}

async function reconcileResumeBytes(input: PhotoTaskInput, deps: PhotoPipelineDeps): Promise<void> {
  const resumeFromBytes = input.resumeFromBytes ?? 0;
  if (resumeFromBytes <= 0) {
    return;
  }
  const actualLength = await deps.getPhotoFileLength(input.jobId, input.entry.photoId);
  if (actualLength === null || actualLength < resumeFromBytes) {
    await deps.truncatePhoto(input.jobId, input.entry.photoId, 0);
    return;
  }
  if (actualLength > resumeFromBytes) {
    await deps.truncatePhoto(input.jobId, input.entry.photoId, resumeFromBytes);
  }
}

function classifyPipelineError(error: unknown): DownloadErrorCode {
  if (isAbortError(error)) {
    return 'Cancelled';
  }
  if (error instanceof DownloadError) {
    return error.code;
  }
  const unwrapped = unwrapShardError(error);
  if (unwrapped !== error) {
    return classifyPipelineError(unwrapped);
  }
  if (unwrapped instanceof ApiError) {
    return classifyStatus(unwrapped.status);
  }
  const status = statusFromUnknown(unwrapped);
  if (status !== null) {
    return classifyStatus(status);
  }
  if (unwrapped instanceof DOMException && unwrapped.name === 'QuotaExceededError') {
    return 'Quota';
  }
  if (unwrapped instanceof Error) {
    const name = unwrapped.name.toLowerCase();
    const message = unwrapped.message.toLowerCase();
    if (name.includes('quota') || message.includes('quota')) {
      return 'Quota';
    }
    if (name.includes('abort') || message.includes('abort')) {
      return 'Cancelled';
    }
    if (message.includes('network') || message.includes('failed to fetch')) {
      return 'TransientNetwork';
    }
  }
  return 'TransientNetwork';
}

function classifyStatus(status: number): DownloadErrorCode {
  if (status === 401) return 'AuthorizationChanged';
  if (status === 403) return 'AccessRevoked';
  if (status === 404) return 'NotFound';
  if (status >= 500) return 'TransientNetwork';
  return 'IllegalState';
}

function unwrapShardError(error: unknown): unknown {
  return error instanceof ShardDownloadError ? error.cause : error;
}

function statusFromUnknown(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return null;
  }
  const status = error.status;
  return typeof status === 'number' ? status : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DownloadError('Cancelled', 'Photo task cancelled');
  }
}

function backoffMs(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** Math.max(0, attempt - 1));
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export const __photoPipelineTestUtils = { classifyPipelineError, backoffMs };
