/**
 * SharedAlbumViewer Component Tests
 *
 * Tests the SharedAlbumViewer component for anonymous share link viewing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

// Mock useLinkKeys hook
const mockUseLinkKeys = vi.fn();
const mockParseLinkFragment = vi.fn();

vi.mock('../../src/hooks/useLinkKeys', () => ({
  useLinkKeys: (...args: unknown[]) => mockUseLinkKeys(...args),
  parseLinkFragment: (...args: unknown[]) => mockParseLinkFragment(...args),
}));

// Mock SharedGallery component
vi.mock('../../src/components/Shared/SharedGallery', () => ({
  SharedGallery: ({ linkId, albumId, accessTier }: { linkId: string; albumId: string; accessTier: number }) => (
    <div data-testid="shared-gallery">
      <span data-testid="gallery-link-id">{linkId}</span>
      <span data-testid="gallery-album-id">{albumId}</span>
      <span data-testid="gallery-access-tier">{accessTier}</span>
    </div>
  ),
}));

// Import after mocks
import { SharedAlbumViewer } from '../../src/components/Shared/SharedAlbumViewer';

describe('SharedAlbumViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Mock window.location
    Object.defineProperty(window, 'location', {
      value: {
        pathname: '/s/test-link-id',
        hash: '#k=test-secret',
      },
      writable: true,
    });

    // Default mock for parseLinkFragment
    mockParseLinkFragment.mockReturnValue('test-secret');

    // Default successful state
    mockUseLinkKeys.mockReturnValue({
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
    cleanup();
    vi.restoreAllMocks();
  });

  describe('rendering states', () => {
    it('should show loading state while keys are loading', () => {
      mockUseLinkKeys.mockReturnValue({
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

      render(<SharedAlbumViewer linkId="test-link-id" />);

      expect(screen.getByText('Validating share link...')).toBeInTheDocument();
      expect(screen.getByTestId('shared-album-viewer')).toBeInTheDocument();
    });

    it('should show error when link secret is missing', () => {
      mockParseLinkFragment.mockReturnValue(null);
      Object.defineProperty(window, 'location', {
        value: {
          pathname: '/s/test-link-id',
          hash: '', // No hash
        },
        writable: true,
      });

      render(<SharedAlbumViewer linkId="test-link-id" />);

      expect(screen.getByText('Invalid Share Link')).toBeInTheDocument();
      expect(screen.getByText(/secret key is missing/i)).toBeInTheDocument();
    });

    it('should show error when link is invalid', () => {
      mockUseLinkKeys.mockReturnValue({
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

      render(<SharedAlbumViewer linkId="test-link-id" />);

      expect(screen.getByText('Unable to Access Album')).toBeInTheDocument();
      expect(screen.getByText('This link has expired')).toBeInTheDocument();
    });

    it('should show gallery when link is valid', () => {
      render(<SharedAlbumViewer linkId="test-link-id" />);

      expect(screen.getByTestId('shared-gallery')).toBeInTheDocument();
      expect(screen.getByTestId('gallery-album-id')).toHaveTextContent('album-123');
      expect(screen.getByTestId('gallery-access-tier')).toHaveTextContent('2');
    });

    it('should display correct access tier name', () => {
      mockUseLinkKeys.mockReturnValue({
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

      render(<SharedAlbumViewer linkId="test-link-id" />);

      expect(screen.getByText('Full Access')).toBeInTheDocument();
    });
  });

  describe('header elements', () => {
    it('should display app title', () => {
      render(<SharedAlbumViewer linkId="test-link-id" />);

      expect(screen.getByText('🖼️ Mosaic')).toBeInTheDocument();
    });

    it('should display shared album badge', () => {
      render(<SharedAlbumViewer linkId="test-link-id" />);

      expect(screen.getByText('Shared Album')).toBeInTheDocument();
    });
  });

  describe('footer', () => {
    it('should display footer with branding', () => {
      render(<SharedAlbumViewer linkId="test-link-id" />);

      expect(screen.getByText(/Powered by/i)).toBeInTheDocument();
      expect(screen.getByText(/Zero-knowledge encrypted/i)).toBeInTheDocument();
    });
  });

  describe('link ID handling', () => {
    it('should use linkId from props if provided', () => {
      render(<SharedAlbumViewer linkId="prop-link-id" />);

      // useLinkKeys should be called with the prop linkId
      expect(mockUseLinkKeys).toHaveBeenCalledWith('prop-link-id', 'test-secret');
    });
  });
});

describe('SharedAlbumViewer access tier display', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParseLinkFragment.mockReturnValue('test-secret');
    Object.defineProperty(window, 'location', {
      value: {
        pathname: '/s/test-link-id',
        hash: '#k=test-secret',
      },
      writable: true,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it.each([
    [1, 'Thumbnails Only'],
    [2, 'Preview'],
    [3, 'Full Access'],
  ])('should display correct tier name for tier %d', (tier, expectedText) => {
    mockUseLinkKeys.mockReturnValue({
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

    render(<SharedAlbumViewer linkId="test-link-id" />);

    expect(screen.getByText(expectedText)).toBeInTheDocument();
  });
});
