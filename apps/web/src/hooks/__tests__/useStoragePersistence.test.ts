import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStoragePersistence, type StoragePersistenceState } from '../useStoragePersistence';

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    startTimer: vi.fn(),
    child: vi.fn(),
    scope: 'useStoragePersistence',
  }),
}));

interface RenderedHook {
  readonly result: () => StoragePersistenceState;
  readonly unmount: () => Promise<void>;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const mounted: RenderedHook[] = [];

async function renderHook(): Promise<RenderedHook> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  let current: StoragePersistenceState | null = null;
  let isMounted = true;

  function TestComponent(): null {
    current = useStoragePersistence();
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
  persist: ReturnType<typeof vi.fn>;
  persisted: ReturnType<typeof vi.fn>;
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

describe('useStoragePersistence', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    clearStorage();
  });

  afterEach(async () => {
    for (const h of mounted.splice(0)) await h.unmount();
    clearStorage();
    vi.restoreAllMocks();
  });

  it('reports unsupported when navigator.storage is missing', async () => {
    const hook = await renderHook();
    await act(async () => { await flushMicrotasks(); });
    expect(hook.result().supported).toBe(false);
    expect(hook.result().persisted).toBeNull();
    const result = await hook.result().request();
    expect(result).toBe(false);
    expect(hook.result().persisted).toBeNull();
  });

  it('reports persisted=true when storage is already promoted', async () => {
    const storage: StorageMock = {
      persist: vi.fn().mockResolvedValue(true),
      persisted: vi.fn().mockResolvedValue(true),
    };
    installStorage(storage);
    const hook = await renderHook();
    await act(async () => { await flushMicrotasks(); });
    expect(hook.result().supported).toBe(true);
    expect(hook.result().persisted).toBe(true);
    expect(storage.persisted).toHaveBeenCalledTimes(1);
  });

  it('updates persisted state after a successful request', async () => {
    const storage: StorageMock = {
      persist: vi.fn().mockResolvedValue(true),
      persisted: vi.fn().mockResolvedValue(false),
    };
    installStorage(storage);
    const hook = await renderHook();
    await act(async () => { await flushMicrotasks(); });
    expect(hook.result().persisted).toBe(false);
    await act(async () => {
      const r = await hook.result().request();
      expect(r).toBe(true);
    });
    expect(hook.result().persisted).toBe(true);
    expect(storage.persist).toHaveBeenCalledTimes(1);
  });

  it('keeps persisted=false when request returns false', async () => {
    const storage: StorageMock = {
      persist: vi.fn().mockResolvedValue(false),
      persisted: vi.fn().mockResolvedValue(false),
    };
    installStorage(storage);
    const hook = await renderHook();
    await act(async () => { await flushMicrotasks(); });
    await act(async () => {
      const r = await hook.result().request();
      expect(r).toBe(false);
    });
    expect(hook.result().persisted).toBe(false);
  });

  it('catches request rejections and resolves to false', async () => {
    const storage: StorageMock = {
      persist: vi.fn().mockRejectedValue(new Error('SecurityError')),
      persisted: vi.fn().mockResolvedValue(false),
    };
    installStorage(storage);
    const hook = await renderHook();
    await act(async () => { await flushMicrotasks(); });
    await act(async () => {
      const r = await hook.result().request();
      expect(r).toBe(false);
    });
    expect(hook.result().persisted).toBe(false);
  });

  it('persists session dismissal in sessionStorage', async () => {
    const storage: StorageMock = {
      persist: vi.fn().mockResolvedValue(false),
      persisted: vi.fn().mockResolvedValue(false),
    };
    installStorage(storage);
    const hook = await renderHook();
    await act(async () => { await flushMicrotasks(); });
    expect(hook.result().dismissedThisSession).toBe(false);
    await act(async () => { hook.result().dismiss(); });
    expect(hook.result().dismissedThisSession).toBe(true);
    expect(window.sessionStorage.getItem('mosaic.persistence-prompt.dismissed')).toBe('1');
    expect(window.localStorage.getItem('mosaic.persistence-prompt.never-ask')).toBeNull();
  });

  it('persists forever-dismissal in localStorage', async () => {
    const storage: StorageMock = {
      persist: vi.fn().mockResolvedValue(false),
      persisted: vi.fn().mockResolvedValue(false),
    };
    installStorage(storage);
    const hook = await renderHook();
    await act(async () => { await flushMicrotasks(); });
    await act(async () => { hook.result().dismissForever(); });
    expect(hook.result().dismissedForever).toBe(true);
    expect(window.localStorage.getItem('mosaic.persistence-prompt.never-ask')).toBe('1');
  });

  it('reads pre-existing dismissal flags on mount', async () => {
    window.sessionStorage.setItem('mosaic.persistence-prompt.dismissed', '1');
    window.localStorage.setItem('mosaic.persistence-prompt.never-ask', '1');
    const storage: StorageMock = {
      persist: vi.fn().mockResolvedValue(false),
      persisted: vi.fn().mockResolvedValue(false),
    };
    installStorage(storage);
    const hook = await renderHook();
    await act(async () => { await flushMicrotasks(); });
    expect(hook.result().dismissedThisSession).toBe(true);
    expect(hook.result().dismissedForever).toBe(true);
  });

  it('falls back gracefully when persisted() rejects', async () => {
    const storage: StorageMock = {
      persist: vi.fn().mockResolvedValue(false),
      persisted: vi.fn().mockRejectedValue(new Error('boom')),
    };
    installStorage(storage);
    const hook = await renderHook();
    await act(async () => { await flushMicrotasks(); });
    expect(hook.result().supported).toBe(true);
    expect(hook.result().persisted).toBe(false);
  });
});
