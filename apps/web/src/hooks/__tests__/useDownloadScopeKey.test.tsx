import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { useDownloadScopeKey } from '../useDownloadScopeKey';
import { DownloadScopeProvider } from '../../contexts/DownloadScopeContext';
import { ensureScopeKeySodiumReady } from '../../lib/scope-key';

interface SessionStub {
  currentUser: { id: string } | null;
  subscribe: (cb: () => void) => () => void;
  _listeners: Set<() => void>;
}

const sessionMocks = vi.hoisted(() => {
  const stub: SessionStub = {
    currentUser: null,
    _listeners: new Set(),
    subscribe(cb: () => void): () => void {
      stub._listeners.add(cb);
      return () => {
        stub._listeners.delete(cb);
      };
    },
  };
  return { sessionStub: stub };
});

const sessionStub = sessionMocks.sessionStub;

vi.mock('../../lib/session', () => ({
  session: sessionMocks.sessionStub,
}));

function notifySession(): void {
  for (const listener of [...sessionStub._listeners]) listener();
}

interface RenderedHook {
  readonly current: () => string | null;
  readonly unmount: () => Promise<void>;
}

const mounted: RenderedHook[] = [];

async function renderHook(wrapper?: (children: ReactNode) => ReactNode): Promise<RenderedHook> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  let last: string | null = null;
  function TestComponent(): null {
    last = useDownloadScopeKey();
    return null;
  }
  const tree: ReactNode = wrapper
    ? wrapper(createElement(TestComponent))
    : createElement(TestComponent);
  await act(async () => {
    root.render(tree);
  });
  const handle: RenderedHook = {
    current: (): string | null => last,
    unmount: async (): Promise<void> => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
  mounted.push(handle);
  return handle;
}

beforeAll(async () => {
  await sodium.ready;
  await ensureScopeKeySodiumReady();
});

beforeEach(() => {
  sessionStub.currentUser = null;
  sessionStub._listeners.clear();
});

afterEach(async () => {
  for (const handle of mounted.splice(0)) {
    await handle.unmount();
  }
});

describe('useDownloadScopeKey', () => {
  it('returns null when no session and no visitor scope', async () => {
    const hook = await renderHook();
    expect(hook.current()).toBeNull();
  });

  it('returns auth:<hex> when session has currentUser', async () => {
    sessionStub.currentUser = { id: 'acct-abc-123' };
    const hook = await renderHook();
    // Auth derivation is async — flush effects
    await act(async () => { await Promise.resolve(); });
    const value = hook.current();
    expect(value).toMatch(/^auth:[0-9a-f]{32}$/u);
  });

  it('visitor scope from context wins over auth derivation', async () => {
    sessionStub.currentUser = { id: 'acct-xyz' };
    const visitor = 'visitor:11111111111111111111111111111111';
    const hook = await renderHook((children) =>
      createElement(DownloadScopeProvider, { scopeKey: visitor, children }),
    );
    await act(async () => { await Promise.resolve(); });
    expect(hook.current()).toBe(visitor);
  });

  it('does not include account id in the returned hex tail (ZK-safe)', async () => {
    const sensitiveAccountId = 'do-not-leak-account-id';
    sessionStub.currentUser = { id: sensitiveAccountId };
    const hook = await renderHook();
    await act(async () => { await Promise.resolve(); });
    const value = hook.current();
    expect(value).not.toBeNull();
    expect(value).not.toContain(sensitiveAccountId);
  });

  it('updates when session changes', async () => {
    const hook = await renderHook();
    expect(hook.current()).toBeNull();
    sessionStub.currentUser = { id: 'acct-1' };
    await act(async () => {
      notifySession();
      await Promise.resolve();
    });
    expect(hook.current()).toMatch(/^auth:[0-9a-f]{32}$/u);
  });
});