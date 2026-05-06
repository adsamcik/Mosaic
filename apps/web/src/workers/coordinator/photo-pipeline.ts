import { deriveTierKeys, memzero } from '@mosaic/crypto';
import { ApiError } from '../../lib/api';
import { ShardDownloadError } from '../../lib/shard-service';
import type { CryptoPool, DownloadErrorCode } from '../crypto-pool';
import { DownloadError } from '../crypto-pool';
import {
  rustOpenStreamingShard,
  type StreamingShardDecryptor,
} from '../rust-crypto-core';
import type { ShardMirror } from './shard-mirror';
import { shardMirrorKey } from './shard-mirror';
import type { DecryptCache } from './decrypt-cache';

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
  /**
   * Open a streaming-AEAD decryptor over a shard envelope (variant 1).
   * Defaults to the production WASM-backed implementation. Tests inject a
   * fake to exercise the streaming path without WASM.
   */
  readonly openStreamingShard?: (envelopeHeader: Uint8Array, key: Uint8Array) => Promise<StreamingShardDecryptor>;
  /**
   * Optional ambient mirror — peeked before each shard fetch and populated on
   * miss after integrity verification. Caches encrypted bytes only.
   */
  readonly mirror?: ShardMirror;
  /** Optional epoch-key cache shared across photos in the same album. */
  readonly decryptCache?: DecryptCache;
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

const SHARD_ENVELOPE_HEADER_BYTES = 64;
/** Reserved[0] within the 64-byte shard envelope header. */
const ENVELOPE_VARIANT_BYTE_OFFSET = 38;
const STREAMING_ENVELOPE_VARIANT = 1;
/** Per-chunk Poly1305 tag length appended to the wire-format chunk. */
const STREAMING_CHUNK_TAG_BYTES = 16;
/**
 * Above this on-wire shard size the photo pipeline switches to streaming
 * decrypt so peak resident plaintext stays bounded by chunkSize + a couple
 * of small fixed buffers (target peak < 4 MB).
 */
const STREAMING_SHARD_THRESHOLD_BYTES = 16 * 1024 * 1024;

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

    const epochSeed = await resolveEpochSeed(input, deps);
    let lastTransientRetryAfterMs = backoffMs(1);

    for (let attempt = 1; attempt <= MAX_NETWORK_ATTEMPTS; attempt += 1) {
      try {
        const fetched = await fetchShardsWithMirror(input, deps);
        throwIfAborted(input.signal);
        const outcome = await verifyDecryptAndWrite(fetched.shards, fetched.fromMirror, epochSeed, input, deps);
        if (outcome.kind !== 'done') {
          return outcome;
        }
        deps.reportBytesWritten?.(input.jobId, input.entry.photoId, outcome.bytesWritten);
        return { kind: 'done', bytesWritten: outcome.bytesWritten };
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

async function verifyDecryptAndWrite(
  encryptedShards: readonly Uint8Array[],
  fromMirror: readonly boolean[],
  epochSeed: Uint8Array,
  input: PhotoTaskInput,
  deps: PhotoPipelineDeps,
): Promise<{ readonly kind: 'done'; readonly bytesWritten: number } | { readonly kind: 'failed'; readonly code: DownloadErrorCode }> {
  if (encryptedShards.length !== input.entry.expectedHashes.length) {
    return { kind: 'failed', code: 'IllegalState' };
  }

  // Phase 1 — verify every shard's envelope hash. Integrity failures may be
  // transient (corrupted CDN cache); retry once before giving up.
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
      break;
    } catch (error) {
      const classified = classifyPipelineError(error);
      if (classified === 'Integrity' && attempt < MAX_INTEGRITY_ATTEMPTS) {
        continue;
      }
      return { kind: 'failed', code: classified };
    }
  }

  // After verification, persist freshly-fetched (non-mirror) shards into the
  // ambient mirror. Mirror failures are non-fatal optimization losses.
  if (deps.mirror) {
    for (let index = 0; index < encryptedShards.length; index += 1) {
      if (fromMirror[index]) continue;
      const shard = encryptedShards[index];
      const expected = input.entry.expectedHashes[index];
      if (!shard || !expected) continue;
      try {
        await deps.mirror.put(shardMirrorKey(expected), shard);
      } catch {
        // Non-fatal — caching is opportunistic.
      }
    }
  }

  // Phase 2 — decrypt each shard and stage plaintext incrementally to OPFS.
  // Streaming shards (variant 1, > THRESHOLD) write chunk-by-chunk; smaller
  // monolithic shards continue through the existing `pool.decryptShard` path.
  let bytesWritten = 0;
  try {
    for (let index = 0; index < encryptedShards.length; index += 1) {
      throwIfAborted(input.signal);
      const shard = encryptedShards[index];
      if (!shard) {
        return { kind: 'failed', code: 'IllegalState' };
      }
      if (shouldStreamShard(shard)) {
        bytesWritten += await streamDecryptAndWriteShard(shard, epochSeed, bytesWritten, input, deps);
      } else {
        const plaintext = await deps.pool.decryptShard(shard, epochSeed, input.entry.tier);
        await deps.writePhotoChunk(input.jobId, input.entry.photoId, bytesWritten, plaintext);
        bytesWritten += plaintext.byteLength;
      }
    }
  } catch (error) {
    return { kind: 'failed', code: classifyPipelineError(error) };
  }

  return { kind: 'done', bytesWritten };
}

function shouldStreamShard(shard: Uint8Array): boolean {
  if (shard.byteLength <= STREAMING_SHARD_THRESHOLD_BYTES) {
    return false;
  }
  if (shard.byteLength < SHARD_ENVELOPE_HEADER_BYTES) {
    return false;
  }
  return shard[ENVELOPE_VARIANT_BYTE_OFFSET] === STREAMING_ENVELOPE_VARIANT;
}

async function streamDecryptAndWriteShard(
  shard: Uint8Array,
  epochSeed: Uint8Array,
  startOffset: number,
  input: PhotoTaskInput,
  deps: PhotoPipelineDeps,
): Promise<number> {
  const opener = deps.openStreamingShard ?? rustOpenStreamingShard;
  const { fullKey, previewKey, thumbKey } = deriveTierKeys(epochSeed);
  let decryptor: StreamingShardDecryptor | null = null;
  let written = 0;
  try {
    const tierKey = selectTierKey(input.entry.tier, { fullKey, previewKey, thumbKey });
    decryptor = await opener(shard.subarray(0, SHARD_ENVELOPE_HEADER_BYTES), tierKey);
    const onWireChunkSize = decryptor.chunkSizeBytes + STREAMING_CHUNK_TAG_BYTES;
    let offset = SHARD_ENVELOPE_HEADER_BYTES;
    while (offset < shard.byteLength) {
      throwIfAborted(input.signal);
      const isFinal = offset + onWireChunkSize >= shard.byteLength;
      const end = isFinal ? shard.byteLength : offset + onWireChunkSize;
      const plaintext = await decryptor.processChunk(shard.subarray(offset, end), isFinal);
      await deps.writePhotoChunk(input.jobId, input.entry.photoId, startOffset + written, plaintext);
      written += plaintext.byteLength;
      if (isFinal) break;
      offset = end;
    }
  } finally {
    if (decryptor) {
      await decryptor.close();
    }
    memzero(fullKey);
    memzero(previewKey);
    memzero(thumbKey);
  }
  return written;
}

function selectTierKey(
  tier: number,
  keys: { readonly fullKey: Uint8Array; readonly previewKey: Uint8Array; readonly thumbKey: Uint8Array },
): Uint8Array {
  switch (tier) {
    case 1:
      return keys.thumbKey;
    case 2:
      return keys.previewKey;
    case 3:
      return keys.fullKey;
    default:
      throw new DownloadError('IllegalState', 'Unsupported shard tier for streaming decrypt');
  }
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

async function fetchShardsWithMirror(
  input: PhotoTaskInput,
  deps: PhotoPipelineDeps,
): Promise<{ shards: Uint8Array[]; fromMirror: boolean[] }> {
  const { shardIds, expectedHashes } = input.entry;
  if (shardIds.length !== expectedHashes.length) {
    throw new DownloadError('IllegalState', 'shardIds/expectedHashes length mismatch');
  }
  const shards: Uint8Array[] = new Array(shardIds.length);
  const fromMirror: boolean[] = new Array(shardIds.length).fill(false) as boolean[];
  const missingIndices: number[] = [];

  if (deps.mirror) {
    for (let i = 0; i < shardIds.length; i += 1) {
      const expected = expectedHashes[i];
      if (!expected) {
        missingIndices.push(i);
        continue;
      }
      let cached: Uint8Array | null = null;
      try {
        cached = await deps.mirror.get(shardMirrorKey(expected));
      } catch {
        cached = null;
      }
      if (cached) {
        shards[i] = cached;
        fromMirror[i] = true;
      } else {
        missingIndices.push(i);
      }
    }
  } else {
    for (let i = 0; i < shardIds.length; i += 1) missingIndices.push(i);
  }

  if (missingIndices.length > 0) {
    const missingShardIds = missingIndices.map((i): string => {
      const id = shardIds[i];
      if (id === undefined) {
        throw new DownloadError('IllegalState', 'shardId index out of range');
      }
      return id;
    });
    const fetched = await deps.fetchShards(missingShardIds, input.signal);
    if (fetched.length !== missingIndices.length) {
      throw new DownloadError('IllegalState', 'fetchShards returned wrong count');
    }
    for (let j = 0; j < missingIndices.length; j += 1) {
      const target = missingIndices[j];
      const bytes = fetched[j];
      if (target === undefined || !bytes) {
        throw new DownloadError('IllegalState', 'fetched shard missing');
      }
      shards[target] = bytes;
    }
  }

  return { shards, fromMirror };
}

async function resolveEpochSeed(input: PhotoTaskInput, deps: PhotoPipelineDeps): Promise<Uint8Array> {
  const cache = deps.decryptCache;
  if (!cache) {
    return deps.getEpochSeed(input.albumId, input.entry.epochId);
  }
  const cacheKey = input.albumId + ':' + String(input.entry.epochId);
  const hit = cache.get(cacheKey);
  if (hit) return hit.epochKey;
  const seed = await deps.getEpochSeed(input.albumId, input.entry.epochId);
  cache.put({ epochId: cacheKey, epochKey: seed });
  return seed;
}

export const __photoPipelineTestUtils = {
  classifyPipelineError,
  backoffMs,
  shouldStreamShard,
  STREAMING_SHARD_THRESHOLD_BYTES,
  ENVELOPE_VARIANT_BYTE_OFFSET,
  STREAMING_ENVELOPE_VARIANT,
};
