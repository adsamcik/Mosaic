import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  AlbumSyncInitInput,
  AlbumSyncSnapshot,
  SyncAdapterPort,
  SyncEffect,
  SyncEvent,
} from './upload-adapter-port';
import { isObject } from '../type-guards';

const ALBUM_SYNC_DB_NAME = 'mosaic-album-sync';
const ALBUM_SYNC_STORE_NAME = 'snapshots';
const ALBUM_SYNC_DB_VERSION = 1;
const ALBUM_SYNC_SNAPSHOT_RECORD_VERSION = 1;

interface AlbumSyncSnapshotDb extends DBSchema {
  readonly snapshots: {
    readonly key: string;
    readonly value: unknown;
  };
}

interface AlbumSyncSnapshotRecord {
  readonly id: string;
  readonly schemaVersion: typeof ALBUM_SYNC_SNAPSHOT_RECORD_VERSION;
  readonly snapshotVersion: typeof ALBUM_SYNC_SNAPSHOT_RECORD_VERSION;
  readonly albumId: string;
  readonly status: string;
  readonly retryCount: number;
  readonly rustCoreSnapshot: AlbumSyncSnapshot;
}

export interface RustCoreSyncSchemaVersionMismatchTelemetry {
  warn(event: {
    readonly warning: 'SchemaVersionMismatch';
    readonly adapter: 'sync';
    readonly expectedSchemaVersion: number;
  }): void;
}

export interface AlbumSyncSnapshotPersistence {
  put(snapshot: AlbumSyncSnapshot): Promise<void>;
  get(snapshotId: string): Promise<AlbumSyncSnapshot | null>;
}

export interface RustSyncAdapterResult {
  readonly snapshot: AlbumSyncSnapshot;
  readonly effects: readonly SyncEffect[];
}

export class IdbAlbumSyncSnapshotPersistence implements AlbumSyncSnapshotPersistence {
  private db: Promise<IDBPDatabase<AlbumSyncSnapshotDb>> | null = null;

  constructor(private readonly telemetry?: RustCoreSyncSchemaVersionMismatchTelemetry) {}

  async put(snapshot: AlbumSyncSnapshot): Promise<void> {
    const db = await this.open();
    await db.put(ALBUM_SYNC_STORE_NAME, toAlbumSyncSnapshotRecord(snapshot));
  }

  async get(snapshotId: string): Promise<AlbumSyncSnapshot | null> {
    const db = await this.open();
    const record = await db.get(ALBUM_SYNC_STORE_NAME, snapshotId);
    if (!isAlbumSyncSnapshotRecord(record)) {
      if (isAlbumSyncSnapshotSchemaVersionMismatch(record)) {
        this.telemetry?.warn({
          warning: 'SchemaVersionMismatch',
          adapter: 'sync',
          expectedSchemaVersion: ALBUM_SYNC_SNAPSHOT_RECORD_VERSION,
        });
      }
      return null;
    }
    return cloneAlbumSyncSnapshot(record.rustCoreSnapshot);
  }

  private open(): Promise<IDBPDatabase<AlbumSyncSnapshotDb>> {
    this.db ??= openDB<AlbumSyncSnapshotDb>(ALBUM_SYNC_DB_NAME, ALBUM_SYNC_DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(ALBUM_SYNC_STORE_NAME)) {
          database.createObjectStore(ALBUM_SYNC_STORE_NAME, { keyPath: 'id' });
        }
      },
    });
    return this.db;
  }
}

export class InMemoryAlbumSyncSnapshotPersistence implements AlbumSyncSnapshotPersistence {
  private readonly snapshots = new Map<string, unknown>();

  constructor(private readonly telemetry?: RustCoreSyncSchemaVersionMismatchTelemetry) {}

  async put(snapshot: AlbumSyncSnapshot): Promise<void> {
    this.snapshots.set(snapshot.albumId, toAlbumSyncSnapshotRecord(snapshot));
  }

  async get(snapshotId: string): Promise<AlbumSyncSnapshot | null> {
    const record = this.snapshots.get(snapshotId);
    if (!isAlbumSyncSnapshotRecord(record)) {
      if (isAlbumSyncSnapshotSchemaVersionMismatch(record)) {
        this.telemetry?.warn({
          warning: 'SchemaVersionMismatch',
          adapter: 'sync',
          expectedSchemaVersion: ALBUM_SYNC_SNAPSHOT_RECORD_VERSION,
        });
      }
      return null;
    }
    return cloneAlbumSyncSnapshot(record.rustCoreSnapshot);
  }

  putRawRecordForTests(snapshotId: string, record: unknown): void {
    this.snapshots.set(snapshotId, record);
  }
}

export class RustSyncAdapter {
  private snapshot: AlbumSyncSnapshot | null = null;
  private pendingTransition: Promise<AlbumSyncSnapshot | null> = Promise.resolve(null);

  constructor(
    private readonly port: SyncAdapterPort,
    private readonly persistence: AlbumSyncSnapshotPersistence = new IdbAlbumSyncSnapshotPersistence(),
  ) {}

  async start(input: AlbumSyncInitInput): Promise<RustSyncAdapterResult> {
    const nextSnapshot = await this.port.initSync(input);
    await this.persistence.put(nextSnapshot);
    this.snapshot = nextSnapshot;
    this.pendingTransition = Promise.resolve(nextSnapshot);
    return this.resultFor(nextSnapshot);
  }

  async submit(event: SyncEvent): Promise<RustSyncAdapterResult> {
    const transition = this.pendingTransition.then(async (currentSnapshot) => {
      if (currentSnapshot === null) {
        throw new Error('Adapter not started');
      }
      const nextSnapshot = await this.port.advanceSync(currentSnapshot, event);
      await this.persistence.put(nextSnapshot);
      this.snapshot = nextSnapshot;
      return nextSnapshot;
    });
    this.pendingTransition = transition.catch(() => this.snapshot);
    const nextSnapshot = await transition;
    return this.resultFor(nextSnapshot);
  }

  async resume(snapshotId: string): Promise<RustSyncAdapterResult | null> {
    const nextSnapshot = await this.persistence.get(snapshotId);
    if (nextSnapshot === null) {
      return null;
    }
    this.snapshot = nextSnapshot;
    this.pendingTransition = Promise.resolve(nextSnapshot);
    return this.resultFor(nextSnapshot);
  }

  private resultFor(snapshot: AlbumSyncSnapshot): RustSyncAdapterResult {
    const effect = this.port.getCurrentEffect(snapshot);
    return {
      snapshot,
      effects: effect === null ? [] : [effect],
    };
  }
}

function toAlbumSyncSnapshotRecord(snapshot: AlbumSyncSnapshot): AlbumSyncSnapshotRecord {
  return {
    id: snapshot.albumId,
    schemaVersion: ALBUM_SYNC_SNAPSHOT_RECORD_VERSION,
    snapshotVersion: ALBUM_SYNC_SNAPSHOT_RECORD_VERSION,
    albumId: snapshot.albumId,
    status: snapshot.phase,
    retryCount: snapshot.retryCount,
    rustCoreSnapshot: cloneAlbumSyncSnapshot(snapshot),
  };
}

function cloneAlbumSyncSnapshot(snapshot: AlbumSyncSnapshot): AlbumSyncSnapshot {
  return {
    ...snapshot,
  };
}

function isAlbumSyncSnapshotRecord(value: unknown): value is AlbumSyncSnapshotRecord {
  if (!isObject(value)) {
    return false;
  }
  return value.rustCoreSnapshot !== undefined
    && isAlbumSyncSnapshot(value.rustCoreSnapshot)
    && value.schemaVersion === ALBUM_SYNC_SNAPSHOT_RECORD_VERSION
    && value.snapshotVersion === ALBUM_SYNC_SNAPSHOT_RECORD_VERSION;
}

function isAlbumSyncSnapshotSchemaVersionMismatch(value: unknown): boolean {
  return isObject(value)
    && (value.schemaVersion !== undefined || value.snapshotVersion !== undefined)
    && (
      value.schemaVersion !== ALBUM_SYNC_SNAPSHOT_RECORD_VERSION
      || value.snapshotVersion !== ALBUM_SYNC_SNAPSHOT_RECORD_VERSION
    );
}

function isAlbumSyncSnapshot(value: unknown): value is AlbumSyncSnapshot {
  if (!isObject(value)) {
    return false;
  }
  return typeof value.schemaVersion === 'number'
    && typeof value.albumId === 'string'
    && typeof value.phase === 'string'
    && typeof value.activeCursor === 'string'
    && typeof value.pendingCursor === 'string'
    && typeof value.rerunRequested === 'boolean'
    && typeof value.retryCount === 'number'
    && typeof value.maxRetryCount === 'number'
    && typeof value.nextRetryUnixMs === 'bigint'
    && typeof value.lastErrorCode === 'number'
    && typeof value.lastErrorStage === 'string'
    && typeof value.updatedAtUnixMs === 'bigint';
}

