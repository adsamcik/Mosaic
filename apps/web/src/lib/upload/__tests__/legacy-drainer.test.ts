import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LegacyUploadQueueDrainer,
  SNAPSHOT_VERSION,
  createUuidV7,
  isUuidV7,
  legacyUploadTelemetry,
  type CurrentUploadRecord,
  type LegacyUploadQueueStoreAdapter,
  type LegacyUploadRecord,
} from '../legacy-drainer';

class MemoryStore implements LegacyUploadQueueStoreAdapter {
  readonly records = new Map<string, LegacyUploadRecord | CurrentUploadRecord>();

  constructor(records: readonly LegacyUploadRecord[]) {
    for (const record of records) {
      this.records.set(record.id ?? record.jobId ?? record.job_id ?? `record-${this.records.size}`, record);
    }
  }

  async getAll(): Promise<readonly LegacyUploadRecord[]> {
    return Array.from(this.records.values());
  }

  async put(record: LegacyUploadRecord | CurrentUploadRecord): Promise<void> {
    this.records.set(record.id ?? `record-${this.records.size}`, record);
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }
}

function currentRecord(): LegacyUploadRecord {
  return {
    id: createUuidV7(),
    schemaVersion: SNAPSHOT_VERSION,
    snapshotVersion: SNAPSHOT_VERSION,
    idempotencyKey: 'upload-current',
    albumId: 'album-1',
    epochId: 7,
    fileName: 'current.jpg',
    fileSize: 1,
    totalChunks: 1,
    completedShards: [],
    status: 'queued',
    retryCount: 0,
    lastAttemptAt: 0,
  };
}

describe('LegacyUploadQueueDrainer', () => {
  beforeEach(() => {
    legacyUploadTelemetry.reset();
  });

  it('detects pre-R-Cl1 records by old snapshot version, missing required fields, and non-UUIDv7 ids', async () => {
    const store = new MemoryStore([
      currentRecord(),
      {
        id: 'legacy-job-1',
        version: 3,
        albumId: 'album-1',
        epochId: 7,
        fileName: 'legacy.jpg',
        fileSize: 3,
        totalChunks: 1,
        completedShards: [],
        status: 'queued',
        retryCount: 0,
        lastAttemptAt: 0,
      },
      {
        id: createUuidV7(),
        schemaVersion: SNAPSHOT_VERSION,
        snapshotVersion: SNAPSHOT_VERSION,
        idempotencyKey: 'upload-complete',
        albumId: 'album-1',
        epochId: 7,
        fileName: 'complete.jpg',
        fileSize: 3,
        totalChunks: 1,
        completedShards: [],
        status: 'complete',
        retryCount: 0,
        lastAttemptAt: 0,
      },
    ]);

    const detections = await new LegacyUploadQueueDrainer(store).detect();

    expect(detections).toHaveLength(2);
    expect(detections[0]?.reasons).toEqual(expect.arrayContaining([
      'snapshot-version-too-old',
      'idempotency-key-missing',
      'job-id-not-uuidv7',
    ]));
    expect(detections[1]?.reasons).toContain('tiered-shards-missing');
  });

  it('drains file-backed legacy records into current schema records with fresh UUIDv7 and idempotency key', async () => {
    const sourceFile = new File([new Uint8Array([1, 2, 3])], 'legacy.png', { type: 'image/png' });
    const store = new MemoryStore([
      {
        id: 'legacy-job-2',
        version: 2,
        album_id: 'album-2',
        epoch_id: 8,
        epoch_handle_id: 'epoch-handle-8',
        file: sourceFile,
        status: 'queued',
      },
    ]);
    const requeue = vi.fn(async () => undefined);

    const result = await new LegacyUploadQueueDrainer(store).drain({ requeue });

    expect(result.stranded).toHaveLength(0);
    expect(result.migrated).toHaveLength(1);
    const migrated = result.migrated[0]!;
    expect(isUuidV7(migrated.id)).toBe(true);
    expect(migrated.idempotencyKey).toMatch(/^upload-/);
    expect(migrated.schemaVersion).toBe(SNAPSHOT_VERSION);
    expect(migrated.snapshotVersion).toBe(SNAPSHOT_VERSION);
    expect(migrated.albumId).toBe('album-2');
    expect(migrated.epochHandleId).toBe('epoch-handle-8');
    expect(store.records.has('legacy-job-2')).toBe(false);
    expect(store.records.get(migrated.id)).toEqual(migrated);
    expect(requeue).toHaveBeenCalledWith(migrated, sourceFile);
    expect(legacyUploadTelemetry.snapshot()).toEqual(expect.arrayContaining([
      { counter: 'upload_queue_migrated_to_rust_core', count: 1 },
      { counter: 'upload_queue_legacy_task_completed', count: 1 },
    ]));
  });

  it('drains mixed stores without touching current-schema tasks or counting them as migrations', async () => {
    const keep = currentRecord();
    const sourceFile = new File([new Uint8Array([4, 5, 6])], 'legacy-mixed.jpg', { type: 'image/jpeg' });
    const store = new MemoryStore([
      keep,
      {
        id: 'legacy-mixed-migratable',
        version: 2,
        albumId: 'album-mixed',
        epochId: 10,
        epochHandleId: 'epoch-handle-10',
        file: sourceFile,
        status: 'queued',
      },
      {
        id: 'legacy-mixed-stranded',
        version: 2,
        albumId: 'album-mixed',
        epochId: 10,
        epochHandleId: 'epoch-handle-10',
        status: 'queued',
      },
    ]);
    const requeue = vi.fn(async () => undefined);

    const result = await new LegacyUploadQueueDrainer(store).drain({ requeue });

    expect(result.migrated).toHaveLength(1);
    expect(result.stranded).toHaveLength(1);
    expect(store.records.get(keep.id!)).toEqual(keep);
    expect(store.records.has('legacy-mixed-migratable')).toBe(false);
    expect(store.records.get('legacy-mixed-stranded')).toEqual(expect.objectContaining({
      stranded: true,
      deletionRequested: true,
      status: 'permanently_failed',
    }));
    expect(requeue).toHaveBeenCalledTimes(1);
    expect(legacyUploadTelemetry.snapshot()).toEqual(expect.arrayContaining([
      { counter: 'upload_queue_migrated_to_rust_core', count: 1 },
      { counter: 'upload_queue_legacy_task_completed', count: 1 },
      { counter: 'upload_queue_legacy_task_stranded', count: 1 },
    ]));
  });

  it('strands legacy records that cannot be safely retried without a source Blob', async () => {
    const store = new MemoryStore([
      {
        id: 'legacy-job-3',
        version: 1,
        albumId: 'album-3',
        epochId: 9,
        status: 'queued',
      },
    ]);

    const result = await new LegacyUploadQueueDrainer(store).drain();

    expect(result.migrated).toHaveLength(0);
    expect(result.stranded).toHaveLength(1);
    expect(store.records.get('legacy-job-3')).toEqual(expect.objectContaining({
      stranded: true,
      deletionRequested: true,
      legacyStrandReason: 'source-blob-unavailable',
      status: 'permanently_failed',
    }));
    expect(legacyUploadTelemetry.snapshot()).toContainEqual({
      counter: 'upload_queue_legacy_task_stranded',
      count: 1,
    });
  });

  it('resets detected and stranded legacy records without deleting current tasks', async () => {
    const keep = currentRecord();
    const store = new MemoryStore([
      keep,
      { id: 'legacy-job-4', version: 3, status: 'queued' },
      { id: 'stranded-job', version: 3, stranded: true, deletionRequested: true, status: 'permanently_failed' },
    ]);

    const removed = await new LegacyUploadQueueDrainer(store).reset();

    expect(removed).toBe(2);
    expect(Array.from(store.records.values())).toEqual([keep]);
  });
});
