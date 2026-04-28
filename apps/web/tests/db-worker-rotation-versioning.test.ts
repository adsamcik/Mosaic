import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';
import type { DecryptedManifest, PhotoMeta } from '../src/workers/types';

vi.mock('comlink', () => ({
  expose: vi.fn(),
}));

import { DbWorker } from '../src/workers/db.worker';

interface DbWorkerInternals {
  db: Database;
  saveToOPFS: () => Promise<void>;
}

function createPhotosSchema(db: Database): void {
  db.run(`
    CREATE TABLE photos (
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
      thumbnail TEXT,
      thumb_width INTEGER,
      thumb_height INTEGER,
      blurhash TEXT,
      thumbnail_shard_id TEXT,
      thumbnail_shard_hash TEXT,
      preview_shard_id TEXT,
      preview_shard_hash TEXT,
      original_shard_ids TEXT,
      original_shard_hashes TEXT,
      thumbhash TEXT,
      is_video INTEGER DEFAULT 0,
      duration REAL,
      rotation INTEGER DEFAULT 0,
      version_created INTEGER DEFAULT 0
    );
  `);
}

function makeManifest(versionCreated: number, rotation: number): DecryptedManifest {
  const meta: PhotoMeta = {
    id: 'photo-1',
    assetId: 'asset-1',
    albumId: 'album-1',
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
    width: 100,
    height: 100,
    tags: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    shardIds: [],
    epochId: 1,
    rotation,
  };

  return {
    id: meta.id,
    albumId: meta.albumId,
    versionCreated,
    isDeleted: false,
    meta,
    shardIds: [],
  };
}

describe('DbWorker manifest rotation versioning', () => {
  let db: Database;
  let worker: DbWorker;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    createPhotosSchema(db);

    worker = new DbWorker();
    const internal = worker as unknown as DbWorkerInternals;
    internal.db = db;
    vi.spyOn(internal, 'saveToOPFS').mockResolvedValue(undefined);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('rejects stale manifest versions so sync cannot clobber a freshly rotated photo', async () => {
    await worker.insertManifests([makeManifest(5, 90)]);

    await worker.insertManifests([makeManifest(3, 0)]);

    let photo = await worker.getPhotoById('photo-1');
    expect(photo?.rotation).toBe(90);

    await worker.insertManifests([makeManifest(7, 180)]);

    photo = await worker.getPhotoById('photo-1');
    expect(photo?.rotation).toBe(180);
  });
});
