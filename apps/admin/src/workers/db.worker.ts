/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import sodium from 'libsodium-wrappers-sumo';
import type {
    Bounds,
    DbWorkerApi,
    DecryptedManifest,
    GeoPoint,
    PhotoMeta,
} from './types';

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
      await sodium.ready;
      this.sodiumReady = true;
    }
  }

  async init(sessionKey: Uint8Array): Promise<void> {
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
      try {
        // Decrypt existing database with XChaCha20-Poly1305
        const decrypted = await this.decryptBlob(existingData);
        this.db = new this.sql.Database(decrypted);
      } catch (error) {
        // Decryption failed - could be wrong password or corrupted data
        // Start fresh with a new database
        console.warn('Failed to decrypt existing database, starting fresh:', error);
        this.db = new this.sql.Database();
      }
    } else {
      this.db = new this.sql.Database();
    }

    await this.runMigrations();
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

  private async runMigrations(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

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
        epoch_id INTEGER
      );
      
      -- Indexes for common queries
      CREATE INDEX IF NOT EXISTS idx_photos_album ON photos(album_id);
      CREATE INDEX IF NOT EXISTS idx_photos_taken ON photos(taken_at);
      CREATE INDEX IF NOT EXISTS idx_photos_geo ON photos(lat, lng) WHERE lat IS NOT NULL;
    `);

    // FTS5 for full-text search (separate statement for SQLite)
    try {
      this.db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS photos_fts USING fts5(
          filename, tags,
          content='photos',
          content_rowid='rowid'
        );
      `);

      // Triggers to keep FTS in sync
      this.db.run(`
        CREATE TRIGGER IF NOT EXISTS photos_ai AFTER INSERT ON photos BEGIN
          INSERT INTO photos_fts(rowid, filename, tags)
          VALUES (NEW.rowid, NEW.filename, NEW.tags);
        END;
      `);

      this.db.run(`
        CREATE TRIGGER IF NOT EXISTS photos_ad AFTER DELETE ON photos BEGIN
          INSERT INTO photos_fts(photos_fts, rowid, filename, tags)
          VALUES ('delete', OLD.rowid, OLD.filename, OLD.tags);
        END;
      `);

      this.db.run(`
        CREATE TRIGGER IF NOT EXISTS photos_au AFTER UPDATE ON photos BEGIN
          INSERT INTO photos_fts(photos_fts, rowid, filename, tags)
          VALUES ('delete', OLD.rowid, OLD.filename, OLD.tags);
          INSERT INTO photos_fts(rowid, filename, tags)
          VALUES (NEW.rowid, NEW.filename, NEW.tags);
        END;
      `);
    } catch {
      // FTS5 may already exist, ignore errors
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
      (id, asset_id, album_id, filename, mime_type, width, height, taken_at, lat, lng, tags, created_at, updated_at, shard_ids, epoch_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const m of manifests) {
      if (m.isDeleted) {
        this.db.run('DELETE FROM photos WHERE id = ?', [m.id]);
      } else {
        stmt.run([
          m.id,
          m.meta.assetId,
          m.albumId,
          m.meta.filename,
          m.meta.mimeType,
          m.meta.width,
          m.meta.height,
          m.meta.takenAt ?? null,
          m.meta.lat ?? null,
          m.meta.lng ?? null,
          JSON.stringify(m.meta.tags),
          m.meta.createdAt,
          m.meta.updatedAt,
          JSON.stringify(m.shardIds),
          m.versionCreated,
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
