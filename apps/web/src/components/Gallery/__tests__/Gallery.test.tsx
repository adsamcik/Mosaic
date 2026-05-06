import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCallback } from 'react';
import { useAlbumDownloadModePicker } from '../../../hooks/useAlbumDownloadModePicker';
import type { DownloadOutputMode, PerFileStrategy, PhotoMeta } from '../../../workers/types';
import { click, flushMicrotasks, render, requireElement } from '../../Download/__tests__/DownloadTestUtils';

// Match the existing DownloadModePicker test setup so the picker is renderable.
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
      if (key === 'download.modePicker.subtitle') return `${opts?.['count']} photos`;
      const dict: Record<string, string> = {
        'download.modePicker.title': 'Save album',
        'download.modePicker.cancel': 'Cancel',
        'download.modePicker.start': 'Start download',
        'download.modePicker.zip.label': 'Save as ZIP',
        'download.modePicker.zip.sub': 'Best for desktop',
        'download.modePicker.keepOffline.label': 'Make available offline',
        'download.modePicker.keepOffline.sub': 'View later in Mosaic',
        'download.modePicker.perFile.label': 'Save individual files',
        'download.modePicker.perFile.sub': 'Coming soon',
        'download.modePicker.perFileNotSupported': 'Per-file save not supported',
        'download.modePicker.statusStreaming': 'Streams to disk',
        'download.modePicker.statusFallback': 'Buffered in memory',
        'download.modePicker.sizeUnknown': 'size unknown',
      };
      return dict[key] ?? key;
    },
  }),
}));

const samplePhoto: PhotoMeta = {
  id: 'p1', assetId: 'a1', albumId: 'alb', filename: 'one.jpg',
  mimeType: 'image/jpeg', width: 100, height: 100, tags: [],
  createdAt: '2025-01-01', updatedAt: '2025-01-01', shardIds: [], epochId: 1,
};

interface AlbumDownloadStub {
  readonly startDownload: import('vitest').Mock<(albumId: string, albumName: string, photos: ReadonlyArray<PhotoMeta>, opts: { readonly mode: DownloadOutputMode }) => Promise<void>>;
}

/**
 * Mirrors Gallery.tsx's handleDownloadAll wiring exactly, so the test exercises
 * the same prompt -> startDownload({mode}) chain that Gallery uses on click.
 */
function GalleryDownloadHarness(props: {
  readonly albumId: string;
  readonly albumName: string;
  readonly photos: ReadonlyArray<PhotoMeta>;
  readonly albumDownload: AlbumDownloadStub;
}) {
  const { albumId, albumName, photos, albumDownload } = props;
  const picker = useAlbumDownloadModePicker();

  const handleDownloadAll = useCallback(async () => {
    if (photos.length === 0) return;
    const picked = await picker.prompt({ albumId, suggestedFileName: albumName, photos });
    if (picked === null) return;
    await albumDownload.startDownload(albumId, albumName, photos, { mode: picked.mode, schedule: picked.schedule });
  }, [albumId, albumName, photos, albumDownload, picker]);

  return (
    <div>
      <button type="button" data-testid="download-all" onClick={() => { void handleDownloadAll(); }}>Download all</button>
      {picker.pickerElement}
    </div>
  );
}

beforeEach(() => {
  saveTargetMocks.strategy = null;
  window.localStorage.clear();
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

describe('Gallery download integration (C1 wiring)', () => {
  it('Download All opens the picker, then Start triggers startDownload({...,mode})', async () => {
    const albumDownload: AlbumDownloadStub = {
      startDownload: vi.fn<(albumId: string, albumName: string, photos: ReadonlyArray<PhotoMeta>, opts: { readonly mode: DownloadOutputMode }) => Promise<void>>(async () => undefined),
    };
    const r = await render(<GalleryDownloadHarness albumId="alb" albumName="My Album" photos={[samplePhoto]} albumDownload={albumDownload} />);
    await click(requireElement(r.container.querySelector('[data-testid="download-all"]')));
    await flushMicrotasks();

    // Picker should now be mounted.
    const picker = document.querySelector('[role="dialog"]');
    expect(picker).not.toBeNull();

    // Choose keepOffline + Start.
    await click(requireElement(document.querySelector('[data-testid="download-mode-radio-keepOffline"]')));
    await click(requireElement(document.querySelector('[data-testid="download-mode-picker-start"]')));
    await flushMicrotasks();

    expect(albumDownload.startDownload).toHaveBeenCalledTimes(1);
    const calls = albumDownload.startDownload.mock.calls as unknown as ReadonlyArray<readonly [string, string, ReadonlyArray<PhotoMeta>, { readonly mode: DownloadOutputMode; readonly schedule?: unknown }]>;
    expect(calls[0]?.[0]).toBe('alb');
    expect(calls[0]?.[1]).toBe('My Album');
    expect(calls[0]?.[3]).toEqual({ mode: { kind: 'keepOffline' }, schedule: { kind: 'immediate' } });
    await r.unmount();
  });

  it('Cancel closes the picker WITHOUT calling startDownload', async () => {
    const albumDownload: AlbumDownloadStub = {
      startDownload: vi.fn<(albumId: string, albumName: string, photos: ReadonlyArray<PhotoMeta>, opts: { readonly mode: DownloadOutputMode }) => Promise<void>>(async () => undefined),
    };
    const r = await render(<GalleryDownloadHarness albumId="alb" albumName="My Album" photos={[samplePhoto]} albumDownload={albumDownload} />);
    await click(requireElement(r.container.querySelector('[data-testid="download-all"]')));
    await flushMicrotasks();

    const cancel = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Cancel');
    await click(requireElement(cancel ?? null));
    await flushMicrotasks();

    expect(albumDownload.startDownload).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await r.unmount();
  });

  it('empty photos array short-circuits without prompting', async () => {
    const albumDownload: AlbumDownloadStub = {
      startDownload: vi.fn<(albumId: string, albumName: string, photos: ReadonlyArray<PhotoMeta>, opts: { readonly mode: DownloadOutputMode }) => Promise<void>>(async () => undefined),
    };
    const r = await render(<GalleryDownloadHarness albumId="alb" albumName="My Album" photos={[]} albumDownload={albumDownload} />);
    await click(requireElement(r.container.querySelector('[data-testid="download-all"]')));
    await flushMicrotasks();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(albumDownload.startDownload).not.toHaveBeenCalled();
    await r.unmount();
  });
});
