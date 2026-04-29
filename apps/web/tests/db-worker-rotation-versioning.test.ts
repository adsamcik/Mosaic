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

  it('updatePhotoRotation refuses to regress version_created when a newer sync has already landed', async () => {
    // Sync delivers a manifest at version 10 with rotation 90.
    await worker.insertManifests([makeManifest(10, 90)]);

    // The user's optimistic rotation write returns from the server with
    // version_created = 7 because their PATCH was based on a stale view of
    // the album. The local row must NOT regress to version 7.
    await worker.updatePhotoRotation('photo-1', 270, 7);

    const photo = await worker.getPhotoById('photo-1');
    expect(photo?.rotation).toBe(90);

    // Confirm the version stayed at 10 by attempting to apply a manifest at
    // version 8: it must still be skipped because the local row is at 10.
    await worker.insertManifests([makeManifest(8, 0)]);
    const reread = await worker.getPhotoById('photo-1');
    expect(reread?.rotation).toBe(90);
  });

  it('updatePhotoRotation applies when the incoming version is newer or equal', async () => {
    await worker.insertManifests([makeManifest(5, 0)]);

    // Newer wins.
    await worker.updatePhotoRotation('photo-1', 90, 6);
    expect((await worker.getPhotoById('photo-1'))?.rotation).toBe(90);

    // Equal wins (idempotent retry of the same write should be safe).
    await worker.updatePhotoRotation('photo-1', 180, 6);
    expect((await worker.getPhotoById('photo-1'))?.rotation).toBe(180);
  });

  it('updatePhotoDescription refuses to regress version_created when a newer sync has already landed', async () => {
    await worker.insertManifests([makeManifest(10, 0)]);

    // Optimistic description write returns at a stale version.
    await worker.updatePhotoDescription('photo-1', 'late-write', 7);

    const photo = await worker.getPhotoById('photo-1');
    // Description stays whatever the manifest at v10 carried (none, in the
    // makeManifest fixture). The stale write was rejected.
    expect(photo?.description ?? null).toBeNull();

    // Newer write still applies cleanly.
    await worker.updatePhotoDescription('photo-1', 'fresh', 11);
    const reread = await worker.getPhotoById('photo-1');
    expect(reread?.description).toBe('fresh');
  });
});
