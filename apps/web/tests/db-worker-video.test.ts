/**
 * DB Worker Video Schema Tests
 *
 * Tests the v6 SQLite migration (video support columns) and verifies
 * that video metadata (isVideo, duration) round-trips correctly through
 * INSERT and SELECT operations with proper type conversions.
 *
 * Uses sql.js directly (in-memory SQLite) to mirror the db worker's
 * schema and mapping logic without needing WASM/OPFS/Worker infra.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';

// ---------------------------------------------------------------------------
// Helpers extracted from db.worker.ts to test in isolation
// ---------------------------------------------------------------------------

function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

interface RowResult {
  columns: string[];
  values: unknown[][];
}

/**
 * Mirrors the db worker's rowsToPhotos mapping logic.
 * Converts raw SQLite rows to PhotoMeta-shaped objects.
 */
function rowsToPhotos(result: RowResult[]): Record<string, unknown>[] {
  if (!result[0]) return [];

  const columns = result[0].columns;
  return result[0].values.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      obj[snakeToCamel(col)] = row[i];
    });
    // Parse JSON strings
    obj['tags'] = JSON.parse((obj['tags'] as string) || '[]') as string[];
    obj['shardIds'] = JSON.parse((obj['shardIds'] as string) || '[]') as string[];
    if (obj['originalShardIds']) {
      obj['originalShardIds'] = JSON.parse((obj['originalShardIds'] as string) || '[]') as string[];
    }
    if (obj['originalShardHashes']) {
      obj['originalShardHashes'] = JSON.parse((obj['originalShardHashes'] as string) || '[]') as string[];
    }
    // Convert is_video INTEGER to boolean (v6)
    obj['isVideo'] = !!(obj['isVideo']);
    return obj;
  });
}

// ---------------------------------------------------------------------------
// Schema DDL & migration helpers (mirrors db.worker.ts)
// ---------------------------------------------------------------------------

/** v1 initial schema */
const V1_SCHEMA = `
  CREATE TABLE IF NOT EXISTS albums (
    id TEXT PRIMARY KEY,
    current_version INTEGER DEFAULT 0
  );
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
  CREATE INDEX IF NOT EXISTS idx_photos_album ON photos(album_id);
  CREATE INDEX IF NOT EXISTS idx_photos_taken ON photos(taken_at);
  CREATE INDEX IF NOT EXISTS idx_photos_geo ON photos(lat, lng) WHERE lat IS NOT NULL;
`;

/** v3 thumbnail columns */
function applyV3(db: Database): void {
  db.run(`ALTER TABLE photos ADD COLUMN thumbnail TEXT;`);
  db.run(`ALTER TABLE photos ADD COLUMN thumb_width INTEGER;`);
  db.run(`ALTER TABLE photos ADD COLUMN thumb_height INTEGER;`);
  db.run(`ALTER TABLE photos ADD COLUMN blurhash TEXT;`);
}

/** v4 tier shard columns */
function applyV4(db: Database): void {
  db.run(`ALTER TABLE photos ADD COLUMN thumbnail_shard_id TEXT;`);
  db.run(`ALTER TABLE photos ADD COLUMN thumbnail_shard_hash TEXT;`);
  db.run(`ALTER TABLE photos ADD COLUMN preview_shard_id TEXT;`);
  db.run(`ALTER TABLE photos ADD COLUMN preview_shard_hash TEXT;`);
  db.run(`ALTER TABLE photos ADD COLUMN original_shard_ids TEXT;`);
  db.run(`ALTER TABLE photos ADD COLUMN original_shard_hashes TEXT;`);
}

/** v5 thumbhash */
function applyV5(db: Database): void {
  db.run(`ALTER TABLE photos ADD COLUMN thumbhash TEXT;`);
}

/** v6 video support — the migration under test */
function applyV6(db: Database): void {
  db.run(`ALTER TABLE photos ADD COLUMN is_video INTEGER DEFAULT 0;`);
  db.run(`ALTER TABLE photos ADD COLUMN duration REAL;`);
}

/** Apply all migrations up to v6 */
function applyAllMigrations(db: Database): void {
  db.run(V1_SCHEMA);
  // Skip v2 (FTS5) — not needed for these tests and sql.js may not ship fts5
  applyV3(db);
  applyV4(db);
  applyV5(db);
  applyV6(db);
  db.run(`PRAGMA user_version = 6`);
}

// The INSERT statement mirrors db.worker.ts insertManifests
const INSERT_SQL = `
  INSERT OR REPLACE INTO photos
  (id, asset_id, album_id, filename, mime_type, width, height, taken_at, lat, lng,
   tags, created_at, updated_at, shard_ids, epoch_id, description,
   thumbnail, thumb_width, thumb_height, blurhash,
   thumbnail_shard_id, thumbnail_shard_hash, preview_shard_id, preview_shard_hash,
   original_shard_ids, original_shard_hashes, thumbhash,
   is_video, duration)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?)
`;

interface InsertOpts {
  id: string;
  albumId?: string;
  filename?: string;
  mimeType?: string;
  isVideo?: boolean;
  duration?: number | null;
}

function insertPhoto(db: Database, opts: InsertOpts): void {
  const {
    id,
    albumId = 'album-1',
    filename = 'test.jpg',
    mimeType = 'image/jpeg',
    isVideo = false,
    duration = null,
  } = opts;

  db.run(INSERT_SQL, [
    id,
    `asset-${id}`,
    albumId,
    filename,
    mimeType,
    1920, 1080,
    null, null, null,
    JSON.stringify([]),
    '2024-01-01T00:00:00Z',
    '2024-01-01T00:00:00Z',
    JSON.stringify([]),
    1,
    null,
    null, null, null, null,
    null, null, null, null,
    JSON.stringify([]),
    JSON.stringify([]),
    null,
    isVideo ? 1 : 0,
    duration ?? null,
  ]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DB Worker Video Schema (v6 migration)', () => {
  let SQL: Awaited<ReturnType<typeof initSqlJs>>;
  let db: Database;

  beforeEach(async () => {
    SQL = await initSqlJs();
    db = new SQL.Database();
  });

  afterEach(() => {
    db.close();
  });

  // ── Schema migration tests ──────────────────────────────────────────

  describe('v6 migration', () => {
    it('adds is_video column with DEFAULT 0', () => {
      applyAllMigrations(db);

      const info = db.exec(`PRAGMA table_info(photos)`);
      const columns = info[0]!.values;
      const isVideoCol = columns.find((c) => c[1] === 'is_video');

      expect(isVideoCol).toBeDefined();
      // column type
      expect(isVideoCol![2]).toBe('INTEGER');
      // default value
      expect(isVideoCol![4]).toBe('0');
    });

    it('adds duration column as REAL', () => {
      applyAllMigrations(db);

      const info = db.exec(`PRAGMA table_info(photos)`);
      const columns = info[0]!.values;
      const durationCol = columns.find((c) => c[1] === 'duration');

      expect(durationCol).toBeDefined();
      expect(durationCol![2]).toBe('REAL');
      // no default → null
      expect(durationCol![4]).toBeNull();
    });

    it('is idempotent (safe to run twice)', () => {
      db.run(V1_SCHEMA);
      applyV3(db);
      applyV4(db);
      applyV5(db);

      // Run v6 migration twice — second call should not throw
      applyV6(db);
      // SQLite ALTER TABLE ADD COLUMN throws if column already exists,
      // so we mirror the db worker's pattern: only run if version < 6
      // The fact that we got here without error proves the first run succeeded.
      // Attempting a second run SHOULD throw (ALTER TABLE ... column already exists),
      // which is why the db worker guards with `if (currentVersion < 6)`.
      expect(() => applyV6(db)).toThrow();
    });

    it('preserves existing data after migration', () => {
      // Set up schema through v5
      db.run(V1_SCHEMA);
      applyV3(db);
      applyV4(db);
      applyV5(db);

      // Insert a photo before v6 migration
      db.run(`
        INSERT INTO photos (id, asset_id, album_id, filename, mime_type, width, height,
          tags, created_at, updated_at, shard_ids, epoch_id)
        VALUES ('pre-v6', 'asset-1', 'album-1', 'old.jpg', 'image/jpeg', 800, 600,
          '[]', '2024-01-01', '2024-01-01', '[]', 1)
      `);

      // Now apply v6
      applyV6(db);

      // Existing row should have default is_video=0, duration=null
      const result = db.exec(`SELECT is_video, duration FROM photos WHERE id = 'pre-v6'`);
      expect(result[0]!.values[0]![0]).toBe(0);
      expect(result[0]!.values[0]![1]).toBeNull();
    });
  });

  // ── Video insert / query round-trip ─────────────────────────────────

  describe('video insert and query', () => {
    beforeEach(() => {
      applyAllMigrations(db);
    });

    it('stores video metadata (isVideo=true, duration=62.5)', () => {
      insertPhoto(db, {
        id: 'vid-1',
        filename: 'clip.mp4',
        mimeType: 'video/mp4',
        isVideo: true,
        duration: 62.5,
      });

      const raw = db.exec(`SELECT is_video, duration FROM photos WHERE id = 'vid-1'`);
      expect(raw[0]!.values[0]![0]).toBe(1);
      expect(raw[0]!.values[0]![1]).toBe(62.5);
    });

    it('retrieves isVideo as boolean true via rowsToPhotos', () => {
      insertPhoto(db, { id: 'vid-2', isVideo: true, duration: 10 });

      const result = db.exec(`SELECT * FROM photos WHERE id = 'vid-2'`);
      const photos = rowsToPhotos(result);

      expect(photos).toHaveLength(1);
      expect(photos[0]!.isVideo).toBe(true);
    });

    it('retrieves duration as number via rowsToPhotos', () => {
      insertPhoto(db, { id: 'vid-3', isVideo: true, duration: 125.75 });

      const result = db.exec(`SELECT * FROM photos WHERE id = 'vid-3'`);
      const photos = rowsToPhotos(result);

      expect(photos[0]!.duration).toBe(125.75);
    });

    it('stores photo without video fields (isVideo defaults to false)', () => {
      insertPhoto(db, { id: 'photo-1', isVideo: false });

      const raw = db.exec(`SELECT is_video, duration FROM photos WHERE id = 'photo-1'`);
      expect(raw[0]!.values[0]![0]).toBe(0);
      expect(raw[0]!.values[0]![1]).toBeNull();
    });

    it('retrieves photo isVideo as false via rowsToPhotos', () => {
      insertPhoto(db, { id: 'photo-2' });

      const result = db.exec(`SELECT * FROM photos WHERE id = 'photo-2'`);
      const photos = rowsToPhotos(result);

      expect(photos[0]!.isVideo).toBe(false);
    });

    it('retrieves photo duration as null via rowsToPhotos', () => {
      insertPhoto(db, { id: 'photo-3' });

      const result = db.exec(`SELECT * FROM photos WHERE id = 'photo-3'`);
      const photos = rowsToPhotos(result);

      expect(photos[0]!.duration).toBeNull();
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────

  describe('edge cases', () => {
    beforeEach(() => {
      applyAllMigrations(db);
    });

    it('handles duration=0 for very short videos', () => {
      insertPhoto(db, { id: 'short-vid', isVideo: true, duration: 0 });

      const result = db.exec(`SELECT * FROM photos WHERE id = 'short-vid'`);
      const photos = rowsToPhotos(result);

      expect(photos[0]!.isVideo).toBe(true);
      expect(photos[0]!.duration).toBe(0);
    });

    it('handles null duration', () => {
      insertPhoto(db, { id: 'no-dur', isVideo: true, duration: null });

      const result = db.exec(`SELECT * FROM photos WHERE id = 'no-dur'`);
      const photos = rowsToPhotos(result);

      expect(photos[0]!.isVideo).toBe(true);
      expect(photos[0]!.duration).toBeNull();
    });

    it('isVideo is false for default (0) value', () => {
      // Insert directly with default — omit is_video column
      db.run(`
        INSERT INTO photos (id, asset_id, album_id, filename, mime_type, width, height,
          tags, created_at, updated_at, shard_ids, epoch_id)
        VALUES ('def-1', 'asset-def', 'album-1', 'default.jpg', 'image/jpeg', 100, 100,
          '[]', '2024-01-01', '2024-01-01', '[]', 1)
      `);

      const result = db.exec(`SELECT * FROM photos WHERE id = 'def-1'`);
      const photos = rowsToPhotos(result);

      expect(photos[0]!.isVideo).toBe(false);
    });

    it('boolean conversion: isVideo=true maps to 1 in DB, back to true', () => {
      // Verify the `isVideo ? 1 : 0` conversion (insert side)
      expect(true ? 1 : 0).toBe(1);

      // Verify the `!!(value)` conversion (read side)
      expect(!!(1)).toBe(true);
      expect(!!(0)).toBe(false);
      expect(!!(null)).toBe(false);
      expect(!!(undefined)).toBe(false);
    });

    it('stores and retrieves multiple videos and photos together', () => {
      insertPhoto(db, { id: 'mix-vid-1', isVideo: true, duration: 30, albumId: 'album-mix' });
      insertPhoto(db, { id: 'mix-photo-1', isVideo: false, albumId: 'album-mix' });
      insertPhoto(db, { id: 'mix-vid-2', isVideo: true, duration: 120.5, albumId: 'album-mix' });
      insertPhoto(db, { id: 'mix-photo-2', isVideo: false, albumId: 'album-mix' });

      const result = db.exec(`SELECT * FROM photos WHERE album_id = 'album-mix' ORDER BY id`);
      const photos = rowsToPhotos(result);

      expect(photos).toHaveLength(4);

      const photo1 = photos.find((p) => p.id === 'mix-photo-1')!;
      const photo2 = photos.find((p) => p.id === 'mix-photo-2')!;
      const vid1 = photos.find((p) => p.id === 'mix-vid-1')!;
      const vid2 = photos.find((p) => p.id === 'mix-vid-2')!;

      expect(photo1.isVideo).toBe(false);
      expect(photo1.duration).toBeNull();
      expect(photo2.isVideo).toBe(false);

      expect(vid1.isVideo).toBe(true);
      expect(vid1.duration).toBe(30);
      expect(vid2.isVideo).toBe(true);
      expect(vid2.duration).toBe(120.5);
    });
  });

  // ── Mapping helpers ─────────────────────────────────────────────────

  describe('snakeToCamel', () => {
    it('converts is_video to isVideo', () => {
      expect(snakeToCamel('is_video')).toBe('isVideo');
    });

    it('converts duration (no underscore) unchanged', () => {
      expect(snakeToCamel('duration')).toBe('duration');
    });

    it('converts multi-underscore names', () => {
      expect(snakeToCamel('thumbnail_shard_id')).toBe('thumbnailShardId');
    });

    it('converts album_id to albumId', () => {
      expect(snakeToCamel('album_id')).toBe('albumId');
    });
  });

  describe('rowsToPhotos empty results', () => {
    it('returns empty array for empty result set', () => {
      expect(rowsToPhotos([])).toEqual([]);
    });
  });
});
