/**
 * @vitest-environment happy-dom
 */
/**
 * ShareLinksPanel Component Tests
 *
 * Tests the ShareLinksPanel component using vitest + happy-dom.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShareLinksPanel } from '../src/components/ShareLinks/ShareLinksPanel';

// Mock useShareLinks hook
const mockUseShareLinks = vi.fn();
vi.mock('../src/hooks/useShareLinks', () => ({
  useShareLinks: (...args: unknown[]) => mockUseShareLinks(...args),
}));

// Default mock return values
const defaultMockState = {
  shareLinks: [],
  isLoading: false,
  error: null,
  refetch: vi.fn(),
  createShareLink: vi.fn().mockResolvedValue({
    shareLink: {
      id: 'link-1',
      linkId: 'abc123',
      accessTier: 2,
      accessTierDisplay: 'Preview',
      isExpired: false,
    },
    shareUrl: 'http://localhost/s/abc123#secret',
    linkSecret: 'secret',
  }),
  isCreating: false,
  createError: null,
  revokeShareLink: vi.fn().mockResolvedValue(undefined),
  isRevoking: false,
  revokeError: null,
};

// Helper to render ShareLinksPanel
function renderShareLinksPanel(
  props: Partial<Parameters<typeof ShareLinksPanel>[0]> = {},
) {
  const defaultProps = {
    albumId: 'album-123',
    isOpen: true,
    onClose: vi.fn(),
    isOwner: true,
  };

  const container = document.createElement('div');
  document.body.appendChild(container);

  let root: ReturnType<typeof createRoot>;
  act(() => {
    root = createRoot(container);
    root.render(createElement(ShareLinksPanel, { ...defaultProps, ...props }));
  });

  const getByTestId = (testId: string) =>
    document.querySelector(`[data-testid="${testId}"]`);
  const queryByTestId = (testId: string) =>
    document.querySelector(`[data-testid="${testId}"]`);

  const cleanup = () => {
    act(() => {
      root!.unmount();
    });
    container.remove();
  };

  const rerender = (
    newProps: Partial<Parameters<typeof ShareLinksPanel>[0]>,
  ) => {
    act(() => {
      root.render(
        createElement(ShareLinksPanel, {
          ...defaultProps,
          ...props,
          ...newProps,
        }),
      );
    });
  };

  return {
    container,
    getByTestId,
    queryByTestId,
    cleanup,
    rerender,
    props: { ...defaultProps, ...props },
  };
}

describe('ShareLinksPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    mockUseShareLinks.mockReturnValue({ ...defaultMockState });
  });

  describe('rendering', () => {
    it('renders the panel when isOpen is true', () => {
      const { getByTestId, cleanup } = renderShareLinksPanel({ isOpen: true });

      expect(getByTestId('share-links-panel')).not.toBeNull();
      cleanup();
    });

    it('does not render when isOpen is false', () => {
      const { queryByTestId, cleanup } = renderShareLinksPanel({
        isOpen: false,
      });

      expect(queryByTestId('share-links-panel')).toBeNull();
      cleanup();
    });

    it('renders the panel header with title', () => {
      const { getByTestId, cleanup } = renderShareLinksPanel();

      const header = getByTestId('share-links-panel');
      expect(header?.textContent).toContain('Share Links');
      cleanup();
    });

    it('renders close button', () => {
      const { getByTestId, cleanup } = renderShareLinksPanel();

      const closeButton = getByTestId('close-share-links-button');
      expect(closeButton).not.toBeNull();
      cleanup();
    });

    it('renders the share links list', () => {
      const { getByTestId, cleanup } = renderShareLinksPanel();

      expect(getByTestId('share-links-list')).not.toBeNull();
      cleanup();
    });
  });

  describe('interactions', () => {
    it('calls onClose when close button is clicked', () => {
      const onClose = vi.fn();
      const { getByTestId, cleanup } = renderShareLinksPanel({ onClose });

      const closeButton = getByTestId('close-share-links-button');
      act(() => {
        (closeButton as HTMLElement).click();
      });

      expect(onClose).toHaveBeenCalledTimes(1);
      cleanup();
    });

    it('calls onClose when backdrop is clicked', () => {
      const onClose = vi.fn();
      const { getByTestId, cleanup } = renderShareLinksPanel({ onClose });

      const backdrop = getByTestId('share-links-panel-backdrop');
      act(() => {
        (backdrop as HTMLElement).click();
      });

      expect(onClose).toHaveBeenCalledTimes(1);
      cleanup();
    });

    it('switching to create view when create button is clicked', () => {
      const { getByTestId, queryByTestId, cleanup } = renderShareLinksPanel();

      // Initially list view
      expect(getByTestId('share-links-list')).not.toBeNull();
      expect(queryByTestId('create-share-link-view')).toBeNull();

      // Click create button
      const createButton = getByTestId('create-share-link-button');
      act(() => {
        (createButton as HTMLElement).click();
      });

      // View should switch
      expect(queryByTestId('share-links-list')).toBeNull();
      expect(getByTestId('create-share-link-view')).not.toBeNull();

      // Check title update
      const header = getByTestId('share-links-panel');
      expect(header?.textContent).toContain('shareLink.panel.createTitle');

      // Check back button
      expect(getByTestId('panel-back-button')).not.toBeNull();

      cleanup();
    });

    it('can navigate back from create view', () => {
      const { getByTestId, queryByTestId, cleanup } = renderShareLinksPanel();

      // Go to create view
      const createButton = getByTestId('create-share-link-button');
      act(() => {
        (createButton as HTMLElement).click();
      });

      // Click back
      const backButton = getByTestId('panel-back-button');
      act(() => {
        (backButton as HTMLElement).click();
      });

      // Should be back to list
      expect(getByTestId('share-links-list')).not.toBeNull();
      expect(queryByTestId('create-share-link-view')).toBeNull();
      cleanup();
    });
  });

  describe('useShareLinks integration', () => {
    it('passes albumId to useShareLinks', () => {
      const { cleanup } = renderShareLinksPanel({ albumId: 'test-album-456' });

      expect(mockUseShareLinks).toHaveBeenCalledWith('test-album-456');
      cleanup();
    });

    it('passes share links to ShareLinksList', () => {
      const mockLinks = [
        {
          id: 'link-1',
          linkId: 'abc',
          accessTier: 2,
          accessTierDisplay: 'Preview',
          isExpired: false,
          isRevoked: false,
          useCount: 0,
          createdAt: new Date().toISOString(),
        },
      ];
      mockUseShareLinks.mockReturnValue({
        ...defaultMockState,
        shareLinks: mockLinks,
      });

      const { getByTestId, cleanup } = renderShareLinksPanel();

      // The share-link-item should be rendered
      expect(getByTestId('share-link-item')).not.toBeNull();
      cleanup();
    });

    it('shows loading state from hook', () => {
      mockUseShareLinks.mockReturnValue({
        ...defaultMockState,
        isLoading: true,
      });

      const { getByTestId, cleanup } = renderShareLinksPanel();

      expect(getByTestId('share-links-loading')).not.toBeNull();
      cleanup();
    });

    it('shows error state from hook', () => {
      mockUseShareLinks.mockReturnValue({
        ...defaultMockState,
        error: new Error('Network error'),
      });

      const { getByTestId, cleanup } = renderShareLinksPanel();

      expect(getByTestId('share-links-error')).not.toBeNull();
      expect(getByTestId('share-links-error')?.textContent).toContain(
        'Network error',
      );
      cleanup();
    });
  });

  describe('owner permissions', () => {
    it('shows create button for owners', () => {
      const { getByTestId, cleanup } = renderShareLinksPanel({ isOwner: true });

      expect(getByTestId('create-share-link-button')).not.toBeNull();
      cleanup();
    });

    it('hides create button for non-owners', () => {
      const { queryByTestId, cleanup } = renderShareLinksPanel({
        isOwner: false,
      });

      expect(queryByTestId('create-share-link-button')).toBeNull();
      cleanup();
    });
  });
});
