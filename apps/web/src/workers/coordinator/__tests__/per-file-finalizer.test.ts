import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runPerFileFinalizer, type PerFileFinalizerDeps, type PerFileSaveSink } from '../per-file-finalizer';
import type { PerFileStrategy } from '../../types';

const loggerMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock('../../../lib/logger', () => ({
  createLogger: () => ({
    warn: loggerMocks.warn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const entries = [
  { photoId: 'photo-01', filename: 'one.jpg' },
  { photoId: 'photo-02', filename: 'two.jpg' },
  { photoId: 'photo-03', filename: 'three.jpg' },
] as const;

function streamOf(bytes: readonly number[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

function makeDeps(strategyCalls: PerFileStrategy[] = []): { deps: PerFileFinalizerDeps; sink: PerFileSaveSink } {
  const sink: PerFileSaveSink = {
    writeOne: vi.fn(async () => undefined),
    finalize: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
  };
  const deps: PerFileFinalizerDeps = {
    readPhotoStream: vi.fn(async () => streamOf([1, 2, 3])),
    getPhotoFileLength: vi.fn(async () => 3),
    openPerFileSaveTarget: vi.fn(async (strategy) => {
      strategyCalls.push(strategy);
      return sink;
    }),
  };
  return { deps, sink };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runPerFileFinalizer', () => {
  it('exports all photos then finalizes for Web Share', async () => {
    const strategies: PerFileStrategy[] = [];
    const { deps, sink } = makeDeps(strategies);
    await runPerFileFinalizer({ jobId: 'job-1', entries }, 'webShare', deps, new AbortController().signal);
    expect(deps.openPerFileSaveTarget).toHaveBeenCalledTimes(1);
    expect(strategies).toEqual(['webShare']);
    expect(sink.writeOne).toHaveBeenCalledTimes(3);
    expect(sink.finalize).toHaveBeenCalledTimes(1);
  });

  it.each<PerFileStrategy>(['fsAccessPerFile', 'blobAnchor'])('exports all photos for %s', async (strategy) => {
    const { deps, sink } = makeDeps();
    await runPerFileFinalizer({ jobId: 'job-1', entries }, strategy, deps, new AbortController().signal);
    expect(sink.writeOne).toHaveBeenCalledTimes(3);
    expect(sink.finalize).toHaveBeenCalledTimes(1);
  });

  it('continues when one photo fails and logs a zk-safe warning', async () => {
    const { deps, sink } = makeDeps();
    vi.mocked(sink.writeOne)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('cancelled'))
      .mockResolvedValueOnce(undefined);
    await runPerFileFinalizer({ jobId: 'job-1', entries }, 'fsAccessPerFile', deps, new AbortController().signal);
    expect(sink.writeOne).toHaveBeenCalledTimes(3);
    expect(sink.finalize).toHaveBeenCalledTimes(1);
    expect(loggerMocks.warn).toHaveBeenCalledWith('Per-file photo export failed', expect.objectContaining({
      jobId: 'job-1',
      photoId: 'photo-02',
      strategy: 'fsAccessPerFile',
      errorName: 'Error',
    }));
  });

  it('aborts mid-flight and skips remaining photos', async () => {
    const controller = new AbortController();
    const { deps, sink } = makeDeps();
    vi.mocked(sink.writeOne).mockImplementationOnce(async () => {
      controller.abort();
    });
    await expect(runPerFileFinalizer({ jobId: 'job-1', entries }, 'blobAnchor', deps, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(sink.writeOne).toHaveBeenCalledTimes(1);
    expect(sink.abort).toHaveBeenCalledTimes(1);
    expect(sink.finalize).not.toHaveBeenCalled();
  });

  it('is a no-op for an empty plan', async () => {
    const { deps, sink } = makeDeps();
    await runPerFileFinalizer({ jobId: 'job-1', entries: [] }, 'webShare', deps, new AbortController().signal);
    expect(deps.openPerFileSaveTarget).not.toHaveBeenCalled();
    expect(sink.writeOne).not.toHaveBeenCalled();
  });
});

