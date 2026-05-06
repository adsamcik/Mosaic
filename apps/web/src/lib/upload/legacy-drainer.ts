import { openDB, type IDBPDatabase } from 'idb';

// Web IDB upload-record envelope version. Independent of Rust ADR-023
// SNAPSHOT_SCHEMA_VERSION (currently 1) and Android RustSnapshotVersions.CURRENT.
export const SNAPSHOT_VERSION = 4;

export type LegacyUploadTelemetryCounter =
  | 'upload_queue_legacy_task_completed'
  | 'upload_queue_legacy_task_stranded'
  | 'upload_queue_migrated_to_rust_core';

export interface LegacyUploadTelemetrySnapshot {
  readonly counter: LegacyUploadTelemetryCounter;
  readonly count: number;
}

export interface LegacyUploadRecord {
  readonly id?: string;
  readonly jobId?: string;
  readonly job_id?: string;
  readonly schemaVersion?: number;
  readonly snapshotVersion?: number;
  readonly version?: number;
  readonly idempotencyKey?: string;
  readonly tieredShards?: unknown;
  readonly status?: string;
  readonly albumId?: string;
  readonly album_id?: string;
  readonly epochId?: number;
  readonly epoch_id?: number;
  readonly epochHandleId?: string;
  readonly epoch_handle_id?: string;
  readonly file?: File;
  readonly blob?: Blob;
  readonly sourceBlob?: Blob;
  readonly fileName?: string;
  readonly file_name?: string;
  readonly fileSize?: number;
  readonly file_size?: number;
  readonly totalChunks?: number;
  readonly total_chunks?: number;
  readonly completedShards?: unknown;
  readonly completed_shards?: unknown;
  readonly retryCount?: number;
  readonly retry_count?: number;
  readonly lastAttemptAt?: number;
  readonly last_attempt_at?: number;
  readonly stranded?: boolean;
  readonly deletionRequested?: boolean;
  readonly legacyStrandReason?: string;
}

export interface CurrentUploadRecord {
  readonly id: string;
  readonly schemaVersion: typeof SNAPSHOT_VERSION;
  readonly snapshotVersion: typeof SNAPSHOT_VERSION;
  readonly idempotencyKey: string;
  readonly albumId: string;
  readonly fileName: string;
  readonly fileSize: number;
  readonly epochId: number;
  readonly epochHandleId: string;
  readonly totalChunks: number;
  readonly completedShards: readonly unknown[];
  readonly status: string;
  readonly retryCount: number;
  readonly lastAttemptAt: number;
  readonly migratedFromLegacyId: string;
  readonly legacySourceDeleted: true;
}

export interface LegacyUploadQueueStoreAdapter {
  getAll(): Promise<readonly LegacyUploadRecord[]>;
  put(record: LegacyUploadRecord | CurrentUploadRecord): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface LegacyUploadDetection {
  readonly task: LegacyUploadRecord;
  readonly storageId: string;
  readonly reasons: readonly string[];
}

export interface LegacyUploadDrainResult {
  readonly migrated: readonly CurrentUploadRecord[];
  readonly stranded: readonly LegacyUploadDetection[];
}

export interface LegacyDrainOptions {
  readonly requeue?: (record: CurrentUploadRecord, file: File | Blob) => Promise<void>;
}

let drainInFlight: Promise<LegacyUploadDrainResult> | null = null;

class LegacyUploadTelemetry {
  private readonly counters = new Map<LegacyUploadTelemetryCounter, number>();

  increment(counter: LegacyUploadTelemetryCounter): void {
    this.counters.set(counter, (this.counters.get(counter) ?? 0) + 1);
  }

  snapshot(): LegacyUploadTelemetrySnapshot[] {
    return Array.from(this.counters.entries()).map(([counter, count]) => ({ counter, count }));
  }

  reset(): void {
    this.counters.clear();
  }
}

export const legacyUploadTelemetry = new LegacyUploadTelemetry();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getString(record: LegacyUploadRecord, ...keys: readonly (keyof LegacyUploadRecord)[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function getNumber(record: LegacyUploadRecord, ...keys: readonly (keyof LegacyUploadRecord)[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function getStorageId(record: LegacyUploadRecord): string {
  return getString(record, 'id', 'jobId', 'job_id') ?? createUuidV7();
}

function taskVersion(record: LegacyUploadRecord): number | undefined {
  return getNumber(record, 'schemaVersion', 'snapshotVersion', 'version');
}

function jobId(record: LegacyUploadRecord): string | undefined {
  return getString(record, 'jobId', 'job_id', 'id');
}

export function isUuidV7(value: string | undefined): boolean {
  return value !== undefined && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function createUuidV7(now: number = Date.now()): string {
  const random = new Uint8Array(10);
  crypto.getRandomValues(random);
  const timestamp = BigInt(now);
  const bytes = new Uint8Array(16);
  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);
  bytes[6] = 0x70 | (random[0]! & 0x0f);
  bytes[7] = random[1]!;
  bytes[8] = 0x80 | (random[2]! & 0x3f);
  bytes.set(random.slice(3), 9);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createIdempotencyKey(): string {
  return `upload-${createUuidV7()}`;
}

function hasCurrentRequiredFields(record: LegacyUploadRecord): boolean {
  return taskVersion(record) === SNAPSHOT_VERSION
    && typeof record.idempotencyKey === 'string'
    && record.idempotencyKey.length > 0
    && isUuidV7(jobId(record))
    && (record.status !== 'complete' || record.tieredShards !== undefined);
}

function detectionReasons(record: LegacyUploadRecord): string[] {
  const reasons: string[] = [];
  const version = taskVersion(record);
  if (version !== undefined && version < SNAPSHOT_VERSION) {
    reasons.push('snapshot-version-too-old');
  }
  if (version === undefined) {
    reasons.push('snapshot-version-missing');
  }
  if (typeof record.idempotencyKey !== 'string' || record.idempotencyKey.length === 0) {
    reasons.push('idempotency-key-missing');
  }
  if (!isUuidV7(jobId(record))) {
    reasons.push('job-id-not-uuidv7');
  }
  if (record.status === 'complete' && record.tieredShards === undefined) {
    reasons.push('tiered-shards-missing');
  }
  return reasons;
}

function fileLike(record: LegacyUploadRecord): File | Blob | undefined {
  const file = record.file;
  if (file !== undefined && file instanceof Blob) return file;
  const blob = record.blob;
  if (blob !== undefined && blob instanceof Blob) return blob;
  const sourceBlob = record.sourceBlob;
  if (sourceBlob !== undefined && sourceBlob instanceof Blob) return sourceBlob;
  return undefined;
}

function migratedRecordFrom(record: LegacyUploadRecord, storageId: string): CurrentUploadRecord | null {
  const file = fileLike(record);
  if (file === undefined) return null;
  const albumId = getString(record, 'albumId', 'album_id');
  const epochId = getNumber(record, 'epochId', 'epoch_id');
  const epochHandleId = getString(record, 'epochHandleId', 'epoch_handle_id');
  if (albumId === undefined || epochId === undefined || epochHandleId === undefined) return null;

  return {
    id: createUuidV7(),
    schemaVersion: SNAPSHOT_VERSION,
    snapshotVersion: SNAPSHOT_VERSION,
    idempotencyKey: createIdempotencyKey(),
    albumId,
    fileName: getString(record, 'fileName', 'file_name') ?? ('name' in file && typeof file.name === 'string' ? file.name : 'legacy-upload.bin'),
    fileSize: getNumber(record, 'fileSize', 'file_size') ?? file.size,
    epochId,
    epochHandleId,
    totalChunks: getNumber(record, 'totalChunks', 'total_chunks') ?? 1,
    completedShards: Array.isArray(record.completedShards) ? record.completedShards : (Array.isArray(record.completed_shards) ? record.completed_shards : []),
    status: 'queued',
    retryCount: 0,
    lastAttemptAt: 0,
    migratedFromLegacyId: storageId,
    legacySourceDeleted: true,
  };
}

export class LegacyUploadQueueDrainer {
  constructor(private readonly store: LegacyUploadQueueStoreAdapter) {}

  async detect(): Promise<LegacyUploadDetection[]> {
    const records = await this.store.getAll();
    return records.flatMap((record) => {
      if (record.stranded === true || record.deletionRequested === true || hasCurrentRequiredFields(record)) {
        return [];
      }
      const reasons = detectionReasons(record);
      return reasons.length === 0 ? [] : [{ task: record, storageId: getStorageId(record), reasons }];
    });
  }

  async drain(options: LegacyDrainOptions = {}): Promise<LegacyUploadDrainResult> {
    if (drainInFlight !== null) return drainInFlight;
    drainInFlight = this.drainInternal(options);
    try {
      return await drainInFlight;
    } finally {
      drainInFlight = null;
    }
  }

  private async drainInternal(options: LegacyDrainOptions = {}): Promise<LegacyUploadDrainResult> {
    const detections = await this.detect();
    const migrated: CurrentUploadRecord[] = [];
    const stranded: LegacyUploadDetection[] = [];

    for (const detection of detections) {
      const currentRecord = migratedRecordFrom(detection.task, detection.storageId);
      const sourceFile = fileLike(detection.task);
      if (currentRecord !== null && sourceFile !== undefined) {
        await this.store.put(currentRecord);
        await options.requeue?.(currentRecord, sourceFile);
        await this.store.delete(detection.storageId);
        migrated.push(currentRecord);
        legacyUploadTelemetry.increment('upload_queue_migrated_to_rust_core');
        legacyUploadTelemetry.increment('upload_queue_legacy_task_completed');
      } else {
        await this.strand(
          detection,
          sourceFile === undefined ? 'source-blob-unavailable' : 'requeue-context-unavailable',
        );
        stranded.push(detection);
      }
    }

    return { migrated, stranded };
  }

  async strand(detection: LegacyUploadDetection, reason: string = 'manual-abandon'): Promise<void> {
    await this.store.put({
      ...detection.task,
      id: detection.storageId,
      stranded: true,
      deletionRequested: true,
      legacyStrandReason: reason,
      status: 'permanently_failed',
    });
    legacyUploadTelemetry.increment('upload_queue_legacy_task_stranded');
  }

  async reset(): Promise<number> {
    const detections = await this.detect();
    const strandedRecords = (await this.store.getAll()).filter((record) => record.stranded === true || record.deletionRequested === true);
    const ids = new Set<string>([
      ...detections.map((detection) => detection.storageId),
      ...strandedRecords.map(getStorageId),
    ]);
    for (const id of ids) {
      await this.store.delete(id);
    }
    return ids.size;
  }

  telemetrySnapshot(): LegacyUploadTelemetrySnapshot[] {
    return legacyUploadTelemetry.snapshot();
  }
}

export function legacyRecordFromUnknown(value: unknown): LegacyUploadRecord | null {
  return isObject(value) ? value : null;
}

export class IndexedDbLegacyUploadQueueStore implements LegacyUploadQueueStoreAdapter {
  private dbPromise: Promise<IDBPDatabase<unknown>> | null = null;

  private async db(): Promise<IDBPDatabase<unknown>> {
    if (this.dbPromise === null) {
      // Intentionally shares UploadPersistence's v1 `tasks` store so detection
      // and reset operate on the same persisted upload records.
      this.dbPromise = openDB('mosaic-upload-queue', 1, {
        upgrade(db) {
          if (!db.objectStoreNames.contains('tasks')) {
            db.createObjectStore('tasks', { keyPath: 'id' });
          }
        },
      });
    }
    return this.dbPromise;
  }

  async getAll(): Promise<readonly LegacyUploadRecord[]> {
    const db = await this.db();
    const values = await db.getAll('tasks');
    return values.flatMap((value) => {
      const record = legacyRecordFromUnknown(value);
      return record === null ? [] : [record];
    });
  }

  async put(record: LegacyUploadRecord | CurrentUploadRecord): Promise<void> {
    const db = await this.db();
    await db.put('tasks', record);
  }

  async delete(id: string): Promise<void> {
    const db = await this.db();
    await db.delete('tasks', id);
  }
}

export const legacyUploadQueueDrainer = new LegacyUploadQueueDrainer(
  new IndexedDbLegacyUploadQueueStore(),
);
