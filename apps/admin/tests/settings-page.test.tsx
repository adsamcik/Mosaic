/**
 * Settings Page Component Tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { SettingsPage } from '../src/components/Settings/SettingsPage';
import type { User } from '../src/lib/api-types';

// Mock user data
const mockUser: User = {
  id: 'user-123-abc-def',
  authSub: 'auth0|123456',
  identityPubkey: 'abcdef1234567890abcdef1234567890abcdef1234567890',
  createdAt: '2024-01-15T10:30:00Z',
};

// Mock API
const mockApi = {
  getCurrentUser: vi.fn(() => Promise.resolve(mockUser)),
};

// Mock storage estimate
const mockStorageEstimate = {
  usage: 1024 * 1024 * 50, // 50 MB
  quota: 1024 * 1024 * 1024 * 5, // 5 GB
};

// Mock services
vi.mock('../src/lib/api', () => ({
  getApi: vi.fn(() => mockApi),
}));

vi.mock('../src/lib/session', () => ({
  session: {
    logout: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('../src/lib/db-client', () => ({
  getDbClient: vi.fn(() => Promise.resolve({})),
  closeDbClient: vi.fn(() => Promise.resolve()),
}));

vi.mock('../src/lib/epoch-key-store', () => ({
  clearAllEpochKeys: vi.fn(),
}));

vi.mock('../src/lib/album-metadata-service', () => ({
  clearAllCachedMetadata: vi.fn(),
}));

vi.mock('../src/lib/album-cover-service', () => ({
  clearAllCovers: vi.fn(),
}));

// Mock localStorage
let localStorageMock: Record<string, string>;

// Mock indexedDB
const mockIndexedDB = {
  databases: vi.fn(() => Promise.resolve([])),
  deleteDatabase: vi.fn(),
};

describe('SettingsPage', () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    // Setup DOM container
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    // Reset mocks
    vi.clearAllMocks();
    mockApi.getCurrentUser.mockResolvedValue(mockUser);

    // Mock localStorage
    localStorageMock = {};
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(
      (key) => localStorageMock[key] ?? null
    );
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, value) => {
      localStorageMock[key] = value;
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation((key) => {
      delete localStorageMock[key];
    });

    // Mock navigator.storage
    Object.defineProperty(navigator, 'storage', {
      value: {
        estimate: vi.fn(() => Promise.resolve(mockStorageEstimate)),
        persist: vi.fn(() => Promise.resolve(true)),
        getDirectory: vi.fn(),
      },
      writable: true,
      configurable: true,
    });

    // Mock indexedDB
    Object.defineProperty(globalThis, 'indexedDB', {
      value: mockIndexedDB,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('renders the settings page', async () => {
    await act(async () => {
      root.render(createElement(SettingsPage));
    });

    const page = container.querySelector('[data-testid="settings-page"]');
    expect(page).toBeTruthy();
  });

  it('displays settings title', async () => {
    await act(async () => {
      root.render(createElement(SettingsPage));
    });

    const title = container.querySelector('.settings-title');
    expect(title?.textContent).toBe('Settings');
  });

  it('renders all settings sections', async () => {
    await act(async () => {
      root.render(createElement(SettingsPage));
    });

    expect(container.querySelector('[data-testid="account-section"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="storage-section"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="session-section"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="security-section"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="about-section"]')).toBeTruthy();
  });

  describe('Account Section', () => {
    it('displays loading state initially', async () => {
      // Delay the API response
      mockApi.getCurrentUser.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(mockUser), 100))
      );

      await act(async () => {
        root.render(createElement(SettingsPage));
      });

      const loading = container.querySelector('.settings-loading');
      expect(loading).toBeTruthy();
    });

    it('displays user information after loading', async () => {
      await act(async () => {
        root.render(createElement(SettingsPage));
      });

      // Wait for async operations
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const accountSection = container.querySelector('[data-testid="account-section"]');
      expect(accountSection?.textContent).toContain('user-123');
      expect(accountSection?.textContent).toContain('abcdef1234');
      expect(accountSection?.textContent).toContain('January');
    });

    it('displays error when API fails', async () => {
      mockApi.getCurrentUser.mockRejectedValue(new Error('Network error'));

      await act(async () => {
        root.render(createElement(SettingsPage));
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const error = container.querySelector('.settings-error');
      expect(error?.textContent).toContain('Network error');
    });
  });

  describe('Storage Section', () => {
    it('displays storage quota information', async () => {
      await act(async () => {
        root.render(createElement(SettingsPage));
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const storageSection = container.querySelector('[data-testid="storage-section"]');
      expect(storageSection?.textContent).toContain('50'); // 50 MB
      expect(storageSection?.textContent).toContain('5'); // 5 GB
    });

    it('displays storage progress bar', async () => {
      await act(async () => {
        root.render(createElement(SettingsPage));
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const progressBar = container.querySelector('[data-testid="storage-bar-fill"]');
      expect(progressBar).toBeTruthy();
    });
  });

  describe('Session Settings Section', () => {
    it('renders idle timeout select', async () => {
      await act(async () => {
        root.render(createElement(SettingsPage));
      });

      const select = container.querySelector(
        '[data-testid="idle-timeout-select"]'
      ) as HTMLSelectElement;
      expect(select).toBeTruthy();
      expect(select.options.length).toBe(3);
    });

    it('has default idle timeout of 30 minutes', async () => {
      await act(async () => {
        root.render(createElement(SettingsPage));
      });

      const select = container.querySelector(
        '[data-testid="idle-timeout-select"]'
      ) as HTMLSelectElement;
      expect(select.value).toBe('30');
    });

    it('renders theme select', async () => {
      await act(async () => {
        root.render(createElement(SettingsPage));
      });

      const select = container.querySelector(
        '[data-testid="theme-select"]'
      ) as HTMLSelectElement;
      expect(select).toBeTruthy();
      expect(select.options.length).toBe(3);
    });

    it('renders thumbnail quality select', async () => {
      await act(async () => {
        root.render(createElement(SettingsPage));
      });

      const select = container.querySelector(
        '[data-testid="thumbnail-quality-select"]'
      ) as HTMLSelectElement;
      expect(select).toBeTruthy();
      expect(select.options.length).toBe(3);
    });

    it('renders auto sync toggle', async () => {
      await act(async () => {
        root.render(createElement(SettingsPage));
      });

      const toggle = container.querySelector(
        '[data-testid="auto-sync-toggle"]'
      ) as HTMLInputElement;
      expect(toggle).toBeTruthy();
      expect(toggle.type).toBe('checkbox');
      expect(toggle.checked).toBe(true);
    });

    it('can change idle timeout', async () => {
      await act(async () => {
        root.render(createElement(SettingsPage));
      });

      const select = container.querySelector(
        '[data-testid="idle-timeout-select"]'
      ) as HTMLSelectElement;

      await act(async () => {
        select.value = '60';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });

      expect(select.value).toBe('60');
    });

    it('can toggle auto sync', async () => {
      await act(async () => {
        root.render(createElement(SettingsPage));
      });

      const toggle = container.querySelector(
        '[data-testid="auto-sync-toggle"]'
      ) as HTMLInputElement;

      await act(async () => {
        toggle.click();
      });

      expect(toggle.checked).toBe(false);
    });

    it('shows save button', async () => {
      await act(async () => {
        root.render(createElement(SettingsPage));
      });

      const saveButton = container.querySelector('.button-primary');
      expect(saveButton?.textContent).toContain('Save');
    });

    it('shows reset button', async () => {
      await act(async () => {
        root.render(createElement(SettingsPage));
      });

      const buttons = container.querySelectorAll('.button-secondary');
      const resetButton = Array.from(buttons).find((b) =>
        b.textContent?.includes('Reset')
      );
      expect(resetButton).toBeTruthy();
    });
  });

  describe('Security Section', () => {
    it('renders clear data button', async () => {
      await act(async () => {
        root.render(createElement(SettingsPage));
      });

      const clearButton = container.querySelector('[data-testid="clear-data-button"]');
      expect(clearButton).toBeTruthy();
      expect(clearButton?.textContent).toContain('Clear Data');
    });

    it('shows confirmation dialog when clear data is clicked', async () => {
      await act(async () => {
        root.render(createElement(SettingsPage));
      });

      const clearButton = container.querySelector(
        '[data-testid="clear-data-button"]'
      ) as HTMLButtonElement;

      await act(async () => {
        clearButton.click();
      });

      const dialog = container.querySelector('[data-testid="clear-confirm-dialog"]');
      expect(dialog).toBeTruthy();
    });

    it('can cancel clear data dialog', async () => {
      await act(async () => {
        root.render(createElement(SettingsPage));
      });

      const clearButton = container.querySelector(
        '[data-testid="clear-data-button"]'
      ) as HTMLButtonElement;

      await act(async () => {
        clearButton.click();
      });

      const cancelButton = container.querySelector(
        '.dialog .button-secondary'
      ) as HTMLButtonElement;

      await act(async () => {
        cancelButton.click();
      });

      const dialog = container.querySelector('[data-testid="clear-confirm-dialog"]');
      expect(dialog).toBeFalsy();
    });
  });

  describe('About Section', () => {
    it('displays version number', async () => {
      await act(async () => {
        root.render(createElement(SettingsPage));
      });

      const aboutSection = container.querySelector('[data-testid="about-section"]');
      expect(aboutSection?.textContent).toContain('1.0.0');
    });

    it('displays GitHub link', async () => {
      await act(async () => {
        root.render(createElement(SettingsPage));
      });

      const link = container.querySelector('.info-link') as HTMLAnchorElement;
      expect(link).toBeTruthy();
      expect(link.href).toContain('github');
    });

    it('displays app description', async () => {
      await act(async () => {
        root.render(createElement(SettingsPage));
      });

      const aboutSection = container.querySelector('[data-testid="about-section"]');
      expect(aboutSection?.textContent).toContain('zero-knowledge');
      expect(aboutSection?.textContent).toContain('encrypted');
    });
  });

  describe('Settings Persistence', () => {
    it('loads saved settings on mount', async () => {
      localStorageMock['mosaic:settings'] = JSON.stringify({
        idleTimeout: 60,
        theme: 'light',
        thumbnailQuality: 'high',
        autoSync: false,
      });

      await act(async () => {
        root.render(createElement(SettingsPage));
      });

      const idleSelect = container.querySelector(
        '[data-testid="idle-timeout-select"]'
      ) as HTMLSelectElement;
      const themeSelect = container.querySelector(
        '[data-testid="theme-select"]'
      ) as HTMLSelectElement;
      const qualitySelect = container.querySelector(
        '[data-testid="thumbnail-quality-select"]'
      ) as HTMLSelectElement;
      const syncToggle = container.querySelector(
        '[data-testid="auto-sync-toggle"]'
      ) as HTMLInputElement;

      expect(idleSelect.value).toBe('60');
      expect(themeSelect.value).toBe('light');
      expect(qualitySelect.value).toBe('high');
      expect(syncToggle.checked).toBe(false);
    });

    it('saves settings when save button is clicked', async () => {
      await act(async () => {
        root.render(createElement(SettingsPage));
      });

      // Change a setting
      const select = container.querySelector(
        '[data-testid="idle-timeout-select"]'
      ) as HTMLSelectElement;

      await act(async () => {
        select.value = '15';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });

      // Click save
      const saveButton = container.querySelector('.button-primary') as HTMLButtonElement;

      await act(async () => {
        saveButton.click();
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const saved = JSON.parse(localStorageMock['mosaic:settings'] ?? '{}');
      expect(saved.idleTimeout).toBe(15);
    });
  });
});
