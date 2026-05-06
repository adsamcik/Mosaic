import { describe, expect, it, vi } from 'vitest';
import { InMemoryUploadSnapshotPersistence, RustUploadAdapter } from '../upload-adapter';
import type {
  UploadAdapterPort,
  UploadEffect,
  UploadEvent,
  UploadInitInput,
  UploadJobSnapshot,
} from '../upload-adapter-port';

const initInput: UploadInitInput = {
  jobId: '018f0000-0000-7000-8000-000000000201',
  albumId: '018f0000-0000-7000-8000-000000000202',
  assetId: '018f0000-0000-7000-8000-000000000203',
  idempotencyKey: '018f0000-0000-7000-8000-000000000204',
  maxRetryCount: 3,
};

function snapshot(phase: string, lastEffectId = ''): UploadJobSnapshot {
  return {
    schemaVersion: 1,
    jobId: initInput.jobId,
    albumId: initInput.albumId,
    phase,
    shardRefCount: 0,
    idempotencyKey: initInput.idempotencyKey,
    retryCount: 0,
    maxRetryCount: initInput.maxRetryCount,
    nextRetryNotBeforeMs: 0n,
    hasNextRetryNotBeforeMs: false,
    snapshotRevision: 0n,
    lastEffectId,
  };
}

class FakeUploadPort implements UploadAdapterPort {
  readonly initJob = vi.fn(async (_input: UploadInitInput): Promise<UploadJobSnapshot> => snapshot('Queued'));
  readonly advanceJob = vi.fn(async (_snapshot: UploadJobSnapshot, event: UploadEvent): Promise<UploadJobSnapshot> =>
    snapshot('AwaitingPreparedMedia', event.effectId));
  readonly getCurrentEffect = vi.fn((current: UploadJobSnapshot): UploadEffect | null =>
    current.lastEffectId.length > 0 ? { kind: 'PrepareMedia', effectId: current.lastEffectId } : null);
  readonly finalizeJob = vi.fn(async (current: UploadJobSnapshot): Promise<UploadJobSnapshot> => current);
}

class FailingUploadPersistence extends InMemoryUploadSnapshotPersistence {
  override async put(_current: UploadJobSnapshot): Promise<void> {
    throw new Error('upload persistence failed');
  }
}

describe('RustUploadAdapter', () => {
  it('start() persists initial snapshot', async () => {
    const port = new FakeUploadPort();
    const persistence = new InMemoryUploadSnapshotPersistence();
    const adapter = new RustUploadAdapter(port, persistence);

    const result = await adapter.start(initInput);

    await expect(persistence.get(initInput.jobId)).resolves.toEqual(result.snapshot);
    expect(result.effects).toEqual([]);
    expect(port.initJob).toHaveBeenCalledWith(initInput);
  });

  it('submit() advances state and emits effect', async () => {
    const port = new FakeUploadPort();
    const adapter = new RustUploadAdapter(port, new InMemoryUploadSnapshotPersistence());
    await adapter.start(initInput);

    const result = await adapter.submit({
      kind: 'StartRequested',
      effectId: '018f0000-0000-7000-8000-000000000205',
    });

    expect(result.snapshot.phase).toBe('AwaitingPreparedMedia');
    expect(result.effects).toEqual([
      { kind: 'PrepareMedia', effectId: '018f0000-0000-7000-8000-000000000205' },
    ]);
    expect(port.advanceJob).toHaveBeenCalledOnce();
  });

  it('resume() loads from persistence', async () => {
    const port = new FakeUploadPort();
    const persistence = new InMemoryUploadSnapshotPersistence();
    const resumed = snapshot('RetryWaiting', '018f0000-0000-7000-8000-000000000206');
    await persistence.put(resumed);
    const adapter = new RustUploadAdapter(port, persistence);

    const result = await adapter.resume(initInput.jobId);

    expect(result).not.toBeNull();
    if (result === null) throw new Error('expected resumed snapshot');
    expect(result.snapshot).toEqual(resumed);
    expect(result.effects).toEqual([
      { kind: 'PrepareMedia', effectId: '018f0000-0000-7000-8000-000000000206' },
    ]);
  });

  it('resume() returns null when persistence has no snapshot', async () => {
    const adapter = new RustUploadAdapter(new FakeUploadPort(), new InMemoryUploadSnapshotPersistence());

    await expect(adapter.resume(initInput.jobId)).resolves.toBeNull();
    await expect(adapter.submit({
      kind: 'StartRequested',
      effectId: '018f0000-0000-7000-8000-000000000207',
    })).rejects.toThrow('Adapter not started');
  });

  it('submit() fails when adapter not started', async () => {
    const adapter = new RustUploadAdapter(new FakeUploadPort(), new InMemoryUploadSnapshotPersistence());

    await expect(adapter.submit({
      kind: 'StartRequested',
      effectId: '018f0000-0000-7000-8000-000000000207',
    })).rejects.toThrow('Adapter not started');
  });

  it('persistence write failure surfaces correctly', async () => {
    const adapter = new RustUploadAdapter(new FakeUploadPort(), new FailingUploadPersistence());

    await expect(adapter.start(initInput)).rejects.toThrow('upload persistence failed');
  });
});
