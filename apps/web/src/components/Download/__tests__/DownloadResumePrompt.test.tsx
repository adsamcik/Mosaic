import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoordinatorWorkerApi, CurrentAlbumManifest, ResumableJobSummary } from '../../../workers/types';
import type { UseDownloadManagerResult } from '../../../hooks/useDownloadManager';
import { DownloadResumePrompt } from '../DownloadResumePrompt';
import { click, flushMicrotasks, render, requireElement, textContent } from './DownloadTestUtils';

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

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));
vi.mock('../../../hooks/useDownloadManager', () => ({
  useDownloadManager: (): UseDownloadManagerResult => ({
    ready: true,
    jobs: [],
    resumableJobs: [],
    api: api as unknown as CoordinatorWorkerApi,
    error: null,
    pauseJob: api.pauseJob,
    resumeJob: api.resumeJob,
    cancelJob: api.cancelJob,
    computeAlbumDiff: api.computeAlbumDiff,
    subscribe: () => (): void => undefined,
  }),
}));

const resumableJob: ResumableJobSummary = {
  jobId: '33333333333333333333333333333333',
  albumId: '018f0000-0000-7000-8000-000000000004',
  phase: 'Paused',
  photoCounts: { pending: 5, inflight: 0, done: 5, failed: 0, skipped: 0 },
  failureCount: 0,
  createdAtMs: 1,
  lastUpdatedAtMs: 1,
  photosDone: 5,
  photosTotal: 10,
  bytesWritten: 2048,
};

const manifest: CurrentAlbumManifest = { albumId: resumableJob.albumId, photos: [] };

beforeEach(() => {
  vi.clearAllMocks();
  api.computeAlbumDiff.mockResolvedValue({ added: ['a'], removed: [], rekeyed: ['r'], shardChanged: [], unchanged: ['u'] });
  api.cancelJob.mockResolvedValue({ phase: 'Cancelled' });
});

afterEach(() => document.body.replaceChildren());

describe('DownloadResumePrompt', () => {
  it('lists resumable jobs', async () => {
    const rendered = await render(<DownloadResumePrompt resumableJobs={[resumableJob]} getCurrentManifest={async () => manifest} />);
    expect(textContent(rendered.container)).toContain('Resume your previous download?');
    expect(textContent(rendered.container)).toContain('5 of 10 photos completed last time.');
    await rendered.unmount();
  });

  it('calls getCurrentManifest and surfaces diff on Resume click', async () => {
    const getCurrentManifest = vi.fn(async () => manifest);
    const rendered = await render(<DownloadResumePrompt resumableJobs={[resumableJob]} getCurrentManifest={getCurrentManifest} />);
    await click(requireElement(rendered.container.querySelector('button')));
    await flushMicrotasks();
    expect(getCurrentManifest).toHaveBeenCalledWith(resumableJob.albumId);
    expect(api.computeAlbumDiff).toHaveBeenCalledWith(resumableJob.jobId, manifest);
    expect(textContent(rendered.container)).toContain('1 new photos');
    expect(textContent(rendered.container)).toContain('1 re-encrypted');
    await rendered.unmount();
  });

  it('discard button calls cancelJob with soft false', async () => {
    const rendered = await render(<DownloadResumePrompt resumableJobs={[resumableJob]} getCurrentManifest={async () => manifest} />);
    const discard = requireElement(Array.from(rendered.container.querySelectorAll('button')).find((button) => button.textContent === 'Discard progress') ?? null);
    await click(discard);
    expect(api.cancelJob).toHaveBeenCalledWith(resumableJob.jobId, { soft: false });
    await rendered.unmount();
  });
});

function translate(key: string, values?: Record<string, unknown>): string {
  const map: Record<string, string> = {
    'download.tray.resumePromptTitle': 'Resume your previous download?',
    'download.tray.resumePromptBody': '{{done}} of {{total}} photos completed last time.',
    'download.tray.resume': 'Resume',
    'download.tray.discard': 'Discard progress',
    'download.diff.title': 'Album has changed',
    'download.diff.added': '{{count}} new photos',
    'download.diff.removed': '{{count}} removed',
    'download.diff.rekeyed': '{{count}} re-encrypted',
    'download.diff.shardChanged': '{{count}} re-uploaded',
    'download.diff.unchanged': '{{count}} unchanged',
  };
  let output = map[key] ?? key;
  for (const [name, value] of Object.entries(values ?? {})) {
    output = output.replaceAll(`{{${name}}}`, String(value));
  }
  return output;
}
