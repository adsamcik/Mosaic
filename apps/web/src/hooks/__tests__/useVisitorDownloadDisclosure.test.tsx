import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  STORAGE_KEY,
  __resetVisitorDisclosureCacheForTests,
  useVisitorDownloadDisclosure,
  type VisitorDisclosureState,
} from '../useVisitorDownloadDisclosure';

interface Probe {
  state: VisitorDisclosureState;
}

function Harness({ scopeKey, probe }: { scopeKey: string | null; probe: Probe }) {
  const state = useVisitorDownloadDisclosure(scopeKey);
  probe.state = state;
  return null;
}

interface Mounted {
  readonly probe: Probe;
  readonly setScope: (s: string | null) => Promise<void>;
  readonly unmount: () => Promise<void>;
}

async function mount(initial: string | null): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const probe: Probe = { state: { acknowledged: false, acknowledge: () => {}, reset: () => {} } };
  let current = initial;
  await act(async () => {
    root.render(<Harness scopeKey={current} probe={probe} />);
  });
  return {
    probe,
    setScope: async (s) => {
      current = s;
      await act(async () => {
        root.render(<Harness scopeKey={current} probe={probe} />);
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  __resetVisitorDisclosureCacheForTests();
});
afterEach(() => {
  document.body.replaceChildren();
});

describe('useVisitorDownloadDisclosure', () => {
  it('returns acknowledged=false for an unknown scope', async () => {
    const m = await mount('visitor:abc123');
    expect(m.probe.state.acknowledged).toBe(false);
    await m.unmount();
  });

  it('returns acknowledged=false when scopeKey is null', async () => {
    const m = await mount(null);
    expect(m.probe.state.acknowledged).toBe(false);
    // Calling acknowledge with null scope must be a safe no-op.
    await act(async () => { m.probe.state.acknowledge(); });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    await m.unmount();
  });

  it('acknowledge() flips to true and persists to localStorage', async () => {
    const m = await mount('visitor:abc');
    await act(async () => { m.probe.state.acknowledge(); });
    expect(m.probe.state.acknowledged).toBe(true);
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual(['visitor:abc']);
    await m.unmount();
  });

  it('different scope keys are isolated', async () => {
    const m = await mount('visitor:aaa');
    await act(async () => { m.probe.state.acknowledge(); });
    expect(m.probe.state.acknowledged).toBe(true);
    await m.setScope('visitor:bbb');
    expect(m.probe.state.acknowledged).toBe(false);
    await m.unmount();
  });

  it('reset() clears acknowledgement for the current scope only', async () => {
    const m = await mount('visitor:aaa');
    await act(async () => { m.probe.state.acknowledge(); });
    await m.setScope('visitor:bbb');
    await act(async () => { m.probe.state.acknowledge(); });
    expect(m.probe.state.acknowledged).toBe(true);
    await act(async () => { m.probe.state.reset(); });
    expect(m.probe.state.acknowledged).toBe(false);
    // The other scope is still acknowledged.
    await m.setScope('visitor:aaa');
    expect(m.probe.state.acknowledged).toBe(true);
    await m.unmount();
  });

  it('handles corrupt localStorage gracefully (not JSON)', async () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    __resetVisitorDisclosureCacheForTests();
    const m = await mount('visitor:abc');
    expect(m.probe.state.acknowledged).toBe(false);
    // Corrupt entry must have been wiped.
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    await m.unmount();
  });

  it('handles corrupt localStorage gracefully (wrong shape)', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ acknowledged: ['a'] }));
    __resetVisitorDisclosureCacheForTests();
    const m = await mount('visitor:abc');
    expect(m.probe.state.acknowledged).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    await m.unmount();
  });

  it('handles corrupt localStorage gracefully (array of non-strings)', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([1, 2, 3]));
    __resetVisitorDisclosureCacheForTests();
    const m = await mount('visitor:abc');
    expect(m.probe.state.acknowledged).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    await m.unmount();
  });

  it('multiple scopes coexist in storage', async () => {
    const m = await mount('visitor:aaa');
    await act(async () => { m.probe.state.acknowledge(); });
    await m.setScope('visitor:bbb');
    await act(async () => { m.probe.state.acknowledge(); });
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = JSON.parse(raw!) as string[];
    expect(parsed.sort()).toEqual(['visitor:aaa', 'visitor:bbb']);
    await m.unmount();
  });

  it('rehydrates from localStorage on a fresh mount (cross-tab persistence)', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['visitor:persisted']));
    __resetVisitorDisclosureCacheForTests();
    const m = await mount('visitor:persisted');
    expect(m.probe.state.acknowledged).toBe(true);
    await m.unmount();
  });
});
