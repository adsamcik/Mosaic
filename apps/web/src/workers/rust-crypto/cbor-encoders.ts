/**
 * Pure-JS CBOR + byte-encoding helpers used by the Rust crypto facade
 * (`workers/rust-crypto-core.ts`).
 *
 * These functions encode the canonical input formats consumed by the
 * generated `mosaic_wasm` bindings (download-plan / snapshot inputs and
 * manifest-transcript records). They contain **no** `rustWasm.*` calls
 * and no libsodium calls — only `TextEncoder`, `atob`, and `Uint8Array`
 * arithmetic — so they live outside the rust-cutover boundary by design.
 *
 * Extracted from the legacy `workers/rust-crypto-core.ts` god-module
 * during sweep39. Behaviour is byte-for-byte identical to the originals.
 */

import type { DownloadSchedule } from '../../lib/download-schedule';
import {
  WorkerCryptoError,
  WorkerCryptoErrorCode,
  type ManifestTranscriptShard,
} from '../types';
import type {
  DownloadBuildPlanInput,
  DownloadBuildPlanPhotoInput,
  DownloadBuildPlanShardInput,
} from '../rust-crypto-core';

const UUID_BYTES = 16;
const SHA256_BYTES = 32;
const SHARD_TRANSCRIPT_RECORD_BYTES = 53;

export function encodeManifestTranscriptShards(
  shards: readonly ManifestTranscriptShard[],
): Uint8Array {
  const output = new Uint8Array(shards.length * SHARD_TRANSCRIPT_RECORD_BYTES);
  let offset = 0;
  for (const shard of shards) {
    const shardId = uuidToBytes(shard.shardId);
    const sha256 = sha256ToBytes(shard.sha256);
    writeU32Le(output, offset, shard.chunkIndex);
    offset += 4;
    output[offset] = shard.tier;
    offset += 1;
    output.set(shardId, offset);
    offset += UUID_BYTES;
    output.set(sha256, offset);
    offset += SHA256_BYTES;
  }
  return output;
}

function writeU32Le(output: Uint8Array, offset: number, value: number): void {
  output[offset] = value & 0xff;
  output[offset + 1] = (value >>> 8) & 0xff;
  output[offset + 2] = (value >>> 16) & 0xff;
  output[offset + 3] = (value >>> 24) & 0xff;
}

export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new WorkerCryptoError(
      WorkerCryptoErrorCode.InvalidInputLength,
      'manifest transcript UUID must contain 16 bytes',
    );
  }
  return hexToBytes(hex);
}

function sha256ToBytes(value: string): Uint8Array {
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return hexToBytes(trimmed);
  }
  const decoded = base64UrlToBytes(trimmed);
  if (decoded.byteLength !== SHA256_BYTES) {
    throw new WorkerCryptoError(
      WorkerCryptoErrorCode.InvalidInputLength,
      'manifest transcript SHA-256 must contain 32 bytes',
    );
  }
  return decoded;
}

function hexToBytes(hex: string): Uint8Array {
  const output = new Uint8Array(hex.length / 2);
  for (let i = 0; i < output.length; i += 1) {
    output[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return output;
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(
    normalized.length + ((4 - normalized.length % 4) % 4),
    '=',
  );
  const binary = atob(padded);
  const output = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    output[i] = binary.charCodeAt(i);
  }
  return output;
}

export function encodeDownloadBuildPlanInput(input: DownloadBuildPlanInput): Uint8Array {
  return cborMap([
    [0, cborArray(input.photos.map((photo) => encodeDownloadPlanPhoto(photo)))],
  ]);
}

function encodeDownloadPlanPhoto(photo: DownloadBuildPlanPhotoInput): Uint8Array {
  return cborMap([
    [0, cborText(photo.photoId)],
    [1, cborText(photo.filename)],
    [2, cborArray(photo.shards.map((shard) => encodeDownloadPlanShard(shard)))],
  ]);
}

function encodeDownloadPlanShard(shard: DownloadBuildPlanShardInput): Uint8Array {
  return cborMap([
    [0, cborBytes(shard.shardId)],
    [1, cborUint(shard.epochId)],
    [2, cborUint(shard.tier)],
    [3, cborBytes(shard.expectedHash)],
    [4, cborUint(shard.declaredSize)],
  ]);
}

export function encodeDownloadInitSnapshotInput(input: {
  readonly jobId: Uint8Array;
  readonly albumId: string;
  readonly planBytes: Uint8Array;
  readonly nowMs: number;
  readonly scopeKey: string;
  readonly schedule?: DownloadSchedule | null;
}): Uint8Array {
  if (input.jobId.length !== 16) {
    throw new WorkerCryptoError(
      WorkerCryptoErrorCode.InvalidInputLength,
      'downloadInitSnapshotV1 requires a 16-byte jobId',
    );
  }
  if (input.scopeKey.length === 0) {
    throw new WorkerCryptoError(
      WorkerCryptoErrorCode.InvalidInputLength,
      'downloadInitSnapshotV1 requires a non-empty scopeKey',
    );
  }
  const entries: Array<readonly [number, Uint8Array]> = [
    [0, cborBytes(input.jobId)],
    [1, cborText(input.albumId)],
    [2, cborBytes(input.planBytes)],
    [3, cborUint(input.nowMs)],
    [4, cborText(input.scopeKey)],
  ];
  // Plan-input key 5 (v3): optional download schedule. Absent and `null`
  // both decode to Immediate on the Rust side, so we only encode the
  // entry when the caller passed a non-trivial schedule.
  const schedule = input.schedule;
  if (schedule && schedule.kind !== 'immediate') {
    entries.push([5, encodeDownloadScheduleValue(schedule)]);
  }
  return cborMap(entries);
}

/**
 * Encode a {@link DownloadSchedule} as canonical CBOR matching the
 * Rust-side `download_schedule_kind_codes` + `download_schedule_keys`.
 *
 * Wire format (all kinds):
 *   { 0: kind_code, 3: max_delay_ms ?? null }
 * Window adds keys 1 (start_hour) + 2 (end_hour).
 *
 * The Rust validator strictly requires the per-kind key set; encode
 * exactly what is needed.
 */
function encodeDownloadScheduleValue(schedule: DownloadSchedule): Uint8Array {
  const maxDelay = schedule.maxDelayMs;
  const maxDelayValue = maxDelay === undefined ? cborNull() : cborUint(maxDelay);
  switch (schedule.kind) {
    case 'wifi':
      return cborMap([
        [0, cborUint(1)],
        [3, maxDelayValue],
      ]);
    case 'wifi-charging':
      return cborMap([
        [0, cborUint(2)],
        [3, maxDelayValue],
      ]);
    case 'idle':
      return cborMap([
        [0, cborUint(3)],
        [3, maxDelayValue],
      ]);
    case 'window': {
      const start = schedule.windowStartHour ?? 0;
      const end = schedule.windowEndHour ?? 0;
      return cborMap([
        [0, cborUint(4)],
        [1, cborUint(start)],
        [2, cborUint(end)],
        [3, maxDelayValue],
      ]);
    }
    case 'immediate':
      // The caller filters this out before reaching here, but keep the
      // exhaustiveness guard so the type-checker catches future kinds.
      throw new WorkerCryptoError(
        WorkerCryptoErrorCode.InvalidInputLength,
        'encodeDownloadScheduleValue called with kind=immediate',
      );
    default: {
      const _exhaustive: never = schedule.kind;
      void _exhaustive;
      throw new WorkerCryptoError(
        WorkerCryptoErrorCode.InvalidInputLength,
        'encodeDownloadScheduleValue: unknown kind',
      );
    }
  }
}

function cborNull(): Uint8Array {
  return new Uint8Array([0xf6]);
}

function cborMap(entries: readonly (readonly [number, Uint8Array])[]): Uint8Array {
  const encodedEntries: Uint8Array[] = [cborTypeAndLength(5, BigInt(entries.length))];
  for (const [key, value] of entries) {
    encodedEntries.push(cborUint(key), value);
  }
  return concatBytes(encodedEntries);
}

function cborArray(items: readonly Uint8Array[]): Uint8Array {
  return concatBytes([cborTypeAndLength(4, BigInt(items.length)), ...items]);
}

function cborBytes(bytes: Uint8Array): Uint8Array {
  return concatBytes([cborTypeAndLength(2, BigInt(bytes.length)), bytes]);
}

function cborText(value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  return concatBytes([cborTypeAndLength(3, BigInt(encoded.length)), encoded]);
}

function cborUint(value: number | bigint): Uint8Array {
  const bigintValue = typeof value === 'bigint' ? value : numberToUnsignedBigInt(value);
  if (bigintValue > 0xffff_ffff_ffff_ffffn) {
    throw new WorkerCryptoError(
      WorkerCryptoErrorCode.InvalidInputLength,
      'CBOR unsigned integer exceeds u64',
    );
  }
  return cborTypeAndLength(0, bigintValue);
}

function numberToUnsignedBigInt(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkerCryptoError(
      WorkerCryptoErrorCode.InvalidInputLength,
      'CBOR unsigned integer must be a non-negative safe integer',
    );
  }
  return BigInt(value);
}

function cborTypeAndLength(major: number, value: bigint): Uint8Array {
  if (value < 0n) {
    throw new WorkerCryptoError(
      WorkerCryptoErrorCode.InvalidInputLength,
      'CBOR length must be non-negative',
    );
  }
  const majorBits = major << 5;
  if (value < 24n) return new Uint8Array([majorBits | Number(value)]);
  if (value <= 0xffn) return new Uint8Array([majorBits | 24, Number(value)]);
  if (value <= 0xffffn) {
    return new Uint8Array([majorBits | 25, Number(value >> 8n), Number(value & 0xffn)]);
  }
  if (value <= 0xffff_ffffn) {
    return new Uint8Array([
      majorBits | 26,
      Number((value >> 24n) & 0xffn),
      Number((value >> 16n) & 0xffn),
      Number((value >> 8n) & 0xffn),
      Number(value & 0xffn),
    ]);
  }
  return new Uint8Array([
    majorBits | 27,
    Number((value >> 56n) & 0xffn),
    Number((value >> 48n) & 0xffn),
    Number((value >> 40n) & 0xffn),
    Number((value >> 32n) & 0xffn),
    Number((value >> 24n) & 0xffn),
    Number((value >> 16n) & 0xffn),
    Number((value >> 8n) & 0xffn),
    Number(value & 0xffn),
  ]);
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((total, part) => total + part.length, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
