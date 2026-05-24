import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStorageQuota, type UseStorageQuotaResult } from '../useStorageQuota';

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    startTimer: vi.fn(),
    child: vi.fn(),
    scope: 'useStorageQuota',
  }),
}));

interface RenderedHook {
  readonly result: () => UseStorageQuotaResult;
  readonly unmount: () => Promise<void>;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const mounted: RenderedHook[] = [];

interface RenderOptions {
  readonly threshold?: number;
  readonly disabled?: boolean;
}

async function renderHook(options: RenderOptions = {}): Promise<RenderedHook> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  let current: UseStorageQuotaResult | null = null;
  let isMounted = true;

  function TestComponent(): null {
    current = useStorageQuota({
      threshold: options.threshold,
      disabled: options.disabled,
      pollIntervalMs: 10_000_000, // effectively disable polling for tests
    });
    return null;
  }

  await act(async () => {
    root.render(createElement(TestComponent));
    await flushMicrotasks();
  });

  const hook: RenderedHook = {
    result: () => {
      if (!current) throw new Error('Hook not rendered');
      return current;
    },
    unmount: async () => {
      if (!isMounted) return;
      isMounted = false;
      await act(async () => {
        root.unmount();
        await flushMicrotasks();
      });
      container.remove();
    },
  };
  mounted.push(hook);
  return hook;
}

interface StorageMock {
  estimate: ReturnType<typeof vi.fn>;
}

function installStorage(mock: StorageMock): void {
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: mock,
  });
}

function clearStorage(): void {
  Reflect.deleteProperty(navigator, 'storage');
}

describe('useStorageQuota', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    clearStorage();
  });

  afterEach(async () => {
    for (const h of mounted.splice(0)) await h.unmount();
    clearStorage();
    vi.restoreAllMocks();
  });

  it('reports unsupported when navigator.storage.estimate is missing', async () => {
    const hook = await renderHook();
    await act(async () => { await flushMicrotasks(); });
    const r = hook.result();
    expect(r.snapshot?.supported).toBe(false);
    expect(r.underPressure).toBe(false);
    expect(r.critical).toBe(false);
  });

  it('does not flag pressure below the threshold', async () => {
    installStorage({
      estimate: vi.fn().mockResolvedValue({ usage: 100, quota: 1000 }),
    });
    const hook = await renderHook();
    await act(async () => { await flushMicrotasks(); });
    const r = hook.result();
    expect(r.snapshot?.supported).toBe(true);
    expect(r.snapshot?.usageRatio).toBeCloseTo(0.1);
    expect(r.underPressure).toBe(false);
  });

  it('flags pressure at 80% usage with default threshold', async () => {
    installStorage({
      estimate: vi.fn().mockResolvedValue({ usage: 800, quota: 1000 }),
    });
    const hook = await renderHook();
    await act(async () => { await flushMicrotasks(); });
    expect(hook.result().underPressure).toBe(true);
  });

  it('flags critical at 95% usage', async () => {
    installStorage({
      estimate: vi.fn().mockResolvedValue({ usage: 950, quota: 1000 }),
    });
    const hook = await renderHook();
    await act(async () => { await flushMicrotasks(); });
    const r = hook.result();
    expect(r.underPressure).toBe(true);
    expect(r.critical).toBe(true);
  });

  it('respects a custom threshold', async () => {
    installStorage({
      estimate: vi.fn().mockResolvedValue({ usage: 600, quota: 1000 }),
    });
    const hook = await renderHook({ threshold: 0.5 });
    await act(async () => { await flushMicrotasks(); });
    expect(hook.result().underPressure).toBe(true);
  });

  it('dismiss() hides pressure for the session', async () => {
    installStorage({
      estimate: vi.fn().mockResolvedValue({ usage: 900, quota: 1000 }),
    });
    const hook = await renderHook();
    await act(async () => { await flushMicrotasks(); });
    expect(hook.result().underPressure).toBe(true);

    await act(async () => {
      hook.result().dismiss();
      await flushMicrotasks();
    });

    expect(hook.result().dismissedThisSession).toBe(true);
    expect(hook.result().underPressure).toBe(false);
    expect(window.sessionStorage.getItem('mosaic.storage-pressure.dismissed')).toBe('1');
  });

  it('persisted dismiss flag is honoured on mount', async () => {
    window.sessionStorage.setItem('mosaic.storage-pressure.dismissed', '1');
    installStorage({
      estimate: vi.fn().mockResolvedValue({ usage: 900, quota: 1000 }),
    });
    const hook = await renderHook();
    await act(async () => { await flushMicrotasks(); });
    expect(hook.result().dismissedThisSession).toBe(true);
    expect(hook.result().underPressure).toBe(false);
  });

  it('disabled=true short-circuits without probing', async () => {
    const estimate = vi.fn().mockResolvedValue({ usage: 900, quota: 1000 });
    installStorage({ estimate });
    const hook = await renderHook({ disabled: true });
    await act(async () => { await flushMicrotasks(); });
    expect(estimate).not.toHaveBeenCalled();
    expect(hook.result().snapshot).toBeNull();
    expect(hook.result().underPressure).toBe(false);
  });

  it('survives a thrown estimate()', async () => {
    installStorage({
      estimate: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const hook = await renderHook();
    await act(async () => { await flushMicrotasks(); });
    const r = hook.result();
    expect(r.snapshot?.supported).toBe(true);
    expect(r.snapshot?.usageRatio).toBeNaN();
    expect(r.underPressure).toBe(false);
  });
});
