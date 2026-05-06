import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __setBackgroundFetchTestEnv,
  useBackgroundFetch,
  type UseBackgroundFetchResult,
} from '../useBackgroundFetch';

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    startTimer: () => ({ end: vi.fn(), elapsed: () => 0 }),
    child: vi.fn(), scope: 'test',
  }),
}));

interface FakeServiceWorker {
  addEventListener(t: string, l: (e: MessageEvent<unknown>) => void): void;
  removeEventListener(t: string, l: (e: MessageEvent<unknown>) => void): void;
  ready: Promise<ServiceWorkerRegistration>;
  fire(data: unknown): void;
}

function makeFakeSW(reg: ServiceWorkerRegistration): FakeServiceWorker {
  const listeners = new Set<(e: MessageEvent<unknown>) => void>();
  return {
    addEventListener: (_t, l) => { listeners.add(l); },
    removeEventListener: (_t, l) => { listeners.delete(l); },
    ready: Promise.resolve(reg),
    fire(data) { for (const l of listeners) l({ data } as MessageEvent<unknown>); },
  };
}

function makeRegistration(opts?: { withBgFetch?: boolean }): {
  reg: ServiceWorkerRegistration;
  fetchSpy: ReturnType<typeof vi.fn>;
  abortSpy: ReturnType<typeof vi.fn>;
} {
  const abortSpy = vi.fn().mockResolvedValue(true);
  const fetchSpy = vi.fn().mockImplementation(async (id: string) => ({ id, abort: abortSpy }));
  const reg = {
    ...(opts?.withBgFetch !== false
      ? { backgroundFetch: { fetch: fetchSpy } as unknown as BackgroundFetchManager }
      : {}),
  } as unknown as ServiceWorkerRegistration;
  return { reg, fetchSpy, abortSpy };
}

interface RenderedHook {
  result(): UseBackgroundFetchResult;
  unmount(): Promise<void>;
}

const mounted: RenderedHook[] = [];

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function renderHook(): Promise<RenderedHook> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  let current: UseBackgroundFetchResult | null = null;
  function TestComponent(): null {
    current = useBackgroundFetch();
    return null;
  }
  await act(async () => {
    root.render(createElement(TestComponent));
    await flush();
  });
  // Allow ready promise to resolve and re-render.
  await act(async () => { await flush(); });
  const rendered: RenderedHook = {
    result: () => {
      if (!current) throw new Error('hook not mounted');
      return current;
    },
    unmount: async () => {
      await act(async () => { root.unmount(); await flush(); });
      container.remove();
    },
  };
  mounted.push(rendered);
  return rendered;
}

afterEach(async () => {
  for (const m of mounted.splice(0)) await m.unmount();
  __setBackgroundFetchTestEnv(null);
});

beforeEach(() => { /* noop */ });

describe('useBackgroundFetch', () => {
  it('reports unsupported when serviceWorker is missing (Safari path)', async () => {
    __setBackgroundFetchTestEnv({ navigator: { } });
    const h = await renderHook();
    expect(h.result().support.supported).toBe(false);
    expect(h.result().support.registration).toBeNull();
  });

  it('reports unsupported when registration has no backgroundFetch (Firefox path)', async () => {
    const { reg } = makeRegistration({ withBgFetch: false });
    const sw = makeFakeSW(reg);
    __setBackgroundFetchTestEnv({ navigator: { serviceWorker: sw as unknown as ServiceWorkerContainer } });
    const h = await renderHook();
    expect(h.result().support.supported).toBe(false);
    expect(h.result().support.registration).toBe(reg);
  });

  it('reports supported and starts a background fetch', async () => {
    const { reg, fetchSpy } = makeRegistration();
    const sw = makeFakeSW(reg);
    __setBackgroundFetchTestEnv({ navigator: { serviceWorker: sw as unknown as ServiceWorkerContainer } });
    const h = await renderHook();
    expect(h.result().support.supported).toBe(true);
    const handle = await h.result().start(
      ['https://x/api/shards/a'],
      { id: 'job-7', title: 'Mosaic download', downloadTotal: 1024 },
    );
    expect(handle.id).toBe('job-7');
    expect(fetchSpy).toHaveBeenCalledWith(
      'job-7',
      ['https://x/api/shards/a'],
      expect.objectContaining({ title: 'Mosaic download', downloadTotal: 1024 }),
    );
    await handle.abort();
  });

  it('rejects start when unsupported', async () => {
    __setBackgroundFetchTestEnv({ navigator: { } });
    const h = await renderHook();
    await expect(h.result().start(['u'], { id: 'j', title: 't' }))
      .rejects.toThrow(/not supported/);
  });

  it('rejects when urls is empty', async () => {
    const { reg } = makeRegistration();
    const sw = makeFakeSW(reg);
    __setBackgroundFetchTestEnv({ navigator: { serviceWorker: sw as unknown as ServiceWorkerContainer } });
    const h = await renderHook();
    await expect(h.result().start([], { id: 'j', title: 't' }))
      .rejects.toThrow(/at least one URL/);
  });

  it('fans out success messages and supports unsubscribe', async () => {
    const { reg } = makeRegistration();
    const sw = makeFakeSW(reg);
    __setBackgroundFetchTestEnv({ navigator: { serviceWorker: sw as unknown as ServiceWorkerContainer } });
    const h = await renderHook();
    const onSuccess = vi.fn();
    const off = h.result().onSuccess(onSuccess);
    sw.fire({ type: 'mosaic.bgfetch.success', jobId: 'j1', urls: ['u1'] });
    expect(onSuccess).toHaveBeenCalledWith('j1', ['u1']);
    off();
    sw.fire({ type: 'mosaic.bgfetch.success', jobId: 'j2', urls: ['u2'] });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('fans out fail messages', async () => {
    const { reg } = makeRegistration();
    const sw = makeFakeSW(reg);
    __setBackgroundFetchTestEnv({ navigator: { serviceWorker: sw as unknown as ServiceWorkerContainer } });
    const h = await renderHook();
    const onFail = vi.fn();
    h.result().onFail(onFail);
    sw.fire({ type: 'mosaic.bgfetch.fail', jobId: 'j9', reason: 'fetch-error' });
    expect(onFail).toHaveBeenCalledWith('j9', 'fetch-error');
  });

  it('ignores unknown message shapes', async () => {
    const { reg } = makeRegistration();
    const sw = makeFakeSW(reg);
    __setBackgroundFetchTestEnv({ navigator: { serviceWorker: sw as unknown as ServiceWorkerContainer } });
    const h = await renderHook();
    const onSuccess = vi.fn();
    const onFail = vi.fn();
    h.result().onSuccess(onSuccess);
    h.result().onFail(onFail);
    sw.fire({ type: 'mosaic.other' });
    sw.fire('not an object');
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFail).not.toHaveBeenCalled();
  });
});