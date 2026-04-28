/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import sodium from 'libsodium-wrappers-sumo';
import { memzero, NONCE_SIZE, TAG_SIZE } from '@mosaic/crypto';
import { createLogger } from '../lib/logger';
import type {
  Bounds,
  DbWorkerApi,
  DecryptedManifest,
  GeoPoint,
  PhotoMeta,
} from './types';
import { buildFtsSearchQuery } from './fts-query';

// Create scoped logger for database worker
const log = createLogger('DbWorker');

// sql.js types - the actual module is loaded dynamically from public folder
type SqlJsStatic = Awaited<ReturnType<typeof import('sql.js').default>>;
type DatabaseType = import('sql.js').Database;

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

// Store the loaded sql.js instance
let cachedSqlJs: SqlJsStatic | null = null;

/**
 * Load sql.js from the public folder.
 * This approach avoids Vite's module transformation issues in Workers.
 * sql.js is fetched and evaluated directly, bypassing ESM import issues.
 */
async function loadSqlJs(): Promise<SqlJsStatic> {
  if (cachedSqlJs) return cachedSqlJs;

  const timer = log.startTimer('sql.js WASM initialization');

  // Fetch and evaluate sql.js from public folder
  const response = await fetch('/sql-wasm.js');
  const scriptText = await response.text();

  // sql.js exports initSqlJs as a global - capture it via Function constructor
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const initSqlJs = new Function(scriptText + '\nreturn initSqlJs;')();

  // Initialize sql.js with WASM file path
  cachedSqlJs = await initSqlJs({
    locateFile: () => '/sql-wasm.wasm',
  });

  timer.end();
  log.info('sql.js loaded successfully');

  return cachedSqlJs!;
}

// NONCE_SIZE and TAG_SIZE imported from @mosaic/crypto

/**
 * Database Worker Implementation
 * Manages SQLite-WASM database with OPFS persistence
 */
export class DbWorker implements DbWorkerApi {
  private sql: SqlJsStatic | null = null;
  private db: DatabaseType | null = null;
  private sessionKey: Uint8Array | null = null;
  private sodiumReady = false;
  private lastError: DbWorkerError | null = null;

  /**
   * Ensure libsodium is initialized before crypto operations.
   */
  private async ensureSodiumReady(): Promise<void> {
    if (!this.sodiumReady) {
      const timer = log.startTimer('libsodium initialization');
      await sodium.ready;
      this.sodiumReady = true;
      timer.end();
    }
  }

  async init(sessionKey: Uint8Array): Promise<void> {
    if (this.lastError) {
      throw this.lastError;
    }

    const initTimer = log.startTimer('database initialization');
    this.sessionKey = sessionKey;

    // Initialize libsodium and SQL.js WASM in parallel
    const [, sqlModule] = await Promise.all([
      this.ensureSodiumReady(),
      loadSqlJs(),
    ]);

    this.sql = sqlModule;

    // Try to load existing DB from OPFS
    const existingData = await this.loadFromOPFS();
    if (existingData) {
      log.debug('Found existing database in OPFS', {
        size: existingData.byteLength,
      });
      try {
        // Decrypt existing database with XChaCha20-Poly1305
        const decryptTimer = log.startTimer('database decryption');
        const decrypted = await this.decryptBlob(existingData);
        decryptTimer.end({ decryptedSize: decrypted.byteLength });
        this.db = new this.sql.Database(decrypted);
        this.lastError = null;
        log.info('Loaded existing database from OPFS');
      } catch (error) {
        this.markUnavailable(
          new DbWorkerError(
            'Failed to decrypt existing database snapshot; explicit reset required',
            DbWorkerErrorCode.SNAPSHOT_DECRYPT_FAILED,
            error,
          ),
        );
        throw this.lastError;
      }
    } else {
      log.debug('No existing database found, creating new one');
      this.db = new this.sql.Database();
      this.lastError = null;
    }

    try {
      await this.runMigrations();
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
    if (!this.sessionKey) {
      throw new DbWorkerError(
        'Database not initialized',
        DbWorkerErrorCode.NOT_INITIALIZED,
      );
    }

    await this.deleteFromOPFS();

    if (!this.sql) {
      this.sql = await loadSqlJs();
    }

    if (this.db) {
      this.db.close();
    }

    this.db = new this.sql.Database();
    this.lastError = null;
    await this.runMigrations();
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.saveToOPFS();
      this.db.close();
      this.db = null;
    }
    if (this.sessionKey) {
      // Clear sensitive key material using libsodium's secure wipe
      memzero(this.sessionKey);
      this.sessionKey = null;
    }
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
        db.run(
          `ALTER TABLE photos ADD COLUMN original_shard_hashes TEXT;`,
        ); // JSON array

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

  async insertManifests(manifests: DecryptedManifest[]): Promise<void> {
    const stmt = this.getReadyDb().prepare(`
      INSERT OR REPLACE INTO photos 
      (id, asset_id, album_id, filename, mime_type, width, height, taken_at, lat, lng, tags, created_at, updated_at, shard_ids, epoch_id, description, thumbnail, thumb_width, thumb_height, blurhash, thumbnail_shard_id, thumbnail_shard_hash, preview_shard_id, preview_shard_hash, original_shard_ids, original_shard_hashes, thumbhash, is_video, duration, rotation, version_created)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const m of manifests) {
      if (m.isDeleted) {
        this.getReadyDb().run('DELETE FROM photos WHERE id = ?', [m.id]);
      } else {
        const existing = this.getReadyDb().exec(
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

    stmt.free();
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
    this.getReadyDb().run(
      'UPDATE photos SET rotation = ?, version_created = ?, updated_at = ? WHERE id = ?',
      [rotation, versionCreated, new Date().toISOString(), photoId],
    );
    await this.saveToOPFS();
  }

  async updatePhotoDescription(
    photoId: string,
    description: string | null,
    versionCreated: number,
  ): Promise<void> {
    this.getReadyDb().run(
      'UPDATE photos SET description = ?, version_created = ?, updated_at = ? WHERE id = ?',
      [description, versionCreated, new Date().toISOString(), photoId],
    );
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
      obj['isVideo'] = !!(obj['isVideo']);
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

  // OPFS persistence (encrypted at rest)
  private async loadFromOPFS(): Promise<Uint8Array | null> {
    try {
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle('mosaic.db.enc');
      const file = await fileHandle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      // File doesn't exist yet
      return null;
    }
  }

  private async saveToOPFS(): Promise<void> {
    const data = this.getReadyDb().export();
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

  private async deleteFromOPFS(): Promise<void> {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry('mosaic.db.enc');
    } catch {
      // Ignore missing file
    }
  }

  /**
   * Encrypt data using XChaCha20-Poly1305.
   * Format: nonce (24 bytes) || ciphertext (data + 16 byte auth tag)
   */
  private async encryptBlob(data: Uint8Array): Promise<Uint8Array> {
    if (!this.sessionKey) {
      throw new Error('Session key not initialized');
    }

    // Generate fresh random nonce (24 bytes for XChaCha20-Poly1305)
    const nonce = sodium.randombytes_buf(NONCE_SIZE);

    // Encrypt with XChaCha20-Poly1305
    const ciphertext = sodium.crypto_secretbox_easy(
      data,
      nonce,
      this.sessionKey,
    );

    // Return nonce || ciphertext
    const result = new Uint8Array(NONCE_SIZE + ciphertext.length);
    result.set(nonce, 0);
    result.set(ciphertext, NONCE_SIZE);

    return result;
  }

  private async decryptBlob(data: Uint8Array): Promise<Uint8Array> {
    if (!this.sessionKey) {
      throw new Error('Session key not initialized');
    }

    // Minimum length: nonce + tag + 1 byte of data
    if (data.length < NONCE_SIZE + TAG_SIZE + 1) {
      throw new Error('Encrypted data too short');
    }

    const nonce = data.slice(0, NONCE_SIZE);
    const ciphertext = data.slice(NONCE_SIZE);

    try {
      return sodium.crypto_secretbox_open_easy(
        ciphertext,
        nonce,
        this.sessionKey,
      );
    } catch {
      throw new Error('Decryption failed - authentication error');
    }
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
  return 'onconnect' in scope || scope.constructor.name === 'SharedWorkerGlobalScope';
}

if (isSharedWorkerContext(self)) {
  self.onconnect = (event: MessageEvent) => {
    const port = event.ports[0];
    Comlink.expose(worker, port);
  };
} else {
  Comlink.expose(worker);
}
