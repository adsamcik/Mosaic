import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobSummary } from '../../../workers/types';
import { DownloadJobRow } from '../DownloadJobRow';
import { click, render, requireElement, textContent } from './DownloadTestUtils';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));

const baseJob: JobSummary = {
  jobId: '22222222222222222222222222222222',
  albumId: '018f0000-0000-7000-8000-000000000003',
  phase: 'Running',
  photoCounts: { pending: 5, inflight: 0, done: 5, failed: 0, skipped: 0 },
  failureCount: 0,
  createdAtMs: 1,
  lastUpdatedAtMs: 1,
  scopeKey: 'auth:00000000000000000000000000000000',
};

afterEach(() => document.body.replaceChildren());

describe('DownloadJobRow', () => {
  it('fires pause and cancel callbacks', async () => {
    const onPause = vi.fn();
    const onCancelSoft = vi.fn();
    const rendered = await render(<DownloadJobRow job={baseJob} onPause={onPause} onResume={vi.fn()} onCancelSoft={onCancelSoft} onCancelHard={vi.fn()} />);
    await click(requireElement(rendered.container.querySelector('button[aria-label="Pause download job"]')));
    await click(requireElement(rendered.container.querySelector('button[aria-label="Cancel download job"]')));
    expect(onPause).toHaveBeenCalledWith(baseJob.jobId);
    expect(onCancelSoft).toHaveBeenCalledWith(baseJob.jobId);
    await rendered.unmount();
  });

  it('renders progress percentage and photo counts', async () => {
    const rendered = await render(<DownloadJobRow job={baseJob} onPause={vi.fn()} onResume={vi.fn()} onCancelSoft={vi.fn()} onCancelHard={vi.fn()} />);
    const progressbar = requireElement(rendered.container.querySelector('[role="progressbar"]'));
    expect(progressbar.getAttribute('aria-valuenow')).toBe('50');
    expect(textContent(rendered.container)).toContain('5 / 10 photos');
    await rendered.unmount();
  });

  it('shows a failure-count badge when failures exist', async () => {
    const rendered = await render(<DownloadJobRow job={{ ...baseJob, failureCount: 2, photoCounts: { ...baseJob.photoCounts, failed: 2 } }} onPause={vi.fn()} onResume={vi.fn()} onCancelSoft={vi.fn()} onCancelHard={vi.fn()} />);
    expect(textContent(rendered.container)).toContain('2 failures');
    await rendered.unmount();
  });
});

function translate(key: string, values?: Record<string, unknown>): string {
  const map: Record<string, string> = {
    'download.tray.phase.Running': 'Running',
    'download.tray.screenOnRequired': 'Keep screen on',
    'download.tray.failureBadge': '{{count}} failures',
    'download.tray.photoProgress': '{{done}} / {{total}} photos',
    'download.tray.progressAria': 'Download progress {{percent}} percent',
    'download.tray.pauseJob': 'Pause download job',
    'download.tray.cancelJob': 'Cancel download job',
    'download.tray.pause': 'Pause',
    'download.tray.cancel': 'Cancel',
  };
  let output = map[key] ?? key;
  for (const [name, value] of Object.entries(values ?? {})) {
    output = output.replaceAll(`{{${name}}}`, String(value));
  }
  return output;
}
