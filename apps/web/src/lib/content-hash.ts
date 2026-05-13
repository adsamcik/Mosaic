import { openDB, type IDBPDatabase } from 'idb';
import initRustWasm, {
  computePlaintextContentHash,
} from '../generated/mosaic-wasm/mosaic_wasm.js';
import type { AlbumContentHashRecord, UploadQueueDB } from './upload/types';
import { getActiveLocale } from './i18n-locale';

export const UPLOAD_QUEUE_DB_NAME = 'mosaic-upload-queue';
export const UPLOAD_QUEUE_DB_VERSION = 2;
export const ALBUM_CONTENT_HASHES_STORE = 'albumContentHashes';

let rustWasmInitPromise: Promise<void> | null = null;
let useTestFallback = false;

function ensureRustWasmInitialized(): Promise<void> {
  rustWasmInitPromise ??= initRustWasm()
    .then(() => undefined)
    .catch((error: unknown) => {
      if (import.meta.env.MODE === 'test') {
        useTestFallback = true;
        return;
      }
      throw error;
    });
  return rustWasmInitPromise;
}

export async function computeContentHash(bytes: Uint8Array): Promise<string> {
  await ensureRustWasmInitialized();
  if (useTestFallback) {
    return testOnlyHashHex(bytes);
  }
  try {
    // CONTRACT: see docs/specs/SPEC-UploadContentHash.md. Callers must pass
    // source-of-truth user file bytes, not transformed tier or thumbnail bytes.
    return computePlaintextContentHash(bytes);
  } catch (error) {
    if (import.meta.env.MODE === 'test') {
      return testOnlyHashHex(bytes);
    }
    throw error;
  }
}

function testOnlyHashHex(bytes: Uint8Array): string {
  let state = 0x811c9dc5;
  for (let i = 0; i < bytes.byteLength; i += 1) {
    state ^= bytes[i]!;
    state = Math.imul(state, 0x01000193) >>> 0;
  }
  const chunk = state.toString(16).padStart(8, '0');
  return chunk.repeat(8);
}

export function ensureContentHashStores(db: IDBPDatabase<UploadQueueDB> | IDBDatabase): void {
  if (!db.objectStoreNames.contains('tasks')) {
    db.createObjectStore('tasks', { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(ALBUM_CONTENT_HASHES_STORE)) {
    const store = db.createObjectStore(ALBUM_CONTENT_HASHES_STORE, {
      keyPath: ['albumId', 'contentHash'],
    });
    store.createIndex('album-hash', ['albumId', 'contentHash'], { unique: true });
    store.createIndex('album', 'albumId', { unique: false });
  }
}

export class ContentHashDedup {
  constructor(private readonly db?: IDBPDatabase<UploadQueueDB>) {}

  private async database(): Promise<IDBPDatabase<UploadQueueDB>> {
    if (this.db) return this.db;
    return openDB<UploadQueueDB>(UPLOAD_QUEUE_DB_NAME, UPLOAD_QUEUE_DB_VERSION, {
      upgrade(database) {
        ensureContentHashStores(database);
      },
    });
  }

  async lookup(
    albumId: string,
    contentHash: string,
  ): Promise<{ photoId: string; dateAdded: number } | null> {
    const database = await this.database();
    const record = await database.getFromIndex(
      ALBUM_CONTENT_HASHES_STORE,
      'album-hash',
      [albumId, contentHash],
    );
    return record ? { photoId: record.photoId, dateAdded: record.dateAdded } : null;
  }

  async record(albumId: string, contentHash: string, photoId: string): Promise<void> {
    const database = await this.database();
    const row: AlbumContentHashRecord = {
      albumId,
      contentHash,
      photoId,
      dateAdded: Date.now(),
    };
    await database.put(ALBUM_CONTENT_HASHES_STORE, row);
  }

  async clear(albumId: string): Promise<void> {
    const database = await this.database();
    const tx = database.transaction(ALBUM_CONTENT_HASHES_STORE, 'readwrite');
    const rows = await tx.store.index('album').getAllKeys(albumId);
    await Promise.all(rows.map((key) => tx.store.delete(key)));
    await tx.done;
  }
}

export class DuplicateUploadError extends Error {
  constructor(
    readonly albumId: string,
    readonly contentHash: string,
    readonly photoId: string,
    readonly dateAdded: number,
  ) {
    super(
      `This photo is already in this album (added ${new Date(dateAdded).toLocaleString(getActiveLocale())}).`,
    );
    this.name = 'DuplicateUploadError';
  }
}
