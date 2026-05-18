/**
 * Snapshot CBOR codec — typed views over the Rust download snapshot format,
 * plus phase / status / error-code translations and event encoders.
 *
 * Extracted from `coordinator.worker.ts` (Sweep 39). Depends only on the
 * minimal CBOR codec and id helpers.
 *
 * Snapshot CBOR map keys:
 *   1  jobId (bytes)
 *   2  albumId (bytes, UUID)
 *   3  createdAtMs (uint)
 *   4  lastUpdatedAtMs (uint)
 *   5  state (map)
 *   6  plan (array of plan entries)
 *   7  photos (array of photo state)
 *   8  failureLog (array of failures)
 *  10  scopeKey (text, v2+) — synthesized as `legacy:<jobIdHex>` for v1
 *  11  schedule (map, v3+, optional)
 */
import type { DownloadSchedule } from '../../lib/download-schedule';
import type { DownloadErrorCode } from '../crypto-pool';
import type {
  AlbumDiff,
  CurrentAlbumManifest,
  DownloadErrorReason,
  DownloadEventInput,
  DownloadFailureView,
  DownloadJobStateView,
  DownloadPhase,
  DownloadPhotoCounts,
  DownloadPhotoStateView,
} from '../types';
import {
  type CborMapEntry,
  type CborValue,
  encodeCbor,
  expectArray,
  expectBytes,
  expectMap,
  expectText,
  expectUint,
  optionalMapValue,
  parseCbor,
  requiredMapValue,
  uintValue,
} from './cbor-codec';
import { bytesToHex, uuidBytesToString } from './coordinator-ids';
import type { DownloadPlanEntry } from './photo-pipeline';

export interface ParsedSnapshotView {
  readonly jobId: string;
  readonly albumId: string;
  readonly createdAtMs: number;
  readonly lastUpdatedAtMs: number;
  readonly state: DownloadJobStateView;
  readonly photos: DownloadPhotoStateView[];
  readonly failureLog: DownloadFailureView[];
  readonly plan: DownloadPlanEntry[];
  /** Tray scope key (CBOR snapshot key 10). v1 snapshots get a synthesized legacy fallback. */
  readonly scopeKey: string;
  /** Last failure reason persisted in the failure log (null when empty). */
  readonly lastErrorReason: DownloadErrorReason | null;
  /** Optional v3 schedule (CBOR snapshot key 11). Null when absent / Immediate. */
  readonly schedule: DownloadSchedule | null;
}

export type PhotoStatusPatch =
  | { readonly kind: 'pending' }
  | { readonly kind: 'inflight' }
  | { readonly kind: 'done'; readonly bytesWritten: number }
  | { readonly kind: 'failed'; readonly reason: DownloadErrorCode }
  | { readonly kind: 'skipped'; readonly reason: 'NotFound' | 'UserExcluded' };

export const PHASE_BY_CODE: Readonly<Record<number, DownloadPhase>> = {
  0: 'Idle',
  1: 'Preparing',
  2: 'Running',
  3: 'Paused',
  4: 'Finalizing',
  5: 'Done',
  6: 'Errored',
  7: 'Cancelled',
};

export const PHASE_CODE_BY_PHASE: Readonly<Record<DownloadPhase, number>> = {
  Idle: 0,
  Preparing: 1,
  Running: 2,
  Paused: 3,
  Finalizing: 4,
  Done: 5,
  Errored: 6,
  Cancelled: 7,
};

export const PHOTO_STATUS_BY_CODE: Readonly<Record<number, keyof DownloadPhotoCounts>> = {
  0: 'pending',
  1: 'inflight',
  2: 'done',
  3: 'failed',
  4: 'skipped',
};

export const DOWNLOAD_ERROR_CODE_BY_REASON: Readonly<Record<DownloadErrorReason, number>> = {
  TransientNetwork: 0,
  Integrity: 1,
  Decrypt: 2,
  NotFound: 3,
  AccessRevoked: 4,
  AuthorizationChanged: 5,
  Quota: 6,
  Cancelled: 7,
  IllegalState: 8,
};

export const DOWNLOAD_REASON_BY_CODE: Readonly<Record<number, DownloadErrorReason>> = (() => {
  const out: Record<number, DownloadErrorReason> = {} as Record<number, DownloadErrorReason>;
  for (const [reason, code] of Object.entries(DOWNLOAD_ERROR_CODE_BY_REASON)) {
    out[code] = reason as DownloadErrorReason;
  }
  return out;
})();

export function parseSnapshotView(bytes: Uint8Array): ParsedSnapshotView {
  const root = parseCbor(bytes);
  const fields = expectMap(root);
  const jobId = bytesToHex(expectBytes(requiredMapValue(fields, 1)));
  const albumBytes = expectBytes(requiredMapValue(fields, 2));
  // Snapshot key 10 = scope_key (v2). v1 snapshots are migrated by Rust to
  // synthesize a `legacy:<jobIdHex>` value, so this is always present after
  // load. Treat unexpected absence as `legacy:<jobIdHex>` for robustness.
  const scopeKey = optionalMapValue(fields, 10);
  // Snapshot key 11 = schedule (v3, optional). Absent or Null ⇒ Immediate.
  const scheduleValue = optionalMapValue(fields, 11);
  return {
    jobId,
    albumId: uuidBytesToString(albumBytes),
    createdAtMs: expectUint(requiredMapValue(fields, 3)),
    lastUpdatedAtMs: expectUint(requiredMapValue(fields, 4)),
    state: parseState(requiredMapValue(fields, 5)),
    plan: expectArray(requiredMapValue(fields, 6)).map(parsePlanEntry),
    photos: expectArray(requiredMapValue(fields, 7)).map(parsePhoto),
    failureLog: expectArray(requiredMapValue(fields, 8)).map(parseFailure),
    scopeKey: scopeKey === null ? `legacy:${jobId}` : expectText(scopeKey),
    lastErrorReason: lastFailureReason(expectArray(requiredMapValue(fields, 8))),
    schedule: scheduleValue === null || scheduleValue.kind === 'null' ? null : parseScheduleValue(scheduleValue),
  };
}

/**
 * Decode a CBOR `schedule_value` (snapshot key 11 OR plan-input key 5).
 * Mirrors `decode_schedule` in `mosaic-client/src/download/snapshot.rs`.
 *
 * Throws on unknown kind codes so a corrupt snapshot does not silently
 * become an Immediate job.
 */
export function parseScheduleValue(value: CborValue): DownloadSchedule | null {
  const fields = expectMap(value);
  const kind = expectUint(requiredMapValue(fields, 0));
  const rawDelay = requiredMapValue(fields, 3);
  const maxDelayMs = rawDelay.kind === 'null' ? undefined : expectUint(rawDelay);
  switch (kind) {
    case 0:
      return null; // IMMEDIATE
    case 1:
      return maxDelayMs === undefined ? { kind: 'wifi' } : { kind: 'wifi', maxDelayMs };
    case 2:
      return maxDelayMs === undefined ? { kind: 'wifi-charging' } : { kind: 'wifi-charging', maxDelayMs };
    case 3:
      return maxDelayMs === undefined ? { kind: 'idle' } : { kind: 'idle', maxDelayMs };
    case 4: {
      const start = expectUint(requiredMapValue(fields, 1));
      const end = expectUint(requiredMapValue(fields, 2));
      return maxDelayMs === undefined
        ? { kind: 'window', windowStartHour: start, windowEndHour: end }
        : { kind: 'window', windowStartHour: start, windowEndHour: end, maxDelayMs };
    }
    default:
      throw new Error(`Unknown download schedule kind code: ${kind}`);
  }
}

/**
 * Encode a {@link DownloadSchedule} into the canonical CBOR `schedule_value`
 * map. Mirrors `schedule_value` in `mosaic-client/src/download/snapshot.rs`
 * AND `encodeDownloadScheduleValue` in `rust-crypto-core.ts`.
 */
export function encodeScheduleValue(schedule: DownloadSchedule): CborValue {
  const maxDelay = schedule.maxDelayMs;
  const maxDelayValue: CborValue = maxDelay === undefined
    ? { kind: 'null' }
    : uintValue(maxDelay);
  switch (schedule.kind) {
    case 'wifi':
      return { kind: 'map', value: [
        { key: uintValue(0), value: uintValue(1) },
        { key: uintValue(3), value: maxDelayValue },
      ] };
    case 'wifi-charging':
      return { kind: 'map', value: [
        { key: uintValue(0), value: uintValue(2) },
        { key: uintValue(3), value: maxDelayValue },
      ] };
    case 'idle':
      return { kind: 'map', value: [
        { key: uintValue(0), value: uintValue(3) },
        { key: uintValue(3), value: maxDelayValue },
      ] };
    case 'window':
      return { kind: 'map', value: [
        { key: uintValue(0), value: uintValue(4) },
        { key: uintValue(1), value: uintValue(schedule.windowStartHour ?? 0) },
        { key: uintValue(2), value: uintValue(schedule.windowEndHour ?? 0) },
        { key: uintValue(3), value: maxDelayValue },
      ] };
    case 'immediate':
      throw new Error('encodeScheduleValue: immediate schedules are not persisted');
    default: {
      const _exhaustive: never = schedule.kind;
      void _exhaustive;
      throw new Error('encodeScheduleValue: unknown schedule kind');
    }
  }
}

/**
 * Insert/replace/remove key 11 (schedule) in a snapshot CBOR body.
 * Preserves canonical ascending-key order. Used by `updateJobSchedule`.
 */
export function patchSnapshotSchedule(snapshotBytes: Uint8Array, schedule: DownloadSchedule | null, nowMs: number): Uint8Array {
  const root = parseCbor(snapshotBytes);
  const entries = expectMap(root);
  const filtered = entries.filter((entry) => {
    const key = expectUint(entry.key);
    return key !== 4 && key !== 11;
  });
  filtered.push({ key: uintValue(4), value: uintValue(nowMs) });
  if (schedule && schedule.kind !== 'immediate') {
    filtered.push({ key: uintValue(11), value: encodeScheduleValue(schedule) });
  }
  // Re-sort by ascending uint key for canonical CBOR order.
  filtered.sort((a, b) => expectUint(a.key) - expectUint(b.key));
  return encodeCbor({ kind: 'map', value: filtered });
}

export function lastFailureReason(entries: readonly CborValue[]): DownloadErrorReason | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (!e) continue;
    const reasonValue = optionalMapValue(expectMap(e), 1);
    if (reasonValue === null) continue;
    const code = expectUint(reasonValue);
    return DOWNLOAD_REASON_BY_CODE[code] ?? null;
  }
  return null;
}

export function extractStateValue(snapshotBytes: Uint8Array): CborValue {
  return requiredMapValue(expectMap(parseCbor(snapshotBytes)), 5);
}

export function patchSnapshotLastUpdatedAtMs(snapshotBytes: Uint8Array, nowMs: number): Uint8Array {
  const root = parseCbor(snapshotBytes);
  const entries = expectMap(root).map((entry) => {
    const key = expectUint(entry.key);
    return key === 4 ? { key: entry.key, value: uintValue(nowMs) } : entry;
  });
  return encodeCbor({ kind: 'map', value: entries });
}

export function patchSnapshotPhotoBytes(snapshotBytes: Uint8Array, photoId: string, bytesWritten: number, lastUpdatedAtMs: number): Uint8Array {
  const root = parseCbor(snapshotBytes);
  const entries = expectMap(root).map((entry) => {
    const key = expectUint(entry.key);
    if (key === 4) {
      return { key: entry.key, value: uintValue(lastUpdatedAtMs) };
    }
    if (key === 7) {
      const photos = expectArray(entry.value).map((photoValue) => patchPhotoBytesValue(photoValue, photoId, bytesWritten));
      return { key: entry.key, value: { kind: 'array', value: photos } as CborValue };
    }
    return entry;
  });
  return encodeCbor({ kind: 'map', value: entries });
}

function patchPhotoBytesValue(value: CborValue, photoId: string, bytesWritten: number): CborValue {
  const fields = expectMap(value);
  if (expectText(requiredMapValue(fields, 0)) !== photoId) {
    return value;
  }
  return {
    kind: 'map',
    value: fields.map((entry) => {
      const key = expectUint(entry.key);
      return key === 2 ? { key: entry.key, value: uintValue(bytesWritten) } : entry;
    }),
  };
}

export function patchSnapshotState(snapshotBytes: Uint8Array, newStateBytes: Uint8Array, nowMs: number): Uint8Array {
  const root = parseCbor(snapshotBytes);
  const entries = expectMap(root).map((entry) => {
    const key = expectUint(entry.key);
    if (key === 4) {
      return { key: entry.key, value: uintValue(nowMs) };
    }
    if (key === 5) {
      return { key: entry.key, value: parseCbor(newStateBytes) };
    }
    return entry;
  });
  return encodeCbor({ kind: 'map', value: entries });
}

function parseState(value: CborValue): DownloadJobStateView {
  const code = expectUint(requiredMapValue(expectMap(value), 0));
  const phase = PHASE_BY_CODE[code];
  if (!phase) {
    throw new Error('Unknown download phase code');
  }
  return { phase };
}

function parsePlanEntry(value: CborValue): DownloadPlanEntry {
  const fields = expectMap(value);
  return {
    photoId: expectText(requiredMapValue(fields, 0)),
    epochId: expectUint(requiredMapValue(fields, 1)),
    tier: expectUint(requiredMapValue(fields, 2)),
    shardIds: expectArray(requiredMapValue(fields, 3)).map((item) => bytesToHex(expectBytes(item))),
    expectedHashes: expectArray(requiredMapValue(fields, 4)).map(expectBytes),
    filename: expectText(requiredMapValue(fields, 5)),
    totalBytes: expectUint(requiredMapValue(fields, 6)),
  };
}

function parsePhoto(value: CborValue): DownloadPhotoStateView {
  const fields = expectMap(value);
  const statusFields = expectMap(requiredMapValue(fields, 1));
  const statusCode = expectUint(requiredMapValue(statusFields, 0));
  const status = PHOTO_STATUS_BY_CODE[statusCode];
  if (!status) {
    throw new Error('Unknown download photo status code');
  }
  return {
    photoId: expectText(requiredMapValue(fields, 0)),
    status,
    bytesWritten: expectUint(requiredMapValue(fields, 2)),
    retryCount: expectUint(requiredMapValue(fields, 4)),
  };
}

function parseFailure(value: CborValue): DownloadFailureView {
  const fields = expectMap(value);
  const reasonValue = optionalMapValue(fields, 1);
  let reason: DownloadErrorReason | null = null;
  if (reasonValue !== null) {
    const code = expectUint(reasonValue);
    reason = DOWNLOAD_REASON_BY_CODE[code] ?? null;
  }
  return { atMs: expectUint(requiredMapValue(fields, 2)), reason };
}

export function patchSnapshotPhoto(snapshotBytes: Uint8Array, photoId: string, patch: PhotoStatusPatch, nowMs: number): Uint8Array {
  const root = parseCbor(snapshotBytes);
  const entries = expectMap(root).map((entry): CborMapEntry => {
    const key = expectUint(entry.key);
    if (key === 4) {
      return { key: entry.key, value: uintValue(nowMs) };
    }
    if (key === 7) {
      const photos = expectArray(entry.value).map((photoValue) => patchPhotoValue(photoValue, photoId, patch, nowMs));
      return { key: entry.key, value: { kind: 'array', value: photos } };
    }
    if (key === 8 && (patch.kind === 'failed' || (patch.kind === 'skipped' && patch.reason === 'NotFound'))) {
      const reason: DownloadErrorCode = patch.kind === 'failed' ? patch.reason : 'NotFound';
      return {
        key: entry.key,
        value: {
          kind: 'array',
          value: [
            ...expectArray(entry.value),
            {
              kind: 'map',
              value: [
                { key: uintValue(0), value: { kind: 'text', value: photoId } },
                { key: uintValue(1), value: uintValue(DOWNLOAD_ERROR_CODE_BY_REASON[reason]) },
                { key: uintValue(2), value: uintValue(nowMs) },
              ],
            },
          ],
        },
      };
    }
    return entry;
  });
  return encodeCbor({ kind: 'map', value: entries });
}

function patchPhotoValue(value: CborValue, photoId: string, patch: PhotoStatusPatch, nowMs: number): CborValue {
  const fields = expectMap(value);
  if (expectText(requiredMapValue(fields, 0)) !== photoId) {
    return value;
  }
  return {
    kind: 'map',
    value: fields.map((entry) => {
      const key = expectUint(entry.key);
      if (key === 1) {
        return { key: entry.key, value: photoStatusValue(patch) };
      }
      if (key === 2) {
        return { key: entry.key, value: uintValue(patch.kind === 'done' ? patch.bytesWritten : expectUint(entry.value)) };
      }
      if (key === 3 && patch.kind === 'inflight') {
        return { key: entry.key, value: uintValue(nowMs) };
      }
      return entry;
    }),
  };
}

function photoStatusValue(patch: PhotoStatusPatch): CborValue {
  switch (patch.kind) {
    case 'pending':
      return { kind: 'map', value: [{ key: uintValue(0), value: uintValue(0) }] };
    case 'inflight':
      return { kind: 'map', value: [{ key: uintValue(0), value: uintValue(1) }] };
    case 'done':
      return { kind: 'map', value: [{ key: uintValue(0), value: uintValue(2) }] };
    case 'failed':
      return { kind: 'map', value: [{ key: uintValue(0), value: uintValue(3) }, { key: uintValue(1), value: uintValue(DOWNLOAD_ERROR_CODE_BY_REASON[patch.reason]) }] };
    case 'skipped':
      return { kind: 'map', value: [{ key: uintValue(0), value: uintValue(4) }, { key: uintValue(2), value: uintValue(patch.reason === 'NotFound' ? 0 : 1) }] };
  }
}

export function encodeStartRequestedEvent(jobIdBytes: Uint8Array, albumId: string): Uint8Array {
  return encodeCbor({
    kind: 'map',
    value: [
      { key: uintValue(0), value: uintValue(0) },
      { key: uintValue(1), value: { kind: 'bytes', value: jobIdBytes } },
      { key: uintValue(2), value: { kind: 'text', value: albumId } },
    ],
  });
}

export function encodeEvent(event: DownloadEventInput): Uint8Array {
  switch (event.kind) {
    case 'PlanReady':
      return encodeEventKind(1);
    case 'PauseRequested':
      return encodeEventKind(2);
    case 'ResumeRequested':
      return encodeEventKind(3);
    case 'CancelRequested':
      return encodeCbor({
        kind: 'map',
        value: [
          { key: uintValue(0), value: uintValue(4) },
          { key: uintValue(3), value: { kind: 'bool', value: event.soft } },
        ],
      });
    case 'ErrorEncountered':
      return encodeCbor({
        kind: 'map',
        value: [
          { key: uintValue(0), value: uintValue(5) },
          { key: uintValue(4), value: uintValue(DOWNLOAD_ERROR_CODE_BY_REASON[event.reason]) },
        ],
      });
    case 'AllPhotosDone':
      return encodeEventKind(6);
    case 'FinalizationDone':
      return encodeEventKind(7);
  }
}

function encodeEventKind(kind: number): Uint8Array {
  return encodeCbor({
    kind: 'map',
    value: [{ key: uintValue(0), value: uintValue(kind) }],
  });
}

export function isIdempotentEvent(phase: DownloadPhase, event: DownloadEventInput): boolean {
  return (event.kind === 'PlanReady' && phase === 'Running')
    || (event.kind === 'PauseRequested' && phase === 'Paused')
    || (event.kind === 'ResumeRequested' && phase === 'Running')
    || (event.kind === 'CancelRequested' && event.soft === true && phase === 'Cancelled');
}

export function computeAlbumDiffFromPlan(plan: readonly DownloadPlanEntry[], current: CurrentAlbumManifest): AlbumDiff {
  const plannedByPhotoId = new Map(plan.map((entry) => [entry.photoId, entry]));
  const currentByPhotoId = new Map(current.photos.map((photo) => [photo.photoId, photo]));
  const removed: string[] = [];
  const added: string[] = [];
  const rekeyed: string[] = [];
  const unchanged: string[] = [];
  const shardChanged: string[] = [];

  for (const entry of plan) {
    if (!currentByPhotoId.has(entry.photoId)) {
      removed.push(entry.photoId);
    }
  }

  for (const photo of current.photos) {
    const planned = plannedByPhotoId.get(photo.photoId);
    if (!planned) {
      added.push(photo.photoId);
      continue;
    }
    if (planned.epochId !== photo.epochId) {
      rekeyed.push(photo.photoId);
      continue;
    }
    if (sameStringSet(planned.shardIds, photo.tier3ShardIds)) {
      unchanged.push(photo.photoId);
    } else {
      shardChanged.push(photo.photoId);
    }
  }

  return { removed, added, rekeyed, unchanged, shardChanged };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}
