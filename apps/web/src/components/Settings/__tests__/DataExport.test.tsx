import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DataExport } from '../DataExport';
import { click, render, requireElement } from '../../Download/__tests__/DownloadTestUtils';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const dict: Record<string, string> = {
        'settings.export.title': 'Data',
        'settings.export.heading': 'Download Export',
        'settings.export.description':
          'Download a zip archive of your entire Mosaic account.',
        'settings.export.downloadButton': 'Download Export',
        'settings.export.loadingMessage': 'Preparing export…',
        'settings.export.largeLibraryWarning':
          'This may take several minutes for large libraries.',
      };
      return dict[key] ?? key;
    },
  }),
}));

describe('DataExport', () => {
  let clickedHref: string | null = null;
  let clickedDownload: string | null = null;
  let origCreate: typeof document.createElement;

  beforeEach(() => {
    clickedHref = null;
    clickedDownload = null;
    origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((
      tag: string,
    ): HTMLElement => {
      const el = origCreate(tag) as HTMLAnchorElement;
      if (tag === 'a') {
        el.click = (): void => {
          clickedHref = el.getAttribute('href');
          clickedDownload = el.getAttribute('download');
        };
      }
      return el;
    }) as typeof document.createElement);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('renders the title, description, and download button', async () => {
    const { container, unmount } = await render(<DataExport />);
    expect(container.textContent).toContain('Data');
    expect(container.textContent).toContain('Download Export');
    expect(container.textContent).toContain(
      'This may take several minutes for large libraries.',
    );
    const button = requireElement(
      container.querySelector('[data-testid="data-export-button"]'),
    );
    expect(button.getAttribute('disabled')).toBeNull();
    await unmount();
  });

  it('navigates an anchor to /api/v1/export on click', async () => {
    const { container, unmount } = await render(<DataExport />);
    const button = requireElement(
      container.querySelector('[data-testid="data-export-button"]'),
    );
    await click(button);
    expect(clickedHref).toBe('/api/v1/export');
    expect(clickedDownload).toBe('');
    await unmount();
  });

  it('disables the button while the download is in flight', async () => {
    vi.useFakeTimers();
    const { container, unmount } = await render(<DataExport />);
    const button = requireElement(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="data-export-button"]',
      ),
    );
    await click(button);
    expect(
      container
        .querySelector<HTMLButtonElement>('[data-testid="data-export-button"]')!
        .disabled,
    ).toBe(true);
    expect(container.textContent).toContain('Preparing export…');
    await unmount();
  });
});
