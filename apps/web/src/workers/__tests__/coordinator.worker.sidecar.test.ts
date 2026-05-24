import { describe, expect, it, vi } from 'vitest';
import {
  pipelineMocks,
  broadcastState,
  nowMs,
  validInput,
  makeComlinkMock,
  makeLoggerMock,
  makeOpfsStagingMock,
  rustMocks,
  cryptoPoolMocks,
  registerCoordinatorHooks,
} from './coordinator.worker.test-shared';

vi.mock('comlink', () => makeComlinkMock());
vi.mock('../../lib/logger', () => makeLoggerMock());
vi.mock('../rust-crypto-core', () => rustMocks);
vi.mock('../crypto-pool', () => cryptoPoolMocks);
vi.mock('../coordinator/photo-pipeline', () => pipelineMocks);
vi.mock('../../lib/opfs-staging', () => makeOpfsStagingMock());

import { CoordinatorWorker, __coordinatorWorkerTestUtils as cbor } from '../coordinator.worker';
import * as opfsStaging from '../../lib/opfs-staging';

registerCoordinatorHooks(cbor);
describe('sidecar output mode', () => {
  interface StubPeer {
    sessionId: string;
    send: ReturnType<typeof vi.fn<(bytes: Uint8Array, filename: string, photoIdx: number) => Promise<void>>>;
    endPhoto: ReturnType<typeof vi.fn<(photoIdx: number) => Promise<void>>>;
    close: ReturnType<typeof vi.fn<(reason: 'success' | 'aborted' | 'failed') => Promise<void>>>;
    onDisconnect: (h: (reason: string) => void) => () => void;
    fireDisconnect: (reason: string) => void;
  }
  function makeStubPeer(): StubPeer {
    const handlers = new Set<(reason: string) => void>();
    return {
      sessionId: 'stub',
      send: vi.fn<(bytes: Uint8Array, filename: string, photoIdx: number) => Promise<void>>(
        async (): Promise<void> => undefined,
      ),
      endPhoto: vi.fn<(photoIdx: number) => Promise<void>>(async (): Promise<void> => undefined),
      close: vi.fn<(reason: 'success' | 'aborted' | 'failed') => Promise<void>>(
        async (): Promise<void> => undefined,
      ),
      onDisconnect: (h: (reason: string) => void): (() => void) => {
        handlers.add(h);
        return () => handlers.delete(h);
      },
      fireDisconnect: (reason: string): void => {
        for (const h of handlers) h(reason);
      },
    };
  }

  it('streams finalized bytes through peerHandle.send + endPhoto', async () => {
    // Make the OPFS read return some bytes for the photo.
    const mocked = opfsStaging as unknown as { readPhotoStream: ReturnType<typeof vi.fn> };
    mocked.readPhotoStream.mockImplementation(async () => new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.close();
      },
    }));
    const peer = makeStubPeer();
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const { jobId } = await worker.startJob({
      ...validInput(),
      outputMode: { kind: 'sidecar', peerHandle: peer, fallback: 'zip' },
    });
    await cbor.awaitScheduledDriver(worker, jobId);
    expect(peer.send).toHaveBeenCalledTimes(1);
    const sendCall = peer.send.mock.calls[0] as unknown as [Uint8Array, string, number];
    expect(Array.from(sendCall[0])).toEqual([1, 2, 3, 4]);
    expect(sendCall[1]).toBe('image-1.jpg');
    expect(sendCall[2]).toBe(0);
    expect(peer.endPhoto).toHaveBeenCalledWith(0);
    // Finalizer closes the session cleanly on success.
    expect(peer.close).toHaveBeenCalledWith('success');
  });


  it('prefers peerHandle.sendStream when available (streaming path)', async () => {
    // 100 MB synthetic photo split into 1 MB upstream chunks. The handle's
    // sendStream must observe the stream lazily and the legacy buffered
    // send() must NOT be called.
    const totalChunks = 100;
    const chunkSize = 1024 * 1024;
    let pulls = 0;
    const mocked = opfsStaging as unknown as { readPhotoStream: ReturnType<typeof vi.fn> };
    mocked.readPhotoStream.mockImplementation(async () => new ReadableStream<Uint8Array>({
      pull(controller): void {
        if (pulls < totalChunks) {
          controller.enqueue(new Uint8Array(chunkSize));
          pulls += 1;
        } else {
          controller.close();
        }
      },
    }));
    const sendStream = vi.fn(async (s: ReadableStream<Uint8Array>): Promise<void> => {
      // Drain the stream to mimic the real transport.
      const reader = s.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    });
    const peer = { ...makeStubPeer(), sendStream };
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const { jobId } = await worker.startJob({
      ...validInput(),
      outputMode: { kind: 'sidecar', peerHandle: peer, fallback: 'zip' },
    });
    await cbor.awaitScheduledDriver(worker, jobId);
    expect(sendStream).toHaveBeenCalledTimes(1);
    expect(peer.send).not.toHaveBeenCalled();
    expect(peer.endPhoto).toHaveBeenCalledWith(0);
  });

  it('falls back to zip finalizer when peer disconnects mid-job', async () => {
    const zipFinalizer = vi.fn(async () => undefined);
    cbor.setRunZipFinalizer(zipFinalizer as unknown as Parameters<typeof cbor.setRunZipFinalizer>[0]);
    const provider = {
      openZipSaveTarget: vi.fn(async () => ({
        write: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
      })),
      openPerFileSaveTarget: vi.fn(),
    };
    // Block the photo task until we explicitly resolve, so we have a window
    // to fire the disconnect before AllPhotosDone.
    let resolvePhoto: ((v: { kind: 'done'; bytesWritten: number }) => void) | null = null;
    pipelineMocks.executePhotoTask.mockImplementation(() => new Promise((resolve) => {
      resolvePhoto = resolve;
    }));
    const peer = makeStubPeer();
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    await worker.setSaveTargetProvider(provider);
    const startPromise = worker.startJob({
      ...validInput(),
      outputMode: { kind: 'sidecar', peerHandle: peer, fallback: 'zip' },
    });
    const { jobId } = await startPromise;
    // Wait briefly for the driver to invoke executePhotoTask before firing the drop.
    await vi.waitFor(() => expect(pipelineMocks.executePhotoTask).toHaveBeenCalled());
    peer.fireDisconnect('ice-failed');
    (resolvePhoto as ((v: { kind: 'done'; bytesWritten: number }) => void) | null)?.({ kind: 'done', bytesWritten: 4 });
    await cbor.awaitScheduledDriver(worker, jobId);
    // Sidecar push must NOT have been called (mode swapped before the photo
    // outcome was observed) and the zip finalizer ran instead.
    expect(zipFinalizer).toHaveBeenCalledTimes(1);
    expect(peer.send).not.toHaveBeenCalled();
  });


  it('does not broadcast sidecar job state changes to sibling tabs', async () => {
    // Spy on the cross-tab BroadcastChannel by creating a sibling worker.
    // Sidecar jobs MUST NOT cause job-changed messages to reach siblings -
    // the peer handle is per-tab and siblings cannot act on it. We assert
    // by counting messages received on a sibling worker's broadcast inbox.
    const peer = makeStubPeer();
    const workerA = new CoordinatorWorker();
    const workerB = new CoordinatorWorker();
    await workerA.initialize({ nowMs });
    await workerB.initialize({ nowMs });
    const received: string[] = [];
    const channel = [...broadcastState.channels].reverse().find((ch) => ch.name === 'mosaic-download-jobs');
    if (!channel) throw new Error('expected mosaic-download-jobs channel');
    channel.listeners.add((ev) => {
      const data = ev.data as { kind?: string; jobId?: string };
      if (data?.kind === 'job-changed' && data.jobId) received.push(data.jobId);
    });
    const { jobId } = await workerA.startJob({
      ...validInput(),
      outputMode: { kind: 'sidecar', peerHandle: peer, fallback: 'zip' },
    });
    await cbor.awaitScheduledDriver(workerA, jobId);
    expect(received).not.toContain(jobId);
  });

  it('still broadcasts non-sidecar job state changes (control case)', async () => {
    const workerA = new CoordinatorWorker();
    const workerB = new CoordinatorWorker();
    await workerA.initialize({ nowMs });
    await workerB.initialize({ nowMs });
    const received: string[] = [];
    const channel = [...broadcastState.channels].reverse().find((ch) => ch.name === 'mosaic-download-jobs');
    if (!channel) throw new Error('expected mosaic-download-jobs channel');
    channel.listeners.add((ev) => {
      const data = ev.data as { kind?: string; jobId?: string };
      if (data?.kind === 'job-changed' && data.jobId) received.push(data.jobId);
    });
    const { jobId } = await workerA.startJob({ ...validInput() });
    await cbor.awaitScheduledDriver(workerA, jobId);
    expect(received).toContain(jobId);
  });

  it('does not persist sidecar outputMode across reconstruction', async () => {
    // The outputMode map is in-memory only; verify by starting a sidecar
    // job, then constructing a new worker over the same OPFS state.
    const peer = makeStubPeer();
    const worker = new CoordinatorWorker();
    await worker.initialize({ nowMs });
    const { jobId } = await worker.startJob({
      ...validInput(),
      outputMode: { kind: 'sidecar', peerHandle: peer, fallback: 'zip' },
    });
    await cbor.awaitScheduledDriver(worker, jobId);
    // New worker over the same persisted snapshots -> the sidecar peerHandle
    // is unreachable, and no SidecarPeerHandle reference can survive the restart.
    const worker2 = new CoordinatorWorker();
    await worker2.initialize({ nowMs });
    // listResumableJobs is empty here because the job already finalized; the
    // important property we are asserting is that no error was thrown
    // attempting to restore the sidecar peerHandle (which is impossible).
    const list = await worker2.listResumableJobs();
    expect(Array.isArray(list)).toBe(true);
  });
});
