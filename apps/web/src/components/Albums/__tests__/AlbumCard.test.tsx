/**
 * AlbumCard expiration badge — regression tests for photos-i.
 *
 * Verifies that the album card renders the expiration badge whenever the
 * `expiresAt` field is present on the Album payload (e.g. after the user
 * saves expiration in the album settings and returns to the album list),
 * and omits it when the album has no expiration.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AlbumCard,
  type Album,
} from '../AlbumCard';

vi.mock('../../../hooks/useAlbumCover', () => ({
  useAlbumCover: () => ({
    coverUrl: null,
    isLoading: false,
    error: null,
  }),
}));

function daysFromNow(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function makeAlbum(overrides: Partial<Album> = {}): Album {
  return {
    id: 'album-photos-i',
    name: 'Test Album',
    photoCount: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('AlbumCard — expiration badge (photos-i)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders [data-testid="expiration-badge"] when album.expiresAt is set', () => {
    const album = makeAlbum({ expiresAt: daysFromNow(5) });
    act(() => {
      root.render(
        createElement(AlbumCard, { album, onClick: vi.fn() }),
      );
    });
    const badge = container.querySelector('[data-testid="expiration-badge"]');
    expect(badge).not.toBeNull();
  });

  it('omits the expiration badge when album.expiresAt is null', () => {
    const album = makeAlbum({ expiresAt: null });
    act(() => {
      root.render(
        createElement(AlbumCard, { album, onClick: vi.fn() }),
      );
    });
    const badge = container.querySelector('[data-testid="expiration-badge"]');
    expect(badge).toBeNull();
  });

  it('omits the expiration badge when album.expiresAt is undefined', () => {
    const album = makeAlbum();
    act(() => {
      root.render(
        createElement(AlbumCard, { album, onClick: vi.fn() }),
      );
    });
    const badge = container.querySelector('[data-testid="expiration-badge"]');
    expect(badge).toBeNull();
  });
});
