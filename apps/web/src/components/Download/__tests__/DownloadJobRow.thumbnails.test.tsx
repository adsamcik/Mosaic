import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobSummary } from '../../../workers/types';
import { DownloadJobRow } from '../DownloadJobRow';
import { render, requireElement, textContent } from './DownloadTestUtils';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));

const baseJob: JobSummary = {
  jobId: '33333333333333333333333333333333',
  albumId: 'album-x',
  phase: 'Running',
  photoCounts: { pending: 5, inflight: 0, done: 5, failed: 0, skipped: 0 },
  failureCount: 0,
  createdAtMs: 1,
  lastUpdatedAtMs: 1,
  scopeKey: 'auth:00000000000000000000000000000000',
  lastErrorReason: null,
  schedule: null,
};

afterEach(() => document.body.replaceChildren());

describe('DownloadJobRow thumbnail strip', () => {
  it('renders the strip with each thumbnail as an <img>', async () => {
    const thumbs = [
      { photoId: 'p1', blobUrl: 'blob:1' },
      { photoId: 'p2', blobUrl: 'blob:2' },
      { photoId: 'p3', blobUrl: 'blob:3' },
    ];
    const r = await render(<DownloadJobRow job={baseJob} thumbnails={thumbs} onPause={vi.fn()} onResume={vi.fn()} onCancelSoft={vi.fn()} onCancelHard={vi.fn()} />);
    const strip = requireElement(r.container.querySelector('[data-testid="download-tray-thumbnails"]'));
    const imgs = strip.querySelectorAll('img');
    expect(imgs).toHaveLength(3);
    expect((imgs[0] as HTMLImageElement).src).toContain('blob:1');
    await r.unmount();
  });

  it('renders an empty hint when running but no thumbnails yet', async () => {
    const r = await render(<DownloadJobRow job={baseJob} thumbnails={[]} onPause={vi.fn()} onResume={vi.fn()} onCancelSoft={vi.fn()} onCancelHard={vi.fn()} />);
    expect(r.container.querySelector('[data-testid="download-tray-thumbnails-empty"]')).not.toBeNull();
    expect(textContent(r.container)).toContain('Previews will appear');
    await r.unmount();
  });

  it('omits the strip entirely for Idle (scheduled) jobs with no thumbnails', async () => {
    const idleJob: JobSummary = { ...baseJob, phase: 'Idle' };
    const r = await render(<DownloadJobRow job={idleJob} thumbnails={[]} onPause={vi.fn()} onResume={vi.fn()} onCancelSoft={vi.fn()} onCancelHard={vi.fn()} />);
    expect(r.container.querySelector('[data-testid="download-tray-thumbnails-empty"]')).toBeNull();
    expect(r.container.querySelector('[data-testid="download-tray-thumbnails"]')).toBeNull();
    await r.unmount();
  });

  it('shows "+N more" when thumbnails exceed the visible limit', async () => {
    const thumbs = Array.from({ length: 10 }, (_, i) => ({ photoId: 'p' + i, blobUrl: 'blob:' + i }));
    const r = await render(<DownloadJobRow job={baseJob} thumbnails={thumbs} thumbnailVisibleLimit={4} onPause={vi.fn()} onResume={vi.fn()} onCancelSoft={vi.fn()} onCancelHard={vi.fn()} />);
    const more = requireElement(r.container.querySelector('[data-testid="download-tray-thumbnails-more"]'));
    expect(more.textContent).toContain('+6 more');
    expect(r.container.querySelectorAll('[data-testid="download-tray-thumbnails"] img')).toHaveLength(4);
    await r.unmount();
  });
});

function translate(key: string, values?: Record<string, unknown>): string {
  const map: Record<string, string> = {
    'download.tray.phase.Running': 'Running',
    'download.tray.phase.Idle': 'Idle',
    'download.tray.screenOnRequired': 'Keep screen on',
    'download.tray.failureBadge': '{{count}} failures',
    'download.tray.photoProgress': '{{done}} / {{total}} photos',
    'download.tray.progressAria': 'Download progress {{percent}} percent',
    'download.tray.pauseJob': 'Pause download job',
    'download.tray.cancelJob': 'Cancel download job',
    'download.tray.pause': 'Pause',
    'download.tray.cancel': 'Cancel',
    'download.tray.thumbnails.empty': 'Previews will appear as photos download',
    'download.tray.thumbnails.morePhotos': '+{{count}} more',
    'download.tray.thumbnails.error': 'Preview unavailable',
  };
  let output = map[key] ?? key;
  for (const [name, value] of Object.entries(values ?? {})) {
    output = output.replaceAll('{{' + name + '}}', String(value));
  }
  return output;
}
