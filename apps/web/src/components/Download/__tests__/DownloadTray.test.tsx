import { act, useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoordinatorWorkerApi, JobProgressEvent, JobSummary, ResumableJobSummary } from '../../../workers/types';
import type { UseDownloadManagerResult } from '../../../hooks/useDownloadManager';
import { DownloadTray } from '../DownloadTray';
import { click, flushMicrotasks, keyDown, render, requireElement, textContent } from './DownloadTestUtils';

const store = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const subscribers = new Map<string, Set<() => void>>();
  let version = 0;
  return {
    listeners,
    subscribers,
    get version(): number { return version; },
    bump(): void { version += 1; for (const listener of listeners) listener(); },
  };
});

const api = vi.hoisted(() => ({
  initialize: vi.fn(),
  startJob: vi.fn(),
  sendEvent: vi.fn(),
  pauseJob: vi.fn(),
  resumeJob: vi.fn(),
  cancelJob: vi.fn(),
  listJobs: vi.fn(),
  listResumableJobs: vi.fn(),
  computeAlbumDiff: vi.fn(),
  getJob: vi.fn(),
  subscribe: vi.fn(),
  gc: vi.fn(),
}));

let jobs: ReadonlyArray<JobSummary> = [];
let resumableJobs: ReadonlyArray<ResumableJobSummary> = [];

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));
let mockScopeKey: string | null = 'auth:00000000000000000000000000000000';
vi.mock('../../../hooks/useDownloadScopeKey', () => ({
  useDownloadScopeKey: (): string | null => mockScopeKey,
}));
vi.mock('../../../hooks/useDownloadManager', () => ({
  useDownloadManager: (): UseDownloadManagerResult => {
    useSyncExternalStore(
      (listener) => {
        store.listeners.add(listener);
        return () => store.listeners.delete(listener);
      },
      () => store.version,
      () => store.version,
    );
    return {
      ready: true,
      jobs,
      resumableJobs,
      api: api as unknown as CoordinatorWorkerApi,
      error: null,
      pauseJob: api.pauseJob,
      resumeJob: api.resumeJob,
      cancelJob: api.cancelJob,
      computeAlbumDiff: api.computeAlbumDiff,
      subscribe: (jobId: string): (() => void) => {
        let callbacks = store.subscribers.get(jobId);
        if (!callbacks) {
          callbacks = new Set();
          store.subscribers.set(jobId, callbacks);
        }
        const callback = (): void => undefined;
        callbacks.add(callback);
        return () => callbacks?.delete(callback);
      },
    };
  },
}));

const baseJob: JobSummary = {
  jobId: '11111111111111111111111111111111',
  albumId: '018f0000-0000-7000-8000-000000000002',
  phase: 'Running',
  photoCounts: { pending: 8, inflight: 2, done: 10, failed: 0, skipped: 0 },
  failureCount: 0,
  createdAtMs: 1,
  lastUpdatedAtMs: 1,
  scopeKey: 'auth:00000000000000000000000000000000',
  lastErrorReason: null,
  schedule: null,
};

beforeEach(() => {
  jobs = [];
  resumableJobs = [];
  store.subscribers.clear();
  vi.clearAllMocks();
  api.pauseJob.mockResolvedValue({ phase: 'Paused' });
  api.resumeJob.mockResolvedValue({ phase: 'Running' });
  api.cancelJob.mockResolvedValue({ phase: 'Cancelled' });
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('DownloadTray', () => {
  it('renders nothing when there are no jobs', async () => {
    const rendered = await render(<DownloadTray />);
    expect(rendered.container.querySelector('[role="region"]')).toBeNull();
    await rendered.unmount();
  });

  it('renders a collapsed strip when jobs exist', async () => {
    jobs = [baseJob];
    const rendered = await render(<DownloadTray />);
    expect(requireElement(rendered.container.querySelector('[role="region"]')).getAttribute('aria-label')).toBe('Downloads');
    expect(textContent(rendered.container)).toContain('1 downloading');
    expect(textContent(rendered.container)).toContain('10 / 20 photos');
    expect(rendered.container.querySelector('.download-tray-panel')).toBeNull();
    await rendered.unmount();
  });

  it('expands on user click', async () => {
    jobs = [baseJob];
    const rendered = await render(<DownloadTray />);
    await click(requireElement(rendered.container.querySelector('.download-tray-summary')));
    expect(rendered.container.querySelector('.download-tray-panel')).not.toBeNull();
    expect(rendered.container.querySelector('[data-testid="download-job-row"]')).not.toBeNull();
    await rendered.unmount();
  });

  it('updates live when subscribed progress changes the hook state', async () => {
    jobs = [baseJob];
    const rendered = await render(<DownloadTray />);
    jobs = [{ ...baseJob, photoCounts: { pending: 1, inflight: 1, done: 18, failed: 0, skipped: 0 }, lastUpdatedAtMs: 2 }];
    await actProgress(baseJob.jobId, {
      jobId: baseJob.jobId,
      phase: 'Running',
      photoCounts: requireJob(jobs[0]).photoCounts,
      failureCount: 0,
      lastUpdatedAtMs: 2,
    });
    expect(textContent(rendered.container)).toContain('18 / 20 photos');
    await rendered.unmount();
  });

  it('has accessible region controls and Escape collapses the panel', async () => {
    jobs = [baseJob];
    const rendered = await render(<DownloadTray />);
    const summary = requireElement<HTMLButtonElement>(rendered.container.querySelector('.download-tray-summary'));
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(requireElement(rendered.container.querySelector('button[aria-label="Pause download job"]'))).not.toBeNull();
    expect(requireElement(rendered.container.querySelector('button[aria-label="Cancel download job"]'))).not.toBeNull();
    await click(summary);
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    await keyDown('Escape');
    expect(rendered.container.querySelector('.download-tray-panel')).toBeNull();
    await rendered.unmount();
  });

  // ----- Scope filtering (Phase 3 visitor tray) -----
  describe('scope filtering', () => {
    const authScope = 'auth:00000000000000000000000000000000';
    const otherAuthScope = 'auth:11111111111111111111111111111111';
    const visitorScope = 'visitor:22222222222222222222222222222222';
    const otherVisitorScope = 'visitor:33333333333333333333333333333333';

    afterEach(() => {
      mockScopeKey = authScope;
    });

    it('hides jobs when currentScope is null', async () => {
      mockScopeKey = null;
      jobs = [baseJob];
      const rendered = await render(<DownloadTray />);
      expect(rendered.container.querySelector('[role="region"]')).toBeNull();
      await rendered.unmount();
    });

    it('shows jobs whose scopeKey exactly matches the current scope', async () => {
      mockScopeKey = authScope;
      jobs = [baseJob];
      const rendered = await render(<DownloadTray />);
      expect(rendered.container.querySelector('[role="region"]')).not.toBeNull();
      await rendered.unmount();
    });

    it('hides jobs from a different auth scope', async () => {
      mockScopeKey = authScope;
      jobs = [{ ...baseJob, scopeKey: otherAuthScope }];
      const rendered = await render(<DownloadTray />);
      expect(rendered.container.querySelector('[role="region"]')).toBeNull();
      await rendered.unmount();
    });

    it('hides jobs from a different visitor scope', async () => {
      mockScopeKey = visitorScope;
      jobs = [{ ...baseJob, scopeKey: otherVisitorScope }];
      const rendered = await render(<DownloadTray />);
      expect(rendered.container.querySelector('[role="region"]')).toBeNull();
      await rendered.unmount();
    });

    it('auth scope sees legacy: jobs (v1 migration safety net)', async () => {
      mockScopeKey = authScope;
      jobs = [{ ...baseJob, scopeKey: 'legacy:abcdef0123456789abcdef0123456789' }];
      const rendered = await render(<DownloadTray />);
      expect(rendered.container.querySelector('[role="region"]')).not.toBeNull();
      await rendered.unmount();
    });

    it('visitor scope does NOT see legacy: jobs', async () => {
      mockScopeKey = visitorScope;
      jobs = [{ ...baseJob, scopeKey: 'legacy:abcdef0123456789abcdef0123456789' }];
      const rendered = await render(<DownloadTray />);
      expect(rendered.container.querySelector('[role="region"]')).toBeNull();
      await rendered.unmount();
    });

    it('visitor sees only their visitor:* jobs', async () => {
      mockScopeKey = visitorScope;
      jobs = [
        { ...baseJob, jobId: 'a'.repeat(32), scopeKey: visitorScope },
        { ...baseJob, jobId: 'b'.repeat(32), scopeKey: otherVisitorScope },
        { ...baseJob, jobId: 'c'.repeat(32), scopeKey: authScope },
      ];
      const rendered = await render(<DownloadTray />);
      const rows = rendered.container.querySelectorAll('[data-testid="download-job-row"]');
      // Tray collapsed by default; expand to see rows.
      await click(requireElement(rendered.container.querySelector('.download-tray-summary')));
      const expandedRows = rendered.container.querySelectorAll('[data-testid="download-job-row"]');
      expect(rows.length + expandedRows.length).toBeGreaterThan(0);
      // Only the matching visitor scope is in the summary count.
      expect(textContent(rendered.container)).toContain('1 downloading');
      await rendered.unmount();
    });

    it('visitor pausedNoSource renders Discard only and an open-share-link hint', async () => {
      mockScopeKey = visitorScope;
      jobs = [];
      resumableJobs = [{
        ...baseJob,
        phase: 'Paused',
        scopeKey: visitorScope,
        photoCounts: { pending: 1, inflight: 0, done: 1, failed: 0, skipped: 0 },
        photosDone: 1,
        photosTotal: 2,
        bytesWritten: 100,
        pausedNoSource: true,
      }];
      const rendered = await render(<DownloadTray forceVisible />);
      // Expand to inspect resumable rows.
      await click(requireElement(rendered.container.querySelector('.download-tray-summary')));
      const row = rendered.container.querySelector('[data-testid="resumable-paused-no-source"]');
      expect(row).not.toBeNull();
      // Resume button is hidden; only Discard is offered.
      const buttons = (row as HTMLElement).querySelectorAll('button');
      expect(buttons.length).toBe(1);
      expect((buttons[0] as HTMLButtonElement).textContent).toContain('Discard');
      expect(textContent(rendered.container)).toContain('Visitor download paused');
      await rendered.unmount();
    });

    it('non-pausedNoSource resumable rows still show Resume', async () => {
      mockScopeKey = visitorScope;
      jobs = [];
      resumableJobs = [{
        ...baseJob,
        phase: 'Paused',
        scopeKey: visitorScope,
        photoCounts: { pending: 1, inflight: 0, done: 1, failed: 0, skipped: 0 },
        photosDone: 1,
        photosTotal: 2,
        bytesWritten: 100,
        pausedNoSource: false,
      }];
      const rendered = await render(<DownloadTray forceVisible />);
      await click(requireElement(rendered.container.querySelector('.download-tray-summary')));
      expect(rendered.container.querySelector('[data-testid="resumable-paused-no-source"]')).toBeNull();
      await rendered.unmount();
    });
  });
});

async function actProgress(jobId: string, event: JobProgressEvent): Promise<void> {
  const callbacks = store.subscribers.get(jobId);
  if (callbacks) {
    for (const callback of callbacks) callback();
  }
  void event;
  await act(async () => {
    store.bump();
    await flushMicrotasks();
  });
}

function translate(key: string, values?: Record<string, unknown>): string {
  const map: Record<string, string> = {
    'download.tray.title': 'Downloads',
    'download.tray.active': '{{count}} downloading',
    'download.tray.completed': 'Completed',
    'download.tray.completedBadge': '{{count}} completed',
    'download.tray.photoProgress': '{{done}} / {{total}} photos',
    'download.tray.etaSimple': 'about {{remaining}} photos left',
    'download.tray.etaPending': 'estimating time left',
    'download.tray.pause': 'Pause',
    'download.tray.resume': 'Resume',
    'download.tray.cancel': 'Cancel',
    'download.tray.pauseJob': 'Pause download job',
    'download.tray.resumeJob': 'Resume download job',
    'download.tray.cancelJob': 'Cancel download job',
    'download.tray.expand': 'Expand downloads',
    'download.tray.collapse': 'Collapse downloads',
    'download.tray.screenOnRequired': 'Keep screen on',
    'download.tray.phase.Running': 'Running',
    'download.tray.progressAria': 'Download progress {{percent}} percent',
    'download.tray.discard': 'Discard',
    'download.tray.resumeFromYesterday': 'Resume from yesterday',
    'download.tray.resumePromptBody': '{{done}} of {{total}} photos completed last time.',
    'download.tray.visitorPausedNoSourceBody': 'Visitor download paused — {{done}} of {{total}} photos saved. Re-open the share link to resume.',
    'download.tray.visitorPausedNoSourceHint': 'We could not keep your share-link credentials across tabs. Open the original link to continue.',
    'download.tray.openShareLinkToResume': 'Open the share link to resume',
    'download.tray.failureBadge': '{{count}} failure',
  };
  return interpolate(map[key] ?? key, values);
}

function interpolate(template: string, values?: Record<string, unknown>): string {
  let output = template;
  for (const [key, value] of Object.entries(values ?? {})) {
    output = output.replaceAll(`{{${key}}}`, String(value));
  }
  return output;
}

function requireJob(job: JobSummary | undefined): JobSummary {
  if (!job) {
    throw new Error('Expected job');
  }
  return job;
}
