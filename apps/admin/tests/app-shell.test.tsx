/**
 * AppShell Component Tests
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../src/components/App/AppShell';

// Mock child components
vi.mock('../src/components/Auth/LogoutButton', () => ({
  LogoutButton: () => createElement('button', { className: 'logout-button' }, 'Logout'),
}));

vi.mock('../src/components/Gallery/Gallery', () => ({
  Gallery: ({ albumId }: { albumId: string }) =>
    createElement('div', { 'data-testid': 'gallery', 'data-album-id': albumId }, 'Gallery'),
}));

vi.mock('../src/components/Albums/AlbumList', () => ({
  AlbumList: ({ onSelectAlbum }: { onSelectAlbum: (id: string) => void }) =>
    createElement(
      'div',
      { 'data-testid': 'album-list' },
      createElement(
        'button',
        { onClick: () => onSelectAlbum('album-1'), 'data-testid': 'select-album' },
        'Select Album'
      )
    ),
}));

vi.mock('../src/components/Settings/SettingsPage', () => ({
  SettingsPage: () => createElement('div', { 'data-testid': 'settings-page' }, 'Settings'),
}));

describe('AppShell', () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
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
    expect(title?.textContent).toContain('Mosaic');
  });

  it('shows album list by default', async () => {
    await act(async () => {
      root.render(createElement(AppShell));
    });

    expect(container.querySelector('[data-testid="album-list"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="gallery"]')).toBeFalsy();
    expect(container.querySelector('[data-testid="settings-page"]')).toBeFalsy();
  });

  it('has settings button in header', async () => {
    await act(async () => {
      root.render(createElement(AppShell));
    });

    const settingsButton = container.querySelector('[data-testid="settings-nav-button"]');
    expect(settingsButton).toBeTruthy();
    expect(settingsButton?.textContent).toContain('⚙️');
  });

  it('navigates to settings when settings button is clicked', async () => {
    await act(async () => {
      root.render(createElement(AppShell));
    });

    const settingsButton = container.querySelector(
      '[data-testid="settings-nav-button"]'
    ) as HTMLButtonElement;

    await act(async () => {
      settingsButton.click();
    });

    expect(container.querySelector('[data-testid="settings-page"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="album-list"]')).toBeFalsy();
  });

  it('hides settings button when on settings page', async () => {
    await act(async () => {
      root.render(createElement(AppShell));
    });

    const settingsButton = container.querySelector(
      '[data-testid="settings-nav-button"]'
    ) as HTMLButtonElement;

    await act(async () => {
      settingsButton.click();
    });

    expect(container.querySelector('[data-testid="settings-nav-button"]')).toBeFalsy();
  });

  it('shows back button on settings page', async () => {
    await act(async () => {
      root.render(createElement(AppShell));
    });

    const settingsButton = container.querySelector(
      '[data-testid="settings-nav-button"]'
    ) as HTMLButtonElement;

    await act(async () => {
      settingsButton.click();
    });

    const backButton = container.querySelector('.back-button');
    expect(backButton).toBeTruthy();
    expect(backButton?.textContent).toContain('Back');
  });

  it('navigates back to albums from settings', async () => {
    await act(async () => {
      root.render(createElement(AppShell));
    });

    // Go to settings
    const settingsButton = container.querySelector(
      '[data-testid="settings-nav-button"]'
    ) as HTMLButtonElement;

    await act(async () => {
      settingsButton.click();
    });

    // Go back
    const backButton = container.querySelector('.back-button') as HTMLButtonElement;

    await act(async () => {
      backButton.click();
    });

    expect(container.querySelector('[data-testid="album-list"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="settings-page"]')).toBeFalsy();
  });

  it('navigates to gallery when album is selected', async () => {
    await act(async () => {
      root.render(createElement(AppShell));
    });

    const selectButton = container.querySelector(
      '[data-testid="select-album"]'
    ) as HTMLButtonElement;

    await act(async () => {
      selectButton.click();
    });

    expect(container.querySelector('[data-testid="gallery"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="album-list"]')).toBeFalsy();
  });

  it('shows back button in gallery view', async () => {
    await act(async () => {
      root.render(createElement(AppShell));
    });

    const selectButton = container.querySelector(
      '[data-testid="select-album"]'
    ) as HTMLButtonElement;

    await act(async () => {
      selectButton.click();
    });

    const backButton = container.querySelector('.back-button');
    expect(backButton).toBeTruthy();
    expect(backButton?.textContent).toContain('Albums');
  });

  it('navigates back to gallery from settings if album was selected', async () => {
    await act(async () => {
      root.render(createElement(AppShell));
    });

    // Select an album first
    const selectButton = container.querySelector(
      '[data-testid="select-album"]'
    ) as HTMLButtonElement;

    await act(async () => {
      selectButton.click();
    });

    // Go to settings
    const settingsButton = container.querySelector(
      '[data-testid="settings-nav-button"]'
    ) as HTMLButtonElement;

    await act(async () => {
      settingsButton.click();
    });

    // Go back should return to gallery
    const backButton = container.querySelector('.back-button') as HTMLButtonElement;

    await act(async () => {
      backButton.click();
    });

    expect(container.querySelector('[data-testid="gallery"]')).toBeTruthy();
  });

  it('passes album ID to gallery component', async () => {
    await act(async () => {
      root.render(createElement(AppShell));
    });

    const selectButton = container.querySelector(
      '[data-testid="select-album"]'
    ) as HTMLButtonElement;

    await act(async () => {
      selectButton.click();
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
