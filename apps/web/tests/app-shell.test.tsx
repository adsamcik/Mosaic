/**
 * AppShell Component Tests
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../src/components/App/AppShell';

// Track router state for tests
let mockRoute: {
  view: 'albums' | 'gallery' | 'settings' | 'admin';
  albumId?: string;
} = { view: 'albums' };
const mockNavigate = vi.fn((route: { view: string; albumId?: string }) => {
  mockRoute = route as typeof mockRoute;
});

// Mock useRouter hook
vi.mock('../src/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/hooks')>();
  return {
    ...actual,
    useRouter: () => ({
      route: mockRoute,
      navigate: mockNavigate,
      navigateToAlbums: () => mockNavigate({ view: 'albums' }),
      navigateToGallery: (albumId: string) =>
        mockNavigate({ view: 'gallery', albumId }),
      navigateToSettings: () => mockNavigate({ view: 'settings' }),
      navigateToAdmin: () => mockNavigate({ view: 'admin' }),
      goBack: () => mockNavigate({ view: 'albums' }),
    }),
  };
});

// Mock child components
vi.mock('../src/components/Auth/LogoutButton', () => ({
  LogoutButton: () =>
    createElement('button', { className: 'logout-button' }, 'Logout'),
}));

vi.mock('../src/components/Gallery/Gallery', () => ({
  Gallery: ({ albumId }: { albumId: string }) =>
    createElement(
      'div',
      { 'data-testid': 'gallery', 'data-album-id': albumId },
      'Gallery',
    ),
}));

vi.mock('../src/components/Albums/AlbumList', () => ({
  AlbumList: ({ onSelectAlbum }: { onSelectAlbum: (id: string) => void }) =>
    createElement(
      'div',
      { 'data-testid': 'album-list' },
      createElement(
        'button',
        {
          onClick: () => onSelectAlbum('album-1'),
          'data-testid': 'select-album',
        },
        'Select Album',
      ),
    ),
}));

vi.mock('../src/components/Settings/SettingsPage', () => ({
  SettingsPage: () =>
    createElement('div', { 'data-testid': 'settings-page' }, 'Settings'),
}));

// Mock SyncContext/SyncProvider - it wraps the entire app
vi.mock('../src/contexts/SyncContext', () => ({
  SyncProvider: ({ children }: { children: React.ReactNode }) => children,
  useSyncContext: vi.fn(() => ({
    autoSyncEnabled: false,
    syncingAlbums: new Set(),
    lastSyncTime: new Map(),
    triggerSync: vi.fn(),
    registerAlbum: vi.fn(),
    unregisterAlbum: vi.fn(),
  })),
  useAutoSync: vi.fn(),
}));

describe('AppShell', () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // Reset router state
    mockRoute = { view: 'albums' };
    mockNavigate.mockClear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('renders the app shell', async () => {
    await act(async () => {
      root.render(createElement(AppShell));
    });

    const shell = container.querySelector('[data-testid="app-shell"]');
    expect(shell).toBeTruthy();
  });

  it('displays app title', async () => {
    await act(async () => {
      root.render(createElement(AppShell));
    });

    const title = container.querySelector('.app-title');
    expect(title?.textContent).toContain('common.appName');
  });

  it('shows album list by default', async () => {
    await act(async () => {
      root.render(createElement(AppShell));
    });

    expect(container.querySelector('[data-testid="album-list"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="gallery"]')).toBeFalsy();
    expect(
      container.querySelector('[data-testid="settings-page"]'),
    ).toBeFalsy();
  });

  it('has settings button in header', async () => {
    await act(async () => {
      root.render(createElement(AppShell));
    });

    const settingsButton = container.querySelector(
      '[data-testid="settings-nav-button"]',
    );
    expect(settingsButton).toBeTruthy();
    // Button uses an SVG icon, check for the svg element
    expect(settingsButton?.querySelector('svg')).toBeTruthy();
  });

  it('navigates to settings when settings button is clicked', async () => {
    await act(async () => {
      root.render(createElement(AppShell));
    });

    const settingsButton = container.querySelector(
      '[data-testid="settings-nav-button"]',
    ) as HTMLButtonElement;

    await act(async () => {
      settingsButton.click();
    });

    expect(mockNavigate).toHaveBeenCalledWith({ view: 'settings' });
  });

  it('hides settings button when on settings page', async () => {
    // Start on settings page
    mockRoute = { view: 'settings' };

    await act(async () => {
      root.render(createElement(AppShell));
    });

    expect(
      container.querySelector('[data-testid="settings-nav-button"]'),
    ).toBeFalsy();
  });

  it('shows back button on settings page', async () => {
    // Start on settings page
    mockRoute = { view: 'settings' };

    await act(async () => {
      root.render(createElement(AppShell));
    });

    const backButton = container.querySelector('.back-button');
    expect(backButton).toBeTruthy();
    expect(backButton?.textContent).toContain('common.back');
  });

  it('navigates back to albums from settings', async () => {
    // Start on settings page
    mockRoute = { view: 'settings' };

    await act(async () => {
      root.render(createElement(AppShell));
    });

    // Go back
    const backButton = container.querySelector(
      '.back-button',
    ) as HTMLButtonElement;

    await act(async () => {
      backButton.click();
    });

    expect(mockNavigate).toHaveBeenCalledWith({ view: 'albums' });
  });

  it('navigates to gallery when album is selected', async () => {
    await act(async () => {
      root.render(createElement(AppShell));
    });

    const selectButton = container.querySelector(
      '[data-testid="select-album"]',
    ) as HTMLButtonElement;

    await act(async () => {
      selectButton.click();
    });

    expect(mockNavigate).toHaveBeenCalledWith({
      view: 'gallery',
      albumId: 'album-1',
    });
  });

  it('shows back button in gallery view', async () => {
    // Start on gallery page
    mockRoute = { view: 'gallery', albumId: 'album-1' };

    await act(async () => {
      root.render(createElement(AppShell));
    });

    const backButton = container.querySelector('.back-button');
    expect(backButton).toBeTruthy();
    expect(backButton?.textContent).toContain('navigation.albums');
  });

  it('navigates back to albums from gallery', async () => {
    // Start on gallery page
    mockRoute = { view: 'gallery', albumId: 'album-1' };

    await act(async () => {
      root.render(createElement(AppShell));
    });

    const backButton = container.querySelector(
      '.back-button',
    ) as HTMLButtonElement;

    await act(async () => {
      backButton.click();
    });

    expect(mockNavigate).toHaveBeenCalledWith({ view: 'albums' });
  });

  it('passes album ID to gallery component', async () => {
    // Start on gallery page with album-1
    mockRoute = { view: 'gallery', albumId: 'album-1' };

    await act(async () => {
      root.render(createElement(AppShell));
    });

    const gallery = container.querySelector('[data-testid="gallery"]');
    expect(gallery?.getAttribute('data-album-id')).toBe('album-1');
  });

  it('has logout button', async () => {
    await act(async () => {
      root.render(createElement(AppShell));
    });

    expect(container.querySelector('.logout-button')).toBeTruthy();
  });
});
