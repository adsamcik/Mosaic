import { openDB, type IDBPDatabase } from 'idb';
import type { AlbumContentHashRecord, UploadQueueDB } from './upload/types';

export const UPLOAD_QUEUE_DB_NAME = 'mosaic-upload-queue';
export const UPLOAD_QUEUE_DB_VERSION = 2;
export const ALBUM_CONTENT_HASHES_STORE = 'albumContentHashes';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function computeContentHash(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('WebCrypto SHA-256 is unavailable');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
  return bytesToHex(new Uint8Array(digest));
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
    super(`This photo is already in this album (added ${new Date(dateAdded).toLocaleString()}).`);
    this.name = 'DuplicateUploadError';
  }
}
