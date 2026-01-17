/**
 * AlbumExpirationSettings Component Tests
 *
 * Tests the AlbumExpirationSettings component behavior using vitest + happy-dom.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlbumExpirationSettings } from '../src/components/Albums/AlbumExpirationSettings';
import type { Album } from '../src/lib/api-types';

// Mock the API
const mockUpdateAlbumExpiration = vi.fn();
vi.mock('../src/lib/api', () => ({
  getApi: () => ({
    updateAlbumExpiration: mockUpdateAlbumExpiration,
  }),
}));

// Helper to create a mock album
function createMockAlbum(overrides: Partial<Album> = {}): Album {
  return {
    id: 'album-123',
    ownerId: 'user-456',
    currentVersion: 1,
    currentEpochId: 1,
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
    onUpdate: () => void;
  }> = {},
) {
  const defaultProps = {
    album: createMockAlbum(),
    onUpdate: vi.fn(),
  };

  const container = document.createElement('div');
  document.body.appendChild(container);

  let root: ReturnType<typeof createRoot>;
  act(() => {
    root = createRoot(container);
    root.render(
      createElement(AlbumExpirationSettings, { ...defaultProps, ...props }),
    );
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

  const rerender = (
    newProps: Partial<{
      album: Album;
      onUpdate: () => void;
    }>,
  ) => {
    act(() => {
      root.render(
        createElement(AlbumExpirationSettings, {
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

describe('AlbumExpirationSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    mockUpdateAlbumExpiration.mockResolvedValue(createMockAlbum());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('rendering', () => {
    it('renders the expiration settings container', () => {
      const { getByTestId, cleanup } = renderComponent();

      expect(getByTestId('expiration-settings')).not.toBeNull();
      cleanup();
    });

    it('renders title and description', () => {
      const { container, cleanup } = renderComponent();

      expect(container.textContent).toContain('Album Expiration');
      expect(container.textContent).toContain('Set an expiration date');
      cleanup();
    });

    it('renders the enable checkbox unchecked by default', () => {
      const { getByTestId, cleanup } = renderComponent();

      const checkbox = getByTestId(
        'expiration-enabled-checkbox',
      ) as HTMLInputElement;
      expect(checkbox.checked).toBe(false);
      cleanup();
    });

    it('renders checkbox checked when album has expiration', () => {
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: daysFromNow(30) }),
      });

      const checkbox = getByTestId(
        'expiration-enabled-checkbox',
      ) as HTMLInputElement;
      expect(checkbox.checked).toBe(true);
      cleanup();
    });

    it('hides date controls when expiration disabled', () => {
      const { queryByTestId, cleanup } = renderComponent();

      expect(queryByTestId('expiration-controls')).toBeNull();
      cleanup();
    });

    it('shows date controls when expiration enabled', () => {
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: daysFromNow(30) }),
      });

      expect(getByTestId('expiration-controls')).not.toBeNull();
      expect(getByTestId('expiration-date-input')).not.toBeNull();
      expect(getByTestId('warning-days-input')).not.toBeNull();
      cleanup();
    });

    it('renders save button disabled when no changes', () => {
      const { getByTestId, cleanup } = renderComponent();

      const button = getByTestId('save-expiration-button') as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      cleanup();
    });
  });

  describe('enable/disable toggle', () => {
    it('shows controls when checkbox is toggled on', () => {
      const { getByTestId, queryByTestId, cleanup } = renderComponent();

      expect(queryByTestId('expiration-controls')).toBeNull();

      const checkbox = getByTestId(
        'expiration-enabled-checkbox',
      ) as HTMLInputElement;
      act(() => {
        checkbox.click();
      });

      expect(getByTestId('expiration-controls')).not.toBeNull();
      cleanup();
    });

    it('hides controls when checkbox is toggled off', () => {
      const { getByTestId, queryByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: daysFromNow(30) }),
      });

      expect(getByTestId('expiration-controls')).not.toBeNull();

      const checkbox = getByTestId(
        'expiration-enabled-checkbox',
      ) as HTMLInputElement;
      act(() => {
        checkbox.click();
      });

      expect(queryByTestId('expiration-controls')).toBeNull();
      cleanup();
    });

    it('sets default date to 30 days when enabling without existing date', () => {
      const { getByTestId, cleanup } = renderComponent();

      const checkbox = getByTestId(
        'expiration-enabled-checkbox',
      ) as HTMLInputElement;
      act(() => {
        checkbox.click();
      });

      const dateInput = getByTestId(
        'expiration-date-input',
      ) as HTMLInputElement;
      expect(dateInput.value).not.toBe('');

      // Should be approximately 30 days from now
      const selectedDate = new Date(dateInput.value);
      const now = new Date();
      const diffDays = Math.round(
        (selectedDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );
      expect(diffDays).toBeGreaterThanOrEqual(29);
      expect(diffDays).toBeLessThanOrEqual(31);

      cleanup();
    });

    it('enables save button after toggling', () => {
      const { getByTestId, cleanup } = renderComponent();

      const checkbox = getByTestId(
        'expiration-enabled-checkbox',
      ) as HTMLInputElement;
      act(() => {
        checkbox.click();
      });

      const button = getByTestId('save-expiration-button') as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      cleanup();
    });
  });

  describe('days remaining', () => {
    it('shows days remaining when date is set', () => {
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: daysFromNow(15) }),
      });

      const daysRemaining = getByTestId('days-remaining');
      expect(daysRemaining?.textContent).toContain('15');
      expect(daysRemaining?.textContent).toContain('days remaining');
      cleanup();
    });

    it('uses singular "day" when 1 day remaining', () => {
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: daysFromNow(1) }),
      });

      const daysRemaining = getByTestId('days-remaining');
      expect(daysRemaining?.textContent).toContain('1 day remaining');
      cleanup();
    });
  });

  describe('warning banner', () => {
    it('shows warning when 7 days or less remaining', () => {
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: daysFromNow(5) }),
      });

      expect(getByTestId('expiration-warning')).not.toBeNull();
      expect(getByTestId('expiration-warning')?.textContent).toContain(
        '5 days',
      );
      cleanup();
    });

    it('does not show warning when more than 7 days remaining', () => {
      const { queryByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: daysFromNow(10) }),
      });

      expect(queryByTestId('expiration-warning')).toBeNull();
      cleanup();
    });

    it('shows expired banner when album has expired', () => {
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: daysFromNow(-1) }),
      });

      expect(getByTestId('expiration-expired')).not.toBeNull();
      expect(getByTestId('expiration-expired')?.textContent).toContain(
        'expired',
      );
      cleanup();
    });
  });

  describe('date input', () => {
    it('updates value when changed', () => {
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: daysFromNow(30) }),
      });

      const dateInput = getByTestId(
        'expiration-date-input',
      ) as HTMLInputElement;
      const newDate = daysFromNow(60).split('T')[0];

      act(() => {
        dateInput.value = newDate;
        dateInput.dispatchEvent(new Event('change', { bubbles: true }));
      });

      expect(dateInput.value).toBe(newDate);
      cleanup();
    });

    it('has minimum date set to tomorrow', () => {
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: daysFromNow(30) }),
      });

      const dateInput = getByTestId(
        'expiration-date-input',
      ) as HTMLInputElement;
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const expectedMin = tomorrow.toISOString().split('T')[0];

      expect(dateInput.min).toBe(expectedMin);
      cleanup();
    });
  });

  describe('warning days input', () => {
    it('displays current value from album', () => {
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({
          expiresAt: daysFromNow(30),
          expirationWarningDays: 14,
        }),
      });

      const input = getByTestId('warning-days-input') as HTMLInputElement;
      expect(input.value).toBe('14');
      cleanup();
    });

    it('defaults to 7 when not set', () => {
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: daysFromNow(30) }),
      });

      const input = getByTestId('warning-days-input') as HTMLInputElement;
      expect(input.value).toBe('7');
      cleanup();
    });

    it('updates value when changed', () => {
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: daysFromNow(30) }),
      });

      const input = getByTestId('warning-days-input') as HTMLInputElement;

      act(() => {
        input.value = '10';
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });

      expect(input.value).toBe('10');
      cleanup();
    });

    it('has min and max constraints', () => {
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: daysFromNow(30) }),
      });

      const input = getByTestId('warning-days-input') as HTMLInputElement;
      expect(input.min).toBe('1');
      expect(input.max).toBe('30');
      cleanup();
    });
  });

  describe('save functionality', () => {
    it('calls API with correct data when saving enabled expiration', async () => {
      const onUpdate = vi.fn();
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum(),
        onUpdate,
      });

      // Enable expiration
      const checkbox = getByTestId(
        'expiration-enabled-checkbox',
      ) as HTMLInputElement;
      act(() => {
        checkbox.click();
      });

      // Save
      const saveButton = getByTestId(
        'save-expiration-button',
      ) as HTMLButtonElement;
      await act(async () => {
        saveButton.click();
      });

      expect(mockUpdateAlbumExpiration).toHaveBeenCalledWith(
        'album-123',
        expect.objectContaining({
          expiresAt: expect.any(String),
          expirationWarningDays: 7,
        }),
      );
      expect(onUpdate).toHaveBeenCalled();
      cleanup();
    });

    it('calls API with null expiresAt when disabling expiration', async () => {
      const onUpdate = vi.fn();
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: daysFromNow(30) }),
        onUpdate,
      });

      // Disable expiration
      const checkbox = getByTestId(
        'expiration-enabled-checkbox',
      ) as HTMLInputElement;
      act(() => {
        checkbox.click();
      });

      // Save
      const saveButton = getByTestId(
        'save-expiration-button',
      ) as HTMLButtonElement;
      await act(async () => {
        saveButton.click();
      });

      expect(mockUpdateAlbumExpiration).toHaveBeenCalledWith(
        'album-123',
        expect.objectContaining({
          expiresAt: null,
        }),
      );
      expect(onUpdate).toHaveBeenCalled();
      cleanup();
    });

    it('shows saving state on button', async () => {
      mockUpdateAlbumExpiration.mockImplementation(() => new Promise(() => {})); // Never resolves

      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: daysFromNow(30) }),
      });

      // Disable to create a change
      const checkbox = getByTestId(
        'expiration-enabled-checkbox',
      ) as HTMLInputElement;
      act(() => {
        checkbox.click();
      });

      // Click save
      const saveButton = getByTestId(
        'save-expiration-button',
      ) as HTMLButtonElement;
      act(() => {
        saveButton.click();
      });

      expect(saveButton.textContent).toBe('Saving...');
      expect(saveButton.disabled).toBe(true);
      cleanup();
    });

    it('shows success message after save', async () => {
      const { getByTestId, queryByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: daysFromNow(30) }),
      });

      // Disable to create a change
      const checkbox = getByTestId(
        'expiration-enabled-checkbox',
      ) as HTMLInputElement;
      act(() => {
        checkbox.click();
      });

      // Save
      const saveButton = getByTestId(
        'save-expiration-button',
      ) as HTMLButtonElement;
      await act(async () => {
        saveButton.click();
      });

      expect(getByTestId('expiration-success')).not.toBeNull();
      expect(getByTestId('expiration-success')?.textContent).toContain(
        'saved successfully',
      );
      cleanup();
    });

    it('shows error message on API failure', async () => {
      mockUpdateAlbumExpiration.mockRejectedValue(new Error('Network error'));

      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: daysFromNow(30) }),
      });

      // Disable to create a change
      const checkbox = getByTestId(
        'expiration-enabled-checkbox',
      ) as HTMLInputElement;
      act(() => {
        checkbox.click();
      });

      // Save
      const saveButton = getByTestId(
        'save-expiration-button',
      ) as HTMLButtonElement;
      await act(async () => {
        saveButton.click();
      });

      expect(getByTestId('expiration-error')).not.toBeNull();
      expect(getByTestId('expiration-error')?.textContent).toContain(
        'Network error',
      );
      cleanup();
    });

    it('shows validation error when date not selected', async () => {
      const { getByTestId, cleanup } = renderComponent();

      // Enable expiration
      const checkbox = getByTestId(
        'expiration-enabled-checkbox',
      ) as HTMLInputElement;
      act(() => {
        checkbox.click();
      });

      // Clear the date by setting to empty (need to use Object.defineProperty to force empty value)
      const dateInput = getByTestId(
        'expiration-date-input',
      ) as HTMLInputElement;
      act(() => {
        // Trigger change with empty value
        Object.defineProperty(dateInput, 'value', {
          value: '',
          writable: true,
        });
        dateInput.dispatchEvent(new Event('change', { bubbles: true }));
      });

      // Try to save
      const saveButton = getByTestId(
        'save-expiration-button',
      ) as HTMLButtonElement;
      await act(async () => {
        saveButton.click();
      });

      expect(getByTestId('expiration-error')).not.toBeNull();
      expect(getByTestId('expiration-error')?.textContent).toContain(
        'select an expiration date',
      );
      expect(mockUpdateAlbumExpiration).not.toHaveBeenCalled();
      cleanup();
    });
  });

  describe('has changes detection', () => {
    it('save button disabled when no changes made', () => {
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({
          expiresAt: daysFromNow(30),
          expirationWarningDays: 7,
        }),
      });

      const button = getByTestId('save-expiration-button') as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      cleanup();
    });

    it('save button enabled when enabled state changes', () => {
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: daysFromNow(30) }),
      });

      const checkbox = getByTestId(
        'expiration-enabled-checkbox',
      ) as HTMLInputElement;
      act(() => {
        checkbox.click();
      });

      const button = getByTestId('save-expiration-button') as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      cleanup();
    });

    it('save button enabled when date changes', () => {
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: daysFromNow(30) }),
      });

      const dateInput = getByTestId(
        'expiration-date-input',
      ) as HTMLInputElement;
      const newDate = daysFromNow(45).split('T')[0];
      act(() => {
        // Use native setter to update value, then dispatch input event
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        )!.set!;
        nativeInputValueSetter.call(dateInput, newDate);
        dateInput.dispatchEvent(new Event('input', { bubbles: true }));
        dateInput.dispatchEvent(new Event('change', { bubbles: true }));
      });

      const button = getByTestId('save-expiration-button') as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      cleanup();
    });

    it('save button enabled when warning days changes', () => {
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({
          expiresAt: daysFromNow(30),
          expirationWarningDays: 7,
        }),
      });

      const input = getByTestId('warning-days-input') as HTMLInputElement;
      act(() => {
        // Use native setter to update value, then dispatch input event
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        )!.set!;
        nativeInputValueSetter.call(input, '14');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });

      const button = getByTestId('save-expiration-button') as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      cleanup();
    });
  });

  describe('album prop changes', () => {
    it('resets state when album changes', () => {
      const album1 = createMockAlbum({
        id: 'album-1',
        expiresAt: daysFromNow(30),
      });
      const album2 = createMockAlbum({ id: 'album-2' });

      const { getByTestId, rerender, cleanup } = renderComponent({
        album: album1,
      });

      // Verify initial state
      let checkbox = getByTestId(
        'expiration-enabled-checkbox',
      ) as HTMLInputElement;
      expect(checkbox.checked).toBe(true);

      // Change album
      rerender({ album: album2 });

      // Verify reset state
      checkbox = getByTestId('expiration-enabled-checkbox') as HTMLInputElement;
      expect(checkbox.checked).toBe(false);
      cleanup();
    });
  });

  describe('accessibility', () => {
    it('has accessible labels for form controls', () => {
      const { container, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: daysFromNow(30) }),
      });

      const dateLabel = container.querySelector('label[for="expiration-date"]');
      const warningLabel = container.querySelector('label[for="warning-days"]');

      expect(dateLabel).not.toBeNull();
      expect(warningLabel).not.toBeNull();
      cleanup();
    });

    it('warning banner has role="alert"', () => {
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: daysFromNow(3) }),
      });

      const warning = getByTestId('expiration-warning');
      expect(warning?.getAttribute('role')).toBe('alert');
      cleanup();
    });

    it('error message has role="alert"', async () => {
      mockUpdateAlbumExpiration.mockRejectedValue(new Error('Error'));

      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: daysFromNow(30) }),
      });

      // Toggle to create change
      const checkbox = getByTestId(
        'expiration-enabled-checkbox',
      ) as HTMLInputElement;
      act(() => {
        checkbox.click();
      });

      // Save
      const saveButton = getByTestId(
        'save-expiration-button',
      ) as HTMLButtonElement;
      await act(async () => {
        saveButton.click();
      });

      const error = getByTestId('expiration-error');
      expect(error?.getAttribute('role')).toBe('alert');
      cleanup();
    });

    it('success message has role="status"', async () => {
      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: daysFromNow(30) }),
      });

      // Toggle to create change
      const checkbox = getByTestId(
        'expiration-enabled-checkbox',
      ) as HTMLInputElement;
      act(() => {
        checkbox.click();
      });

      // Save
      const saveButton = getByTestId(
        'save-expiration-button',
      ) as HTMLButtonElement;
      await act(async () => {
        saveButton.click();
      });

      const success = getByTestId('expiration-success');
      expect(success?.getAttribute('role')).toBe('status');
      cleanup();
    });
  });

  describe('disabled state during save', () => {
    it('disables checkbox during save', async () => {
      mockUpdateAlbumExpiration.mockImplementation(() => new Promise(() => {})); // Never resolves

      const { getByTestId, cleanup } = renderComponent({
        album: createMockAlbum({ expiresAt: daysFromNow(30) }),
      });

      // Toggle to create change
      const checkbox = getByTestId(
        'expiration-enabled-checkbox',
      ) as HTMLInputElement;
      act(() => {
        checkbox.click();
      });

      // Click save
      const saveButton = getByTestId(
        'save-expiration-button',
      ) as HTMLButtonElement;
      act(() => {
        saveButton.click();
      });

      expect(
        (getByTestId('expiration-enabled-checkbox') as HTMLInputElement)
          .disabled,
      ).toBe(true);
      cleanup();
    });
  });
});
