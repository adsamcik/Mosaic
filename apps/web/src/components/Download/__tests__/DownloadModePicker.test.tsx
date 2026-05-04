import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadModePicker } from '../DownloadModePicker';
import type { PhotoMeta } from '../../../workers/types';
import { click, render, requireElement } from './DownloadTestUtils';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'download.modePicker.subtitle') return `${opts?.['count']} photos · ${opts?.['size']}`;
      if (key === 'download.modePicker.connection') return `Connection: ${opts?.['type']}`;
      if (key === 'download.modePicker.battery') return `Battery: ${opts?.['level']}`;
      const dict: Record<string, string> = {
        'download.modePicker.title': 'Save album',
        'download.modePicker.sizeUnknown': 'size unknown',
        'download.modePicker.cancel': 'Cancel',
        'download.modePicker.start': 'Start download',
        'download.modePicker.statusStreaming': 'Streams to disk',
        'download.modePicker.statusFallback': 'Buffered in memory',
        'download.modePicker.zip.label': 'Save as ZIP',
        'download.modePicker.zip.sub': 'Best for desktop',
        'download.modePicker.keepOffline.label': 'Make available offline',
        'download.modePicker.keepOffline.sub': 'View later in Mosaic',
        'download.modePicker.perFile.label': 'Save individual files',
        'download.modePicker.perFile.sub': 'Coming soon',
      };
      return dict[key] ?? key;
    },
  }),
}));

const samplePhoto: PhotoMeta = {
  id: 'p1',
  assetId: 'a1',
  albumId: 'alb',
  filename: 'one.jpg',
  mimeType: 'image/jpeg',
  width: 100,
  height: 100,
  tags: [],
  createdAt: '2025-01-01',
  updatedAt: '2025-01-01',
  shardIds: [],
  epochId: 1,
};

beforeEach(() => {
  window.localStorage.clear();
  // happy-dom doesn't implement matchMedia by default
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (q: string) => ({ matches: false, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn(), onchange: null, addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() }),
    });
  }
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('DownloadModePicker', () => {
  it('renders three options with translated labels', async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    const r = await render(
      <DownloadModePicker
        open
        albumId="alb"
        suggestedFileName="album"
        photos={[samplePhoto]}
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    const text = r.container.textContent ?? '';
    expect(text).toContain('Save as ZIP');
    expect(text).toContain('Make available offline');
    expect(text).toContain('Save individual files');
    expect(text).toContain('Coming soon');
    await r.unmount();
  });

  it('disables the per-file option', async () => {
    const r = await render(
      <DownloadModePicker open albumId="alb" suggestedFileName="album" photos={[]} onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    const radio = requireElement<HTMLInputElement>(r.container.querySelector('[data-testid="download-mode-radio-perFile"]'));
    expect(radio.disabled).toBe(true);
    await r.unmount();
  });

  it('confirms keepOffline mode when selected and Start clicked', async () => {
    const onConfirm = vi.fn();
    const r = await render(
      <DownloadModePicker open albumId="alb" suggestedFileName="album" photos={[]} onConfirm={onConfirm} onClose={vi.fn()} />,
    );
    await click(requireElement(r.container.querySelector('[data-testid="download-mode-radio-keepOffline"]')));
    await click(requireElement(r.container.querySelector('[data-testid="download-mode-picker-start"]')));
    expect(onConfirm).toHaveBeenCalledWith({ kind: 'keepOffline' });
    await r.unmount();
  });

  it('confirms zip mode with appended .zip extension', async () => {
    const onConfirm = vi.fn();
    const r = await render(
      <DownloadModePicker open albumId="alb" suggestedFileName="my-album" photos={[]} onConfirm={onConfirm} onClose={vi.fn()} />,
    );
    // Default selection should be 'zip'
    await click(requireElement(r.container.querySelector('[data-testid="download-mode-picker-start"]')));
    expect(onConfirm).toHaveBeenCalledWith({ kind: 'zip', fileName: 'my-album.zip' });
    await r.unmount();
  });

  it('persists last mode in localStorage and restores on next open', async () => {
    let r = await render(
      <DownloadModePicker open albumId="alb" suggestedFileName="album" photos={[]} onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    await click(requireElement(r.container.querySelector('[data-testid="download-mode-radio-keepOffline"]')));
    await click(requireElement(r.container.querySelector('[data-testid="download-mode-picker-start"]')));
    await r.unmount();
    expect(window.localStorage.getItem('mosaic.download.lastMode')).toBe('keepOffline');

    r = await render(
      <DownloadModePicker open albumId="alb" suggestedFileName="album" photos={[]} onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    const radio = requireElement<HTMLInputElement>(r.container.querySelector('[data-testid="download-mode-radio-keepOffline"]'));
    expect(radio.checked).toBe(true);
    await r.unmount();
  });

  it('returns null when not open', async () => {
    const r = await render(
      <DownloadModePicker open={false} albumId="alb" suggestedFileName="album" photos={[]} onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    expect(r.container.querySelector('[role="dialog"]')).toBeNull();
    await r.unmount();
  });
});
