import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { createShardMirror, shardMirrorKey } from '../shard-mirror';

// ── Minimal in-memory OPFS shim ─────────────────────────────────────────────
class FileNode { data = new Uint8Array(); lastModified = Date.now(); }

class FileHandle implements FileSystemFileHandle {
  readonly kind = 'file';
  constructor(public name: string, _parent: DirHandle, private node: FileNode) {}
  async createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle> { throw new DOMException('unsupported', 'NotSupportedError'); }
  async getFile(): Promise<File> {
    return new File([this.node.data], this.name, { lastModified: this.node.lastModified });
  }
  async createWritable(opts?: FileSystemCreateWritableOptions): Promise<FileSystemWritableFileStream> {
    if (!opts?.keepExistingData) this.node.data = new Uint8Array();
    const node = this.node;
    return Object.assign(new WritableStream(), {
      async write(chunk: unknown): Promise<void> {
        const b = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer);
        node.data = new Uint8Array(b);
        node.lastModified = Date.now();
      },
      async seek(): Promise<void> {},
      async truncate(n: number): Promise<void> { node.data = node.data.slice(0, n); },
    }) as unknown as FileSystemWritableFileStream;
  }
  async isSameEntry(o: FileSystemHandle): Promise<boolean> { return o === this; }
}

class DirHandle implements FileSystemDirectoryHandle {
  readonly kind = 'directory';
  private children = new Map<string, DirHandle | FileNode>();
  constructor(public readonly name: string) {}
  async getDirectoryHandle(name: string, opts?: FileSystemGetDirectoryOptions): Promise<FileSystemDirectoryHandle> {
    const ex = this.children.get(name);
    if (ex instanceof DirHandle) return ex;
    if (ex !== undefined) throw new DOMException('type mismatch', 'TypeMismatchError');
    if (opts?.create) { const d = new DirHandle(name); this.children.set(name, d); return d; }
    throw new DOMException('not found', 'NotFoundError');
  }
  async getFileHandle(name: string, opts?: FileSystemGetFileOptions): Promise<FileSystemFileHandle> {
    const ex = this.children.get(name);
    if (ex instanceof FileNode) return new FileHandle(name, this, ex);
    if (ex !== undefined) throw new DOMException('type mismatch', 'TypeMismatchError');
    if (opts?.create) { const n = new FileNode(); this.children.set(name, n); return new FileHandle(name, this, n); }
    throw new DOMException('not found', 'NotFoundError');
  }
  async removeEntry(name: string): Promise<void> {
    if (!this.children.delete(name)) throw new DOMException('not found', 'NotFoundError');
  }
  async isSameEntry(o: FileSystemHandle): Promise<boolean> { return o === this; }
  async resolve(): Promise<string[] | null> { return null; }
  async *entries(): AsyncIterableIterator<[string, FileSystemHandle]> {
    for (const [n, c] of this.children) {
      yield c instanceof DirHandle ? [n, c] : [n, new FileHandle(n, this, c)];
    }
  }
  async *keys(): AsyncIterableIterator<string> { for (const k of this.children.keys()) yield k; }
  async *values(): AsyncIterableIterator<FileSystemHandle> {
    for await (const [, h] of this.entries()) yield h;
  }
  [Symbol.asyncIterator](): AsyncIterableIterator<[string, FileSystemHandle]> { return this.entries(); }

  // Test-only escape hatch
  _setRawFileBytes(name: string, bytes: Uint8Array): void {
    const node = new FileNode();
    node.data = new Uint8Array(bytes);
    this.children.set(name, node);
  }
}

let opfsRoot: DirHandle;

function installOpfs(): void {
  opfsRoot = new DirHandle('');
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: {
      async getDirectory(): Promise<FileSystemDirectoryHandle> { return opfsRoot; },
      async estimate(): Promise<StorageEstimate> { return {}; },
      async persist(): Promise<boolean> { return true; },
      async persisted(): Promise<boolean> { return true; },
    },
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

beforeEach(async () => {
  await sodium.ready;
  installOpfs();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ShardMirror', () => {
  it('roundtrips put → get with hash verification', async () => {
    const m = createShardMirror({ directory: 'd1' });
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const hash = await sha256Hex(bytes);
    await m.put(hash, bytes);
    const got = await m.get(hash);
    expect(got).not.toBeNull();
    expect(Array.from(got!)).toEqual([1, 2, 3, 4, 5]);
    const stats = await m.stats();
    expect(stats.entries).toBe(1);
    expect(stats.bytesUsed).toBe(5);
    expect(stats.hits).toBe(1);
    expect(stats.puts).toBe(1);
  });

  it('returns null on miss', async () => {
    const m = createShardMirror({ directory: 'd2' });
    const fakeHash = '00'.repeat(32);
    expect(await m.get(fakeHash)).toBeNull();
    expect((await m.stats()).misses).toBe(1);
  });

  it('rejects put when bytes do not match content hash', async () => {
    const m = createShardMirror({ directory: 'd3' });
    const wrongHash = '11'.repeat(32);
    await expect(m.put(wrongHash, new Uint8Array([9, 9, 9]))).rejects.toThrow();
  });

  it('rejects malformed hash keys', async () => {
    const m = createShardMirror({ directory: 'd4' });
    await expect(m.put('not-hex', new Uint8Array([1]))).rejects.toThrow();
    expect(await m.get('not-hex')).toBeNull();
  });

  it('expires entries past TTL on get', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const m = createShardMirror({ directory: 'd5', ttlMs: 1000 });
    const bytes = new Uint8Array([7, 7, 7]);
    const hash = await sha256Hex(bytes);
    await m.put(hash, bytes);
    expect(await m.get(hash)).not.toBeNull();
    vi.setSystemTime(new Date('2025-01-01T01:00:00Z'));
    expect(await m.get(hash)).toBeNull();
    expect((await m.stats()).entries).toBe(0);
  });

  it('evicts and returns null when on-disk bytes are tampered with', async () => {
    const m = createShardMirror({ directory: 'd6' });
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const hash = await sha256Hex(bytes);
    await m.put(hash, bytes);
    // Tamper directly via the OPFS shim.
    const dirRoot = await navigator.storage.getDirectory();
    const dir = await dirRoot.getDirectoryHandle('d6');
    const fh = await dir.getFileHandle(hash);
    const w = await (fh as { createWritable: () => Promise<FileSystemWritableFileStream> }).createWritable();
    await w.write(new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]));
    await w.close();
    expect(await m.get(hash)).toBeNull();
    // Entry was evicted.
    expect((await m.stats()).entries).toBe(0);
  });

  it('explicit evict removes the entry', async () => {
    const m = createShardMirror({ directory: 'd7' });
    const bytes = new Uint8Array([5, 5, 5]);
    const hash = await sha256Hex(bytes);
    await m.put(hash, bytes);
    await m.evict(hash);
    expect(await m.get(hash)).toBeNull();
  });

  it('trim drops oldest entries to 90% of budget (LRU)', async () => {
    const m = createShardMirror({ directory: 'd8', bytesBudget: 100 });
    // 4 entries × 30 bytes = 120 bytes. Budget=100, target=90.
    // We must put serially to control insertion order/lastAccess.
    const hashes: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const b = new Uint8Array(30).fill(i + 1);
      const h = await sha256Hex(b);
      hashes.push(h);
      await m.put(h, b);
    }
    // After 4th put, total=120>100 → trim to ≤90 should evict the oldest.
    const stats = await m.stats();
    expect(stats.bytesUsed).toBeLessThanOrEqual(90);
    expect(stats.entries).toBeLessThanOrEqual(3);
    // Oldest (hashes[0]) should be gone.
    expect(await m.get(hashes[0]!)).toBeNull();
    // Newest should still be present.
    expect(await m.get(hashes[3]!)).not.toBeNull();
  });

  it('serializes concurrent puts so budget is enforced', async () => {
    const m = createShardMirror({ directory: 'd9', bytesBudget: 100 });
    const bs: { hash: string; bytes: Uint8Array }[] = [];
    for (let i = 0; i < 6; i += 1) {
      const b = new Uint8Array(30).fill(i + 10);
      bs.push({ hash: await sha256Hex(b), bytes: b });
    }
    await Promise.all(bs.map((x) => m.put(x.hash, x.bytes)));
    const stats = await m.stats();
    expect(stats.bytesUsed).toBeLessThanOrEqual(100);
  });

  it('stats are consistent after a sequence of operations', async () => {
    const m = createShardMirror({ directory: 'd10' });
    const b1 = new Uint8Array([1]); const h1 = await sha256Hex(b1);
    const b2 = new Uint8Array([2]); const h2 = await sha256Hex(b2);
    await m.put(h1, b1);
    await m.put(h2, b2);
    await m.get(h1);          // hit
    await m.get('aa'.repeat(32)); // miss
    await m.evict(h2);
    const s = await m.stats();
    expect(s.entries).toBe(1);
    expect(s.bytesUsed).toBe(1);
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(1);
    expect(s.puts).toBe(2);
    expect(s.evictions).toBeGreaterThanOrEqual(1);
  });

  it('survives an index file roundtrip (cross-instance persistence)', async () => {
    const m1 = createShardMirror({ directory: 'd11' });
    const bytes = new Uint8Array([42, 42, 42]);
    const hash = await sha256Hex(bytes);
    await m1.put(hash, bytes);
    // New instance reads the persisted index.
    const m2 = createShardMirror({ directory: 'd11' });
    const got = await m2.get(hash);
    expect(got).not.toBeNull();
    expect(Array.from(got!)).toEqual([42, 42, 42]);
  });
});

describe('shardMirrorKey', () => {
  it('rejects non-32-byte hashes', () => {
    expect(() => shardMirrorKey(new Uint8Array(31))).toThrow();
    expect(() => shardMirrorKey(new Uint8Array(33))).toThrow();
  });
  it('produces 64-char hex', () => {
    const k = shardMirrorKey(new Uint8Array(32).fill(0xab));
    expect(k).toBe('ab'.repeat(32));
    expect(k).toMatch(/^[0-9a-f]{64}$/u);
  });
});
