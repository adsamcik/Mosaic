/**
 * AlbumCard Component Tests
 *
 * Tests the AlbumCard component including expiration badge functionality.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AlbumCard,
  formatExpirationBadge,
  type Album,
} from '../src/components/Albums/AlbumCard';

// Mock the useAlbumCover hook
vi.mock('../src/hooks/useAlbumCover', () => ({
  useAlbumCover: () => ({
    coverUrl: null,
    isLoading: false,
    error: null,
  }),
}));

// Helper to create a mock album
function createMockAlbum(overrides: Partial<Album> = {}): Album {
  return {
    id: 'album-123',
    name: 'Test Album',
    photoCount: 10,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// Helper to get a date N days from now
function daysFromNow(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

// Helper to render component
function renderComponent(
  props: Partial<{
    album: Album;
    onClick: () => void;
  }> = {},
) {
  const defaultProps = {
    album: createMockAlbum(),
    onClick: vi.fn(),
  };

  const container = document.createElement('div');
  document.body.appendChild(container);

  let root: ReturnType<typeof createRoot>;
  act(() => {
    root = createRoot(container);
    root.render(createElement(AlbumCard, { ...defaultProps, ...props }));
  });

  const getByTestId = (testId: string) =>
    container.querySelector(`[data-testid="${testId}"]`);
  const queryByTestId = (testId: string) =>
    container.querySelector(`[data-testid="${testId}"]`);

  const cleanup = () => {
    act(() => {
      root!.unmount();
    });
    container.remove();
  };

  return {
    container,
    getByTestId,
    queryByTestId,
    cleanup,
    props: { ...defaultProps, ...props },
  };
}

describe('AlbumCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('rendering', () => {
    it('renders the album card with name and count', () => {
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ name: 'My Vacation', photoCount: 25 }),
      });

      const albumName = getByTestId('album-name');
      expect(albumName?.textContent).toContain('My Vacation');

      const albumCard = getByTestId('album-card');
      expect(albumCard?.textContent).toContain('album.photoCount:{"count":25}');

      cleanup();
    });

    it('shows singular photo count when count is 1', () => {
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ photoCount: 1 }),
      });

      const albumCard = getByTestId('album-card');
      expect(albumCard?.textContent).toContain('album.photoCount:{"count":1}');

      cleanup();
    });

    it('shows photo count when count is 0', () => {
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ photoCount: 0 }),
      });

      const albumCard = getByTestId('album-card');
      expect(albumCard?.textContent).toContain('album.photoCount:{"count":0}');

      cleanup();
    });

    it('calls onClick when card is clicked', () => {
      const onClick = vi.fn();
      const { getByTestId, cleanup } = renderComponent({ onClick });

      const albumCard = getByTestId('album-card') as HTMLButtonElement;
      act(() => {
        albumCard.click();
      });

      expect(onClick).toHaveBeenCalledTimes(1);

      cleanup();
    });

    it('shows decrypted name when available', () => {
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({
          name: 'Placeholder',
          decryptedName: 'Decrypted Name',
        }),
      });

      const albumName = getByTestId('album-name');
      expect(albumName?.textContent).toContain('Decrypted Name');
      expect(albumName?.textContent).not.toContain('Placeholder');

      cleanup();
    });

    it('shows loading indicator when decrypting', () => {
      const { getByTestId, queryByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ isDecrypting: true }),
      });

      expect(getByTestId('album-name-loading')).toBeTruthy();

      cleanup();
    });

    it('shows error indicator when decryption failed', () => {
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ decryptionFailed: true }),
      });

      expect(getByTestId('album-name-error')).toBeTruthy();

      cleanup();
    });
  });

  describe('expiration badge rendering', () => {
    it('does not show badge when no expiration is set', () => {
      const { queryByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: undefined }),
      });

      expect(queryByTestId('expiration-badge')).toBeNull();

      cleanup();
    });

    it('does not show badge when expiresAt is null', () => {
      const { queryByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: null }),
      });

      expect(queryByTestId('expiration-badge')).toBeNull();

      cleanup();
    });

    it('shows expired badge for past dates', () => {
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: daysFromNow(-1) }),
      });

      const badge = getByTestId('expiration-badge');
      expect(badge?.textContent).toBe('album.expired');
      expect(badge?.className).toContain('expiration-badge--danger');

      cleanup();
    });

    it('shows expires tomorrow badge', () => {
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: daysFromNow(1) }),
      });

      const badge = getByTestId('expiration-badge');
      expect(badge?.textContent).toBe('album.expiresInDay');
      expect(badge?.className).toContain('expiration-badge--warning');

      cleanup();
    });

    it('shows expires in N days badge for 2-7 days', () => {
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: daysFromNow(5) }),
      });

      const badge = getByTestId('expiration-badge');
      expect(badge?.textContent).toBe('album.expiresIn:{"days":5}');
      expect(badge?.className).toContain('expiration-badge--warning');

      cleanup();
    });

    it('shows expires in N weeks badge for 8-30 days', () => {
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: daysFromNow(15) }),
      });

      const badge = getByTestId('expiration-badge');
      expect(badge?.textContent).toBe('album.expiresInWeeks:{"weeks":3}');
      expect(badge?.className).toContain('expiration-badge--info');

      cleanup();
    });

    it('shows months badge for more than 30 days', () => {
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: daysFromNow(60) }),
      });

      const badge = getByTestId('expiration-badge');
      expect(badge?.textContent).toBe('album.expiresInMonths:{"months":2}');
      expect(badge?.className).toContain('expiration-badge--info');

      cleanup();
    });
  });
});

// Mock translation function for formatExpirationBadge tests
const mockT = (key: string, options?: Record<string, unknown>) => {
  if (options) {
    return `${key}:${JSON.stringify(options)}`;
  }
  return key;
};

describe('formatExpirationBadge', () => {
  describe('edge cases', () => {
    it('returns null for undefined input', () => {
      expect(formatExpirationBadge(undefined, mockT)).toBeNull();
    });

    it('returns null for null input', () => {
      expect(formatExpirationBadge(null, mockT)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(formatExpirationBadge('', mockT)).toBeNull();
    });
  });

  describe('expired states', () => {
    it('returns danger variant for expired albums', () => {
      const result = formatExpirationBadge(daysFromNow(-1), mockT);
      expect(result).toEqual({ text: 'album.expired', variant: 'danger' });
    });

    it('returns danger variant for albums expired today', () => {
      // Set to a time earlier today
      const earlier = new Date();
      earlier.setHours(earlier.getHours() - 1);
      const result = formatExpirationBadge(earlier.toISOString(), mockT);
      expect(result).toEqual({ text: 'album.expired', variant: 'danger' });
    });

    it('returns danger variant for albums expired long ago', () => {
      const result = formatExpirationBadge(daysFromNow(-100), mockT);
      expect(result).toEqual({ text: 'album.expired', variant: 'danger' });
    });
  });

  describe('warning states', () => {
    it('returns warning for exactly 1 day left', () => {
      const result = formatExpirationBadge(daysFromNow(1), mockT);
      expect(result).toEqual({
        text: 'album.expiresInDay',
        variant: 'warning',
      });
    });

    it('returns warning for 2 days left', () => {
      const result = formatExpirationBadge(daysFromNow(2), mockT);
      expect(result).toEqual({
        text: 'album.expiresIn:{"days":2}',
        variant: 'warning',
      });
    });

    it('returns warning for 3 days left', () => {
      const result = formatExpirationBadge(daysFromNow(3), mockT);
      expect(result).toEqual({
        text: 'album.expiresIn:{"days":3}',
        variant: 'warning',
      });
    });

    it('returns warning for 7 days left', () => {
      const result = formatExpirationBadge(daysFromNow(7), mockT);
      expect(result).toEqual({
        text: 'album.expiresIn:{"days":7}',
        variant: 'warning',
      });
    });
  });

  describe('info states', () => {
    it('returns info for 8 days left (2 weeks)', () => {
      const result = formatExpirationBadge(daysFromNow(8), mockT);
      expect(result).toEqual({
        text: 'album.expiresInWeeks:{"weeks":2}',
        variant: 'info',
      });
    });

    it('returns info for 15 days left (3 weeks)', () => {
      const result = formatExpirationBadge(daysFromNow(15), mockT);
      expect(result).toEqual({
        text: 'album.expiresInWeeks:{"weeks":3}',
        variant: 'info',
      });
    });

    it('returns info for 21 days left (3 weeks)', () => {
      const result = formatExpirationBadge(daysFromNow(21), mockT);
      expect(result).toEqual({
        text: 'album.expiresInWeeks:{"weeks":3}',
        variant: 'info',
      });
    });

    it('returns info for 30 days left (5 weeks)', () => {
      const result = formatExpirationBadge(daysFromNow(30), mockT);
      expect(result).toEqual({
        text: 'album.expiresInWeeks:{"weeks":5}',
        variant: 'info',
      });
    });

    it('returns info with months for 31 days left', () => {
      const result = formatExpirationBadge(daysFromNow(31), mockT);
      expect(result).toEqual({
        text: 'album.expiresInMonths:{"months":2}',
        variant: 'info',
      });
    });

    it('returns info with months for 60 days left', () => {
      const result = formatExpirationBadge(daysFromNow(60), mockT);
      expect(result).toEqual({
        text: 'album.expiresInMonths:{"months":2}',
        variant: 'info',
      });
    });

    it('returns info with months for 365 days left', () => {
      const result = formatExpirationBadge(daysFromNow(365), mockT);
      expect(result).toEqual({
        text: 'album.expiresInMonths:{"months":13}',
        variant: 'info',
      });
    });
  });

  describe('boundary conditions', () => {
    it('treats exactly 0 days as expired', () => {
      // Create a date that's in the past but same day
      const almostExpired = new Date();
      almostExpired.setHours(almostExpired.getHours() - 1);
      const result = formatExpirationBadge(almostExpired.toISOString(), mockT);
      expect(result?.variant).toBe('danger');
    });

    it('handles ISO date strings correctly', () => {
      const isoDate = new Date(
        Date.now() + 5 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const result = formatExpirationBadge(isoDate, mockT);
      expect(result?.variant).toBe('warning');
      expect(result?.text).toContain('album.expiresIn');
    });

    it('returns null for invalid date string', () => {
      const result = formatExpirationBadge('not-a-date', mockT);
      expect(result).toBeNull();
    });

    it('returns null for whitespace-only string', () => {
      const result = formatExpirationBadge('   ', mockT);
      expect(result).toBeNull();
    });

    it('handles exactly midnight boundary with fake timers', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-06-15T00:00:00Z'));

      // Expiration is exactly at midnight of the same day (0 ms diff)
      const result = formatExpirationBadge('2024-06-15T00:00:00Z', mockT);
      // ceil(0) = 0, 0 <= 0 → expired
      expect(result).toEqual({ text: 'album.expired', variant: 'danger' });

      vi.useRealTimers();
    });
  });
});
