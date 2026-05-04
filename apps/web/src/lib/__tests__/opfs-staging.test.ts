import sodium from 'libsodium-wrappers-sumo';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OpfsStagingError,
  OpfsStagingErrorCode,
  createJobDir,
  gcStaleJobs,
  getPhotoFileLength,
  getStagingRoot,
  isOpfsSupported,
  jobExists,
  listJobs,
  purgeJob,
  quotaInfo,
  readPhotoStream,
  readSnapshot,
  truncatePhotoTo,
  writePhotoChunk,
  writeSnapshot,
  type JobId,
  type PhotoId,
} from '../opfs-staging';

const JOB_A: JobId = '0000000000000000000000000000000a';
const JOB_B: JobId = '0000000000000000000000000000000b';
const JOB_C: JobId = '0000000000000000000000000000000c';
const PHOTO_A: PhotoId = '018f6b8c-0000-7000-8000-000000000001';
const PHOTO_B: PhotoId = '018f6b8c-0000-7000-8000-000000000002';

class MemoryFileNode {
  data = new Uint8Array();
  lastModified = Date.now();
}

class MemoryFileHandle implements FileSystemFileHandle {
  readonly kind = 'file';

  constructor(
    public name: string,
    private parent: MemoryDirectoryHandle,
    private readonly node: MemoryFileNode,
  ) {}

  async createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle> {
    return new MemorySyncAccessHandle(this.node);
  }

  async createWritable(options?: FileSystemCreateWritableOptions): Promise<FileSystemWritableFileStream> {
    return new MemoryWritableFileStream(this.node, options?.keepExistingData === true);
  }

  async getFile(): Promise<File> {
    return new File([this.node.data], this.name, { lastModified: this.node.lastModified });
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return this === other;
  }

  async move(parent: FileSystemDirectoryHandle, name: string): Promise<void> {
    if (!(parent instanceof MemoryDirectoryHandle)) {
      throw new DOMException('Unsupported target directory', 'NotFoundError');
    }
    this.parent.deleteChild(this.name);
    this.name = name;
    this.parent = parent;
    parent.setChild(name, this.node);
    this.node.lastModified = Date.now();
  }

  setLastModified(lastModified: number): void {
    this.node.lastModified = lastModified;
  }
}

class MemoryDirectoryHandle implements FileSystemDirectoryHandle {
  readonly kind = 'directory';
  private readonly children = new Map<string, MemoryDirectoryHandle | MemoryFileNode>();

  constructor(public readonly name: string) {}

  async getDirectoryHandle(
    name: string,
    options?: FileSystemGetDirectoryOptions,
  ): Promise<FileSystemDirectoryHandle> {
    const existing = this.children.get(name);
    if (existing instanceof MemoryDirectoryHandle) {
      return existing;
    }
    if (existing !== undefined) {
      throw new DOMException('A file exists at this path', 'TypeMismatchError');
    }
    if (options?.create === true) {
      const dir = new MemoryDirectoryHandle(name);
      this.children.set(name, dir);
      return dir;
    }
    throw new DOMException('Directory not found', 'NotFoundError');
  }

  async getFileHandle(name: string, options?: FileSystemGetFileOptions): Promise<FileSystemFileHandle> {
    const existing = this.children.get(name);
    if (existing instanceof MemoryFileNode) {
      return new MemoryFileHandle(name, this, existing);
    }
    if (existing !== undefined) {
      throw new DOMException('A directory exists at this path', 'TypeMismatchError');
    }
    if (options?.create === true) {
      const node = new MemoryFileNode();
      this.children.set(name, node);
      return new MemoryFileHandle(name, this, node);
    }
    throw new DOMException('File not found', 'NotFoundError');
  }

  async removeEntry(name: string, options?: FileSystemRemoveOptions): Promise<void> {
    const existing = this.children.get(name);
    if (existing instanceof MemoryDirectoryHandle && options?.recursive !== true && existing.children.size > 0) {
      throw new DOMException('Directory is not empty', 'InvalidModificationError');
    }
    if (!this.children.delete(name)) {
      throw new DOMException('Entry not found', 'NotFoundError');
    }
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return this === other;
  }

  async resolve(possibleDescendant: FileSystemHandle): Promise<string[] | null> {
    for await (const [name, handle] of this.entries()) {
      if (await handle.isSameEntry(possibleDescendant)) {
        return [name];
      }
    }
    return null;
  }

  async *entries(): AsyncIterableIterator<[string, FileSystemHandle]> {
    for (const [name, child] of this.children) {
      if (child instanceof MemoryDirectoryHandle) {
        yield [name, child];
      } else {
        yield [name, new MemoryFileHandle(name, this, child)];
      }
    }
  }

  async *keys(): AsyncIterableIterator<string> {
    for (const key of this.children.keys()) {
      yield key;
    }
  }

  async *values(): AsyncIterableIterator<FileSystemHandle> {
    for await (const [, handle] of this.entries()) {
      yield handle;
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<[string, FileSystemHandle]> {
    return this.entries();
  }

  deleteChild(name: string): void {
    this.children.delete(name);
  }

  setChild(name: string, node: MemoryFileNode): void {
    this.children.set(name, node);
  }
}

class MemorySyncAccessHandle implements FileSystemSyncAccessHandle {
  constructor(private readonly node: MemoryFileNode) {}

  close(): void {}

  flush(): void {
    this.node.lastModified = Date.now();
  }

  getSize(): number {
    return this.node.data.byteLength;
  }

  read(buffer: BufferSource, options?: FileSystemReadWriteOptions): number {
    const target = bufferToUint8Array(buffer);
    const offset = options?.at ?? 0;
    const source = this.node.data.slice(offset, offset + target.byteLength);
    target.set(source);
    return source.byteLength;
  }

  truncate(newSize: number): void {
    this.node.data = this.node.data.slice(0, newSize);
    this.node.lastModified = Date.now();
  }

  write(buffer: BufferSource, options?: FileSystemReadWriteOptions): number {
    const source = bufferToUint8Array(buffer);
    const offset = options?.at ?? 0;
    const nextLength = Math.max(this.node.data.byteLength, offset + source.byteLength);
    const next = new Uint8Array(nextLength);
    next.set(this.node.data);
    next.set(source, offset);
    this.node.data = next;
    this.node.lastModified = Date.now();
    return source.byteLength;
  }
}

class MemoryWritableFileStream extends WritableStream implements FileSystemWritableFileStream {
  constructor(
    private readonly node: MemoryFileNode,
    keepExistingData: boolean,
  ) {
    super();
    if (!keepExistingData) {
      this.node.data = new Uint8Array();
    }
  }

  async seek(position: number): Promise<void> {
    if (position < 0) {
      throw new DOMException('Negative seek', 'InvalidStateError');
    }
  }

  async truncate(size: number): Promise<void> {
    this.node.data = this.node.data.slice(0, size);
    this.node.lastModified = Date.now();
  }

  async write(data: FileSystemWriteChunkType): Promise<void> {
    if (data instanceof Uint8Array) {
      this.node.data = new Uint8Array(data);
      this.node.lastModified = Date.now();
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.node.data = new Uint8Array(data.slice(0));
      this.node.lastModified = Date.now();
      return;
    }
    if (data instanceof Blob) {
      this.node.data = new Uint8Array(await data.arrayBuffer());
      this.node.lastModified = Date.now();
      return;
    }
    if (typeof data === 'string') {
      this.node.data = new TextEncoder().encode(data);
      this.node.lastModified = Date.now();
      return;
    }
    if (ArrayBuffer.isView(data)) {
      this.node.data = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
      this.node.lastModified = Date.now();
      return;
    }
    throw new DOMException('Unsupported write payload in OPFS test shim', 'NotSupportedError');
  }
}

function bufferToUint8Array(buffer: BufferSource): Uint8Array {
  if (buffer instanceof ArrayBuffer) {
    return new Uint8Array(buffer);
  }
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function installOpfs(root = new MemoryDirectoryHandle('')): void {
  const storage: StorageManager = {
    async estimate(): Promise<StorageEstimate> {
      return { quota: 1_000_000, usage: 123_456 };
    },
    async getDirectory(): Promise<FileSystemDirectoryHandle> {
      return root;
    },
    async persist(): Promise<boolean> {
      return true;
    },
    async persisted(): Promise<boolean> {
      return true;
    },
  };
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: storage,
  });
}

function installStorageWithoutEstimate(root = new MemoryDirectoryHandle('')): void {
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: {
      async getDirectory(): Promise<FileSystemDirectoryHandle> {
        return root;
      },
    },
  });
}

function removeStorage(): void {
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: undefined,
  });
}

function encodeUnsigned(value: number): Uint8Array {
  if (value < 24) {
    return Uint8Array.of(value);
  }
  if (value <= 0xff) {
    return Uint8Array.of(0x18, value);
  }
  if (value <= 0xffff) {
    return Uint8Array.of(0x19, value >> 8, value & 0xff);
  }
  if (value <= 0xffffffff) {
    return Uint8Array.of(
      0x1a,
      Math.floor(value / 0x1000000) & 0xff,
      Math.floor(value / 0x10000) & 0xff,
      Math.floor(value / 0x100) & 0xff,
      value & 0xff,
    );
  }
  let remaining = BigInt(value);
  const bytes = new Uint8Array(9);
  bytes[0] = 0x1b;
  for (let i = 8; i >= 1; i -= 1) {
    bytes[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function encodeSnapshotBody(lastUpdatedAtMs: number): Uint8Array {
  return concatBytes([Uint8Array.of(0xa1), encodeUnsigned(4), encodeUnsigned(lastUpdatedAtMs)]);
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function checksum(body: Uint8Array): Promise<Uint8Array> {
  await sodium.ready;
  return sodium.crypto_generichash(32, body);
}

async function snapshot(lastUpdatedAtMs: number): Promise<{
  readonly body: Uint8Array;
  readonly digest: Uint8Array;
}> {
  const body = encodeSnapshotBody(lastUpdatedAtMs);
  return { body, digest: await checksum(body) };
}

async function streamBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    chunks.push(result.value);
    total += result.value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function committedSnapshotHandle(jobId: JobId): Promise<MemoryFileHandle> {
  const root = await getStagingRoot();
  const jobDir = await root.getDirectoryHandle(jobId);
  const handle = await jobDir.getFileHandle('snapshot.cbor');
  if (!(handle instanceof MemoryFileHandle)) {
    throw new Error('Expected memory file handle');
  }
  return handle;
}

describe('opfs-staging', () => {
  beforeEach(async () => {
    if (typeof navigator.storage?.getDirectory === 'function') {
      for (const jobId of [JOB_A, JOB_B, JOB_C]) {
        try {
          await purgeJob(jobId);
        } catch {
          // Ignore cleanup failures between isolated in-memory OPFS roots.
        }
      }
    }
    installOpfs();
  });

  it('detects OPFS support and gracefully reports unsupported storage', async () => {
    await expect(isOpfsSupported()).resolves.toBe(true);

    vi.resetModules();
    removeStorage();
    const module = await import('../opfs-staging');
    await expect(module.isOpfsSupported()).resolves.toBe(false);
  });

  it('creates, lists, detects, and purges job directories', async () => {
    expect(await jobExists(JOB_A)).toBe(false);
    await createJobDir(JOB_A);
    await createJobDir(JOB_A);

    expect(await jobExists(JOB_A)).toBe(true);
    expect(await listJobs()).toEqual([JOB_A]);

    await purgeJob(JOB_A);
    expect(await jobExists(JOB_A)).toBe(false);
    expect(await listJobs()).toEqual([]);
  });

  it('writes photo chunks at exact offsets and preserves sparse zeroes', async () => {
    await createJobDir(JOB_A);
    await writePhotoChunk(JOB_A, PHOTO_A, 0, Uint8Array.of(1, 2, 3));
    await writePhotoChunk(JOB_A, PHOTO_A, 5, Uint8Array.of(9, 8));

    expect(await getPhotoFileLength(JOB_A, PHOTO_A)).toBe(7);
    await expect(streamBytes(await readPhotoStream(JOB_A, PHOTO_A))).resolves.toEqual(
      Uint8Array.of(1, 2, 3, 0, 0, 9, 8),
    );
  });

  it('streams the exact photo bytes that were staged', async () => {
    const bytes = new Uint8Array([5, 4, 3, 2, 1]);
    await createJobDir(JOB_A);
    await writePhotoChunk(JOB_A, PHOTO_A, 0, bytes);

    await expect(streamBytes(await readPhotoStream(JOB_A, PHOTO_A))).resolves.toEqual(bytes);
  });

  it('reports photo length precisely before and after writes', async () => {
    await createJobDir(JOB_A);
    expect(await getPhotoFileLength(JOB_A, PHOTO_A)).toBeNull();

    await writePhotoChunk(JOB_A, PHOTO_A, 0, Uint8Array.of(1, 2));
    expect(await getPhotoFileLength(JOB_A, PHOTO_A)).toBe(2);

    await writePhotoChunk(JOB_A, PHOTO_A, 2, Uint8Array.of(3));
    expect(await getPhotoFileLength(JOB_A, PHOTO_A)).toBe(3);
  });

  it('truncates a photo and subsequent reads stop at the truncation point', async () => {
    await createJobDir(JOB_A);
    await writePhotoChunk(JOB_A, PHOTO_A, 0, Uint8Array.of(1, 2, 3, 4, 5));
    await truncatePhotoTo(JOB_A, PHOTO_A, 3);

    expect(await getPhotoFileLength(JOB_A, PHOTO_A)).toBe(3);
    await expect(streamBytes(await readPhotoStream(JOB_A, PHOTO_A))).resolves.toEqual(
      Uint8Array.of(1, 2, 3),
    );
  });

  it('atomically commits snapshots and ignores stale temp files', async () => {
    const first = await snapshot(1_000);
    const second = await snapshot(2_000);
    await writeSnapshot(JOB_A, first.body, first.digest);
    await writeSnapshot(JOB_A, second.body, second.digest);

    const root = await getStagingRoot();
    const jobDir = await root.getDirectoryHandle(JOB_A);
    const temp = await jobDir.getFileHandle('snapshot.cbor.tmp', { create: true });
    const writable = await temp.createWritable();
    await writable.write(Uint8Array.of(0xff));
    await writable.close();

    await expect(readSnapshot(JOB_A)).resolves.toEqual({ body: second.body, checksum: second.digest });
  });

  it('throws a typed checksum error when the committed snapshot is corrupt', async () => {
    const good = await snapshot(1_000);
    await writeSnapshot(JOB_A, good.body, good.digest);
    const handle = await committedSnapshotHandle(JOB_A);
    const writable = await handle.createWritable();
    await writable.write(Uint8Array.of(0xa0));
    await writable.close();

    await expect(readSnapshot(JOB_A)).rejects.toMatchObject({
      code: OpfsStagingErrorCode.ChecksumMismatch,
    });
  });

  it('garbage-collects stale jobs, preserves requested jobs, and ages out corrupt snapshots', async () => {
    const old = await snapshot(1_700_000_001_000);
    const fresh = await snapshot(1_700_000_009_500);
    await writeSnapshot(JOB_A, old.body, old.digest);
    await writeSnapshot(JOB_B, fresh.body, fresh.digest);
    await createJobDir(JOB_C);

    const root = await getStagingRoot();
    const corruptJob = await root.getDirectoryHandle(JOB_C);
    const corruptFile = await corruptJob.getFileHandle('snapshot.cbor', { create: true });
    const writable = await corruptFile.createWritable();
    await writable.write(Uint8Array.of(0xa0));
    await writable.close();
    if (corruptFile instanceof MemoryFileHandle) {
      corruptFile.setLastModified(1_000);
    }

    await expect(
      gcStaleJobs({ nowMs: 1_700_000_010_000, maxAgeMs: 1_000, preserveJobIds: new Set([JOB_B]) }),
    ).resolves.toEqual({ purged: [JOB_A, JOB_C], preserved: [JOB_B] });
    expect(await listJobs()).toEqual([JOB_B]);
  });

  it('normalizes quota estimates and missing estimate support', async () => {
    await expect(quotaInfo()).resolves.toEqual({
      availableBytes: 876_544,
      totalBytes: 1_000_000,
      reported: true,
    });

    installStorageWithoutEstimate();
    await expect(quotaInfo()).resolves.toEqual({
      availableBytes: 0,
      totalBytes: 0,
      reported: false,
    });
  });

  it('rejects path traversal attempts instead of sanitizing them into OPFS paths', async () => {
    await expect(createJobDir('../etc')).rejects.toBeInstanceOf(OpfsStagingError);
    await expect(writePhotoChunk(JOB_A, '../photo', 0, Uint8Array.of(1))).rejects.toMatchObject({
      code: OpfsStagingErrorCode.IoError,
    });
  });

  it('reports precise file length for resume torn-file checks owned by Rust', async () => {
    await createJobDir(JOB_A);
    await writePhotoChunk(JOB_A, PHOTO_B, 0, Uint8Array.of(1, 2, 3, 4));
    const callerClaim = 5;

    expect(await getPhotoFileLength(JOB_A, PHOTO_B)).toBe(4);
    const actualLength = await getPhotoFileLength(JOB_A, PHOTO_B);
    expect(actualLength).not.toBeNull();
    expect(actualLength ?? 0).toBeLessThan(callerClaim);
  });
});