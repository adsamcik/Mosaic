import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoordinatorWorkerApi, DownloadPhase } from '../../workers/types';

const comlinkMocks = vi.hoisted(() => ({
  wrap: vi.fn(),
  releaseProxy: Symbol('releaseProxy'),
}));
const releaseProxy = comlinkMocks.releaseProxy;

vi.mock('comlink', () => comlinkMocks);
vi.mock('../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    startTimer: () => ({ end: vi.fn(), elapsed: () => 0 }),
    child: vi.fn(),
    scope: 'DownloadManager',
  }),
}));

const terminateMock = vi.fn();
let workerConstructCount = 0;

class MockWorker {
  onerror: ((event: ErrorEvent) => void) | null = null;

  constructor(_url: URL, _options: WorkerOptions) {
    workerConstructCount += 1;
  }

  terminate(): void {
    terminateMock();
  }
}

function phaseResult(phase: DownloadPhase): Promise<{ phase: DownloadPhase }> {
  return Promise.resolve({ phase });
}

function createApi(): CoordinatorWorkerApi & { [releaseProxy]: () => void } {
  return {
    initialize: vi.fn(async () => ({ reconstructedJobs: 0 })),
    startJob: vi.fn(async () => ({ jobId: '11111111111111111111111111111111' })),
    sendEvent: vi.fn(() => phaseResult('Running')),
    pauseJob: vi.fn(() => phaseResult('Paused')),
    resumeJob: vi.fn(() => phaseResult('Running')),
    rebindJobSource: vi.fn(async () => undefined),
    cancelJob: vi.fn(() => phaseResult('Cancelled')),
    listJobs: vi.fn(async () => []),
    listResumableJobs: vi.fn(async () => []),
    computeAlbumDiff: vi.fn(async () => ({ removed: [], added: [], rekeyed: [], unchanged: [], shardChanged: [] })),
    getJob: vi.fn(async () => null),
    subscribe: vi.fn(async () => ({ unsubscribe: vi.fn() })),
    gc: vi.fn(async () => ({ purged: [] })),
    setSaveTargetProvider: vi.fn(async () => undefined),
    forceStartJob: vi.fn(async () => undefined),
    updateJobSchedule: vi.fn(async () => undefined),
  subscribeToThumbnails: vi.fn(async () => ({ unsubscribe: vi.fn() })),
    [releaseProxy]: vi.fn(),
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  terminateMock.mockClear();
  workerConstructCount = 0;
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    value: MockWorker,
  });
});

describe('download-manager', () => {
  it('lazily creates one worker and returns the same instance', async () => {
    const api = createApi();
    comlinkMocks.wrap.mockReturnValue(api);
    const { getDownloadManager } = await import('../download-manager');

    const first = await getDownloadManager();
    const second = await getDownloadManager();

    expect(first).toBe(api);
    expect(second).toBe(api);
    expect(workerConstructCount).toBe(1);
    expect(api.initialize).toHaveBeenCalledTimes(1);
  });

  it('dispose tears down so the next call creates a fresh worker', async () => {
    const firstApi = createApi();
    const secondApi = createApi();
    comlinkMocks.wrap.mockReturnValueOnce(firstApi).mockReturnValueOnce(secondApi);
    const { disposeDownloadManager, getDownloadManager } = await import('../download-manager');

    await expect(getDownloadManager()).resolves.toBe(firstApi);
    await disposeDownloadManager();
    await expect(getDownloadManager()).resolves.toBe(secondApi);

    expect(firstApi[releaseProxy]).toHaveBeenCalledTimes(1);
    expect(terminateMock).toHaveBeenCalledTimes(1);
    expect(workerConstructCount).toBe(2);
  });


  it('exposes resumable-job and album-diff helper functions', async () => {
    const api = createApi();
    comlinkMocks.wrap.mockReturnValue(api);
    const { computeAlbumDiff, listResumableJobs } = await import('../download-manager');

    await expect(listResumableJobs()).resolves.toEqual([]);
    await expect(computeAlbumDiff('job', { albumId: 'album', photos: [] })).resolves.toEqual({
      removed: [],
      added: [],
      rekeyed: [],
      unchanged: [],
      shardChanged: [],
    });

    expect(api.listResumableJobs).toHaveBeenCalledTimes(1);
    expect(api.computeAlbumDiff).toHaveBeenCalledWith('job', { albumId: 'album', photos: [] });
  });
});
