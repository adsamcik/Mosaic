import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, render, requireElement } from '../../Download/__tests__/DownloadTestUtils';
import {
  STORAGE_KEY,
  __resetVisitorDisclosureCacheForTests,
} from '../../../hooks/useVisitorDownloadDisclosure';
import { VisitorDownloadDisclosure } from '../VisitorDownloadDisclosure';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const dict: Record<string, string> = {
        'download.visitorDisclosure.title': 'Before you download',
        'download.visitorDisclosure.body1': 'BODY-ONE',
        'download.visitorDisclosure.body2': 'BODY-TWO',
        'download.visitorDisclosure.body3': 'BODY-THREE',
        'download.visitorDisclosure.acknowledge': 'I understand, continue',
        'download.visitorDisclosure.cancel': 'Cancel',
      };
      return dict[key] ?? key;
    },
  }),
}));

beforeEach(() => {
  localStorage.clear();
  __resetVisitorDisclosureCacheForTests();
});
afterEach(() => {
  document.body.replaceChildren();
});

describe('VisitorDownloadDisclosure', () => {
  it('renders the dialog when the scope is not acknowledged', async () => {
    const r = await render(
      <VisitorDownloadDisclosure
        scopeKey="visitor:abc"
        onAcknowledge={() => {}}
        onCancel={() => {}}
      />,
    );
    const dialog = r.container.querySelector('[data-testid="visitor-download-disclosure"]');
    expect(dialog).not.toBeNull();
    expect(r.container.textContent).toContain('Before you download');
    expect(r.container.textContent).toContain('BODY-ONE');
    expect(r.container.textContent).toContain('BODY-TWO');
    expect(r.container.textContent).toContain('BODY-THREE');
    await r.unmount();
  });

  it('renders nothing if the scope is already acknowledged', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['visitor:abc']));
    __resetVisitorDisclosureCacheForTests();
    const r = await render(
      <VisitorDownloadDisclosure
        scopeKey="visitor:abc"
        onAcknowledge={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(r.container.querySelector('[data-testid="visitor-download-disclosure"]')).toBeNull();
    await r.unmount();
  });

  it('acknowledge button persists state and calls onAcknowledge', async () => {
    const onAck = vi.fn();
    const onCancel = vi.fn();
    const r = await render(
      <VisitorDownloadDisclosure
        scopeKey="visitor:abc"
        onAcknowledge={onAck}
        onCancel={onCancel}
      />,
    );
    await click(
      requireElement(
        r.container.querySelector('[data-testid="visitor-download-disclosure-acknowledge"]'),
      ),
    );
    expect(onAck).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(['visitor:abc']);
    await r.unmount();
  });

  it('cancel button calls onCancel and does NOT persist acknowledgement', async () => {
    const onAck = vi.fn();
    const onCancel = vi.fn();
    const r = await render(
      <VisitorDownloadDisclosure
        scopeKey="visitor:abc"
        onAcknowledge={onAck}
        onCancel={onCancel}
      />,
    );
    await click(
      requireElement(
        r.container.querySelector('[data-testid="visitor-download-disclosure-cancel"]'),
      ),
    );
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onAck).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    await r.unmount();
  });

  it('isolates acknowledgement between scope keys', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['visitor:other']));
    __resetVisitorDisclosureCacheForTests();
    const r = await render(
      <VisitorDownloadDisclosure
        scopeKey="visitor:abc"
        onAcknowledge={() => {}}
        onCancel={() => {}}
      />,
    );
    // Different scope: must still render.
    expect(r.container.querySelector('[data-testid="visitor-download-disclosure"]')).not.toBeNull();
    await r.unmount();
  });
});
