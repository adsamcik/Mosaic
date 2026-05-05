import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoordinatorWorkerApi, DownloadPhase, JobProgressEvent, JobSummary, ResumableJobSummary } from '../../workers/types';
import { useDownloadManager, type UseDownloadManagerResult } from '../useDownloadManager';

const managerMocks = vi.hoisted(() => ({
  getDownloadManager: vi.fn<() => Promise<CoordinatorWorkerApi>>(),
}));

vi.mock('../../lib/download-manager', () => managerMocks);
vi.mock('../useDownloadScopeKey', () => ({
  useDownloadScopeKey: () => 'auth:00000000000000000000000000000000',
}));
vi.mock('comlink', () => ({ proxy: (value: unknown): unknown => value }));
vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    startTimer: () => ({ end: vi.fn(), elapsed: () => 0 }),
    child: vi.fn(),
    scope: 'useDownloadManager',
  }),
}));

interface RenderedHook {
  readonly result: () => UseDownloadManagerResult;
  readonly unmount: () => Promise<void>;
}

interface MockChannelRecord {
  readonly name: string;
  readonly listeners: Set<(event: MessageEvent<unknown>) => void>;
  closed: boolean;
}

const channels: MockChannelRecord[] = [];
const mountedHooks: RenderedHook[] = [];
let jobs: JobSummary[] = [];
let resumableJobs: ResumableJobSummary[] = [];
const subscribers = new Map<string, Set<(event: JobProgressEvent) => void>>();

const baseJob: JobSummary = {
  jobId: '11111111111111111111111111111111',
  albumId: '018f0000-0000-7000-8000-000000000002',
  phase: 'Preparing',
  photoCounts: { pending: 1, inflight: 0, done: 0, failed: 0, skipped: 0 },
  failureCount: 0,
  createdAtMs: 1,
  lastUpdatedAtMs: 1,
  scopeKey: 'auth:00000000000000000000000000000000',
  lastErrorReason: null,
};

function phaseResult(phase: DownloadPhase): Promise<{ phase: DownloadPhase }> {
  return Promise.resolve({ phase });
}

const api: CoordinatorWorkerApi = {
  initialize: vi.fn(async () => ({ reconstructedJobs: 0 })),
  startJob: vi.fn(async () => ({ jobId: baseJob.jobId })),
  sendEvent: vi.fn(() => phaseResult('Running')),
  pauseJob: vi.fn(() => phaseResult('Paused')),
  resumeJob: vi.fn(() => phaseResult('Running')),
  rebindJobSource: vi.fn(async () => undefined),
  cancelJob: vi.fn(() => phaseResult('Cancelled')),
  listJobs: vi.fn(async () => jobs),
  listResumableJobs: vi.fn(async () => resumableJobs),
  computeAlbumDiff: vi.fn(async () => ({ removed: [], added: [], rekeyed: [], unchanged: [], shardChanged: [] })),
  getJob: vi.fn(async (jobId: string) => jobs.find((job) => job.jobId === jobId) ?? null),
  subscribe: vi.fn(async (jobId: string, callback: (event: JobProgressEvent) => void) => {
    let callbacks = subscribers.get(jobId);
    if (!callbacks) {
      callbacks = new Set();
      subscribers.set(jobId, callbacks);
    }
    callbacks.add(callback);
    return {
      unsubscribe: (): void => {
        callbacks?.delete(callback);
      },
    };
  }),
  gc: vi.fn(async () => ({ purged: [] })),
  setSaveTargetProvider: vi.fn(async () => undefined),
};

class MockBroadcastChannel {
  private readonly record: MockChannelRecord;

  constructor(name: string) {
    this.record = { name, listeners: new Set(), closed: false };
    channels.push(this.record);
  }

  addEventListener(type: string, listener: (event: MessageEvent<unknown>) => void): void {
    if (type === 'message') {
      this.record.listeners.add(listener);
    }
  }

  removeEventListener(type: string, listener: (event: MessageEvent<unknown>) => void): void {
    if (type === 'message') {
      this.record.listeners.delete(listener);
    }
  }

  postMessage(data: unknown): void {
    emitBroadcast(data);
  }

  close(): void {
    this.record.closed = true;
    this.record.listeners.clear();
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function renderHook(): Promise<RenderedHook> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  let currentResult: UseDownloadManagerResult | null = null;
  let mounted = true;

  function TestComponent(): null {
    currentResult = useDownloadManager();
    return null;
  }

  await act(async () => {
    root.render(createElement(TestComponent));
    await flushMicrotasks();
  });

  const rendered: RenderedHook = {
    result: (): UseDownloadManagerResult => {
      if (!currentResult) {
        throw new Error('Hook result is not available');
      }
      return currentResult;
    },
    unmount: async (): Promise<void> => {
      if (!mounted) return;
      mounted = false;
      await act(async () => {
        root.unmount();
        await flushMicrotasks();
      });
      container.remove();
    },
  };
  mountedHooks.push(rendered);
  return rendered;
}

function emitBroadcast(data: unknown): void {
  for (const channel of channels) {
    if (!channel.closed) {
      for (const listener of channel.listeners) {
        listener(new MessageEvent('message', { data }));
      }
    }
  }
}

async function emitProgress(job: JobSummary): Promise<void> {
  jobs = [job];
  const callbacks = subscribers.get(job.jobId);
  if (!callbacks) return;
  await act(async () => {
    for (const callback of callbacks) {
      callback({
        jobId: job.jobId,
        phase: job.phase,
        photoCounts: job.photoCounts,
        failureCount: job.failureCount,
        lastUpdatedAtMs: job.lastUpdatedAtMs,
      });
    }
    await flushMicrotasks();
  });
}

beforeEach(() => {
  jobs = [];
  resumableJobs = [];
  subscribers.clear();
  channels.length = 0;
  managerMocks.getDownloadManager.mockReset();
  managerMocks.getDownloadManager.mockResolvedValue(api);
  Object.defineProperty(globalThis, 'BroadcastChannel', {
    configurable: true,
    value: MockBroadcastChannel,
  });
});

afterEach(async () => {
  for (const mountedHook of mountedHooks.splice(0)) {
    await mountedHook.unmount();
  }
  vi.clearAllMocks();
});

describe('useDownloadManager', () => {
  it('renders and flips ready after worker initialization', async () => {
    const hook = await renderHook();
    expect(hook.result().ready).toBe(true);
    expect(hook.result().api).toBe(api);
    expect(hook.result().error).toBeNull();
  });

  it('updates jobs when a job is added via the API', async () => {
    const hook = await renderHook();
    jobs = [baseJob];
    await act(async () => {
      emitBroadcast({ kind: 'job-changed', jobId: baseJob.jobId, phase: 'Preparing', lastUpdatedAtMs: 1, scopeKey: 'auth:00000000000000000000000000000000' });
      await flushMicrotasks();
    });
    expect(hook.result().jobs).toEqual([baseJob]);
  });

  it('subscribe(jobId) triggers a re-render on progress', async () => {
    jobs = [baseJob];
    const hook = await renderHook();
    const cleanup = hook.result().subscribe(baseJob.jobId);
    const running: JobSummary = { ...baseJob, phase: 'Running', lastUpdatedAtMs: 2 };
    await emitProgress(running);
    expect(hook.result().jobs).toEqual([running]);
    cleanup();
  });

  it('BroadcastChannel messages from another tab update jobs', async () => {
    const hook = await renderHook();
    const running: JobSummary = { ...baseJob, phase: 'Running', lastUpdatedAtMs: 2 };
    jobs = [running];
    await act(async () => {
      emitBroadcast({ kind: 'job-changed', jobId: running.jobId, phase: 'Running', lastUpdatedAtMs: 2, scopeKey: 'auth:00000000000000000000000000000000' });
      await flushMicrotasks();
    });
    expect(hook.result().jobs).toEqual([running]);
  });


  it('updates resumableJobs when download broadcasts arrive', async () => {
    const hook = await renderHook();
    const resumable: ResumableJobSummary = {
      ...baseJob,
      phase: 'Paused',
      photoCounts: { pending: 1, inflight: 0, done: 1, failed: 0, skipped: 0 },
      photosDone: 1,
      photosTotal: 2,
      bytesWritten: 123,
      pausedNoSource: false,
      lastUpdatedAtMs: 2,
    };
    resumableJobs = [resumable];
    await act(async () => {
      emitBroadcast({ kind: 'job-changed', jobId: resumable.jobId, phase: 'Paused', lastUpdatedAtMs: 2, scopeKey: 'auth:00000000000000000000000000000000' });
      await flushMicrotasks();
    });
    expect(hook.result().resumableJobs).toEqual([resumable]);
  });

  it('delegates job actions through the coordinator and refreshes job lists', async () => {
    jobs = [baseJob];
    const hook = await renderHook();
    let result: { phase: DownloadPhase } | null = null;
    await act(async () => {
      result = await hook.result().pauseJob(baseJob.jobId);
      await flushMicrotasks();
    });
    expect(result).toEqual({ phase: 'Paused' });
    expect(api.pauseJob).toHaveBeenCalledWith(baseJob.jobId);
    expect(api.listJobs).toHaveBeenCalledTimes(2);
    expect(api.listResumableJobs).toHaveBeenCalledTimes(2);
  });

});

