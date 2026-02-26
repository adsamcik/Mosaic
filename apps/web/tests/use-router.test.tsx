/**
 * useRouter Hook Tests
 */
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRouter } from '../src/hooks/useRouter';
import type { Route } from '../src/hooks/useRouter';

// Test component that exposes router functionality
function TestComponent({
  onRouteChange,
}: {
  onRouteChange?: (route: Route) => void;
}) {
  const {
    route,
    navigateToAlbums,
    navigateToGallery,
    navigateToSettings,
    navigateToAdmin,
  } = useRouter();

  // Report route changes to test
  if (onRouteChange) {
    onRouteChange(route);
  }

  return createElement(
    'div',
    null,
    createElement('span', { 'data-testid': 'current-view' }, route.view),
    createElement(
      'span',
      { 'data-testid': 'album-id' },
      route.view === 'gallery' ? route.albumId : '',
    ),
    createElement(
      'button',
      { 'data-testid': 'nav-albums', onClick: navigateToAlbums },
      'Albums',
    ),
    createElement(
      'button',
      {
        'data-testid': 'nav-gallery',
        onClick: () => navigateToGallery('test-album-123'),
      },
      'Gallery',
    ),
    createElement(
      'button',
      { 'data-testid': 'nav-settings', onClick: navigateToSettings },
      'Settings',
    ),
    createElement(
      'button',
      { 'data-testid': 'nav-admin', onClick: navigateToAdmin },
      'Admin',
    ),
  );
}

describe('useRouter', () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;
  let originalPathname: string;
  let pushStateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    // Save original pathname
    originalPathname = window.location.pathname;

    // Mock history.pushState
    pushStateSpy = vi
      .spyOn(window.history, 'pushState')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();

    // Restore pathname by navigating back
    window.history.replaceState(null, '', originalPathname);
    pushStateSpy.mockRestore();
  });

  describe('route parsing', () => {
    it('parses root path as albums view', async () => {
      window.history.replaceState(null, '', '/');

      let capturedRoute: Route | undefined;
      await act(async () => {
        root.render(
          createElement(TestComponent, {
            onRouteChange: (r) => {
              capturedRoute = r;
            },
          }),
        );
      });

      expect(capturedRoute?.view).toBe('albums');
    });

    it('parses /settings as settings view', async () => {
      window.history.replaceState(null, '', '/settings');

      let capturedRoute: Route | undefined;
      await act(async () => {
        root.render(
          createElement(TestComponent, {
            onRouteChange: (r) => {
              capturedRoute = r;
            },
          }),
        );
      });

      expect(capturedRoute?.view).toBe('settings');
    });

    it('parses /admin as admin view', async () => {
      window.history.replaceState(null, '', '/admin');

      let capturedRoute: Route | undefined;
      await act(async () => {
        root.render(
          createElement(TestComponent, {
            onRouteChange: (r) => {
              capturedRoute = r;
            },
          }),
        );
      });

      expect(capturedRoute?.view).toBe('admin');
    });

    it('parses /albums/:id as gallery view with album ID', async () => {
      window.history.replaceState(null, '', '/albums/abc-123-def');

      let capturedRoute: Route | undefined;
      await act(async () => {
        root.render(
          createElement(TestComponent, {
            onRouteChange: (r) => {
              capturedRoute = r;
            },
          }),
        );
      });

      expect(capturedRoute?.view).toBe('gallery');
      if (capturedRoute?.view === 'gallery') {
        expect(capturedRoute.albumId).toBe('abc-123-def');
      }
    });

    it('falls back to albums for unknown paths', async () => {
      window.history.replaceState(null, '', '/unknown/path');

      let capturedRoute: Route | undefined;
      await act(async () => {
        root.render(
          createElement(TestComponent, {
            onRouteChange: (r) => {
              capturedRoute = r;
            },
          }),
        );
      });

      expect(capturedRoute?.view).toBe('albums');
    });
  });

  describe('navigation', () => {
    it('navigateToAlbums updates URL to /', async () => {
      window.history.replaceState(null, '', '/settings');

      await act(async () => {
        root.render(createElement(TestComponent));
      });

      const button = container.querySelector(
        '[data-testid="nav-albums"]',
      ) as HTMLButtonElement;
      await act(async () => {
        button.click();
      });

      expect(pushStateSpy).toHaveBeenCalledWith(null, '', '/');
    });

    it('navigateToGallery updates URL to /albums/:id', async () => {
      window.history.replaceState(null, '', '/');

      await act(async () => {
        root.render(createElement(TestComponent));
      });

      const button = container.querySelector(
        '[data-testid="nav-gallery"]',
      ) as HTMLButtonElement;
      await act(async () => {
        button.click();
      });

      expect(pushStateSpy).toHaveBeenCalledWith(
        null,
        '',
        '/albums/test-album-123',
      );
    });

    it('navigateToSettings updates URL to /settings', async () => {
      window.history.replaceState(null, '', '/');

      await act(async () => {
        root.render(createElement(TestComponent));
      });

      const button = container.querySelector(
        '[data-testid="nav-settings"]',
      ) as HTMLButtonElement;
      await act(async () => {
        button.click();
      });

      expect(pushStateSpy).toHaveBeenCalledWith(null, '', '/settings');
    });

    it('navigateToAdmin updates URL to /admin', async () => {
      window.history.replaceState(null, '', '/');

      await act(async () => {
        root.render(createElement(TestComponent));
      });

      const button = container.querySelector(
        '[data-testid="nav-admin"]',
      ) as HTMLButtonElement;
      await act(async () => {
        button.click();
      });

      expect(pushStateSpy).toHaveBeenCalledWith(null, '', '/admin');
    });

    it('does not push state when navigating to current path', async () => {
      window.history.replaceState(null, '', '/settings');

      await act(async () => {
        root.render(createElement(TestComponent));
      });

      const button = container.querySelector(
        '[data-testid="nav-settings"]',
      ) as HTMLButtonElement;
      await act(async () => {
        button.click();
      });

      // Should not call pushState since we're already on /settings
      expect(pushStateSpy).not.toHaveBeenCalled();
    });
  });
});
