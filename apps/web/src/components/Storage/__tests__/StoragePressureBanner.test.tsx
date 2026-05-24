import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoragePressureBanner } from '../StoragePressureBanner';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      const dict: Record<string, string> = {
        'storage.pressureBanner.title': 'Storage nearly full',
        'storage.pressureBanner.criticalTitle': 'Storage almost full',
        'storage.pressureBanner.dismiss': 'Dismiss',
      };
      if (key === 'storage.pressureBanner.message') {
        const usage = vars?.usage ?? '';
        const quota = vars?.quota ?? '';
        const percent = vars?.percent ?? '';
        return `Using ${usage} of ${quota} (${percent}%).`;
      }
      return dict[key] ?? key;
    },
  }),
}));

vi.mock('../../../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    startTimer: vi.fn(),
    child: vi.fn(),
    scope: 'banner-test',
  }),
}));

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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

interface RenderResult {
  readonly container: HTMLDivElement;
  readonly unmount: () => Promise<void>;
}

const mounted: RenderResult[] = [];

async function render(element: ReactElement): Promise<RenderResult> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(element);
    await flushMicrotasks();
  });
  const result: RenderResult = {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
        await flushMicrotasks();
      });
      container.remove();
    },
  };
  mounted.push(result);
  return result;
}

describe('StoragePressureBanner', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    clearStorage();
  });

  afterEach(async () => {
    for (const m of mounted.splice(0)) await m.unmount();
    clearStorage();
    vi.restoreAllMocks();
  });

  it('renders when usage crosses default 80% threshold', async () => {
    installStorage({
      estimate: vi.fn().mockResolvedValue({ usage: 900, quota: 1000 }),
    });
    const r = await render(createElement(StoragePressureBanner));
    expect(r.container.querySelector('[data-testid="storage-pressure-banner"]')).not.toBeNull();
    expect(r.container.textContent).toContain('Storage nearly full');
  });

  it('does not render when usage is below threshold', async () => {
    installStorage({
      estimate: vi.fn().mockResolvedValue({ usage: 100, quota: 1000 }),
    });
    const r = await render(createElement(StoragePressureBanner));
    expect(r.container.querySelector('[data-testid="storage-pressure-banner"]')).toBeNull();
  });

  it('does not render when StorageManager is unsupported', async () => {
    const r = await render(createElement(StoragePressureBanner));
    expect(r.container.querySelector('[data-testid="storage-pressure-banner"]')).toBeNull();
  });

  it('shows critical title above 95% usage', async () => {
    installStorage({
      estimate: vi.fn().mockResolvedValue({ usage: 980, quota: 1000 }),
    });
    const r = await render(createElement(StoragePressureBanner));
    const banner = r.container.querySelector('[data-testid="storage-pressure-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute('data-critical')).toBe('true');
    expect(r.container.textContent).toContain('Storage almost full');
  });

  it('dismiss button hides the banner', async () => {
    installStorage({
      estimate: vi.fn().mockResolvedValue({ usage: 900, quota: 1000 }),
    });
    const r = await render(createElement(StoragePressureBanner));
    const dismiss = r.container.querySelector<HTMLButtonElement>(
      '[data-testid="storage-pressure-banner-dismiss"]',
    );
    expect(dismiss).not.toBeNull();
    await act(async () => {
      dismiss!.click();
      await flushMicrotasks();
    });
    expect(r.container.querySelector('[data-testid="storage-pressure-banner"]')).toBeNull();
    expect(window.sessionStorage.getItem('mosaic.storage-pressure.dismissed')).toBe('1');
  });

  it('does not render when disabled prop is true', async () => {
    installStorage({
      estimate: vi.fn().mockResolvedValue({ usage: 900, quota: 1000 }),
    });
    const r = await render(<StoragePressureBanner disabled />);
    expect(r.container.querySelector('[data-testid="storage-pressure-banner"]')).toBeNull();
  });

  it('honours a custom threshold prop', async () => {
    installStorage({
      estimate: vi.fn().mockResolvedValue({ usage: 600, quota: 1000 }),
    });
    const r = await render(<StoragePressureBanner threshold={0.5} />);
    expect(r.container.querySelector('[data-testid="storage-pressure-banner"]')).not.toBeNull();
  });
});
