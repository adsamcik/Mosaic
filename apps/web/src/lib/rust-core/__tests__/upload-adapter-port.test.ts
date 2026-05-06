import { describe, expect, it, vi } from 'vitest';
import { RustCoreAdapterPortError, WasmUploadAdapterPort } from '../wasm-upload-adapter-port';
import type { WasmUploadAdapterBindings } from '../wasm-upload-adapter-port';

const initInput = {
  jobId: '018f0000-0000-7000-8000-000000000001',
  albumId: '018f0000-0000-7000-8000-000000000002',
  assetId: '018f0000-0000-7000-8000-000000000003',
  idempotencyKey: '018f0000-0000-7000-8000-000000000004',
  maxRetryCount: 3,
};

function bindings(): WasmUploadAdapterBindings {
  return {
    init: vi.fn(async () => undefined),
    initUploadJob: vi.fn(() =>
      JSON.stringify({
        code: 0,
        schemaVersion: 1,
        jobId: initInput.jobId,
        albumId: initInput.albumId,
        phase: 'Queued',
        shardRefCount: 0,
      }),
    ),
    advanceUploadJob: vi.fn(() =>
      JSON.stringify({
        code: 0,
        schemaVersion: 1,
        jobId: initInput.jobId,
        albumId: initInput.albumId,
        phase: 'AwaitingPreparedMedia',
        shardRefCount: 0,
      }),
    ),
    clientCoreStateMachineSnapshot: vi.fn(() => 'client-core-state-machines:v1'),
  };
}

describe('WasmUploadAdapterPort', () => {
  it('round-trips an init and start event through the WASM upload surface', async () => {
    const wasm = bindings();
    const port = new WasmUploadAdapterPort(wasm);

    const queued = await port.initJob(initInput);
    const advanced = await port.advanceJob(queued, {
      kind: 'StartRequested',
      effectId: '018f0000-0000-7000-8000-000000000005',
    });

    expect(queued).toMatchObject({
      schemaVersion: 1,
      jobId: initInput.jobId,
      albumId: initInput.albumId,
      phase: 'Queued',
      idempotencyKey: initInput.idempotencyKey,
      maxRetryCount: 3,
    });
    expect(advanced).toMatchObject({
      phase: 'AwaitingPreparedMedia',
      lastEffectId: '018f0000-0000-7000-8000-000000000005',
    });
    expect(wasm.advanceUploadJob).toHaveBeenCalledWith(
      initInput.jobId,
      initInput.albumId,
      initInput.idempotencyKey,
      'Queued',
      0,
      3,
      0n,
      false,
      0n,
      '',
      'StartRequested',
      '018f0000-0000-7000-8000-000000000005',
      0,
      0,
      '',
      new Uint8Array(),
      0n,
      0,
      '',
      0n,
      '',
      0n,
      0n,
      0n,
      false,
      0,
      '',
    );
  });

  it('propagates WASM upload error codes as typed port errors', async () => {
    const wasm = bindings();
    vi.mocked(wasm.advanceUploadJob).mockReturnValueOnce(
      JSON.stringify({
        code: 700,
        schemaVersion: 1,
        jobId: initInput.jobId,
        albumId: initInput.albumId,
        phase: 'Queued',
        shardRefCount: 0,
      }),
    );
    const port = new WasmUploadAdapterPort(wasm);
    const queued = await port.initJob(initInput);

    await expect(
      port.advanceJob(queued, {
        kind: 'NotARealEvent',
        effectId: '018f0000-0000-7000-8000-000000000006',
      }),
    ).rejects.toMatchObject({
      name: 'RustCoreAdapterPortError',
      operation: 'advanceUploadJob',
      code: 700,
    } satisfies Partial<RustCoreAdapterPortError>);
  });

  it('exposes no synthetic upload effects beyond the primitive WASM surface', async () => {
    const port = new WasmUploadAdapterPort(bindings());
    const snapshot = await port.initJob(initInput);

    expect(port.getCurrentEffect(snapshot)).toBeNull();
    await expect(port.finalizeJob(snapshot)).resolves.toBe(snapshot);
  });
});
