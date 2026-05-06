import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  UploadAdapterPort,
  UploadEffect,
  UploadEvent,
  UploadInitInput,
  UploadJobSnapshot,
} from './upload-adapter-port';

const UPLOAD_QUEUE_DB_NAME = 'mosaic-upload-queue';
const UPLOAD_QUEUE_STORE_NAME = 'tasks';
const UPLOAD_QUEUE_DB_VERSION = 1;
const UPLOAD_SNAPSHOT_RECORD_VERSION = 4;

interface UploadSnapshotDb extends DBSchema {
  readonly tasks: {
    readonly key: string;
    readonly value: unknown;
  };
}

interface UploadSnapshotRecord {
  readonly id: string;
  readonly schemaVersion: typeof UPLOAD_SNAPSHOT_RECORD_VERSION;
  readonly snapshotVersion: typeof UPLOAD_SNAPSHOT_RECORD_VERSION;
  readonly jobId: string;
  readonly albumId: string;
  readonly idempotencyKey: string;
  readonly status: string;
  readonly retryCount: number;
  readonly rustCoreSnapshot: UploadJobSnapshot;
}

export interface UploadSnapshotPersistence {
  put(snapshot: UploadJobSnapshot): Promise<void>;
  get(snapshotId: string): Promise<UploadJobSnapshot | null>;
}

export interface RustUploadAdapterResult {
  readonly snapshot: UploadJobSnapshot;
  readonly effects: readonly UploadEffect[];
}

export class IdbUploadSnapshotPersistence implements UploadSnapshotPersistence {
  private db: Promise<IDBPDatabase<UploadSnapshotDb>> | null = null;

  async put(snapshot: UploadJobSnapshot): Promise<void> {
    const db = await this.open();
    await db.put(UPLOAD_QUEUE_STORE_NAME, toUploadSnapshotRecord(snapshot));
  }

  async get(snapshotId: string): Promise<UploadJobSnapshot | null> {
    const db = await this.open();
    const record = await db.get(UPLOAD_QUEUE_STORE_NAME, snapshotId);
    if (!isUploadSnapshotRecord(record)) {
      return null;
    }
    return cloneUploadSnapshot(record.rustCoreSnapshot);
  }

  private open(): Promise<IDBPDatabase<UploadSnapshotDb>> {
    this.db ??= openDB<UploadSnapshotDb>(UPLOAD_QUEUE_DB_NAME, UPLOAD_QUEUE_DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(UPLOAD_QUEUE_STORE_NAME)) {
          database.createObjectStore(UPLOAD_QUEUE_STORE_NAME, { keyPath: 'id' });
        }
      },
    });
    return this.db;
  }
}

export class InMemoryUploadSnapshotPersistence implements UploadSnapshotPersistence {
  private readonly snapshots = new Map<string, UploadJobSnapshot>();

  async put(snapshot: UploadJobSnapshot): Promise<void> {
    this.snapshots.set(snapshot.jobId, cloneUploadSnapshot(snapshot));
  }

  async get(snapshotId: string): Promise<UploadJobSnapshot | null> {
    const snapshot = this.snapshots.get(snapshotId);
    return snapshot === undefined ? null : cloneUploadSnapshot(snapshot);
  }
}

export class RustUploadAdapter {
  private snapshot: UploadJobSnapshot | null = null;

  constructor(
    private readonly port: UploadAdapterPort,
    private readonly persistence: UploadSnapshotPersistence = new IdbUploadSnapshotPersistence(),
  ) {}

  async start(input: UploadInitInput): Promise<RustUploadAdapterResult> {
    const nextSnapshot = await this.port.initJob(input);
    await this.persistence.put(nextSnapshot);
    this.snapshot = nextSnapshot;
    return this.resultFor(nextSnapshot);
  }

  async submit(event: UploadEvent): Promise<RustUploadAdapterResult> {
    if (this.snapshot === null) {
      throw new Error('Adapter not started');
    }
    const nextSnapshot = await this.port.advanceJob(this.snapshot, event);
    await this.persistence.put(nextSnapshot);
    this.snapshot = nextSnapshot;
    return this.resultFor(nextSnapshot);
  }

  async resume(snapshotId: string): Promise<RustUploadAdapterResult | null> {
    const nextSnapshot = await this.persistence.get(snapshotId);
    if (nextSnapshot === null) {
      return null;
    }
    this.snapshot = nextSnapshot;
    return this.resultFor(nextSnapshot);
  }

  private resultFor(snapshot: UploadJobSnapshot): RustUploadAdapterResult {
    const effect = this.port.getCurrentEffect(snapshot);
    return {
      snapshot,
      effects: effect === null ? [] : [effect],
    };
  }
}

function toUploadSnapshotRecord(snapshot: UploadJobSnapshot): UploadSnapshotRecord {
  return {
    id: snapshot.jobId,
    schemaVersion: UPLOAD_SNAPSHOT_RECORD_VERSION,
    snapshotVersion: UPLOAD_SNAPSHOT_RECORD_VERSION,
    jobId: snapshot.jobId,
    albumId: snapshot.albumId,
    idempotencyKey: snapshot.idempotencyKey,
    status: snapshot.phase,
    retryCount: snapshot.retryCount,
    rustCoreSnapshot: cloneUploadSnapshot(snapshot),
  };
}

function cloneUploadSnapshot(snapshot: UploadJobSnapshot): UploadJobSnapshot {
  return {
    ...snapshot,
  };
}

function isUploadSnapshotRecord(value: unknown): value is UploadSnapshotRecord {
  if (!isObject(value)) {
    return false;
  }
  return value.rustCoreSnapshot !== undefined && isUploadJobSnapshot(value.rustCoreSnapshot);
}

function isUploadJobSnapshot(value: unknown): value is UploadJobSnapshot {
  if (!isObject(value)) {
    return false;
  }
  return typeof value.schemaVersion === 'number'
    && typeof value.jobId === 'string'
    && typeof value.albumId === 'string'
    && typeof value.phase === 'string'
    && typeof value.shardRefCount === 'number'
    && typeof value.idempotencyKey === 'string'
    && typeof value.retryCount === 'number'
    && typeof value.maxRetryCount === 'number'
    && typeof value.nextRetryNotBeforeMs === 'bigint'
    && typeof value.hasNextRetryNotBeforeMs === 'boolean'
    && typeof value.snapshotRevision === 'bigint'
    && typeof value.lastEffectId === 'string';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
