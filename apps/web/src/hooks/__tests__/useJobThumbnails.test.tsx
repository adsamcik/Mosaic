import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { useJobThumbnails, type UseJobThumbnailsResult } from '../useJobThumbnails';

const mocks = vi.hoisted(() => {
  const subscribeToThumbnails = vi.fn();
  const unsubscribe = vi.fn();
  let storedCb: ((p: string, u: string) => void) | null = null;
  subscribeToThumbnails.mockImplementation(async (_jobId: string, cb: (p: string, u: string) => void) => {
    storedCb = cb;
    return { unsubscribe };
  });
  return {
    subscribeToThumbnails,
    unsubscribe,
    emit: (p: string, u: string): void => { storedCb?.(p, u); },
    reset: (): void => {
      storedCb = null;
      subscribeToThumbnails.mockClear();
      unsubscribe.mockClear();
    },
  };
});

vi.mock('../../lib/download-manager', () => ({
  getDownloadManager: vi.fn(async () => ({
    subscribeToThumbnails: mocks.subscribeToThumbnails,
  })),
}));

// Comlink.proxy is identity for our purposes here.
vi.mock('comlink', () => ({
  proxy: <T,>(x: T): T => x,
}));

interface Captured { current: UseJobThumbnailsResult | null }

function Probe({ jobId, captured }: { readonly jobId: string | null; readonly captured: Captured }): JSX.Element {
  const result = useJobThumbnails(jobId);
  useEffect(() => { captured.current = result; });
  return <div />;
}

async function renderProbe(jobId: string | null): Promise<{ captured: Captured; cleanup: () => Promise<void> }> {
  const captured: Captured = { current: null };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Probe jobId={jobId} captured={captured} />);
    await Promise.resolve(); await Promise.resolve();
  });
  return {
    captured,
    cleanup: async (): Promise<void> => {
      await act(async () => { root.unmount(); await Promise.resolve(); });
      container.remove();
    },
  };
}

beforeEach(() => { mocks.reset(); });
afterEach(() => { document.body.replaceChildren(); });

describe('useJobThumbnails', () => {
  it('subscribes and yields thumbnails most-recent first', async () => {
    const { captured, cleanup } = await renderProbe('job-1');
    expect(mocks.subscribeToThumbnails).toHaveBeenCalledTimes(1);
    await act(async () => {
      mocks.emit('photo-A', 'blob:url-1');
      mocks.emit('photo-B', 'blob:url-2');
      await Promise.resolve();
    });
    expect(captured.current?.thumbnails.map((t) => t.photoId)).toEqual(['photo-B', 'photo-A']);
    await cleanup();
  });

  it('caps the ring buffer to 100 entries', async () => {
    const { captured, cleanup } = await renderProbe('job-2');
    await act(async () => {
      for (let i = 0; i < 150; i += 1) mocks.emit(`photo-${i}`, `blob:u${i}`);
      await Promise.resolve();
    });
    expect((captured.current?.thumbnails.length ?? 0)).toBeLessThanOrEqual(100);
    await cleanup();
  });

  it('unsubscribes on unmount', async () => {
    const { cleanup } = await renderProbe('job-3');
    await cleanup();
    expect(mocks.unsubscribe).toHaveBeenCalled();
  });

  it('returns empty thumbnails and does not subscribe when jobId is null', async () => {
    const { captured, cleanup } = await renderProbe(null);
    expect(mocks.subscribeToThumbnails).not.toHaveBeenCalled();
    expect(captured.current?.thumbnails).toEqual([]);
    await cleanup();
  });

  it('replaces an earlier thumbnail when the same photoId emits again', async () => {
    const { captured, cleanup } = await renderProbe('job-R');
    await act(async () => {
      mocks.emit('photo-X', 'blob:v1');
      mocks.emit('photo-Y', 'blob:y');
      mocks.emit('photo-X', 'blob:v2');
      await Promise.resolve();
    });
    const ids = captured.current?.thumbnails.map((t) => t.photoId) ?? [];
    expect(ids[0]).toBe('photo-X');
    expect(ids.filter((p) => p === 'photo-X')).toHaveLength(1);
    expect(captured.current?.thumbnails[0]?.blobUrl).toBe('blob:v2');
    await cleanup();
  });
});
