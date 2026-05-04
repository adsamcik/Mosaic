import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('comlink', () => ({ expose: vi.fn(), proxy: <T>(value: T): T => value }));
vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    startTimer: () => ({ end: vi.fn(), elapsed: () => 0 }),
    child: vi.fn(),
    scope: 'test',
  }),
}));

import { readSnapshot } from '../../lib/opfs-staging';
import { CoordinatorWorker, __coordinatorWorkerTestUtils as cbor } from '../coordinator.worker';
import { rustLoadDownloadSnapshot, rustVerifyDownloadSnapshot } from '../rust-crypto-core';
import type { DownloadPhase, StartJobInput } from '../types';

class MemoryFileNode {
  data = new Uint8Array();
  lastModified = Date.now();
}

class MemoryWritableFileStream implements FileSystemWritableFileStream {
  locked = false;

  constructor(
    private readonly node: MemoryFileNode,
    keepExistingData: boolean,
  ) {
    if (!keepExistingData) {
      this.node.data = new Uint8Array();
    }
  }

  async write(data: BufferSource | Blob | string | WriteParams): Promise<void> {
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      this.node.data = toUint8Array(data);
      this.node.lastModified = Date.now();
      return;
    }
    if (isWriteParams(data)) {
      if (data.type === 'truncate') {
        await this.truncate(data.size ?? 0);
        return;
      }
      if (data.type === 'write') {
        const payload = data.data;
        if (!(payload instanceof ArrayBuffer) && !ArrayBuffer.isView(payload)) {
          return;
        }
        const bytes = toUint8Array(payload);
        const position = data.position ?? 0;
        const next = new Uint8Array(Math.max(this.node.data.byteLength, position + bytes.byteLength));
        next.set(this.node.data);
        next.set(bytes, position);
        this.node.data = next;
        this.node.lastModified = Date.now();
      }
    }
  }

  async seek(_position: number): Promise<void> {}

  async truncate(size: number): Promise<void> {
    this.node.data = this.node.data.slice(0, size);
    this.node.lastModified = Date.now();
  }

  async close(): Promise<void> {}

  abort(): Promise<void> {
    return Promise.resolve();
  }

  getWriter(): WritableStreamDefaultWriter<unknown> {
    throw new Error('not implemented');
  }
}

class MemoryFileHandle implements FileSystemFileHandle {
  readonly kind = 'file';

  constructor(
    public name: string,
    private parent: MemoryDirectoryHandle,
    private readonly node: MemoryFileNode,
  ) {}

  async createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle> {
    throw new DOMException('Sync access handles are not implemented by this test shim', 'NotSupportedError');
  }

  async createWritable(options?: FileSystemCreateWritableOptions): Promise<FileSystemWritableFileStream> {
    return new MemoryWritableFileStream(this.node, options?.keepExistingData === true) as FileSystemWritableFileStream;
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
}

class MemoryDirectoryHandle implements FileSystemDirectoryHandle {
  readonly kind = 'directory';
  private readonly children = new Map<string, MemoryDirectoryHandle | MemoryFileNode>();

  constructor(public readonly name: string) {}

  async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions): Promise<FileSystemDirectoryHandle> {
    const existing = this.children.get(name);
    if (existing instanceof MemoryDirectoryHandle) {
      return existing;
    }
    if (existing !== undefined) {
      throw new DOMException('A file exists at this path', 'TypeMismatchError');
    }
    if (options?.create === true) {
      const directory = new MemoryDirectoryHandle(name);
      this.children.set(name, directory);
      return directory;
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

  async removeEntry(name: string, _options?: FileSystemRemoveOptions): Promise<void> {
    if (!this.children.delete(name)) {
      throw new DOMException('Entry not found', 'NotFoundError');
    }
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return this === other;
  }

  async resolve(_possibleDescendant: FileSystemHandle): Promise<string[] | null> {
    return null;
  }

  async *entries(): AsyncIterableIterator<[string, FileSystemHandle]> {
    for (const [name, child] of this.children) {
      yield [name, child instanceof MemoryDirectoryHandle ? child : new MemoryFileHandle(name, this, child)];
    }
  }

  deleteChild(name: string): void {
    this.children.delete(name);
  }

  setChild(name: string, node: MemoryFileNode): void {
    this.children.set(name, node);
  }
}

const nowMs = 1_700_000_000_000;
const laterMs = nowMs + 12_345;

function validInput(): StartJobInput {
  return {
    albumId: '018f0000-0000-7000-8000-000000000002',
    photos: [
      {
        photoId: 'photo-1',
        filename: 'IMG_001.jpg',
        shards: [
          {
            shardId: new Uint8Array([
              0x01, 0x8f, 0x00, 0x00, 0x00, 0x00, 0x70, 0x00,
              0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03,
            ]),
            epochId: 7,
            tier: 3,
            expectedHash: new Uint8Array(32).fill(0x44),
            declaredSize: 1234,
          },
        ],
      },
    ],
  };
}

function isWriteParams(data: BufferSource | Blob | string | WriteParams): data is WriteParams {
  return typeof data === 'object' && data !== null && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)
    && !(data instanceof Blob) && 'type' in data;
}

function toUint8Array(data: BufferSource): Uint8Array<ArrayBuffer> {
  const view = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const out = new Uint8Array(view.byteLength);
  out.set(view);
  return out;
}

function requiredMapValue(value: ReturnType<typeof cbor.parseCbor>, key: number): ReturnType<typeof cbor.parseCbor> {
  if (value.kind !== 'map') {
    throw new Error('expected CBOR map');
  }
  const entry = value.value.find((candidate) => candidate.key.kind === 'uint' && candidate.key.value === key);
  if (!entry) {
    throw new Error(`missing CBOR key ${String(key)}`);
  }
  return entry.value;
}

function uintValue(value: ReturnType<typeof cbor.parseCbor>): number {
  if (value.kind !== 'uint') {
    throw new Error('expected CBOR uint');
  }
  return value.value;
}

function snapshotPhase(snapshotBytes: Uint8Array): DownloadPhase {
  const state = requiredMapValue(cbor.parseCbor(snapshotBytes), 5);
  const phaseCode = uintValue(requiredMapValue(state, 0));
  const phase = Object.entries(cbor.phaseCodeByPhase).find(([, code]) => code === phaseCode)?.[0];
  if (phase === undefined) {
    throw new Error('unknown phase code');
  }
  return phase as DownloadPhase;
}

function snapshotLastUpdatedAtMs(snapshotBytes: Uint8Array): number {
  return uintValue(requiredMapValue(cbor.parseCbor(snapshotBytes), 4));
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('coordinator Rust snapshot round-trip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const root = new MemoryDirectoryHandle('root');
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn(async () => root),
        estimate: vi.fn(async () => ({ quota: 1_000_000, usage: 0 })),
      },
    });
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL): Promise<ArrayBuffer> => {
      if (String(input).endsWith('mosaic_wasm_bg.wasm')) {
        const bytes = await readFile(join(process.cwd(), 'src/generated/mosaic-wasm/mosaic_wasm_bg.wasm'));
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
      throw new Error(`unexpected fetch ${String(input)}`);
    });
  });

  it('keeps TS-patched snapshot CBOR valid for Rust verify and load', async () => {
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });

    const { jobId } = await worker.startJob(validInput());
    const initialSnapshot = await readSnapshot(jobId);
    if (initialSnapshot === null) {
      throw new Error('expected initial snapshot');
    }
    const initialLastUpdatedAtMs = snapshotLastUpdatedAtMs(initialSnapshot.body);
    vi.setSystemTime(laterMs);

    await worker.sendEvent(jobId, { kind: 'PlanReady' });
    const persisted = await readSnapshot(jobId);
    if (persisted === null) {
      throw new Error('expected persisted snapshot');
    }

    await expect(rustVerifyDownloadSnapshot(persisted.body, persisted.checksum)).resolves.toEqual({ valid: true });
    const loaded = await rustLoadDownloadSnapshot(persisted.body, persisted.checksum);
    expect(snapshotPhase(loaded.snapshotBytes)).toBe('Running');
    expect(snapshotLastUpdatedAtMs(loaded.snapshotBytes)).toBe(laterMs);
    expect(snapshotLastUpdatedAtMs(loaded.snapshotBytes)).not.toBe(initialLastUpdatedAtMs);
  });
});
