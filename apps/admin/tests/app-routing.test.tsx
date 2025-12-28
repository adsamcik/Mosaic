/**
 * App Component Routing Tests
 *
 * Tests the App component routing between authenticated and share link views.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock session
const mockSession = {
  isLoggedIn: false,
  subscribe: vi.fn(() => () => {}),
};

vi.mock('../src/lib/session', () => ({
  session: mockSession,
}));

// Mock components
vi.mock('../src/components/Auth/LoginForm', () => ({
  LoginForm: () => createElement('div', { 'data-testid': 'login-form' }, 'Login Form'),
}));

vi.mock('../src/components/App/AppShell', () => ({
  AppShell: () => createElement('div', { 'data-testid': 'app-shell' }, 'App Shell'),
}));

vi.mock('../src/components/Shared/SharedAlbumViewer', () => ({
  SharedAlbumViewer: ({ linkId }: { linkId: string }) =>
    createElement('div', { 'data-testid': 'shared-album-viewer', 'data-link-id': linkId }, 'Shared Album Viewer'),
}));

// Import after mocks
import { App } from '../src/App';

describe('App routing', () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;
  let originalLocation: Location;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    
    // Save original location
    originalLocation = window.location;
    
    // Reset session state
    mockSession.isLoggedIn = false;
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    
    // Restore location
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
    });
    
    vi.restoreAllMocks();
  });

  describe('share link route detection', () => {
    it('should render SharedAlbumViewer for /s/{linkId} path', async () => {
      Object.defineProperty(window, 'location', {
        value: {
          pathname: '/s/ABC123_-test',
          hash: '#k=secret123',
        },
        writable: true,
      });

      await act(async () => {
        root.render(createElement(App));
      });

      const viewer = container.querySelector('[data-testid="shared-album-viewer"]');
      expect(viewer).toBeTruthy();
      expect(viewer?.getAttribute('data-link-id')).toBe('ABC123_-test');
    });

    it('should pass linkId from URL to SharedAlbumViewer', async () => {
      Object.defineProperty(window, 'location', {
        value: {
          pathname: '/s/my-link-id-123',
          hash: '#k=secret',
        },
        writable: true,
      });

      await act(async () => {
        root.render(createElement(App));
      });

      const viewer = container.querySelector('[data-testid="shared-album-viewer"]');
      expect(viewer?.getAttribute('data-link-id')).toBe('my-link-id-123');
    });

    it('should not render SharedAlbumViewer for non-share routes', async () => {
      Object.defineProperty(window, 'location', {
        value: {
          pathname: '/albums',
          hash: '',
        },
        writable: true,
      });

      mockSession.isLoggedIn = false;

      await act(async () => {
        root.render(createElement(App));
      });

      expect(container.querySelector('[data-testid="shared-album-viewer"]')).toBeFalsy();
      expect(container.querySelector('[data-testid="login-form"]')).toBeTruthy();
    });

    it('should not match /s/ without linkId', async () => {
      Object.defineProperty(window, 'location', {
        value: {
          pathname: '/s/',
          hash: '#k=secret',
        },
        writable: true,
      });

      mockSession.isLoggedIn = false;

      await act(async () => {
        root.render(createElement(App));
      });

      expect(container.querySelector('[data-testid="shared-album-viewer"]')).toBeFalsy();
    });

    it('should not match /s/{linkId}/extra path', async () => {
      Object.defineProperty(window, 'location', {
        value: {
          pathname: '/s/link123/extra',
          hash: '#k=secret',
        },
        writable: true,
      });

      mockSession.isLoggedIn = false;

      await act(async () => {
        root.render(createElement(App));
      });

      expect(container.querySelector('[data-testid="shared-album-viewer"]')).toBeFalsy();
    });
  });

  describe('authenticated routes', () => {
    beforeEach(() => {
      Object.defineProperty(window, 'location', {
        value: {
          pathname: '/',
          hash: '',
        },
        writable: true,
      });
    });

    it('should render LoginForm when not logged in', async () => {
      mockSession.isLoggedIn = false;

      await act(async () => {
        root.render(createElement(App));
      });

      expect(container.querySelector('[data-testid="login-form"]')).toBeTruthy();
      expect(container.querySelector('[data-testid="app-shell"]')).toBeFalsy();
    });

    it('should render AppShell when logged in', async () => {
      mockSession.isLoggedIn = true;

      await act(async () => {
        root.render(createElement(App));
      });

      expect(container.querySelector('[data-testid="app-shell"]')).toBeTruthy();
      expect(container.querySelector('[data-testid="login-form"]')).toBeFalsy();
    });

    it('should subscribe to session changes', async () => {
      await act(async () => {
        root.render(createElement(App));
      });

      expect(mockSession.subscribe).toHaveBeenCalled();
    });
  });

  describe('share links bypass authentication', () => {
    it('should show SharedAlbumViewer even when not logged in', async () => {
      Object.defineProperty(window, 'location', {
        value: {
          pathname: '/s/public-link',
          hash: '#k=secret',
        },
        writable: true,
      });

      mockSession.isLoggedIn = false;

      await act(async () => {
        root.render(createElement(App));
      });

      expect(container.querySelector('[data-testid="shared-album-viewer"]')).toBeTruthy();
      expect(container.querySelector('[data-testid="login-form"]')).toBeFalsy();
    });

    it('should show SharedAlbumViewer even when logged in', async () => {
      Object.defineProperty(window, 'location', {
        value: {
          pathname: '/s/public-link',
          hash: '#k=secret',
        },
        writable: true,
      });

      mockSession.isLoggedIn = true;

      await act(async () => {
        root.render(createElement(App));
      });

      expect(container.querySelector('[data-testid="shared-album-viewer"]')).toBeTruthy();
      expect(container.querySelector('[data-testid="app-shell"]')).toBeFalsy();
    });
  });

  describe('link ID validation', () => {
    it('should match base64url characters in linkId', async () => {
      Object.defineProperty(window, 'location', {
        value: {
          pathname: '/s/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-',
          hash: '#k=secret',
        },
        writable: true,
      });

      await act(async () => {
        root.render(createElement(App));
      });

      expect(container.querySelector('[data-testid="shared-album-viewer"]')).toBeTruthy();
    });

    it('should not match invalid characters in linkId', async () => {
      Object.defineProperty(window, 'location', {
        value: {
          pathname: '/s/invalid!link',
          hash: '#k=secret',
        },
        writable: true,
      });

      mockSession.isLoggedIn = false;

      await act(async () => {
        root.render(createElement(App));
      });

      expect(container.querySelector('[data-testid="shared-album-viewer"]')).toBeFalsy();
    });
  });
});
