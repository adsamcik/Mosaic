import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWakeLockMock, type MockWakeLock } from '../../../tests/helpers/wake-lock-mock';
import { useWakeLock, type UseWakeLockResult } from '../useWakeLock';

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    startTimer: vi.fn(),
    child: vi.fn(),
    scope: 'useWakeLock',
  }),
}));

interface RenderedWakeLockHook {
  readonly result: () => UseWakeLockResult;
  readonly unmount: () => Promise<void>;
}

function setVisibilityState(visibilityState: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: visibilityState,
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}

const mountedHooks: RenderedWakeLockHook[] = [];

async function renderWakeLockHook(): Promise<RenderedWakeLockHook> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  let currentResult: UseWakeLockResult | null = null;
  let mounted = true;

  function TestComponent(): null {
    currentResult = useWakeLock();
    return null;
  }

  await act(async () => {
    root.render(createElement(TestComponent));
  });

  const renderedHook: RenderedWakeLockHook = {
    result: (): UseWakeLockResult => {
      if (!currentResult) {
        throw new Error('Hook result is not available');
      }
      return currentResult;
    },
    unmount: async (): Promise<void> => {
      if (!mounted) {
        return;
      }
      mounted = false;
      await act(async () => {
        root.unmount();
        await flushMicrotasks();
      });
      container.remove();
    },
  };
  mountedHooks.push(renderedHook);
  return renderedHook;
}

describe('useWakeLock', () => {
  let wakeLockMock: MockWakeLock | null = null;

  beforeEach(() => {
    setVisibilityState('visible');
    Reflect.deleteProperty(navigator, 'wakeLock');
  });

  afterEach(async () => {
    for (const mountedHook of mountedHooks.splice(0)) {
      await mountedHook.unmount();
    }
    wakeLockMock?.uninstall();
    wakeLockMock = null;
    vi.restoreAllMocks();
    setVisibilityState('visible');
  });

  it('resolves acquire without throwing when wake lock is unsupported', async () => {
    const hook = await renderWakeLockHook();

    await act(async () => {
      await hook.result().acquire();
    });

    expect(hook.result().state.supported).toBe(false);
    expect(hook.result().state.active).toBe(false);

    await hook.unmount();
  });

  it('acquires a screen wake lock when supported', async () => {
    wakeLockMock = createWakeLockMock();
    wakeLockMock.install();
    const hook = await renderWakeLockHook();

    await act(async () => {
      await hook.result().acquire();
    });

    expect(hook.result().state.active).toBe(true);
    expect(wakeLockMock.requestCount).toBe(1);
    expect(wakeLockMock.activeCount).toBe(1);

    await hook.unmount();
  });

  it('releases the current wake lock manually', async () => {
    wakeLockMock = createWakeLockMock();
    wakeLockMock.install();
    const hook = await renderWakeLockHook();

    await act(async () => {
      await hook.result().acquire();
      await hook.result().release();
    });

    expect(wakeLockMock.activeCount).toBe(0);
    expect(hook.result().state.active).toBe(false);
    expect(hook.result().state.lastReleaseReason).toBe('manual');

    await hook.unmount();
  });

  it('re-acquires after a hidden to visible transition when previously active', async () => {
    wakeLockMock = createWakeLockMock();
    wakeLockMock.install();
    const hook = await renderWakeLockHook();

    await act(async () => {
      await hook.result().acquire();
    });

    await act(async () => {
      setVisibilityState('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      await flushMicrotasks();
    });

    expect(hook.result().state.active).toBe(false);
    expect(hook.result().state.lastReleaseReason).toBe('visibility-hidden');

    await act(async () => {
      setVisibilityState('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await flushMicrotasks();
    });

    expect(wakeLockMock.requestCount).toBe(2);
    expect(hook.result().state.active).toBe(true);

    await hook.unmount();
  });

  it('does not acquire after a visibility transition when not previously active', async () => {
    wakeLockMock = createWakeLockMock();
    wakeLockMock.install();
    const hook = await renderWakeLockHook();

    await act(async () => {
      setVisibilityState('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      setVisibilityState('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await flushMicrotasks();
    });

    expect(wakeLockMock.requestCount).toBe(0);
    expect(hook.result().state.active).toBe(false);

    await hook.unmount();
  });

  it('records browser revoke without re-acquiring', async () => {
    wakeLockMock = createWakeLockMock();
    wakeLockMock.install();
    const hook = await renderWakeLockHook();

    await act(async () => {
      await hook.result().acquire();
    });

    await act(async () => {
      wakeLockMock?.emitRevoke();
      await flushMicrotasks();
    });

    expect(hook.result().state.active).toBe(false);
    expect(hook.result().state.lastReleaseReason).toBe('browser');

    await act(async () => {
      setVisibilityState('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      setVisibilityState('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await flushMicrotasks();
    });

    expect(wakeLockMock.requestCount).toBe(1);

    await hook.unmount();
  });

  it('does not request a second wake lock when already active', async () => {
    wakeLockMock = createWakeLockMock();
    wakeLockMock.install();
    const hook = await renderWakeLockHook();

    await act(async () => {
      await hook.result().acquire();
      await hook.result().acquire();
    });

    expect(wakeLockMock.requestCount).toBe(1);
    expect(wakeLockMock.activeCount).toBe(1);

    await hook.unmount();
  });

  it('releases the wake lock and removes visibility listeners on unmount', async () => {
    wakeLockMock = createWakeLockMock();
    wakeLockMock.install();
    const hook = await renderWakeLockHook();

    await act(async () => {
      await hook.result().acquire();
    });

    await hook.unmount();

    expect(wakeLockMock.activeCount).toBe(0);

    await act(async () => {
      setVisibilityState('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      setVisibilityState('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await flushMicrotasks();
    });

    expect(wakeLockMock.requestCount).toBe(1);
  });

  it('stores acquire failures without throwing', async () => {
    const deniedError = new Error('NotAllowedError');
    const failingWakeLock: WakeLock = {
      request: vi.fn<WakeLock['request']>().mockRejectedValue(deniedError),
    };
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: failingWakeLock,
    });
    const hook = await renderWakeLockHook();

    await act(async () => {
      await hook.result().acquire();
      await flushMicrotasks();
    });

    expect(failingWakeLock.request).toHaveBeenCalledTimes(1);

    expect(hook.result().state.active).toBe(false);
    expect(hook.result().state.lastError).toBe(deniedError);

    await hook.unmount();
  });
});
