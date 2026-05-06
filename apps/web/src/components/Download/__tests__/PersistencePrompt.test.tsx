import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersistencePrompt } from '../PersistencePrompt';
import type { StoragePersistenceState } from '../../../hooks/useStoragePersistence';
import { click, render, requireElement } from './DownloadTestUtils';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const dict: Record<string, string> = {
        'download.persistencePrompt.title': 'Keep these photos safe',
        'download.persistencePrompt.body': 'Body copy',
        'download.persistencePrompt.allow': 'Allow',
        'download.persistencePrompt.notNow': 'Not now',
        'download.persistencePrompt.neverAsk': "Don't ask again",
      };
      return dict[key] ?? key;
    },
  }),
}));

function makeState(overrides: Partial<StoragePersistenceState> = {}): StoragePersistenceState {
  return {
    supported: true,
    persisted: false,
    dismissedThisSession: false,
    dismissedForever: false,
    request: vi.fn().mockResolvedValue(true),
    dismiss: vi.fn(),
    dismissForever: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('PersistencePrompt', () => {
  it('renders when active and conditions are met', async () => {
    const state = makeState();
    const r = await render(<PersistencePrompt state={state} active />);
    expect(r.container.querySelector('[data-testid="persistence-prompt"]')).not.toBeNull();
    expect(r.container.textContent).toContain('Keep these photos safe');
    await r.unmount();
  });

  it('does not render when active=false', async () => {
    const state = makeState();
    const r = await render(<PersistencePrompt state={state} active={false} />);
    expect(r.container.querySelector('[data-testid="persistence-prompt"]')).toBeNull();
    await r.unmount();
  });

  it('does not render when supported=false', async () => {
    const state = makeState({ supported: false, persisted: null });
    const r = await render(<PersistencePrompt state={state} active />);
    expect(r.container.querySelector('[data-testid="persistence-prompt"]')).toBeNull();
    await r.unmount();
  });

  it('does not render when already persisted', async () => {
    const state = makeState({ persisted: true });
    const r = await render(<PersistencePrompt state={state} active />);
    expect(r.container.querySelector('[data-testid="persistence-prompt"]')).toBeNull();
    await r.unmount();
  });

  it('does not render when persisted is null (still probing)', async () => {
    const state = makeState({ persisted: null });
    const r = await render(<PersistencePrompt state={state} active />);
    expect(r.container.querySelector('[data-testid="persistence-prompt"]')).toBeNull();
    await r.unmount();
  });

  it('does not render when dismissed for this session', async () => {
    const state = makeState({ dismissedThisSession: true });
    const r = await render(<PersistencePrompt state={state} active />);
    expect(r.container.querySelector('[data-testid="persistence-prompt"]')).toBeNull();
    await r.unmount();
  });

  it('does not render when dismissed forever', async () => {
    const state = makeState({ dismissedForever: true });
    const r = await render(<PersistencePrompt state={state} active />);
    expect(r.container.querySelector('[data-testid="persistence-prompt"]')).toBeNull();
    await r.unmount();
  });

  it('Allow button calls request and reports allowed outcome', async () => {
    const request = vi.fn().mockResolvedValue(true);
    const state = makeState({ request });
    const onResolved = vi.fn();
    const r = await render(<PersistencePrompt state={state} active onResolved={onResolved} />);
    await click(requireElement(r.container.querySelector('[data-testid="persistence-prompt-allow"]')));
    expect(request).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledWith('allowed');
    await r.unmount();
  });

  it('Allow button reports denied outcome when request returns false', async () => {
    const request = vi.fn().mockResolvedValue(false);
    const state = makeState({ request });
    const onResolved = vi.fn();
    const r = await render(<PersistencePrompt state={state} active onResolved={onResolved} />);
    await click(requireElement(r.container.querySelector('[data-testid="persistence-prompt-allow"]')));
    expect(onResolved).toHaveBeenCalledWith('denied');
    await r.unmount();
  });

  it('Not-now button calls dismiss', async () => {
    const dismiss = vi.fn();
    const state = makeState({ dismiss });
    const onResolved = vi.fn();
    const r = await render(<PersistencePrompt state={state} active onResolved={onResolved} />);
    await click(requireElement(r.container.querySelector('[data-testid="persistence-prompt-dismiss"]')));
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledWith('dismissed');
    await r.unmount();
  });

  it("Don't-ask-again button calls dismissForever", async () => {
    const dismissForever = vi.fn();
    const state = makeState({ dismissForever });
    const onResolved = vi.fn();
    const r = await render(<PersistencePrompt state={state} active onResolved={onResolved} />);
    await click(requireElement(r.container.querySelector('[data-testid="persistence-prompt-never"]')));
    expect(dismissForever).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledWith('dismissedForever');
    await r.unmount();
  });
});