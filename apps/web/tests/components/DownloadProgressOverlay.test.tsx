import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadProgressOverlay } from '../../src/components/Gallery/DownloadProgressOverlay';
import type { AlbumDownloadProgress } from '../../src/lib/album-download-service';

vi.mock('../../src/styles/download-progress.css', () => ({}));

function makeProgress(overrides: Partial<AlbumDownloadProgress> = {}): AlbumDownloadProgress {
  return {
    phase: 'downloading',
    currentFileName: 'photo-001.jpg',
    completedFiles: 3,
    totalFiles: 10,
    ...overrides,
  };
}

interface RenderResult {
  container: HTMLDivElement;
  getByTestId: (id: string) => Element | null;
  queryByTestId: (id: string) => Element | null;
  cleanup: () => void;
  rerender: (newProps: Partial<{ progress: AlbumDownloadProgress; onCancel: () => void }>) => void;
}

function renderComponent(
  props: Partial<{ progress: AlbumDownloadProgress; onCancel: () => void }> = {},
): RenderResult {
  const defaultProps = {
    progress: makeProgress(),
    onCancel: vi.fn(),
  };

  const merged = { ...defaultProps, ...props };

  const container = document.createElement('div');
  document.body.appendChild(container);

  let root: ReturnType<typeof createRoot>;
  act(() => {
    root = createRoot(container);
    root.render(createElement(DownloadProgressOverlay, merged));
  });

  const getByTestId = (testId: string) =>
    container.querySelector(`[data-testid="${testId}"]`);
  const queryByTestId = (testId: string) =>
    container.querySelector(`[data-testid="${testId}"]`);

  const cleanup = () => {
    act(() => { root!.unmount(); });
    container.remove();
  };

  const rerender = (newProps: Partial<{ progress: AlbumDownloadProgress; onCancel: () => void }>) => {
    act(() => {
      root.render(createElement(DownloadProgressOverlay, { ...merged, ...newProps }));
    });
  };

  return { container, getByTestId, queryByTestId, cleanup, rerender };
}

describe('DownloadProgressOverlay', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Rendering ---

  describe('rendering', () => {
    it('renders the overlay', () => {
      const { getByTestId, cleanup } = renderComponent();
      expect(getByTestId('download-progress-overlay')).not.toBeNull();
      cleanup();
    });

    it('shows preparing state text', () => {
      const { container, cleanup } = renderComponent({
        progress: makeProgress({ phase: 'preparing' }),
      });
      expect(container.textContent).toContain('download.preparing');
      cleanup();
    });

    it('shows downloading state with filename', () => {
      const { container, cleanup } = renderComponent({
        progress: makeProgress({ phase: 'downloading', currentFileName: 'sunset.jpg' }),
      });
      expect(container.textContent).toContain('download.downloading');
      expect(container.textContent).toContain('sunset.jpg');
      cleanup();
    });

    it('shows complete state with success message and title', () => {
      const { container, cleanup } = renderComponent({
        progress: makeProgress({ phase: 'complete', completedFiles: 7, totalFiles: 7 }),
      });
      expect(container.textContent).toContain('download.complete');
      expect(container.textContent).toContain('download.completeMessage');
      cleanup();
    });

    it('adds download-progress-complete CSS class when complete', () => {
      const { container, cleanup } = renderComponent({
        progress: makeProgress({ phase: 'complete' }),
      });
      const card = container.querySelector('.download-progress-card');
      expect(card?.classList.contains('download-progress-complete')).toBe(true);
      cleanup();
    });
  });

  // --- Progress Bar ---

  describe('progress bar', () => {
    it('calculates percentage correctly', () => {
      const { container, cleanup } = renderComponent({
        progress: makeProgress({ completedFiles: 3, totalFiles: 10 }),
      });
      const bar = container.querySelector('[role="progressbar"]') as HTMLElement;
      expect(bar.getAttribute('aria-valuenow')).toBe('30');
      expect(bar.style.width).toBe('30%');
      cleanup();
    });

    it('shows 0% when totalFiles is 0', () => {
      const { container, cleanup } = renderComponent({
        progress: makeProgress({ completedFiles: 0, totalFiles: 0 }),
      });
      const bar = container.querySelector('[role="progressbar"]') as HTMLElement;
      expect(bar.getAttribute('aria-valuenow')).toBe('0');
      expect(bar.style.width).toBe('0%');
      cleanup();
    });

    it('shows file count text', () => {
      const { container, cleanup } = renderComponent({
        progress: makeProgress({ completedFiles: 5, totalFiles: 10 }),
      });
      expect(container.textContent).toContain('5 / 10');
      cleanup();
    });
  });

  // --- Cancel Button ---

  describe('cancel button', () => {
    it('is visible during download', () => {
      const { queryByTestId, cleanup } = renderComponent({
        progress: makeProgress({ phase: 'downloading' }),
      });
      expect(queryByTestId('download-cancel-button')).not.toBeNull();
      cleanup();
    });

    it('is hidden when complete', () => {
      const { queryByTestId, cleanup } = renderComponent({
        progress: makeProgress({ phase: 'complete' }),
      });
      expect(queryByTestId('download-cancel-button')).toBeNull();
      cleanup();
    });

    it('calls onCancel when clicked', () => {
      const onCancel = vi.fn();
      const { getByTestId, cleanup } = renderComponent({ onCancel });
      const button = getByTestId('download-cancel-button') as HTMLButtonElement;
      act(() => { button.click(); });
      expect(onCancel).toHaveBeenCalledOnce();
      cleanup();
    });
  });

  // --- Keyboard ---

  describe('keyboard', () => {
    it('Escape key triggers onCancel during download', () => {
      const onCancel = vi.fn();
      const { cleanup } = renderComponent({
        onCancel,
        progress: makeProgress({ phase: 'downloading' }),
      });
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      expect(onCancel).toHaveBeenCalledOnce();
      cleanup();
    });

    it('Escape key does NOT trigger onCancel when complete', () => {
      const onCancel = vi.fn();
      const { cleanup } = renderComponent({
        onCancel,
        progress: makeProgress({ phase: 'complete' }),
      });
      // Clear any calls from the auto-close timer setup
      onCancel.mockClear();
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      expect(onCancel).not.toHaveBeenCalled();
      cleanup();
    });
  });

  // --- Auto-Close ---

  describe('auto-close', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('auto-closes after 2 seconds when complete', () => {
      const onCancel = vi.fn();
      const { cleanup } = renderComponent({
        onCancel,
        progress: makeProgress({ phase: 'complete' }),
      });
      expect(onCancel).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(2000); });
      expect(onCancel).toHaveBeenCalledOnce();
      cleanup();
    });
  });

  // --- Accessibility ---

  describe('accessibility', () => {
    it('progress bar has correct ARIA attributes', () => {
      const { container, cleanup } = renderComponent({
        progress: makeProgress({ completedFiles: 6, totalFiles: 12 }),
      });
      const bar = container.querySelector('[role="progressbar"]') as HTMLElement;
      expect(bar).not.toBeNull();
      expect(bar.getAttribute('aria-valuenow')).toBe('50');
      expect(bar.getAttribute('aria-valuemin')).toBe('0');
      expect(bar.getAttribute('aria-valuemax')).toBe('100');
      cleanup();
    });
  });
});
