import { openDB, type IDBPDatabase } from 'idb';
import initRustWasm, {
  computePlaintextContentHash,
  Sha256StreamingHasher,
} from '../generated/mosaic-wasm/mosaic_wasm.js';
import type { AlbumContentHashRecord, UploadQueueDB } from './upload/types';
import { getActiveLocale } from './i18n-locale';

export const UPLOAD_QUEUE_DB_NAME = 'mosaic-upload-queue';
export const UPLOAD_QUEUE_DB_VERSION = 3;
export const ALBUM_CONTENT_HASHES_STORE = 'albumContentHashes';

/**
 * Chunk size used by {@link computeContentHashStreaming}. Sized to keep
 * peak heap modest even for multi-GB videos (8 MiB ≈ a single
 * `arrayBuffer()` of one chunk at a time) while avoiding excessive
 * WASM boundary crossings.
 */
export const STREAMING_HASH_CHUNK_BYTES = 8 * 1024 * 1024;

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

/**
 * Streaming variant of {@link computeContentHash} for large files
 * (v1.0.x s47-y1).
 *
 * Reads the file slice-by-slice and feeds each chunk to the Rust WASM
 * `Sha256StreamingHasher`. The result is bit-identical to the
 * non-streaming `computeContentHash` (both compute plain SHA-256 of the
 * source bytes), so this is safe to use for the dedup index.
 *
 * Avoids OOM/jank on multi-hundred-MB videos that would otherwise
 * require a single `File.arrayBuffer()` allocation.
 *
 * Falls back to the non-streaming path when the test harness has
 * activated `useTestFallback` (the FNV-32 mock can't be made streaming
 * bit-identically and tests don't exercise multi-GB inputs).
 */
export async function computeContentHashStreaming(
  file: File,
  chunkBytes: number = STREAMING_HASH_CHUNK_BYTES,
): Promise<string> {
  await ensureRustWasmInitialized();
  if (useTestFallback) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      return testOnlyHashHex(bytes);
    } finally {
      bytes.fill(0);
    }
  }

  // Vitest throws on accessing exports that aren't returned from a `vi.mock`
  // factory. Probe the binding once defensively so we can fall back to the
  // one-shot path in tests (and in any future build where the streaming
  // hasher binding is absent).
  let StreamingHasherCtor: typeof Sha256StreamingHasher | undefined;
  try {
    StreamingHasherCtor =
      typeof Sha256StreamingHasher === 'function' ? Sha256StreamingHasher : undefined;
  } catch {
    StreamingHasherCtor = undefined;
  }

  if (!StreamingHasherCtor) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      return await computeContentHash(bytes);
    } finally {
      bytes.fill(0);
    }
  }

  let hasher: Sha256StreamingHasher;
  try {
    hasher = new StreamingHasherCtor();
  } catch {
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      return await computeContentHash(bytes);
    } finally {
      bytes.fill(0);
    }
  }

  try {
    const size = file.size;
    if (size === 0) {
      return hasher.finalize_hex();
    }
    for (let start = 0; start < size; start += chunkBytes) {
      const end = Math.min(start + chunkBytes, size);
      const chunk = new Uint8Array(await file.slice(start, end).arrayBuffer());
      try {
        hasher.update(chunk);
      } finally {
        chunk.fill(0);
      }
    }
    return hasher.finalize_hex();
  } catch (error) {
    if (import.meta.env.MODE === 'test') {
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        return await computeContentHash(bytes);
      } finally {
        bytes.fill(0);
      }
    }
    throw error;
  } finally {
    try {
      hasher.free();
    } catch {
      // ignore double-free / mock-free errors
    }
  }
}

interface ContentHashIndexStore {
  readonly indexNames: DOMStringList;
  createIndex(
    name: string,
    keyPath: string | string[],
    options?: IDBIndexParameters,
  ): unknown;
}

function ensureContentHashIndexes(store: ContentHashIndexStore): void {
  if (!store.indexNames.contains('album-hash')) {
    store.createIndex('album-hash', ['albumId', 'contentHash'], { unique: true });
  }
  if (!store.indexNames.contains('album')) {
    store.createIndex('album', 'albumId', { unique: false });
  }
  if (!store.indexNames.contains('album-photo')) {
    store.createIndex('album-photo', ['albumId', 'photoId'], { unique: false });
  }
}

export function ensureContentHashStores(
  db: IDBPDatabase<UploadQueueDB> | IDBDatabase,
  albumContentHashesStore?: ContentHashIndexStore,
): void {
  if (!db.objectStoreNames.contains('tasks')) {
    db.createObjectStore('tasks', { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(ALBUM_CONTENT_HASHES_STORE)) {
    const store = db.createObjectStore(ALBUM_CONTENT_HASHES_STORE, {
      keyPath: ['albumId', 'contentHash'],
    });
    ensureContentHashIndexes(store);
  } else if (albumContentHashesStore) {
    ensureContentHashIndexes(albumContentHashesStore);
  }
}

export class ContentHashDedup {
  constructor(private readonly db?: IDBPDatabase<UploadQueueDB>) {}

  private async database(): Promise<IDBPDatabase<UploadQueueDB>> {
    if (this.db) return this.db;
    return openDB<UploadQueueDB>(UPLOAD_QUEUE_DB_NAME, UPLOAD_QUEUE_DB_VERSION, {
      upgrade(database, _oldVersion, _newVersion, transaction) {
        const store = database.objectStoreNames.contains(ALBUM_CONTENT_HASHES_STORE)
          ? transaction.objectStore(ALBUM_CONTENT_HASHES_STORE)
          : undefined;
        ensureContentHashStores(database, store);
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

  async deleteByContentHash(albumId: string, contentHash: string): Promise<void> {
    const database = await this.database();
    await database.delete(ALBUM_CONTENT_HASHES_STORE, [albumId, contentHash]);
  }

  async deleteByPhotoId(albumId: string, photoId: string): Promise<void> {
    const database = await this.database();
    const tx = database.transaction(ALBUM_CONTENT_HASHES_STORE, 'readwrite');
    const keys = await tx.store.index('album-photo').getAllKeys([albumId, photoId]);
    await Promise.all(keys.map((key) => tx.store.delete(key)));
    await tx.done;
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
