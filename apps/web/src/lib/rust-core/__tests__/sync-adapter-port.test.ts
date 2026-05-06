import { describe, expect, it, vi } from 'vitest';
import { RustCoreAdapterPortError, WasmSyncAdapterPort } from '../wasm-upload-adapter-port';
import type { WasmSyncAdapterBindings } from '../wasm-upload-adapter-port';

const initInput = {
  albumId: '018f0000-0000-7000-8000-000000000102',
  requestId: '018f0000-0000-7000-8000-000000000103',
  startCursor: '',
  nowUnixMs: 0n,
  maxRetryCount: 4,
};

function bindings(): WasmSyncAdapterBindings {
  return {
    init: vi.fn(async () => undefined),
    initAlbumSync: vi.fn(() =>
      JSON.stringify({
        code: 0,
        schemaVersion: 1,
        albumId: initInput.albumId,
        phase: 'Idle',
        rerunRequested: false,
      }),
    ),
    advanceAlbumSync: vi.fn(() =>
      JSON.stringify({
        code: 0,
        schemaVersion: 1,
        albumId: initInput.albumId,
        phase: 'FetchingPage',
        rerunRequested: false,
      }),
    ),
    clientCoreStateMachineSnapshot: vi.fn(() => 'client-core-state-machines:v1'),
  };
}

describe('WasmSyncAdapterPort', () => {
  it('round-trips an init and start event through the WASM sync surface', async () => {
    const wasm = bindings();
    const port = new WasmSyncAdapterPort(wasm);

    const idle = await port.initSync(initInput);
    const fetching = await port.advanceSync(idle, {
      kind: 'SyncRequested',
      nextCursor: 'cursor-a',
    });

    expect(idle).toMatchObject({
      schemaVersion: 1,
      albumId: initInput.albumId,
      phase: 'Idle',
      activeCursor: '',
      maxRetryCount: 4,
    });
    expect(fetching).toMatchObject({
      phase: 'FetchingPage',
      rerunRequested: false,
    });
    expect(wasm.advanceAlbumSync).toHaveBeenCalledWith(
      initInput.albumId,
      'Idle',
      '',
      '',
      false,
      0,
      4,
      0n,
      0,
      '',
      0n,
      'SyncRequested',
      '',
      'cursor-a',
      0,
      0n,
      0,
    );
  });

  it('propagates WASM sync error codes as typed port errors', async () => {
    const wasm = bindings();
    vi.mocked(wasm.advanceAlbumSync).mockReturnValueOnce(
      JSON.stringify({
        code: 703,
        schemaVersion: 1,
        albumId: initInput.albumId,
        phase: 'Idle',
        rerunRequested: false,
      }),
    );
    const port = new WasmSyncAdapterPort(wasm);
    const idle = await port.initSync(initInput);

    await expect(
      port.advanceSync(idle, { kind: 'PageFetched' }),
    ).rejects.toMatchObject({
      name: 'RustCoreAdapterPortError',
      operation: 'advanceAlbumSync',
      code: 703,
    } satisfies Partial<RustCoreAdapterPortError>);
  });

  it('exposes no synthetic sync effects beyond the primitive WASM surface', async () => {
    const port = new WasmSyncAdapterPort(bindings());
    const snapshot = await port.initSync(initInput);

    expect(port.getCurrentEffect(snapshot)).toBeNull();
  });
});
