/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import initSqlJs from 'fts5-sql-bundle';
import '../lib/worker-error-transfer';
import { createLogger } from '../lib/logger';
import type {
  Bounds,
  AlbumEpochHighWaterMark,
  DbCryptoBridge,
  DbWorkerApi,
  DecryptedManifest,
  ManifestReplayCheckpoint,
  ManifestSyncCheckpoint,
  ManifestSeqHighWaterMark,
  GeoPoint,
  PhotoMeta,
} from './types';
import { buildFtsSearchQuery } from './fts-query';

// Create scoped logger for database worker
const log = createLogger('DbWorker');

type SqlJsStatic = Awaited<ReturnType<typeof import('sql.js').default>>;
type DatabaseType = import('sql.js').Database;

const SECURITY_STATE_FILE = 'mosaic.security.enc';
const SECURITY_STATE_LOCK = 'mosaic-security-state-v1';
const SECURITY_STATE_MAGIC = 'MOSAIC_SECURITY_STATE';
const SECURITY_STATE_VERSION = 1 as const;

interface PersistedManifestSecurityState {
  readonly magic: typeof SECURITY_STATE_MAGIC;
  readonly version: typeof SECURITY_STATE_VERSION;
  readonly epochHighWaters: readonly AlbumEpochHighWaterMark[];
  readonly highWaters: readonly ManifestSeqHighWaterMark[];
  readonly checkpoints: readonly ManifestReplayCheckpoint[];
}

interface ManifestSecurityState {
  readonly epochHighWaters: Map<string, AlbumEpochHighWaterMark>;
  readonly highWaters: Map<string, ManifestSeqHighWaterMark>;
  readonly checkpoints: Map<string, ManifestReplayCheckpoint>;
}

/**
 * On-disk envelope version for the OPFS-persisted SQLite snapshot.
 *
 * Layout: `[u8 SNAPSHOT_VERSION][...account-handle wrap blob (nonce(24) || ciphertext_with_tag(16))...]`.
 *
 * R-C6 hard cutover: bumped from the Slice 8 v3 account-handle wrap
 * envelope to v4 because `wrapWithAccountHandle`/`unwrapWithAccountHandle`
 * now bind OPFS data to the `mosaic:account-wrapped-data:v1` AEAD AAD label.
 * v3 snapshots were encrypted with the same wire bytes but no AAD, so they
 * cannot be decrypted under the new domain.
 *
 * Slice 8 hard cutover: bumped from the legacy un-prefixed
 * `[nonce(24) || ciphertext]` libsodium-secretbox layout to a versioned
 * envelope wrapped via Rust `wrapWithAccountHandle`. After the independent
 * replay-security sidecar authenticates, snapshots whose first byte does not
 * match {@link SNAPSHOT_VERSION} are rebuilt as disposable cache. A missing
 * or corrupt sidecar fails closed instead of trusting cursor or replay state
 * from this cache.
 *
 * Bumps must always invalidate older versions (not migrate them) — the
 * snapshot is a local cache that the sync engine repopulates from the
 * server, so there is no data-loss concern.
 */
export const SNAPSHOT_VERSION = 4 as const;

export enum DbWorkerErrorCode {
  NOT_INITIALIZED = 'NOT_INITIALIZED',
  RESET_REQUIRED = 'RESET_REQUIRED',
  SNAPSHOT_DECRYPT_FAILED = 'SNAPSHOT_DECRYPT_FAILED',
}

export class DbWorkerError extends Error {
  constructor(
    message: string,
    public readonly code: DbWorkerErrorCode,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DbWorkerError';
  }
}

/**
 * Sentinel thrown internally when the persisted snapshot's version byte
 * does not match {@link SNAPSHOT_VERSION}. Once the independent security
 * sidecar authenticates, callers in `init` translate this to "rebuild the
 * disposable cache".
 */
class SnapshotVersionMismatchError extends Error {
  constructor(public readonly observed: number) {
    super(
      `OPFS snapshot version ${String(observed)} does not match expected ${String(SNAPSHOT_VERSION)}`,
    );
    this.name = 'SnapshotVersionMismatchError';
  }
}

// Store the loaded sql.js instance
let cachedSqlJs: SqlJsStatic | null = null;

/**
 * Load the pinned FTS5 sql.js package as a build-time module. Vite includes
 * the JavaScript in the frontend artifact; only the WASM binary is located
 * at runtime. No fetched source text or dynamic code evaluation is allowed.
 */
async function loadSqlJs(): Promise<SqlJsStatic> {
  if (cachedSqlJs) return cachedSqlJs;

  const timer = log.startTimer('sql.js WASM initialization');

  cachedSqlJs = (await initSqlJs({
    locateFile: () => '/sql-wasm.wasm',
  })) as unknown as SqlJsStatic;

  timer.end();
  log.info('sql.js loaded successfully');

  return cachedSqlJs!;
}

/**
 * Database Worker Implementation
 * Manages SQLite-WASM database with OPFS persistence
 */
export class DbWorker implements DbWorkerApi {
  private sql: SqlJsStatic | null = null;
  private db: DatabaseType | null = null;
  /**
   * Slice 8: replaces the legacy `sessionKey: Uint8Array` field. The
   * worker no longer holds raw key bytes — wrap/unwrap is delegated to
   * the crypto worker via this Comlink-proxied bridge.
   */
  private crypto: DbCryptoBridge | null = null;
  private lastError: DbWorkerError | null = null;
  /** Account-wrapped anti-replay state, deliberately outside the cache DB. */
  private securityState: ManifestSecurityState | null = null;
  /** Serializes this worker's security mutations before the cross-worker lock. */
  private securityStateChain: Promise<void> = Promise.resolve();
  /**
   * Tail of a per-worker chain of in-flight OPFS writes.
   *
   * Comlink can dispatch multiple async method calls concurrently on a
   * single worker — each `await` yields the message loop and lets the
   * next queued call begin. Without serialization, two `saveToOPFS()`
   * calls could open two `createWritable()` streams on the same
   * `mosaic.db.enc` file handle in parallel; whichever `close()`d last
   * would silently overwrite the other, losing freshly persisted data.
   * Under burst-upload load this manifested as the post-reload regression
   * in `identity-persistence-stress.spec.ts` (P0-IDENTITY-STRESS): 3
   * uploads succeeded in-memory but only 1 made it into OPFS before the
   * test reloaded the page.
   *
   * Every call to `saveToOPFS()` chains onto this promise so writes are
   * processed strictly in-order, and `flushSnapshot()` simply awaits the
   * current tail to give callers a deterministic "OPFS is up to date"
   * fence (used by `UploadContext` after `flushSyncCompleteNow`).
   */
  private snapshotChain: Promise<void> = Promise.resolve();

  async init(crypto: DbCryptoBridge): Promise<void> {
    if (this.lastError) {
      throw this.lastError;
    }

    const initTimer = log.startTimer('database initialization');
    this.crypto = crypto;

    // Slice 8: SQLite WASM is the only synchronous bootstrap left here.
    // libsodium is no longer imported — encryption is delegated via the
    // crypto bridge.
    this.sql = await loadSqlJs();

    // Read the cache first so a missing security sidecar cannot be mistaken for
    // a first run and paired with an existing high unsigned cursor.
    const existingData = await this.loadFromOPFS();
    try {
      this.securityState = await this.withSecurityStateLock(async () => {
        const diskState = await this.readSecurityStateFromOPFS();
        if (diskState) return diskState;
        if (existingData) {
          throw new Error(
            'Replay-security sidecar is missing while the cache snapshot exists',
          );
        }
        const emptyState = DbWorker.emptySecurityState();
        if (
          typeof navigator !== 'undefined' &&
          navigator.storage !== undefined &&
          'getDirectory' in navigator.storage
        ) {
          // Establish the authenticated pair before any cache snapshot exists.
          await this.writeSecurityStateToOPFS(emptyState);
        }
        return emptyState;
      });
    } catch (error) {
      this.securityState = null;
      this.markUnavailable(
        new DbWorkerError(
          'Failed to load signed-manifest replay security state; explicit Clear Local Data is required',
          DbWorkerErrorCode.RESET_REQUIRED,
          error,
        ),
      );
      throw this.lastError;
    }

    let cacheNeedsRewrite = false;
    if (existingData) {
      log.debug('Found existing database in OPFS', {
        size: existingData.byteLength,
      });
      try {
        // Decrypt existing database via the crypto bridge (Rust-backed)
        const decryptTimer = log.startTimer('database decryption');
        const decrypted = await this.decryptBlob(existingData);
        decryptTimer.end({ decryptedSize: decrypted.byteLength });
        this.db = new this.sql.Database(decrypted);
        this.lastError = null;
        log.info('Loaded existing database from OPFS');
      } catch (error) {
        // The independently authenticated replay state loaded first, so this
        // file is only a disposable cache. Recreate it without weakening floors.
        log.warn('Rebuilding unreadable disposable database cache', {
          error: error instanceof Error ? error.message : String(error),
        });
        this.db = new this.sql.Database();
        this.lastError = null;
        cacheNeedsRewrite = true;
      }
    } else {
      log.debug('No existing database found, creating new one');
      this.db = new this.sql.Database();
      this.lastError = null;
    }

    try {
      await this.runMigrations();
      if (cacheNeedsRewrite) {
        await this.saveToOPFS();
      }
      this.lastError = null;
    } catch (error) {
      this.markUnavailable(
        error instanceof DbWorkerError
          ? error
          : new DbWorkerError(
              'Database initialization failed',
              DbWorkerErrorCode.RESET_REQUIRED,
              error,
            ),
      );
      throw this.lastError;
    }
    initTimer.end();
  }

  async resetStorage(): Promise<void> {
    if (!this.crypto) {
      throw new DbWorkerError(
        'Database not initialized',
        DbWorkerErrorCode.NOT_INITIALIZED,
      );
    }
    if (!this.securityState) {
      throw new DbWorkerError(
        'Cannot rebuild cache without authenticated replay-security state; use Clear Local Data to forget this device',
        DbWorkerErrorCode.RESET_REQUIRED,
        this.lastError ?? undefined,
      );
    }

    // Security state lives in mosaic.security.enc and is intentionally not
    // modified here. Finish all older writes before replacing only the cache.
    await this.securityStateChain;
    await this.flushSnapshot();
    const currentDb = this.db;
    const priorError = this.lastError;

    if (!this.sql) {
      this.sql = await loadSqlJs();
    }

    this.lastError = null;
    const replacementDb = new this.sql.Database();
    this.db = replacementDb;
    try {
      await this.runMigrations();
      await this.saveToOPFS();
      currentDb?.close();
    } catch (error) {
      replacementDb.close();
      this.db = currentDb;
      this.lastError = priorError;
      if (!currentDb) {
        const resetError = new DbWorkerError(
          'Failed to rebuild disposable database cache',
          DbWorkerErrorCode.RESET_REQUIRED,
          error,
        );
        this.markUnavailable(resetError);
        throw resetError;
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.securityStateChain;
    if (this.db) {
      await this.saveToOPFS();
      this.db.close();
      this.db = null;
    }
    // Slice 8: nothing to wipe — the crypto bridge holds no key bytes.
    // The crypto worker's account handle owns the L2-derived material
    // and is cleared via its own `clear()` lifecycle.
    this.securityState = null;
    this.crypto = null;
  }

  private markUnavailable(error: DbWorkerError): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }

    this.lastError = error;
    log.error(error.message, error.cause);
  }

  private getReadyDb(): DatabaseType {
    if (this.lastError) {
      throw this.lastError;
    }

    if (!this.db) {
      throw new DbWorkerError(
        'Database not initialized',
        DbWorkerErrorCode.NOT_INITIALIZED,
      );
    }

    return this.db;
  }

  /**
   * Get current schema version from SQLite PRAGMA user_version
   */
  private getSchemaVersion(): number {
    const db = this.getReadyDb();
    const result = db.exec('PRAGMA user_version');
    return (result[0]?.values[0]?.[0] as number) ?? 0;
  }

  /**
   * Set schema version using SQLite PRAGMA user_version
   */
  private setSchemaVersion(version: number): void {
    this.getReadyDb().run(`PRAGMA user_version = ${version}`);
  }

  /**
   * Check if FTS5 table exists
   */
  private ftsTableExists(): boolean {
    const result = this.getReadyDb().exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='photos_fts'",
    );
    const firstRow = result[0];
    return (
      result.length > 0 &&
      firstRow !== undefined &&
      (firstRow.values?.length ?? 0) > 0
    );
  }

  private columnExists(table: string, column: string): boolean {
    const result = this.getReadyDb().exec(`PRAGMA table_info(${table})`);
    const rows = result[0]?.values ?? [];
    return rows.some((row) => row[1] === column);
  }

  /**
   * Create FTS5 table and triggers
   */
  private createFtsTable(): void {
    log.info('Creating FTS5 virtual table for full-text search');

    this.getReadyDb().run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS photos_fts USING fts5(
        filename, tags, description,
        content='photos',
        content_rowid='rowid'
      );
    `);

    // Triggers to keep FTS in sync
    this.getReadyDb().run(`
      CREATE TRIGGER IF NOT EXISTS photos_ai AFTER INSERT ON photos BEGIN
        INSERT INTO photos_fts(rowid, filename, tags, description)
        VALUES (NEW.rowid, NEW.filename, NEW.tags, NEW.description);
      END;
    `);

    this.getReadyDb().run(`
      CREATE TRIGGER IF NOT EXISTS photos_ad AFTER DELETE ON photos BEGIN
        INSERT INTO photos_fts(photos_fts, rowid, filename, tags, description)
        VALUES ('delete', OLD.rowid, OLD.filename, OLD.tags, OLD.description);
      END;
    `);

    this.getReadyDb().run(`
      CREATE TRIGGER IF NOT EXISTS photos_au AFTER UPDATE ON photos BEGIN
        INSERT INTO photos_fts(photos_fts, rowid, filename, tags, description)
        VALUES ('delete', OLD.rowid, OLD.filename, OLD.tags, OLD.description);
        INSERT INTO photos_fts(rowid, filename, tags, description)
        VALUES (NEW.rowid, NEW.filename, NEW.tags, NEW.description);
      END;
    `);
  }

  /**
   * Rebuild FTS index from existing photos data
   */
  private rebuildFtsIndex(): void {
    log.info('Rebuilding FTS index from existing photos');

    // Clear existing FTS data and rebuild from photos table
    this.getReadyDb().run(`
      INSERT INTO photos_fts(photos_fts) VALUES('rebuild');
    `);

    log.info('FTS index rebuild complete');
  }

  private async runMigrations(): Promise<void> {
    const db = this.getReadyDb();
    const currentVersion = this.getSchemaVersion();
    log.debug('Current schema version', { version: currentVersion });

    // Version 0 -> 1: Initial schema
    if (currentVersion < 1) {
      log.info('Running migration: v0 -> v1 (initial schema)');

      db.run(`
        -- Albums table for sync state
        CREATE TABLE IF NOT EXISTS albums (
          id TEXT PRIMARY KEY,
          current_version INTEGER DEFAULT 0
        );
        
        -- Photos table for decrypted metadata
        CREATE TABLE IF NOT EXISTS photos (
          id TEXT PRIMARY KEY,
          asset_id TEXT NOT NULL,
          album_id TEXT NOT NULL,
          filename TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          width INTEGER,
          height INTEGER,
          taken_at TEXT,
          lat REAL,
          lng REAL,
          tags TEXT,
          created_at TEXT,
          updated_at TEXT,
          shard_ids TEXT,
          epoch_id INTEGER,
          description TEXT,
          rotation INTEGER DEFAULT 0,
          version_created INTEGER DEFAULT 0
        );
        
        -- Indexes for common queries
        CREATE INDEX IF NOT EXISTS idx_photos_album ON photos(album_id);
        CREATE INDEX IF NOT EXISTS idx_photos_taken ON photos(taken_at);
        CREATE INDEX IF NOT EXISTS idx_photos_geo ON photos(lat, lng) WHERE lat IS NOT NULL;
      `);

      this.setSchemaVersion(1);
    }

    // Version 1 -> 2: Add FTS5 for full-text search
    if (currentVersion < 2) {
      log.info('Running migration: v1 -> v2 (FTS5 full-text search)');

      try {
        this.createFtsTable();

        // If upgrading from v1, rebuild FTS index to include existing photos
        if (currentVersion === 1) {
          this.rebuildFtsIndex();
        }

        this.setSchemaVersion(2);
        log.info('FTS5 migration complete');
      } catch (error) {
        log.error('Failed to create FTS5 table', error);
        // Don't update version - will retry on next init
        throw error;
      }
    }

    // Version 2 -> 3: Add thumbnail columns
    if (currentVersion < 3) {
      log.info('Running migration: v2 -> v3 (thumbnail columns)');

      try {
        db.run(`
          ALTER TABLE photos ADD COLUMN thumbnail TEXT;
        `);
        db.run(`
          ALTER TABLE photos ADD COLUMN thumb_width INTEGER;
        `);
        db.run(`
          ALTER TABLE photos ADD COLUMN thumb_height INTEGER;
        `);
        db.run(`
          ALTER TABLE photos ADD COLUMN blurhash TEXT;
        `);

        this.setSchemaVersion(3);
        log.info('Thumbnail columns migration complete');
      } catch (error) {
        log.error('Failed to add thumbnail columns', error);
        // Don't update version - will retry on next init
        throw error;
      }
    }

    // Version 3 -> 4: Add tier-specific shard ID columns
    if (currentVersion < 4) {
      log.info('Running migration: v3 -> v4 (tier shard columns)');

      try {
        db.run(`ALTER TABLE photos ADD COLUMN thumbnail_shard_id TEXT;`);
        db.run(`ALTER TABLE photos ADD COLUMN thumbnail_shard_hash TEXT;`);
        db.run(`ALTER TABLE photos ADD COLUMN preview_shard_id TEXT;`);
        db.run(`ALTER TABLE photos ADD COLUMN preview_shard_hash TEXT;`);
        db.run(`ALTER TABLE photos ADD COLUMN original_shard_ids TEXT;`); // JSON array
        db.run(`ALTER TABLE photos ADD COLUMN original_shard_hashes TEXT;`); // JSON array

        this.setSchemaVersion(4);
        log.info('Tier shard columns migration complete');
      } catch (error) {
        log.error('Failed to add tier shard columns', error);
        throw error;
      }
    }

    // Version 4 -> 5: Add thumbhash column (replaces blurhash for new uploads)
    if (currentVersion < 5) {
      log.info('Running migration: v4 -> v5 (thumbhash column)');

      try {
        db.run(`ALTER TABLE photos ADD COLUMN thumbhash TEXT;`);

        this.setSchemaVersion(5);
        log.info('Thumbhash column migration complete');
      } catch (error) {
        log.error('Failed to add thumbhash column', error);
        throw error;
      }
    }

    // Version 5 -> 6: Add video support columns
    if (currentVersion < 6) {
      log.info('Running migration: v5 -> v6 (video support)');

      try {
        db.run(`ALTER TABLE photos ADD COLUMN is_video INTEGER DEFAULT 0;`);
        db.run(`ALTER TABLE photos ADD COLUMN duration REAL;`);

        this.setSchemaVersion(6);
        log.info('Video support migration complete');
      } catch (error) {
        log.error('Failed to add video support columns', error);
        throw error;
      }
    }

    // Version 6 -> 7: Add photo rotation column
    if (this.getSchemaVersion() < 7) {
      log.info('Running migration: v6 -> v7 (photo rotation)');

      try {
        if (!this.columnExists('photos', 'rotation')) {
          db.run(`ALTER TABLE photos ADD COLUMN rotation INTEGER DEFAULT 0;`);
        }

        this.setSchemaVersion(7);
        log.info('Photo rotation migration complete');
      } catch (error) {
        log.error('Failed to add photo rotation column', error);
        throw error;
      }
    }

    // Version 7 -> 8: Track manifest version for stale sync protection
    if (this.getSchemaVersion() < 8) {
      log.info('Running migration: v7 -> v8 (manifest version tracking)');

      try {
        if (!this.columnExists('photos', 'version_created')) {
          db.run(
            `ALTER TABLE photos ADD COLUMN version_created INTEGER DEFAULT 0;`,
          );
        }

        this.setSchemaVersion(8);
        log.info('Manifest version tracking migration complete');
      } catch (error) {
        log.error('Failed to add manifest version tracking column', error);
        throw error;
      }
    }

    // Version 8 -> 9: Composite indexes for hot gallery / map queries.
    //
    // Audit "perf-slo C4/C5" found that:
    //   - getPhotos() does `WHERE album_id = ? ORDER BY taken_at DESC,
    //     created_at DESC LIMIT ? OFFSET ?` but only had a single-column
    //     idx_photos_album. Sorting was unindexable, so deep scrolling on
    //     a 10k-photo album degraded to O(N) per page.
    //   - getPhotosForMap() does `WHERE album_id = ? AND lat BETWEEN ?
    //     AND ? AND lng BETWEEN ? AND ?` but idx_photos_geo had no
    //     album_id prefix, so multi-album users scanned every geo-tagged
    //     photo and post-filtered.
    //
    // The new composite indexes subsume the legacy single-column ones,
    // which we drop to avoid double-write cost and planner confusion.
    if (this.getSchemaVersion() < 9) {
      log.info('Running migration: v8 -> v9 (composite gallery + geo indexes)');

      try {
        db.run(`
          CREATE INDEX IF NOT EXISTS idx_photos_album_taken_created
            ON photos(album_id, taken_at DESC, created_at DESC, id);

          CREATE INDEX IF NOT EXISTS idx_photos_album_geo
            ON photos(album_id, lat, lng) WHERE lat IS NOT NULL;

          DROP INDEX IF EXISTS idx_photos_album;
          DROP INDEX IF EXISTS idx_photos_taken;
          DROP INDEX IF EXISTS idx_photos_geo;
        `);

        this.setSchemaVersion(9);
        log.info('Composite index migration complete');
      } catch (error) {
        log.error('Failed to apply composite index migration', error);
        throw error;
      }
    }

    // Version 9 -> 10: replay-state cutover marker. The actual epoch, signer,
    // sequence, and exact-head state is account-wrapped in mosaic.security.enc;
    // it must never live in this disposable cache database.
    if (this.getSchemaVersion() < 10) {
      log.info('Running migration: v9 -> v10 (external replay-state cutover)');
      this.setSchemaVersion(10);
      log.info('External replay-state cutover complete');
    }

    // Ensure FTS table exists (safety check for corrupted state)
    if (!this.ftsTableExists()) {
      log.warn('FTS table missing despite schema version, recreating...');
      try {
        this.createFtsTable();
        this.rebuildFtsIndex();
        await this.saveToOPFS();
      } catch (error) {
        log.error('Failed to recreate FTS table', error);
      }
    }
  }

  async getAlbumVersion(albumId: string): Promise<number> {
    const result = this.getReadyDb().exec(
      'SELECT current_version FROM albums WHERE id = ?',
      [albumId],
    );
    return (result[0]?.values[0]?.[0] as number) ?? 0;
  }

  async setAlbumVersion(albumId: string, version: number): Promise<void> {
    this.getReadyDb().run(
      `
      INSERT INTO albums (id, current_version) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET current_version = ?
    `,
      [albumId, version, version],
    );
    await this.saveToOPFS();
  }

  /** Read one durable v2 manifest replay floor. */
  async getManifestSeqHighWater(
    albumId: string,
    signerKey: string,
  ): Promise<number | null> {
    const highWater = this.getReadySecurityState().highWaters.get(
      DbWorker.highWaterKey(albumId, signerKey),
    );
    return highWater?.manifestSeq ?? null;
  }

  async getAlbumEpochHighWater(
    albumId: string,
  ): Promise<AlbumEpochHighWaterMark | null> {
    const value = this.getReadySecurityState().epochHighWaters.get(albumId);
    return value ? { ...value } : null;
  }

  async getManifestReplayCheckpoint(
    albumId: string,
    manifestId: string,
  ): Promise<ManifestReplayCheckpoint | null> {
    const checkpoint = this.getReadySecurityState().checkpoints.get(
      DbWorker.replayCheckpointKey(albumId, manifestId),
    );
    return checkpoint ? { ...checkpoint } : null;
  }

  async listManifestReplayCheckpoints(
    albumId: string,
  ): Promise<readonly ManifestReplayCheckpoint[]> {
    return [...this.getReadySecurityState().checkpoints.values()]
      .filter((checkpoint) => checkpoint.albumId === albumId)
      .map((checkpoint) => ({ ...checkpoint }))
      .sort((left, right) => left.manifestId.localeCompare(right.manifestId));
  }

  async insertManifests(
    manifests: DecryptedManifest[],
    manifestSeqHighWaters: readonly ManifestSeqHighWaterMark[] = [],
    manifestSyncCheckpoint?: ManifestSyncCheckpoint,
    manifestReplayCheckpoints: readonly ManifestReplayCheckpoint[] = [],
    albumEpochHighWaters: readonly AlbumEpochHighWaterMark[] = [],
  ): Promise<void> {
    if (
      manifestSyncCheckpoint !== undefined &&
      (!Number.isSafeInteger(manifestSyncCheckpoint.albumVersion) ||
        manifestSyncCheckpoint.albumVersion < 0)
    ) {
      throw new Error('Manifest sync checkpoint version is invalid');
    }

    const committedManifestKeys = new Set(
      manifests.map((manifest) => `${manifest.albumId}\u0000${manifest.id}`),
    );
    for (const checkpoint of manifestReplayCheckpoints) {
      if (
        !committedManifestKeys.has(
          `${checkpoint.albumId}\u0000${checkpoint.manifestId}`,
        )
      ) {
        throw new Error('Replay checkpoint has no matching cache mutation');
      }
    }
    if (manifestSyncCheckpoint !== undefined) {
      for (const value of [
        ...manifestSeqHighWaters,
        ...manifestReplayCheckpoints,
        ...albumEpochHighWaters,
      ]) {
        if (value.albumId !== manifestSyncCheckpoint.albumId) {
          throw new Error('Replay security album does not match checkpoint');
        }
      }
    }

    // Security first: a cache/cursor mutation is never visible without its
    // monotonic signer floor and exact signed-state head already durable.
    await this.persistManifestSecurityState(
      manifestSeqHighWaters,
      manifestReplayCheckpoints,
      albumEpochHighWaters,
    );

    const db = this.getReadyDb();
    db.run('BEGIN IMMEDIATE TRANSACTION');
    try {
      const stmt = db.prepare(`
      INSERT OR REPLACE INTO photos 
      (id, asset_id, album_id, filename, mime_type, width, height, taken_at, lat, lng, tags, created_at, updated_at, shard_ids, epoch_id, description, thumbnail, thumb_width, thumb_height, blurhash, thumbnail_shard_id, thumbnail_shard_hash, preview_shard_id, preview_shard_hash, original_shard_ids, original_shard_hashes, thumbhash, is_video, duration, rotation, version_created)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

      try {
        for (const m of manifests) {
          if (m.isDeleted) {
            db.run('DELETE FROM photos WHERE id = ?', [m.id]);
          } else {
            const existing = db.exec(
              'SELECT version_created FROM photos WHERE id = ?',
              [m.id],
            );
            const existingVersion =
              (existing[0]?.values[0]?.[0] as number | undefined) ?? 0;
            if (existingVersion > m.versionCreated) {
              log.debug(
                `Skipping manifest ${m.id}: stale version ${m.versionCreated} <= local ${existingVersion}`,
              );
              continue;
            }

            log.debug('insertManifest', {
              id: m.id,
              hasThumbnail: !!m.meta.thumbnail,
              hasThumbhash: !!m.meta.thumbhash,
              shardCount: m.meta.shardIds?.length ?? 0,
              hasTierShards: !!(
                m.meta.thumbnailShardId ||
                m.meta.previewShardId ||
                m.meta.originalShardIds?.length
              ),
            });

            // Ensure all values are either defined or null - SQLite cannot bind undefined
            // Use m.meta.shardIds and m.meta.epochId (from decrypted metadata) for storage
            stmt.run([
              m.id,
              m.meta.assetId ?? null,
              m.albumId ?? null,
              m.meta.filename ?? null,
              m.meta.mimeType ?? null,
              m.meta.width ?? 0,
              m.meta.height ?? 0,
              m.meta.takenAt ?? null,
              m.meta.lat ?? null,
              m.meta.lng ?? null,
              JSON.stringify(m.meta.tags ?? []),
              m.meta.createdAt ?? null,
              m.meta.updatedAt ?? null,
              JSON.stringify(m.meta.shardIds ?? []),
              m.meta.epochId ?? 0,
              m.meta.description ?? null,
              m.meta.thumbnail ?? null,
              m.meta.thumbWidth ?? null,
              m.meta.thumbHeight ?? null,
              m.meta.blurhash ?? null,
              // Tier-specific shard IDs (v4)
              m.meta.thumbnailShardId ?? null,
              m.meta.thumbnailShardHash ?? null,
              m.meta.previewShardId ?? null,
              m.meta.previewShardHash ?? null,
              JSON.stringify(m.meta.originalShardIds ?? []),
              JSON.stringify(m.meta.originalShardHashes ?? []),
              // ThumbHash placeholder (v5)
              m.meta.thumbhash ?? null,
              // Video support (v6)
              m.meta.isVideo ? 1 : 0,
              m.meta.duration ?? null,
              // Display rotation (v7)
              m.meta.rotation ?? 0,
              // Manifest version for stale sync protection (v8)
              m.versionCreated,
            ]);
          }
        }
      } finally {
        stmt.free();
      }
      if (manifestSyncCheckpoint !== undefined) {
        db.run(
          `
          INSERT INTO albums (id, current_version) VALUES (?, ?)
          ON CONFLICT(id) DO UPDATE SET current_version = ?
        `,
          [
            manifestSyncCheckpoint.albumId,
            manifestSyncCheckpoint.albumVersion,
            manifestSyncCheckpoint.albumVersion,
          ],
        );
      }
      db.run('COMMIT');
    } catch (error) {
      try {
        db.run('ROLLBACK');
      } catch (rollbackError) {
        log.error(
          'Failed to roll back manifest sync transaction',
          rollbackError,
        );
      }
      throw error;
    }
    await this.saveToOPFS();
  }

  async deleteManifest(id: string): Promise<void> {
    this.getReadyDb().run('DELETE FROM photos WHERE id = ?', [id]);
    await this.saveToOPFS();
  }

  async updatePhotoRotation(
    photoId: string,
    rotation: number,
    versionCreated: number,
  ): Promise<void> {
    // Symmetric monotonicity guard with `insertManifests`: if a concurrent
    // sync just delivered a newer manifest version for this row, our
    // optimistic local write would otherwise regress `version_created`
    // and re-arm the inbound-sync race the next time a manifest arrives.
    // The atomic predicate makes the UPDATE a no-op when that's the case.
    const db = this.getReadyDb();
    db.run(
      'UPDATE photos SET rotation = ?, version_created = ?, updated_at = ? WHERE id = ? AND version_created <= ?',
      [
        rotation,
        versionCreated,
        new Date().toISOString(),
        photoId,
        versionCreated,
      ],
    );
    // sql.js exposes getRowsModified at runtime but it isn't part of the
    // shipped TypeScript definitions, hence the narrowing cast.
    const rowsModified = (
      db as unknown as { getRowsModified(): number }
    ).getRowsModified();
    if (rowsModified === 0) {
      log.debug(
        `Skipping local rotation write for ${photoId}: incoming version ${versionCreated} not newer than local`,
      );
    }
    await this.saveToOPFS();
  }

  async updatePhotoDescription(
    photoId: string,
    description: string | null,
    versionCreated: number,
  ): Promise<void> {
    // See updatePhotoRotation for the rationale of the version_created guard.
    const db = this.getReadyDb();
    db.run(
      'UPDATE photos SET description = ?, version_created = ?, updated_at = ? WHERE id = ? AND version_created <= ?',
      [
        description,
        versionCreated,
        new Date().toISOString(),
        photoId,
        versionCreated,
      ],
    );
    const rowsModified = (
      db as unknown as { getRowsModified(): number }
    ).getRowsModified();
    if (rowsModified === 0) {
      log.debug(
        `Skipping local description write for ${photoId}: incoming version ${versionCreated} not newer than local`,
      );
    }
    await this.saveToOPFS();
  }

  async getPhotos(
    albumId: string,
    limit: number,
    offset: number,
  ): Promise<PhotoMeta[]> {
    const result = this.getReadyDb().exec(
      `
      SELECT * FROM photos WHERE album_id = ?
      ORDER BY taken_at DESC, created_at DESC
      LIMIT ? OFFSET ?
    `,
      [albumId, limit, offset],
    );

    const photos = this.rowsToPhotos(result);

    log.debug('getPhotos', {
      albumId,
      count: photos.length,
      firstFew: photos.slice(0, 3).map((p) => ({
        id: p.id,
        hasThumbnail: !!p.thumbnail,
        shardCount: p.shardIds?.length ?? 0,
      })),
    });

    return photos;
  }

  async getPhotoCount(albumId: string): Promise<number> {
    const result = this.getReadyDb().exec(
      'SELECT COUNT(*) FROM photos WHERE album_id = ?',
      [albumId],
    );
    return (result[0]?.values[0]?.[0] as number) ?? 0;
  }

  async searchPhotos(
    albumId: string,
    query: string,
    limit = 100,
    offset = 0,
  ): Promise<PhotoMeta[]> {
    const ftsQuery = buildFtsSearchQuery(query);
    if (!ftsQuery) {
      return this.getPhotos(albumId, limit, offset);
    }

    const result = this.getReadyDb().exec(
      `
      SELECT p.* FROM photos p
      INNER JOIN photos_fts fts ON p.rowid = fts.rowid
      WHERE p.album_id = ? AND photos_fts MATCH ?
      ORDER BY rank
      LIMIT ? OFFSET ?
    `,
      [albumId, ftsQuery, limit, offset],
    );

    return this.rowsToPhotos(result);
  }

  async getPhotosForMap(albumId: string, bounds: Bounds): Promise<GeoPoint[]> {
    const result = this.getReadyDb().exec(
      `
      SELECT id, lat, lng FROM photos
      WHERE album_id = ?
        AND lat IS NOT NULL AND lng IS NOT NULL
        AND lat BETWEEN ? AND ?
        AND lng BETWEEN ? AND ?
    `,
      [albumId, bounds.south, bounds.north, bounds.west, bounds.east],
    );

    if (!result[0]) return [];

    return result[0].values.map((row: unknown[]) => ({
      id: row[0] as string,
      lat: row[1] as number,
      lng: row[2] as number,
    }));
  }

  async getPhotoById(id: string): Promise<PhotoMeta | null> {
    const result = this.getReadyDb().exec('SELECT * FROM photos WHERE id = ?', [
      id,
    ]);
    const photos = this.rowsToPhotos(result);
    return photos[0] ?? null;
  }

  async clearAlbumPhotos(albumId: string): Promise<void> {
    log.info('Clearing cached photos for album', { albumId });

    // Delete all photos for this album
    const db = this.getReadyDb();
    db.run('DELETE FROM photos WHERE album_id = ?', [albumId]);

    // Reset album version to force full resync
    db.run('DELETE FROM albums WHERE id = ?', [albumId]);

    // Persist changes to OPFS
    await this.saveToOPFS();

    log.info('Cleared cached photos for album', { albumId });
  }

  private rowsToPhotos(
    result: { columns: string[]; values: unknown[][] }[],
  ): PhotoMeta[] {
    if (!result[0]) return [];

    const columns = result[0].columns;
    return result[0].values.map((row) => {
      const obj: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        obj[this.snakeToCamel(col)] = row[i];
      });
      // Parse tags from JSON string
      obj['tags'] = JSON.parse((obj['tags'] as string) || '[]') as string[];
      // Parse shardIds from JSON string
      obj['shardIds'] = JSON.parse(
        (obj['shardIds'] as string) || '[]',
      ) as string[];
      // Parse tier-specific shard IDs from JSON strings (v4)
      if (obj['originalShardIds']) {
        obj['originalShardIds'] = JSON.parse(
          (obj['originalShardIds'] as string) || '[]',
        ) as string[];
      }
      if (obj['originalShardHashes']) {
        obj['originalShardHashes'] = JSON.parse(
          (obj['originalShardHashes'] as string) || '[]',
        ) as string[];
      }
      // Convert is_video INTEGER to boolean (v6)
      obj['isVideo'] = !!obj['isVideo'];
      // duration is already REAL → number (or null), no conversion needed
      // Keep rotation omitted for zero/default values to match manifest optional fields.
      if (!obj['rotation']) {
        delete obj['rotation'];
      }
      return obj as unknown as PhotoMeta;
    });
  }

  private snakeToCamel(str: string): string {
    return str.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  }

  private static highWaterKey(albumId: string, signerKey: string): string {
    return `${albumId}\u0000${signerKey}`;
  }

  private static replayCheckpointKey(
    albumId: string,
    manifestId: string,
  ): string {
    return `${albumId}\u0000${manifestId}`;
  }

  private static emptySecurityState(): ManifestSecurityState {
    return {
      epochHighWaters: new Map(),
      highWaters: new Map(),
      checkpoints: new Map(),
    };
  }

  private getReadySecurityState(): ManifestSecurityState {
    if (!this.securityState) {
      throw new DbWorkerError(
        'Manifest replay security state is not initialized',
        DbWorkerErrorCode.NOT_INITIALIZED,
      );
    }
    return this.securityState;
  }

  private parseEpochHighWater(value: unknown): AlbumEpochHighWaterMark {
    if (typeof value !== 'object' || value === null) {
      throw new Error('Album epoch high-water is not an object');
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.albumId !== 'string' ||
      record.albumId.length === 0 ||
      typeof record.epochId !== 'number' ||
      !Number.isSafeInteger(record.epochId) ||
      record.epochId <= 0 ||
      typeof record.signerKey !== 'string' ||
      !/^[0-9a-f]{64}$/.test(record.signerKey)
    ) {
      throw new Error('Album epoch high-water is invalid');
    }
    return {
      albumId: record.albumId,
      epochId: record.epochId,
      signerKey: record.signerKey,
    };
  }

  private parseHighWater(value: unknown): ManifestSeqHighWaterMark {
    if (typeof value !== 'object' || value === null) {
      throw new Error('Manifest sequence high-water is not an object');
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.albumId !== 'string' ||
      record.albumId.length === 0 ||
      typeof record.signerKey !== 'string' ||
      !/^[0-9a-f]{64}$/.test(record.signerKey) ||
      typeof record.manifestSeq !== 'number' ||
      !Number.isSafeInteger(record.manifestSeq) ||
      record.manifestSeq <= 0
    ) {
      throw new Error('Manifest sequence high-water is invalid');
    }
    return {
      albumId: record.albumId,
      signerKey: record.signerKey,
      manifestSeq: record.manifestSeq,
    };
  }

  private parseReplayCheckpoint(value: unknown): ManifestReplayCheckpoint {
    if (typeof value !== 'object' || value === null) {
      throw new Error('Manifest replay checkpoint is not an object');
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.albumId !== 'string' ||
      record.albumId.length === 0 ||
      typeof record.signerKey !== 'string' ||
      !/^[0-9a-f]{64}$/.test(record.signerKey) ||
      typeof record.manifestId !== 'string' ||
      record.manifestId.length === 0 ||
      typeof record.manifestSeq !== 'number' ||
      !Number.isSafeInteger(record.manifestSeq) ||
      record.manifestSeq <= 0 ||
      typeof record.epochId !== 'number' ||
      !Number.isSafeInteger(record.epochId) ||
      record.epochId <= 0 ||
      (record.operationKind !== 'Live' &&
        record.operationKind !== 'Tombstone') ||
      typeof record.signatureFingerprint !== 'string' ||
      !/^[0-9a-f]{128}$/.test(record.signatureFingerprint)
    ) {
      throw new Error('Manifest replay checkpoint is invalid');
    }
    return {
      albumId: record.albumId,
      signerKey: record.signerKey,
      manifestId: record.manifestId,
      manifestSeq: record.manifestSeq,
      operationKind: record.operationKind,
      signatureFingerprint: record.signatureFingerprint,
      epochId: record.epochId,
    };
  }

  private deserializeSecurityState(data: Uint8Array): ManifestSecurityState {
    let decoded: unknown;
    try {
      decoded = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(data),
      );
    } catch (error) {
      throw new Error(
        'Manifest replay security envelope is not valid UTF-8 JSON',
        {
          cause: error,
        },
      );
    }
    if (typeof decoded !== 'object' || decoded === null) {
      throw new Error('Manifest replay security envelope is not an object');
    }
    const envelope = decoded as Record<string, unknown>;
    if (
      envelope.magic !== SECURITY_STATE_MAGIC ||
      envelope.version !== SECURITY_STATE_VERSION ||
      !Array.isArray(envelope.epochHighWaters) ||
      !Array.isArray(envelope.highWaters) ||
      !Array.isArray(envelope.checkpoints)
    ) {
      throw new Error(
        'Manifest replay security envelope magic/version is invalid',
      );
    }

    const state = DbWorker.emptySecurityState();
    for (const raw of envelope.epochHighWaters) {
      const epoch = this.parseEpochHighWater(raw);
      if (state.epochHighWaters.has(epoch.albumId)) {
        throw new Error(
          'Manifest replay security envelope has duplicate epoch floors',
        );
      }
      state.epochHighWaters.set(epoch.albumId, epoch);
    }
    for (const raw of envelope.highWaters) {
      const highWater = this.parseHighWater(raw);
      const key = DbWorker.highWaterKey(highWater.albumId, highWater.signerKey);
      if (state.highWaters.has(key)) {
        throw new Error(
          'Manifest replay security envelope has duplicate high-waters',
        );
      }
      state.highWaters.set(key, highWater);
    }
    for (const raw of envelope.checkpoints) {
      const checkpoint = this.parseReplayCheckpoint(raw);
      const key = DbWorker.replayCheckpointKey(
        checkpoint.albumId,
        checkpoint.manifestId,
      );
      if (state.checkpoints.has(key)) {
        throw new Error(
          'Manifest replay security envelope has duplicate checkpoints',
        );
      }
      const floor = state.highWaters.get(
        DbWorker.highWaterKey(checkpoint.albumId, checkpoint.signerKey),
      );
      if (!floor || floor.manifestSeq < checkpoint.manifestSeq) {
        throw new Error('Manifest replay checkpoint exceeds its signer floor');
      }
      const epochFloor = state.epochHighWaters.get(checkpoint.albumId);
      if (
        !epochFloor ||
        checkpoint.epochId > epochFloor.epochId ||
        (checkpoint.epochId === epochFloor.epochId &&
          checkpoint.signerKey !== epochFloor.signerKey)
      ) {
        throw new Error(
          'Manifest replay checkpoint is not covered by its album epoch floor',
        );
      }
      state.checkpoints.set(key, checkpoint);
    }
    return state;
  }

  private serializeSecurityState(state: ManifestSecurityState): Uint8Array {
    const envelope: PersistedManifestSecurityState = {
      magic: SECURITY_STATE_MAGIC,
      version: SECURITY_STATE_VERSION,
      epochHighWaters: [...state.epochHighWaters.values()].sort((left, right) =>
        left.albumId.localeCompare(right.albumId),
      ),
      highWaters: [...state.highWaters.values()].sort(
        (left, right) =>
          left.albumId.localeCompare(right.albumId) ||
          left.signerKey.localeCompare(right.signerKey),
      ),
      checkpoints: [...state.checkpoints.values()].sort(
        (left, right) =>
          left.albumId.localeCompare(right.albumId) ||
          left.manifestId.localeCompare(right.manifestId),
      ),
    };
    return new TextEncoder().encode(JSON.stringify(envelope));
  }

  private mergeSecurityStates(
    ...states: readonly ManifestSecurityState[]
  ): ManifestSecurityState {
    const merged = DbWorker.emptySecurityState();
    for (const state of states) {
      for (const epoch of state.epochHighWaters.values()) {
        const existing = merged.epochHighWaters.get(epoch.albumId);
        if (
          existing?.epochId === epoch.epochId &&
          existing.signerKey !== epoch.signerKey
        ) {
          throw new Error(
            'One album epoch is bound to conflicting signing keys',
          );
        }
        if (!existing || epoch.epochId > existing.epochId) {
          merged.epochHighWaters.set(epoch.albumId, { ...epoch });
        }
      }
      for (const highWater of state.highWaters.values()) {
        const key = DbWorker.highWaterKey(
          highWater.albumId,
          highWater.signerKey,
        );
        const existing = merged.highWaters.get(key);
        if (!existing || highWater.manifestSeq > existing.manifestSeq) {
          merged.highWaters.set(key, { ...highWater });
        }
      }
      for (const checkpoint of state.checkpoints.values()) {
        const key = DbWorker.replayCheckpointKey(
          checkpoint.albumId,
          checkpoint.manifestId,
        );
        const existing = merged.checkpoints.get(key);
        if (!existing || checkpoint.epochId > existing.epochId) {
          merged.checkpoints.set(key, { ...checkpoint });
          continue;
        }
        if (checkpoint.epochId < existing.epochId) continue;
        if (checkpoint.signerKey !== existing.signerKey) {
          throw new Error(
            'One manifest epoch is bound to conflicting signing keys',
          );
        }
        if (checkpoint.manifestSeq > existing.manifestSeq) {
          merged.checkpoints.set(key, { ...checkpoint });
          continue;
        }
        if (
          checkpoint.manifestSeq === existing.manifestSeq &&
          (checkpoint.operationKind !== existing.operationKind ||
            checkpoint.signatureFingerprint !== existing.signatureFingerprint)
        ) {
          throw new Error(
            'Conflicting signed states share one manifest sequence',
          );
        }
      }
    }
    for (const checkpoint of merged.checkpoints.values()) {
      const floor = merged.highWaters.get(
        DbWorker.highWaterKey(checkpoint.albumId, checkpoint.signerKey),
      );
      if (!floor || floor.manifestSeq < checkpoint.manifestSeq) {
        throw new Error('Merged replay checkpoint exceeds its signer floor');
      }
      const epochFloor = merged.epochHighWaters.get(checkpoint.albumId);
      if (
        !epochFloor ||
        checkpoint.epochId > epochFloor.epochId ||
        (checkpoint.epochId === epochFloor.epochId &&
          checkpoint.signerKey !== epochFloor.signerKey)
      ) {
        throw new Error(
          'Merged replay checkpoint exceeds its album epoch floor',
        );
      }
    }
    return merged;
  }

  private applySecurityCandidates(
    base: ManifestSecurityState,
    highWaters: readonly ManifestSeqHighWaterMark[],
    checkpoints: readonly ManifestReplayCheckpoint[],
    epochHighWaters: readonly AlbumEpochHighWaterMark[],
  ): ManifestSecurityState {
    const next = this.mergeSecurityStates(base);
    for (const raw of epochHighWaters) {
      const epoch = this.parseEpochHighWater(raw);
      const existing = next.epochHighWaters.get(epoch.albumId);
      if (existing && epoch.epochId < existing.epochId) {
        throw new Error('Album signing epoch would regress');
      }
      if (
        existing?.epochId === epoch.epochId &&
        existing.signerKey !== epoch.signerKey
      ) {
        throw new Error('Album signing epoch is bound to a different key');
      }
      if (!existing || epoch.epochId > existing.epochId) {
        next.epochHighWaters.set(epoch.albumId, epoch);
      }
    }
    for (const raw of highWaters) {
      const highWater = this.parseHighWater(raw);
      const key = DbWorker.highWaterKey(highWater.albumId, highWater.signerKey);
      const existing = next.highWaters.get(key);
      if (existing && highWater.manifestSeq < existing.manifestSeq) {
        throw new Error(
          'Manifest sequence would regress the durable high-water',
        );
      }
      if (!existing || highWater.manifestSeq > existing.manifestSeq) {
        next.highWaters.set(key, highWater);
      }
    }
    for (const raw of checkpoints) {
      const checkpoint = this.parseReplayCheckpoint(raw);
      const floor = next.highWaters.get(
        DbWorker.highWaterKey(checkpoint.albumId, checkpoint.signerKey),
      );
      if (!floor || floor.manifestSeq < checkpoint.manifestSeq) {
        throw new Error('Replay checkpoint was not covered by a durable floor');
      }
      const epochFloor = next.epochHighWaters.get(checkpoint.albumId);
      if (
        !epochFloor ||
        checkpoint.epochId > epochFloor.epochId ||
        (checkpoint.epochId === epochFloor.epochId &&
          checkpoint.signerKey !== epochFloor.signerKey)
      ) {
        throw new Error(
          'Replay checkpoint is not covered by the authenticated album epoch floor',
        );
      }
      const key = DbWorker.replayCheckpointKey(
        checkpoint.albumId,
        checkpoint.manifestId,
      );
      const existing = next.checkpoints.get(key);
      if (!existing || checkpoint.epochId > existing.epochId) {
        next.checkpoints.set(key, checkpoint);
        continue;
      }
      if (checkpoint.epochId < existing.epochId) {
        throw new Error('Manifest replay checkpoint epoch would regress');
      }
      if (checkpoint.signerKey !== existing.signerKey) {
        throw new Error('Manifest epoch is bound to a different signing key');
      }
      if (checkpoint.manifestSeq < existing.manifestSeq) {
        throw new Error('Manifest replay checkpoint sequence would regress');
      }
      if (checkpoint.manifestSeq === existing.manifestSeq) {
        if (
          checkpoint.operationKind !== existing.operationKind ||
          checkpoint.signatureFingerprint !== existing.signatureFingerprint
        ) {
          throw new Error(
            'Manifest sequence is bound to a different signed state',
          );
        }
        continue;
      }
      next.checkpoints.set(key, checkpoint);
    }
    return next;
  }

  private async withSecurityStateLock<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const hasPersistentOpfs =
      typeof navigator !== 'undefined' &&
      navigator.storage !== undefined &&
      'getDirectory' in navigator.storage;
    const hasWebLocks =
      typeof navigator !== 'undefined' &&
      'locks' in navigator &&
      navigator.locks != null;
    if (!hasWebLocks) {
      if (hasPersistentOpfs) {
        throw new Error(
          'Web Locks are required for monotonic replay-security persistence',
        );
      }
      // Unit/non-persistent environments have no cross-tab OPFS state to race.
      return operation();
    }
    return navigator.locks.request(
      SECURITY_STATE_LOCK,
      { mode: 'exclusive' },
      () => operation(),
    );
  }

  private async readSecurityStateFromOPFS(): Promise<ManifestSecurityState | null> {
    if (
      typeof navigator === 'undefined' ||
      !navigator.storage ||
      !('getDirectory' in navigator.storage)
    ) {
      return DbWorker.emptySecurityState();
    }
    try {
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle(SECURITY_STATE_FILE);
      const file = await fileHandle.getFile();
      const wrapped = new Uint8Array(await file.arrayBuffer());
      if (!this.crypto) {
        throw new Error('Crypto bridge not initialized');
      }
      const plaintext = await this.crypto.unwrap(wrapped);
      return this.deserializeSecurityState(plaintext);
    } catch (error) {
      if ((error as { name?: unknown }).name === 'NotFoundError') {
        return null;
      }
      throw error;
    }
  }

  private async writeSecurityStateToOPFS(
    state: ManifestSecurityState,
  ): Promise<void> {
    if (!this.crypto) {
      throw new Error('Crypto bridge not initialized');
    }
    if (
      typeof navigator === 'undefined' ||
      !navigator.storage ||
      !('getDirectory' in navigator.storage)
    ) {
      throw new Error('OPFS is unavailable for replay-security persistence');
    }
    const wrapped = await this.crypto.wrap(this.serializeSecurityState(state));
    const root = await navigator.storage.getDirectory();
    const fileHandle = await root.getFileHandle(SECURITY_STATE_FILE, {
      create: true,
    });
    const writable = await fileHandle.createWritable();
    const buffer = new ArrayBuffer(wrapped.byteLength);
    new Uint8Array(buffer).set(wrapped);
    await writable.write(buffer);
    await writable.close();
  }

  private async persistManifestSecurityState(
    highWaters: readonly ManifestSeqHighWaterMark[],
    checkpoints: readonly ManifestReplayCheckpoint[],
    epochHighWaters: readonly AlbumEpochHighWaterMark[],
  ): Promise<void> {
    if (
      highWaters.length === 0 &&
      checkpoints.length === 0 &&
      epochHighWaters.length === 0
    )
      return;

    const capturedHighWaters = highWaters.map((value) => ({ ...value }));
    const capturedCheckpoints = checkpoints.map((value) => ({ ...value }));
    const capturedEpochHighWaters = epochHighWaters.map((value) => ({
      ...value,
    }));
    const nextWrite = this.securityStateChain.then(() =>
      this.withSecurityStateLock(async () => {
        const diskState = await this.readSecurityStateFromOPFS();
        if (!diskState) {
          throw new Error(
            'Replay-security sidecar disappeared after initialization',
          );
        }
        const base = this.mergeSecurityStates(
          diskState,
          this.getReadySecurityState(),
        );
        const nextState = this.applySecurityCandidates(
          base,
          capturedHighWaters,
          capturedCheckpoints,
          capturedEpochHighWaters,
        );
        await this.writeSecurityStateToOPFS(nextState);
        this.securityState = nextState;
      }),
    );
    this.securityStateChain = nextWrite.catch(() => undefined);
    await nextWrite;
  }

  // OPFS persistence (encrypted at rest)
  private async loadFromOPFS(): Promise<Uint8Array | null> {
    try {
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle('mosaic.db.enc');
      const file = await fileHandle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      if ((error as { name?: unknown }).name === 'NotFoundError') {
        return null;
      }
      // A transient permission/I/O failure is not proof that the cache is
      // absent. Propagate it so init cannot establish a fresh empty security
      // sidecar while an existing cache may still be present.
      throw error;
    }
  }

  private async saveToOPFS(): Promise<void> {
    // Snapshot the in-memory DB synchronously, BEFORE chaining onto the
    // pending write tail. This pins the "version" of the DB this caller
    // intended to persist; chained writes then proceed in FIFO order.
    const data = this.getReadyDb().export();

    const next = this.snapshotChain.then(async () => {
      await this.writeSnapshotToOPFS(data);
    });
    // Don't let one failed write break the chain for subsequent callers,
    // but DO surface the failure to the immediate awaiter below.
    this.snapshotChain = next.catch(() => undefined);
    await next;
  }

  private async writeSnapshotToOPFS(data: Uint8Array): Promise<void> {
    // Encrypt database with XChaCha20-Poly1305 using session key
    const encrypted = await this.encryptBlob(data);

    const root = await navigator.storage.getDirectory();
    const fileHandle = await root.getFileHandle('mosaic.db.enc', {
      create: true,
    });
    const writable = await fileHandle.createWritable();
    // Create a new ArrayBuffer from the Uint8Array to satisfy TypeScript
    const buffer = new ArrayBuffer(encrypted.byteLength);
    new Uint8Array(buffer).set(encrypted);
    await writable.write(buffer);
    await writable.close();
  }

  /**
   * Wait until every previously-queued OPFS write has completed.
   *
   * Used by `UploadContext` after a successful upload + sync round-trip
   * so the next page reload is guaranteed to see the freshly persisted
   * manifests. Without this fence, the SharedWorker (or regular Worker
   * in automated test environments) could still have an in-flight
   * `saveToOPFS()` whose `writable.close()` had not yet flushed when the
   * test issued `page.reload()`, causing the post-reload SQLite
   * database to silently regress to an older snapshot (P0-IDENTITY-STRESS).
   *
   * The loop guards against a producer that enqueues another write while
   * we are awaiting the current tail — we re-await until the chain
   * settles on a stable tail promise.
   */
  async flushSnapshot(): Promise<void> {
    let previousTail: Promise<void> | undefined;
    // Bound the loop conservatively to avoid an unbounded await under
    // a pathological producer; in practice the chain stabilizes in 1–2
    // iterations once the upload pipeline goes idle.
    for (let i = 0; i < 16; i += 1) {
      if (previousTail === this.snapshotChain) {
        return;
      }
      previousTail = this.snapshotChain;
      await this.snapshotChain;
    }
  }

  /**
   * Wrap an OPFS snapshot with the crypto bridge's account-handle
   * wrapper. Returns `[u8 SNAPSHOT_VERSION][...account-handle wrap blob...]` —
   * the wrapped blob is the Rust XChaCha20-Poly1305 envelope
   * (`nonce(24) || ciphertext_with_tag(16)`), so the only on-disk
   * additions over the legacy libsodium-secretbox layout are the
   * leading version byte and the Rust-side framing.
   */
  private async encryptBlob(data: Uint8Array): Promise<Uint8Array> {
    if (!this.crypto) {
      throw new Error('Crypto bridge not initialized');
    }

    const wrapped = await this.crypto.wrap(data);

    const result = new Uint8Array(1 + wrapped.length);
    result[0] = SNAPSHOT_VERSION;
    result.set(wrapped, 1);
    return result;
  }

  /**
   * Inverse of {@link encryptBlob}. Throws
   * {@link SnapshotVersionMismatchError} when the leading version byte
   * does not match {@link SNAPSHOT_VERSION} so callers can route the
   * blob to the discard-and-reinitialize path; throws other errors
   * (e.g. authentication failures) unchanged so they reach the
   * `SNAPSHOT_DECRYPT_FAILED` fail-closed branch in `init`.
   */
  private async decryptBlob(data: Uint8Array): Promise<Uint8Array> {
    if (!this.crypto) {
      throw new Error('Crypto bridge not initialized');
    }

    if (data.length < 1) {
      throw new SnapshotVersionMismatchError(-1);
    }

    const version = data[0];
    if (version !== SNAPSHOT_VERSION) {
      throw new SnapshotVersionMismatchError(version ?? -1);
    }

    return this.crypto.unwrap(data.subarray(1));
  }
}

// Create worker instance
const worker = new DbWorker();

// For regular Worker, expose on self
// For SharedWorker, expose on each connection's port
// Type-safe SharedWorker detection
interface SharedWorkerGlobalScopeWithConnect extends EventTarget {
  onconnect: ((this: SharedWorkerGlobalScope, ev: MessageEvent) => void) | null;
}

function isSharedWorkerContext(
  scope: typeof globalThis,
): scope is typeof globalThis & SharedWorkerGlobalScopeWithConnect {
  return (
    'onconnect' in scope || scope.constructor.name === 'SharedWorkerGlobalScope'
  );
}

if (isSharedWorkerContext(self)) {
  self.onconnect = (event: MessageEvent) => {
    const port = event.ports[0];
    Comlink.expose(worker, port);
  };
} else {
  Comlink.expose(worker);
}
