/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import sodium from 'libsodium-wrappers-sumo';
import { createLogger } from '../lib/logger';
import type {
    Bounds,
    DbWorkerApi,
    DecryptedManifest,
    GeoPoint,
    PhotoMeta,
} from './types';

// Create scoped logger for database worker
const log = createLogger('DbWorker');

// sql.js types - the actual module is loaded dynamically from public folder
type SqlJsStatic = Awaited<ReturnType<typeof import('sql.js').default>>;
type DatabaseType = import('sql.js').Database;

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

/** Nonce size for XChaCha20-Poly1305 */
const NONCE_SIZE = 24;
/** Auth tag size */
const TAG_SIZE = 16;

/**
 * Database Worker Implementation
 * Manages SQLite-WASM database with OPFS persistence
 */
class DbWorker implements DbWorkerApi {
  private sql: SqlJsStatic | null = null;
  private db: DatabaseType | null = null;
  private sessionKey: Uint8Array | null = null;
  private sodiumReady = false;

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
      log.debug('Found existing database in OPFS', { size: existingData.byteLength });
      try {
        // Decrypt existing database with XChaCha20-Poly1305
        const decryptTimer = log.startTimer('database decryption');
        const decrypted = await this.decryptBlob(existingData);
        decryptTimer.end({ decryptedSize: decrypted.byteLength });
        this.db = new this.sql.Database(decrypted);
        log.info('Loaded existing database from OPFS');
      } catch (error) {
        // Decryption failed - could be wrong password or corrupted data
        // Start fresh with a new database
        log.error('Failed to decrypt existing database, starting fresh', error);
        this.db = new this.sql.Database();
      }
    } else {
      log.debug('No existing database found, creating new one');
      this.db = new this.sql.Database();
    }

    await this.runMigrations();
    initTimer.end();
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.saveToOPFS();
      this.db.close();
      this.db = null;
    }
    if (this.sessionKey) {
      // Clear sensitive key material
      this.sessionKey.fill(0);
      this.sessionKey = null;
    }
  }

  /**
   * Get current schema version from SQLite PRAGMA user_version
   */
  private getSchemaVersion(): number {
    if (!this.db) return 0;
    const result = this.db.exec('PRAGMA user_version');
    return (result[0]?.values[0]?.[0] as number) ?? 0;
  }

  /**
   * Set schema version using SQLite PRAGMA user_version
   */
  private setSchemaVersion(version: number): void {
    if (!this.db) return;
    this.db.run(`PRAGMA user_version = ${version}`);
  }

  /**
   * Check if FTS5 table exists
   */
  private ftsTableExists(): boolean {
    if (!this.db) return false;
    const result = this.db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='photos_fts'"
    );
    const firstRow = result[0];
    return result.length > 0 && firstRow !== undefined && (firstRow.values?.length ?? 0) > 0;
  }

  /**
   * Create FTS5 table and triggers
   */
  private createFtsTable(): void {
    if (!this.db) return;

    log.info('Creating FTS5 virtual table for full-text search');

    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS photos_fts USING fts5(
        filename, tags, description,
        content='photos',
        content_rowid='rowid'
      );
    `);

    // Triggers to keep FTS in sync
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS photos_ai AFTER INSERT ON photos BEGIN
        INSERT INTO photos_fts(rowid, filename, tags, description)
        VALUES (NEW.rowid, NEW.filename, NEW.tags, NEW.description);
      END;
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS photos_ad AFTER DELETE ON photos BEGIN
        INSERT INTO photos_fts(photos_fts, rowid, filename, tags, description)
        VALUES ('delete', OLD.rowid, OLD.filename, OLD.tags, OLD.description);
      END;
    `);

    this.db.run(`
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
    if (!this.db) return;

    log.info('Rebuilding FTS index from existing photos');

    // Clear existing FTS data and rebuild from photos table
    this.db.run(`
      INSERT INTO photos_fts(photos_fts) VALUES('rebuild');
    `);

    log.info('FTS index rebuild complete');
  }

  private async runMigrations(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    const currentVersion = this.getSchemaVersion();
    log.debug('Current schema version', { version: currentVersion });

    // Version 0 -> 1: Initial schema
    if (currentVersion < 1) {
      log.info('Running migration: v0 -> v1 (initial schema)');

      this.db.run(`
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
          description TEXT
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
    if (!this.db) throw new Error('Database not initialized');

    const result = this.db.exec(
      'SELECT current_version FROM albums WHERE id = ?',
      [albumId]
    );
    return (result[0]?.values[0]?.[0] as number) ?? 0;
  }

  async setAlbumVersion(albumId: string, version: number): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    this.db.run(
      `
      INSERT INTO albums (id, current_version) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET current_version = ?
    `,
      [albumId, version, version]
    );
    await this.saveToOPFS();
  }

  async insertManifests(manifests: DecryptedManifest[]): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO photos 
      (id, asset_id, album_id, filename, mime_type, width, height, taken_at, lat, lng, tags, created_at, updated_at, shard_ids, epoch_id, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const m of manifests) {
      if (m.isDeleted) {
        this.db.run('DELETE FROM photos WHERE id = ?', [m.id]);
      } else {
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
        ]);
      }
    }

    stmt.free();
    await this.saveToOPFS();
  }

  async deleteManifest(id: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    this.db.run('DELETE FROM photos WHERE id = ?', [id]);
    await this.saveToOPFS();
  }

  async getPhotos(
    albumId: string,
    limit: number,
    offset: number
  ): Promise<PhotoMeta[]> {
    if (!this.db) throw new Error('Database not initialized');

    const result = this.db.exec(
      `
      SELECT * FROM photos WHERE album_id = ?
      ORDER BY taken_at DESC, created_at DESC
      LIMIT ? OFFSET ?
    `,
      [albumId, limit, offset]
    );

    return this.rowsToPhotos(result);
  }

  async getPhotoCount(albumId: string): Promise<number> {
    if (!this.db) throw new Error('Database not initialized');

    const result = this.db.exec(
      'SELECT COUNT(*) FROM photos WHERE album_id = ?',
      [albumId]
    );
    return (result[0]?.values[0]?.[0] as number) ?? 0;
  }

  async searchPhotos(albumId: string, query: string): Promise<PhotoMeta[]> {
    if (!this.db) throw new Error('Database not initialized');

    const result = this.db.exec(
      `
      SELECT p.* FROM photos p
      INNER JOIN photos_fts fts ON p.rowid = fts.rowid
      WHERE p.album_id = ? AND photos_fts MATCH ?
      ORDER BY rank
      LIMIT 100
    `,
      [albumId, query]
    );

    return this.rowsToPhotos(result);
  }

  async getPhotosForMap(albumId: string, bounds: Bounds): Promise<GeoPoint[]> {
    if (!this.db) throw new Error('Database not initialized');

    const result = this.db.exec(
      `
      SELECT id, lat, lng FROM photos
      WHERE album_id = ?
        AND lat IS NOT NULL AND lng IS NOT NULL
        AND lat BETWEEN ? AND ?
        AND lng BETWEEN ? AND ?
    `,
      [albumId, bounds.south, bounds.north, bounds.west, bounds.east]
    );

    if (!result[0]) return [];

    return result[0].values.map((row: unknown[]) => ({
      id: row[0] as string,
      lat: row[1] as number,
      lng: row[2] as number,
    }));
  }

  async getPhotoById(id: string): Promise<PhotoMeta | null> {
    if (!this.db) throw new Error('Database not initialized');

    const result = this.db.exec('SELECT * FROM photos WHERE id = ?', [id]);
    const photos = this.rowsToPhotos(result);
    return photos[0] ?? null;
  }

  async clearAlbumPhotos(albumId: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    log.info('Clearing cached photos for album', { albumId });

    // Delete all photos for this album
    this.db.run('DELETE FROM photos WHERE album_id = ?', [albumId]);

    // Reset album version to force full resync
    this.db.run('DELETE FROM albums WHERE id = ?', [albumId]);

    // Persist changes to OPFS
    await this.saveToOPFS();

    log.info('Cleared cached photos for album', { albumId });
  }

  private rowsToPhotos(result: { columns: string[]; values: unknown[][] }[]): PhotoMeta[] {
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
      obj['shardIds'] = JSON.parse((obj['shardIds'] as string) || '[]') as string[];
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
    if (!this.db) return;

    const data = this.db.export();
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
    const ciphertext = sodium.crypto_secretbox_easy(data, nonce, this.sessionKey);

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
      return sodium.crypto_secretbox_open_easy(ciphertext, nonce, this.sessionKey);
    } catch {
      throw new Error('Decryption failed - authentication error');
    }
  }
}

// Create worker instance
const worker = new DbWorker();

// For regular Worker, expose on self
// For SharedWorker, expose on each connection's port
// Check if we're in a SharedWorker context
const isSharedWorker = typeof (self as any).onconnect !== 'undefined' || 
  self.constructor.name === 'SharedWorkerGlobalScope';

if (isSharedWorker) {
  (self as any).onconnect = (event: MessageEvent) => {
    const port = event.ports[0];
    Comlink.expose(worker, port);
  };
} else {
  Comlink.expose(worker);
}
