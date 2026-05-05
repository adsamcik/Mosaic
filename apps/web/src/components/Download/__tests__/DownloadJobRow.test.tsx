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
  lastErrorReason: null,
  schedule: null,
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

  it('shows "Share link revoked or expired" for visitor jobs Errored with AccessRevoked', async () => {
    const visitorJob: JobSummary = {
      ...baseJob,
      phase: 'Errored',
      lastErrorReason: 'AccessRevoked',
  schedule: null,
      scopeKey: 'visitor:11111111111111111111111111111111',
    };
    const rendered = await render(
      <DownloadJobRow
        job={visitorJob}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onCancelSoft={vi.fn()}
        onCancelHard={vi.fn()}
      />,
    );
    expect(textContent(rendered.container)).toContain('Share link revoked or expired');
    await rendered.unmount();
  });

  it('renders Scheduled badge + Start now + Edit schedule for Idle+schedule jobs', async () => {
    const scheduledJob: JobSummary = {
      ...baseJob,
      phase: 'Idle',
      schedule: { kind: 'wifi' },
      scheduleEvaluation: { canStart: false, reason: 'connection too slow', retryAfterMs: 30_000 },
    };
    const onForceStart = vi.fn();
    const onEditSchedule = vi.fn();
    const r = await render(
      <DownloadJobRow
        job={scheduledJob}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onCancelSoft={vi.fn()}
        onCancelHard={vi.fn()}
        onForceStart={onForceStart}
        onEditSchedule={onEditSchedule}
      />,
    );
    expect(textContent(r.container)).toContain('Scheduled');
    expect(textContent(r.container)).toContain('Waiting: connection too slow');
    await click(requireElement(r.container.querySelector('[data-testid="download-tray-start-now"]')));
    await click(requireElement(r.container.querySelector('[data-testid="download-tray-edit-schedule"]')));
    expect(onForceStart).toHaveBeenCalledWith(scheduledJob.jobId);
    expect(onEditSchedule).toHaveBeenCalledWith(scheduledJob.jobId);
    // a11y: scheduled-reason is a polite live region.
    const reason = requireElement(r.container.querySelector('[data-testid="download-tray-scheduled-reason"]'));
    expect(reason.getAttribute('role')).toBe('status');
    expect(reason.getAttribute('aria-live')).toBe('polite');
    await r.unmount();
  });

  it('does NOT render Start now / Edit schedule when callbacks are absent', async () => {
    const scheduledJob: JobSummary = {
      ...baseJob,
      phase: 'Idle',
      schedule: { kind: 'wifi' },
      scheduleEvaluation: null,
    };
    const r = await render(
      <DownloadJobRow
        job={scheduledJob}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onCancelSoft={vi.fn()}
        onCancelHard={vi.fn()}
      />,
    );
    expect(r.container.querySelector('[data-testid="download-tray-start-now"]')).toBeNull();
    expect(r.container.querySelector('[data-testid="download-tray-edit-schedule"]')).toBeNull();
    await r.unmount();
  });

  it('does NOT use the share-link copy for AUTH jobs Errored with AccessRevoked', async () => {
    const authJob: JobSummary = {
      ...baseJob,
      phase: 'Errored',
      lastErrorReason: 'AccessRevoked',
  schedule: null,
      scopeKey: 'auth:00000000000000000000000000000000',
    };
    const rendered = await render(
      <DownloadJobRow
        job={authJob}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onCancelSoft={vi.fn()}
        onCancelHard={vi.fn()}
      />,
    );
    expect(textContent(rendered.container)).not.toContain('Share link revoked');
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
    'download.tray.shareLinkRevoked': 'Share link revoked or expired',
    'download.tray.phase.Errored': 'Error',
    'download.tray.discardJob': 'Discard download progress',
    'download.tray.discard': 'Discard',
    'download.tray.scheduledBadge': 'Scheduled',
    'download.tray.scheduledStartNow': 'Start now',
    'download.tray.scheduledEdit': 'Edit schedule',
    'download.tray.scheduledReason': 'Waiting: {{reason}}',
    'download.tray.scheduledReasons.connectionTooSlow': 'connection too slow',
    'download.tray.scheduledReasons.notCharging': 'not charging',
    'download.tray.phase.Idle': 'Idle',
  };
  let output = map[key] ?? key;
  for (const [name, value] of Object.entries(values ?? {})) {
    output = output.replaceAll(`{{${name}}}`, String(value));
  }
  return output;
}
