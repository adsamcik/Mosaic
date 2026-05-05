/**
 * Ambient shard mirror — OPFS-backed, encrypted-only cache that amortizes
 * shard fetches across photos and across job runs.
 *
 * # Integrity property
 * Every `get` re-computes SHA-256 of the on-disk bytes and compares it to the
 * caller-supplied content hash. Any mismatch (including bit-rot or tampering
 * via dev-tools) evicts the entry and returns `null`. Callers therefore
 * receive bytes that provably match the requested content hash.
 *
 * # ZK property
 * Only encrypted shard bytes ever cross this boundary. Plaintext, derived
 * keys, photo IDs, filenames, and any other plaintext metadata MUST NOT be
 * passed to `put`. The cache key is the SHA-256 content hash of the
 * encrypted shard envelope (already public on the wire).
 *
 * # Budget semantics
 * `bytesBudget` is a hard upper bound. On `put`, after admitting the new
 * entry the cache trims down to 90% of budget if exceeded. `trim()` always
 * targets 90% so we don't trim on every put. Eviction order is LRU by
 * `lastAccessMs`, with TTL-expired entries swept first.
 *
 * # TTL default
 * 30 days. Long enough to survive a typical resume cycle and casual re-runs;
 * short enough that abandoned shards eventually free their slot in the
 * presence of a stable budget.
 */
import sodium from 'libsodium-wrappers-sumo';

export interface ShardMirror {
  get(contentHash: string): Promise<Uint8Array | null>;
  put(contentHash: string, bytes: Uint8Array): Promise<void>;
  evict(contentHash: string): Promise<void>;
  trim(): Promise<{ readonly evicted: number; readonly bytesFreed: number }>;
  stats(): Promise<ShardMirrorStats>;
}

export interface ShardMirrorStats {
  readonly entries: number;
  readonly bytesUsed: number;
  readonly bytesBudget: number;
  readonly hits: number;
  readonly misses: number;
  readonly puts: number;
  readonly evictions: number;
}

export interface ShardMirrorOptions {
  readonly bytesBudget: number;
  readonly ttlMs: number;
  readonly directory: string;
}

const DEFAULT_BYTES_BUDGET = 256 * 1024 * 1024;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_DIRECTORY = 'mosaic-shard-mirror';
const TRIM_HEADROOM_RATIO = 0.9;
const INDEX_FILE = 'index.json';
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

interface IndexEntry {
  bytes: number;
  lastAccessMs: number;
  createdAtMs: number;
}

interface PersistedIndex {
  readonly version: 1;
  readonly entries: Record<string, IndexEntry>;
}

interface WritableFileHandle extends FileSystemFileHandle {
  createWritable(options?: FileSystemCreateWritableOptions): Promise<FileSystemWritableFileStream>;
}

interface EnumerableDirectoryHandle extends FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    try {
      await prev;
      return await fn();
    } finally {
      release();
    }
  }
}

export function createShardMirror(opts?: Partial<ShardMirrorOptions>): ShardMirror {
  const bytesBudget = opts?.bytesBudget ?? DEFAULT_BYTES_BUDGET;
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const directoryName = opts?.directory ?? DEFAULT_DIRECTORY;
  if (!(bytesBudget > 0)) throw new Error('bytesBudget must be > 0');
  if (!(ttlMs > 0)) throw new Error('ttlMs must be > 0');

  const mutex = new Mutex();
  const counters = { hits: 0, misses: 0, puts: 0, evictions: 0 };
  let index: Map<string, IndexEntry> | null = null;
  let dirHandle: FileSystemDirectoryHandle | null = null;

  async function getDir(): Promise<FileSystemDirectoryHandle> {
    if (dirHandle !== null) return dirHandle;
    if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
      throw new Error('OPFS unsupported');
    }
    const root = await navigator.storage.getDirectory();
    dirHandle = await root.getDirectoryHandle(directoryName, { create: true });
    return dirHandle;
  }

  async function ensureIndex(): Promise<Map<string, IndexEntry>> {
    if (index !== null) return index;
    index = await loadIndex();
    return index;
  }

  async function loadIndex(): Promise<Map<string, IndexEntry>> {
    const dir = await getDir();
    const fromFile = await readIndexFile(dir);
    if (fromFile !== null) {
      // Reconcile: drop entries whose data file is missing or wrong size.
      const reconciled = new Map<string, IndexEntry>();
      for (const [hash, entry] of fromFile) {
        if (!HASH_PATTERN.test(hash)) continue;
        const size = await safeFileSize(dir, hash);
        if (size === entry.bytes) {
          reconciled.set(hash, entry);
        } else if (size !== null) {
          await safeRemove(dir, hash);
        }
      }
      return reconciled;
    }
    // No index file — scan directory and synthesize.
    const synth = new Map<string, IndexEntry>();
    const now = Date.now();
    if (!hasEntries(dir)) return synth;
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file' || !HASH_PATTERN.test(name)) continue;
      const size = await safeFileSize(dir, name);
      if (size === null) continue;
      synth.set(name, { bytes: size, lastAccessMs: now, createdAtMs: now });
    }
    return synth;
  }

  async function persistIndex(): Promise<void> {
    if (index === null) return;
    const dir = await getDir();
    const obj: PersistedIndex = { version: 1, entries: Object.fromEntries(index) };
    const text = JSON.stringify(obj);
    const handle = await dir.getFileHandle(INDEX_FILE, { create: true });
    if (!hasCreateWritable(handle)) {
      throw new Error('OPFS createWritable required');
    }
    const writable = await handle.createWritable();
    try {
      await writable.write(new TextEncoder().encode(text));
    } finally {
      await writable.close();
    }
  }

  async function readEntryBytes(hash: string): Promise<Uint8Array | null> {
    const dir = await getDir();
    try {
      const fh = await dir.getFileHandle(hash);
      const file = await fh.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
  }

  async function writeEntryBytes(hash: string, bytes: Uint8Array): Promise<void> {
    const dir = await getDir();
    const fh = await dir.getFileHandle(hash, { create: true });
    if (!hasCreateWritable(fh)) {
      throw new Error('OPFS createWritable required');
    }
    const writable = await fh.createWritable();
    try {
      await writable.write(new Uint8Array(bytes));
    } finally {
      await writable.close();
    }
  }

  async function evictInternal(hash: string, idx: Map<string, IndexEntry>): Promise<number> {
    const entry = idx.get(hash);
    idx.delete(hash);
    const dir = await getDir();
    await safeRemove(dir, hash);
    counters.evictions += 1;
    return entry?.bytes ?? 0;
  }

  async function trimInternal(idx: Map<string, IndexEntry>, nowMs: number): Promise<{ evicted: number; bytesFreed: number }> {
    let bytesFreed = 0;
    let evicted = 0;
    // First sweep: TTL-expired entries.
    const expired: string[] = [];
    for (const [hash, entry] of idx) {
      if (nowMs - entry.createdAtMs > ttlMs) expired.push(hash);
    }
    for (const hash of expired) {
      bytesFreed += await evictInternal(hash, idx);
      evicted += 1;
    }
    // Then LRU until under 90% budget.
    const target = Math.floor(bytesBudget * TRIM_HEADROOM_RATIO);
    let used = totalBytes(idx);
    if (used > target) {
      const ordered = [...idx.entries()].sort((a, b) => a[1].lastAccessMs - b[1].lastAccessMs);
      for (const [hash] of ordered) {
        if (used <= target) break;
        const freed = await evictInternal(hash, idx);
        bytesFreed += freed;
        used -= freed;
        evicted += 1;
      }
    }
    return { evicted, bytesFreed };
  }

  async function computeSha256Hex(bytes: Uint8Array): Promise<string> {
    // Copy into a fresh ArrayBuffer-backed view so SubtleCrypto's BufferSource
    // signature is satisfied even when the input is SharedArrayBuffer-backed.
    const owned = new Uint8Array(bytes);
    if (typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function') {
      const buf = await crypto.subtle.digest('SHA-256', owned);
      return toHex(new Uint8Array(buf));
    }
    await sodium.ready;
    return toHex(sodium.crypto_hash_sha256(owned));
  }

  return {
    async get(contentHash: string): Promise<Uint8Array | null> {
      if (!HASH_PATTERN.test(contentHash)) {
        counters.misses += 1;
        return null;
      }
      try {
        const idx = await ensureIndex();
        const entry = idx.get(contentHash);
        if (!entry) {
          counters.misses += 1;
          return null;
        }
        const now = Date.now();
        if (now - entry.createdAtMs > ttlMs) {
          await mutex.run(async () => {
            const i = await ensureIndex();
            if (i.has(contentHash)) {
              await evictInternal(contentHash, i);
              await persistIndex();
            }
          });
          counters.misses += 1;
          return null;
        }
        const bytes = await readEntryBytes(contentHash);
        if (bytes === null) {
          await mutex.run(async () => {
            const i = await ensureIndex();
            if (i.has(contentHash)) {
              i.delete(contentHash);
              await persistIndex();
            }
          });
          counters.misses += 1;
          return null;
        }
        const actualHex = await computeSha256Hex(bytes);
        if (actualHex !== contentHash) {
          await mutex.run(async () => {
            const i = await ensureIndex();
            if (i.has(contentHash)) {
              await evictInternal(contentHash, i);
              await persistIndex();
            }
          });
          counters.misses += 1;
          return null;
        }
        // LRU bump (best-effort; serialized to avoid clobbering concurrent writes).
        await mutex.run(async () => {
          const i = await ensureIndex();
          const cur = i.get(contentHash);
          if (cur) {
            cur.lastAccessMs = now;
            await persistIndex();
          }
        });
        counters.hits += 1;
        return bytes;
      } catch {
        counters.misses += 1;
        return null;
      }
    },

    async put(contentHash: string, bytes: Uint8Array): Promise<void> {
      if (!HASH_PATTERN.test(contentHash)) {
        throw new Error('Invalid content hash format (expected 64 hex chars)');
      }
      // Defensive: never persist bytes whose hash doesn't match the key.
      // This is what makes the ZK invariant audit-able: callers can't smuggle
      // arbitrary plaintext through put() because the key-hash relationship
      // is enforced both on put and on get.
      const actualHex = await computeSha256Hex(bytes);
      if (actualHex !== contentHash) {
        throw new Error('Content hash does not match bytes');
      }
      // Refuse single entries larger than the entire budget.
      if (bytes.byteLength > bytesBudget) return;
      await mutex.run(async () => {
        const idx = await ensureIndex();
        const now = Date.now();
        const existing = idx.get(contentHash);
        if (existing) {
          existing.lastAccessMs = now;
          await persistIndex();
          return;
        }
        await writeEntryBytes(contentHash, bytes);
        idx.set(contentHash, { bytes: bytes.byteLength, lastAccessMs: now, createdAtMs: now });
        counters.puts += 1;
        if (totalBytes(idx) > bytesBudget) {
          await trimInternal(idx, now);
        }
        await persistIndex();
      });
    },

    async evict(contentHash: string): Promise<void> {
      if (!HASH_PATTERN.test(contentHash)) return;
      await mutex.run(async () => {
        const idx = await ensureIndex();
        if (!idx.has(contentHash)) return;
        await evictInternal(contentHash, idx);
        await persistIndex();
      });
    },

    async trim(): Promise<{ readonly evicted: number; readonly bytesFreed: number }> {
      return mutex.run(async () => {
        const idx = await ensureIndex();
        const result = await trimInternal(idx, Date.now());
        if (result.evicted > 0) await persistIndex();
        return result;
      });
    },

    async stats(): Promise<ShardMirrorStats> {
      const idx = await ensureIndex();
      return {
        entries: idx.size,
        bytesUsed: totalBytes(idx),
        bytesBudget,
        hits: counters.hits,
        misses: counters.misses,
        puts: counters.puts,
        evictions: counters.evictions,
      };
    },
  };
}

function totalBytes(idx: Map<string, IndexEntry>): number {
  let total = 0;
  for (const e of idx.values()) total += e.bytes;
  return total;
}

async function readIndexFile(dir: FileSystemDirectoryHandle): Promise<Map<string, IndexEntry> | null> {
  let handle: FileSystemFileHandle;
  try {
    handle = await dir.getFileHandle(INDEX_FILE);
  } catch {
    return null;
  }
  try {
    const file = await handle.getFile();
    const text = await file.text();
    if (text.length === 0) return new Map();
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as { entries?: Record<string, unknown> };
    if (typeof obj.entries !== 'object' || obj.entries === null) return null;
    const map = new Map<string, IndexEntry>();
    for (const [k, v] of Object.entries(obj.entries)) {
      if (!HASH_PATTERN.test(k)) continue;
      if (typeof v !== 'object' || v === null) continue;
      const e = v as { bytes?: unknown; lastAccessMs?: unknown; createdAtMs?: unknown };
      if (typeof e.bytes !== 'number' || typeof e.lastAccessMs !== 'number' || typeof e.createdAtMs !== 'number') continue;
      map.set(k, { bytes: e.bytes, lastAccessMs: e.lastAccessMs, createdAtMs: e.createdAtMs });
    }
    return map;
  } catch {
    return null;
  }
}

async function safeFileSize(dir: FileSystemDirectoryHandle, name: string): Promise<number | null> {
  try {
    const fh = await dir.getFileHandle(name);
    const file = await fh.getFile();
    return file.size;
  } catch {
    return null;
  }
}

async function safeRemove(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await dir.removeEntry(name);
  } catch {
    // Already gone — idempotent.
  }
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

function hasCreateWritable(handle: FileSystemFileHandle): handle is WritableFileHandle {
  return typeof (handle as WritableFileHandle).createWritable === 'function';
}

function hasEntries(dir: FileSystemDirectoryHandle): dir is EnumerableDirectoryHandle {
  return typeof (dir as EnumerableDirectoryHandle).entries === 'function';
}

/** Convert a SHA-256 digest (32 bytes) into the lowercase hex key used by the mirror. */
export function shardMirrorKey(hash: Uint8Array): string {
  if (hash.byteLength !== 32) {
    throw new Error('Shard content hash must be 32 bytes (SHA-256)');
  }
  return toHex(hash);
}
