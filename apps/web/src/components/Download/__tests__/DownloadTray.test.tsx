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
