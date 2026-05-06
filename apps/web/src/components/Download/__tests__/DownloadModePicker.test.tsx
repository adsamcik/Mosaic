import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadModePicker } from '../DownloadModePicker';
import type { PerFileStrategy, PhotoMeta } from '../../../workers/types';
import { click, render, requireElement } from './DownloadTestUtils';

const saveTargetMocks = vi.hoisted(() => ({
  strategy: null as PerFileStrategy | null,
}));

vi.mock('../../../lib/save-target', () => ({
  BLOB_ANCHOR_PHOTO_LIMIT: 50,
  detectPerFileStrategy: () => saveTargetMocks.strategy,
  supportsStreamingSave: () => true,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'download.modePicker.subtitle') return `${opts?.['count']} photos · ${opts?.['size']}`;
      if (key === 'download.modePicker.connection') return `Connection: ${opts?.['type']}`;
      if (key === 'download.modePicker.battery') return `Battery: ${opts?.['level']}`;
      if (key === 'download.modePicker.perFileFsAccess') return `Save individual files (${opts?.['count']} prompts)`;
      if (key === 'download.modePicker.perFilePromptCountMany') return `${opts?.['count']} prompts`;
      if (key === 'download.modePicker.perFileBlobAnchorRefusal') return `Too many photos (${opts?.['count']}) for individual downloads in this browser. Try Save as ZIP.`;
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
        'download.modePicker.perFileWebShare': 'Save individual files (via Share menu)',
        'download.modePicker.perFileBlobAnchor': 'Save individual files (browser may warn)',
        'download.modePicker.perFileNotSupported': 'Per-file save not supported in this browser',
        'download.modePicker.perFilePromptCountOne': '1 prompt',
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
  saveTargetMocks.strategy = null;
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
    expect(text).toContain('Per-file save not supported in this browser');
    await r.unmount();
  });

  it('disables the per-file option when unsupported', async () => {
    saveTargetMocks.strategy = null;
    const r = await render(
      <DownloadModePicker open albumId="alb" suggestedFileName="album" photos={[]} onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    const radio = requireElement<HTMLInputElement>(r.container.querySelector('[data-testid="download-mode-radio-perFile"]'));
    expect(radio.disabled).toBe(true);
    expect(r.container.textContent).toContain('Per-file save not supported in this browser');
    await r.unmount();
  });

  it('enables Web Share per-file mode with friendly sub-label', async () => {
    saveTargetMocks.strategy = 'webShare';
    const onConfirm = vi.fn();
    const r = await render(
      <DownloadModePicker open albumId="alb" suggestedFileName="album" photos={[samplePhoto]} onConfirm={onConfirm} onClose={vi.fn()} />,
    );
    const radio = requireElement<HTMLInputElement>(r.container.querySelector('[data-testid="download-mode-radio-perFile"]'));
    expect(radio.disabled).toBe(false);
    expect(r.container.textContent).toContain('Save individual files (via Share menu)');
    expect(r.container.textContent).toContain('1 prompt');
    await click(radio);
    await click(requireElement(r.container.querySelector('[data-testid="download-mode-picker-start"]')));
    expect(onConfirm).toHaveBeenCalledWith({ kind: 'perFile', strategy: 'webShare' });
    await r.unmount();
  });

  it('enables fsAccessPerFile with prompt-count estimate', async () => {
    saveTargetMocks.strategy = 'fsAccessPerFile';
    const photos = makePhotos(3);
    const r = await render(
      <DownloadModePicker open albumId="alb" suggestedFileName="album" photos={photos} onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    const radio = requireElement<HTMLInputElement>(r.container.querySelector('[data-testid="download-mode-radio-perFile"]'));
    expect(radio.disabled).toBe(false);
    expect(r.container.textContent).toContain('Save individual files (3 prompts)');
    await r.unmount();
  });

  it('shows a refusal for blobAnchor when photo count exceeds the honest limit', async () => {
    saveTargetMocks.strategy = 'blobAnchor';
    const onConfirm = vi.fn();
    const r = await render(
      <DownloadModePicker open albumId="alb" suggestedFileName="album" photos={makePhotos(51)} onConfirm={onConfirm} onClose={vi.fn()} />,
    );
    const radio = requireElement<HTMLInputElement>(r.container.querySelector('[data-testid="download-mode-radio-perFile"]'));
    expect(radio.disabled).toBe(false);
    await click(radio);
    const start = requireElement<HTMLButtonElement>(r.container.querySelector('[data-testid="download-mode-picker-start"]'));
    expect(start.disabled).toBe(true);
    expect(r.container.textContent).toContain('Too many photos (51) for individual downloads in this browser. Try Save as ZIP.');
    await click(start);
    expect(onConfirm).not.toHaveBeenCalled();
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

function makePhotos(count: number): PhotoMeta[] {
  return Array.from({ length: count }, (_, index) => ({
    ...samplePhoto,
    id: `p${index}`,
    assetId: `a${index}`,
    filename: `${index}.jpg`,
  }));
}
