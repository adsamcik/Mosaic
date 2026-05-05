import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../generated/mosaic-wasm/mosaic_wasm.js', () => {
  const init = vi.fn().mockResolvedValue(undefined);
  return {
    default: init,
    openStreamingShardV1: vi.fn(),
    streamingShardProcessChunkV1: vi.fn(),
    streamingShardCloseV1: vi.fn(),
  };
});

import * as wasmStub from '../../generated/mosaic-wasm/mosaic_wasm.js';
import { rustOpenStreamingShard } from '../rust-crypto-core';
import { WorkerCryptoError, WorkerCryptoErrorCode } from '../types';

interface OpenResultStub {
  code: number;
  handleId: number;
  chunkSizeBytes: number;
  free: ReturnType<typeof vi.fn>;
}
interface ChunkResultStub {
  code: number;
  plaintext: Uint8Array;
  free: ReturnType<typeof vi.fn>;
}

function openOk(handleId = 7, chunkSizeBytes = 64 * 1024): OpenResultStub {
  return { code: 0, handleId, chunkSizeBytes, free: vi.fn() };
}
function openErr(code: number): OpenResultStub {
  return { code, handleId: 0, chunkSizeBytes: 0, free: vi.fn() };
}
function chunkOk(plaintext: Uint8Array): ChunkResultStub {
  return { code: 0, plaintext, free: vi.fn() };
}
function chunkErr(code: number): ChunkResultStub {
  return { code, plaintext: new Uint8Array(), free: vi.fn() };
}

const stub = wasmStub as unknown as {
  openStreamingShardV1: ReturnType<typeof vi.fn>;
  streamingShardProcessChunkV1: ReturnType<typeof vi.fn>;
  streamingShardCloseV1: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  stub.streamingShardCloseV1.mockReturnValue(0);
});

describe('rustOpenStreamingShard', () => {
  it('opens a decryptor and exposes chunkSizeBytes from the Rust handle', async () => {
    const opened = openOk(11, 128 * 1024);
    stub.openStreamingShardV1.mockReturnValue(opened);

    const decryptor = await rustOpenStreamingShard(new Uint8Array(64), new Uint8Array(32));

    expect(decryptor.chunkSizeBytes).toBe(128 * 1024);
    expect(stub.openStreamingShardV1).toHaveBeenCalledTimes(1);
    expect(opened.free).toHaveBeenCalledTimes(1);
  });

  it('translates a non-zero open code into WorkerCryptoError', async () => {
    stub.openStreamingShardV1.mockReturnValue(openErr(200));
    await expect(
      rustOpenStreamingShard(new Uint8Array(64), new Uint8Array(32)),
    ).rejects.toBeInstanceOf(WorkerCryptoError);
  });

  it('processChunk forwards plaintext and forgets the handle on isFinal=true', async () => {
    stub.openStreamingShardV1.mockReturnValue(openOk(42));
    stub.streamingShardProcessChunkV1.mockReturnValue(chunkOk(new Uint8Array([7, 8, 9])));

    const decryptor = await rustOpenStreamingShard(new Uint8Array(64), new Uint8Array(32));

    const out = await decryptor.processChunk(new Uint8Array([1, 2, 3]), true);
    expect([...out]).toEqual([7, 8, 9]);
    const args = stub.streamingShardProcessChunkV1.mock.calls[0] as [number, Uint8Array, boolean];
    expect(args[0]).toBe(42);
    expect(args[2]).toBe(true);

    await decryptor.close();
    expect(stub.streamingShardCloseV1).not.toHaveBeenCalled();
  });

  it('processChunk on a non-final chunk keeps the handle alive for subsequent chunks', async () => {
    stub.openStreamingShardV1.mockReturnValue(openOk(42));
    stub.streamingShardProcessChunkV1.mockReturnValue(chunkOk(new Uint8Array([1])));

    const decryptor = await rustOpenStreamingShard(new Uint8Array(64), new Uint8Array(32));
    await decryptor.processChunk(new Uint8Array([0]), false);
    await decryptor.processChunk(new Uint8Array([0]), false);
    expect(stub.streamingShardProcessChunkV1).toHaveBeenCalledTimes(2);

    await decryptor.close();
    expect(stub.streamingShardCloseV1).toHaveBeenCalledTimes(1);
    expect(stub.streamingShardCloseV1).toHaveBeenCalledWith(42);
  });

  it('clears the handle on processChunk error so close() is a no-op', async () => {
    stub.openStreamingShardV1.mockReturnValue(openOk(42));
    stub.streamingShardProcessChunkV1.mockReturnValueOnce(chunkErr(208));

    const decryptor = await rustOpenStreamingShard(new Uint8Array(64), new Uint8Array(32));
    await expect(
      decryptor.processChunk(new Uint8Array([0]), false),
    ).rejects.toBeInstanceOf(WorkerCryptoError);

    await decryptor.close();
    expect(stub.streamingShardCloseV1).not.toHaveBeenCalled();
  });

  it('close() is idempotent — second call is a no-op', async () => {
    stub.openStreamingShardV1.mockReturnValue(openOk(42));
    const decryptor = await rustOpenStreamingShard(new Uint8Array(64), new Uint8Array(32));

    await decryptor.close();
    await decryptor.close();
    expect(stub.streamingShardCloseV1).toHaveBeenCalledTimes(1);
  });

  it('processChunk after close throws StaleHandle', async () => {
    stub.openStreamingShardV1.mockReturnValue(openOk(42));
    const decryptor = await rustOpenStreamingShard(new Uint8Array(64), new Uint8Array(32));
    await decryptor.close();
    await expect(
      decryptor.processChunk(new Uint8Array([0]), true),
    ).rejects.toMatchObject({ code: WorkerCryptoErrorCode.StaleHandle });
  });

  it('tolerates a non-zero close code without throwing (best-effort cleanup)', async () => {
    stub.openStreamingShardV1.mockReturnValue(openOk(42));
    stub.streamingShardCloseV1.mockReturnValue(500);
    const decryptor = await rustOpenStreamingShard(new Uint8Array(64), new Uint8Array(32));
    await expect(decryptor.close()).resolves.toBeUndefined();
  });
});
