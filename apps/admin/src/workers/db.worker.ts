/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import type {
  DbWorkerApi,
  PhotoMeta,
  DecryptedManifest,
  Bounds,
  GeoPoint,
} from './types';

/**
 * Database Worker Implementation
 * Manages SQLite-WASM database with OPFS persistence
 */
class DbWorker implements DbWorkerApi {
  private sql: SqlJsStatic | null = null;
  private db: Database | null = null;
  private sessionKey: Uint8Array | null = null;

  async init(sessionKey: Uint8Array): Promise<void> {
    this.sessionKey = sessionKey;

    // Initialize SQL.js WASM
    this.sql = await initSqlJs({
      locateFile: (_file: string) => `/sql-wasm.wasm`,
    });

    // Try to load existing DB from OPFS
    const existingData = await this.loadFromOPFS();
    if (existingData) {
      // TODO: Decrypt with sessionKey when crypto integration is done
      const decrypted = await this.decryptBlob(existingData);
      this.db = new this.sql.Database(decrypted);
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
        updated_at TEXT
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
      (id, asset_id, album_id, filename, mime_type, width, height, taken_at, lat, lng, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    // TODO: Encrypt with sessionKey when crypto integration is done
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

  // Placeholder encryption - will be replaced with real XChaCha20-Poly1305
  private async encryptBlob(data: Uint8Array): Promise<Uint8Array> {
    // Mock: Return data as-is (to be replaced in crypto integration)
    return data;
  }

  private async decryptBlob(data: Uint8Array): Promise<Uint8Array> {
    // Mock: Return data as-is (to be replaced in crypto integration)
    return data;
  }
}

// Create worker instance
const worker = new DbWorker();

// Expose for regular Worker usage
Comlink.expose(worker);

// Handle SharedWorker connections
declare const self: SharedWorkerGlobalScope;
if (typeof self.onconnect !== 'undefined') {
  self.onconnect = (event: MessageEvent) => {
    const port = event.ports[0];
    Comlink.expose(worker, port);
  };
}
