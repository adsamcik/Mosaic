/**
 * SharedAlbumViewer Component Tests
 *
 * Tests the SharedAlbumViewer component for anonymous share link viewing.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Use vi.hoisted for mocks
const mocks = vi.hoisted(() => ({
  useLinkKeys: vi.fn(),
  parseLinkFragment: vi.fn(),
}));

// Mock useLinkKeys hook
vi.mock('../src/hooks/useLinkKeys', () => ({
  useLinkKeys: (...args: unknown[]) => mocks.useLinkKeys(...args),
  parseLinkFragment: (...args: unknown[]) => mocks.parseLinkFragment(...args),
}));

// Mock SharedGallery component
vi.mock('../src/components/Shared/SharedGallery', () => ({
  SharedGallery: ({ linkId, albumId, accessTier }: { linkId: string; albumId: string; accessTier: number }) => 
    createElement('div', { 'data-testid': 'shared-gallery' }, [
      createElement('span', { key: 'link', 'data-testid': 'gallery-link-id' }, linkId),
      createElement('span', { key: 'album', 'data-testid': 'gallery-album-id' }, albumId),
      createElement('span', { key: 'tier', 'data-testid': 'gallery-access-tier' }, String(accessTier)),
    ]),
}));

// Import after mocks
import { SharedAlbumViewer } from '../src/components/Shared/SharedAlbumViewer';

// Helper to render component
function renderComponent(props: { linkId: string }) {
  const container = document.createElement('div');
  document.body.appendChild(container);

  let root: ReturnType<typeof createRoot>;
  act(() => {
    root = createRoot(container);
    root.render(createElement(SharedAlbumViewer, props));
  });

  const getByTestId = (testId: string) =>
    container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;

  const getByText = (text: string | RegExp) => {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const content = walker.currentNode.textContent;
      if (content) {
        if (typeof text === 'string' && content.includes(text)) {
          return walker.currentNode.parentElement;
        }
        if (text instanceof RegExp && text.test(content)) {
          return walker.currentNode.parentElement;
        }
      }
    }
    return null;
  };

  const queryAllByText = (text: string | RegExp): HTMLElement[] => {
    const results: HTMLElement[] = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const content = walker.currentNode.textContent;
      if (content) {
        if (typeof text === 'string' && content.includes(text)) {
          if (walker.currentNode.parentElement) {
            results.push(walker.currentNode.parentElement);
          }
        }
        if (text instanceof RegExp && text.test(content)) {
          if (walker.currentNode.parentElement) {
            results.push(walker.currentNode.parentElement);
          }
        }
      }
    }
    return results;
  };

  return {
    container,
    getByTestId,
    getByText,
    queryAllByText,
    cleanup: () => {
      act(() => { root.unmount(); });
      container.remove();
    },
  };
}

describe('SharedAlbumViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';

    // Mock window.location
    Object.defineProperty(window, 'location', {
      value: {
        pathname: '/s/test-link-id',
        hash: '#k=test-secret',
      },
      writable: true,
      configurable: true,
    });

    // Default mock for parseLinkFragment
    mocks.parseLinkFragment.mockReturnValue('test-secret');

    // Default successful state
    mocks.useLinkKeys.mockReturnValue({
      isLoading: false,
      error: null,
      linkId: 'test-link-id',
      accessTier: 2,
      albumId: 'album-123',
      tierKeys: new Map([[1, new Map([[2, { epochId: 1, tier: 2, key: new Uint8Array(32) }]])]]),
      isValid: true,
      getReadKey: vi.fn(),
      getSignPubkey: vi.fn(),
      refresh: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  describe('rendering states', () => {
    it('should show loading state while keys are loading', () => {
      mocks.useLinkKeys.mockReturnValue({
        isLoading: true,
        error: null,
        linkId: null,
        accessTier: null,
        albumId: null,
        tierKeys: new Map(),
        isValid: false,
        getReadKey: vi.fn(),
        getSignPubkey: vi.fn(),
        refresh: vi.fn(),
      });

      const { getByText, getByTestId, cleanup } = renderComponent({ linkId: 'test-link-id' });

      expect(getByText('Validating share link...')).not.toBeNull();
      expect(getByTestId('shared-album-viewer')).not.toBeNull();

      cleanup();
    });

    it('should show error when link secret is missing', () => {
      mocks.parseLinkFragment.mockReturnValue(null);
      Object.defineProperty(window, 'location', {
        value: {
          pathname: '/s/test-link-id',
          hash: '',
        },
        writable: true,
        configurable: true,
      });

      const { getByText, cleanup } = renderComponent({ linkId: 'test-link-id' });

      expect(getByText('Invalid Share Link')).not.toBeNull();
      expect(getByText(/secret key is missing/i)).not.toBeNull();

      cleanup();
    });

    it('should show error when link is invalid', () => {
      mocks.useLinkKeys.mockReturnValue({
        isLoading: false,
        error: new Error('This link has expired'),
        linkId: 'test-link-id',
        accessTier: null,
        albumId: null,
        tierKeys: new Map(),
        isValid: false,
        getReadKey: vi.fn(),
        getSignPubkey: vi.fn(),
        refresh: vi.fn(),
      });

      const { getByText, cleanup } = renderComponent({ linkId: 'test-link-id' });

      expect(getByText('Unable to Access Album')).not.toBeNull();
      expect(getByText('This link has expired')).not.toBeNull();

      cleanup();
    });

    it('should show gallery when link is valid', () => {
      const { getByTestId, cleanup } = renderComponent({ linkId: 'test-link-id' });

      expect(getByTestId('shared-gallery')).not.toBeNull();
      expect(getByTestId('gallery-album-id')?.textContent).toBe('album-123');
      expect(getByTestId('gallery-access-tier')?.textContent).toBe('2');

      cleanup();
    });

    it('should display correct access tier name', () => {
      mocks.useLinkKeys.mockReturnValue({
        isLoading: false,
        error: null,
        linkId: 'test-link-id',
        accessTier: 3 as const,
        albumId: 'album-123',
        tierKeys: new Map(),
        isValid: true,
        getReadKey: vi.fn(),
        getSignPubkey: vi.fn(),
        refresh: vi.fn(),
      });

      const { getByText, cleanup } = renderComponent({ linkId: 'test-link-id' });

      expect(getByText('Full Access')).not.toBeNull();

      cleanup();
    });
  });

  describe('header elements', () => {
    it('should display app title', () => {
      const { getByText, cleanup } = renderComponent({ linkId: 'test-link-id' });

      expect(getByText('🖼️ Mosaic')).not.toBeNull();

      cleanup();
    });

    it('should display shared album badge', () => {
      const { getByText, cleanup } = renderComponent({ linkId: 'test-link-id' });

      expect(getByText('Shared Album')).not.toBeNull();

      cleanup();
    });
  });

  describe('footer', () => {
    it('should display footer with branding', () => {
      const { getByText, cleanup } = renderComponent({ linkId: 'test-link-id' });

      expect(getByText(/Powered by/i)).not.toBeNull();
      expect(getByText(/Zero-knowledge encrypted/i)).not.toBeNull();

      cleanup();
    });
  });

  describe('link ID handling', () => {
    it('should use linkId from props if provided', () => {
      const { cleanup } = renderComponent({ linkId: 'prop-link-id' });

      // useLinkKeys should be called with the prop linkId
      expect(mocks.useLinkKeys).toHaveBeenCalledWith('prop-link-id', 'test-secret');

      cleanup();
    });
  });
});

describe('SharedAlbumViewer access tier display', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    mocks.parseLinkFragment.mockReturnValue('test-secret');
    Object.defineProperty(window, 'location', {
      value: {
        pathname: '/s/test-link-id',
        hash: '#k=test-secret',
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it.each([
    [1, 'Thumbnails Only'],
    [2, 'Preview'],
    [3, 'Full Access'],
  ])('should display correct tier name for tier %d', (tier, expectedText) => {
    mocks.useLinkKeys.mockReturnValue({
      isLoading: false,
      error: null,
      linkId: 'test-link-id',
      accessTier: tier as 1 | 2 | 3,
      albumId: 'album-123',
      tierKeys: new Map(),
      isValid: true,
      getReadKey: vi.fn(),
      getSignPubkey: vi.fn(),
      refresh: vi.fn(),
    });

    const { getByText, cleanup } = renderComponent({ linkId: 'test-link-id' });

    expect(getByText(expectedText)).not.toBeNull();

    cleanup();
  });
});
