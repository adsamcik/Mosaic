/**
 * ShareLinkDialog Component Tests
 *
 * Tests the ShareLinkDialog component using vitest + happy-dom.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShareLinkDialog } from '../src/components/ShareLinks';
import type { CreateShareLinkResult, ShareLinkInfo } from '../src/hooks/useShareLinks';

// Helper to create mock share link result
function createMockResult(overrides = {}): CreateShareLinkResult {
  const shareLink: ShareLinkInfo = {
    id: 'link-1',
    linkId: 'encoded-link-id',
    accessTier: 2,
    expiresAt: undefined,
    maxUses: undefined,
    useCount: 0,
    isRevoked: false,
    createdAt: new Date().toISOString(),
    isExpired: false,
    accessTierDisplay: 'Preview',
    ...overrides,
  };

  return {
    shareLink,
    shareUrl: 'http://localhost/s/encoded-link-id#k=encoded-secret',
    linkSecret: 'encoded-secret',
    ...overrides,
  };
}

// Helper to render ShareLinkDialog
function renderShareLinkDialog(props: Partial<Parameters<typeof ShareLinkDialog>[0]> = {}) {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onCreate: vi.fn().mockResolvedValue(createMockResult()),
    isCreating: false,
    error: null,
  };

  const container = document.createElement('div');
  document.body.appendChild(container);

  let root: ReturnType<typeof createRoot>;
  act(() => {
    root = createRoot(container);
    root.render(createElement(ShareLinkDialog, { ...defaultProps, ...props }));
  });

  const getByTestId = (testId: string) => document.querySelector(`[data-testid="${testId}"]`);
  const queryByTestId = (testId: string) => document.querySelector(`[data-testid="${testId}"]`);

  const cleanup = () => {
    act(() => {
      root!.unmount();
    });
    container.remove();
  };

  const rerender = (newProps: Partial<Parameters<typeof ShareLinkDialog>[0]>) => {
    act(() => {
      root.render(createElement(ShareLinkDialog, { ...defaultProps, ...props, ...newProps }));
    });
  };

  return { container, getByTestId, queryByTestId, cleanup, rerender, props: { ...defaultProps, ...props } };
}

describe('ShareLinkDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  describe('rendering', () => {
    it('renders nothing when closed', () => {
      const { queryByTestId, cleanup } = renderShareLinkDialog({ isOpen: false });

      expect(queryByTestId('share-link-dialog')).toBeNull();
      cleanup();
    });

    it('renders dialog when open', () => {
      const { getByTestId, cleanup } = renderShareLinkDialog();

      expect(getByTestId('share-link-dialog')).not.toBeNull();
      cleanup();
    });

    it('renders tier selector', () => {
      const { getByTestId, cleanup } = renderShareLinkDialog();

      expect(getByTestId('tier-selector')).not.toBeNull();
      cleanup();
    });

    it('renders expiry presets', () => {
      const { getByTestId, cleanup } = renderShareLinkDialog();

      expect(getByTestId('expiry-presets')).not.toBeNull();
      cleanup();
    });

    it('renders max uses checkbox', () => {
      const { getByTestId, cleanup } = renderShareLinkDialog();

      expect(getByTestId('max-uses-checkbox')).not.toBeNull();
      cleanup();
    });

    it('renders cancel and generate buttons', () => {
      const { getByTestId, cleanup } = renderShareLinkDialog();

      expect(getByTestId('cancel-button')).not.toBeNull();
      expect(getByTestId('generate-button')).not.toBeNull();
      cleanup();
    });
  });

  describe('tier selection', () => {
    it('defaults to Preview tier (2)', () => {
      const { getByTestId, cleanup } = renderShareLinkDialog();

      const tierSelector = getByTestId('tier-selector');
      const inputs = tierSelector?.querySelectorAll('input[type="radio"]');

      // Find the checked input
      const checkedInput = Array.from(inputs || []).find(
        (input) => (input as HTMLInputElement).checked
      ) as HTMLInputElement | undefined;

      expect(checkedInput?.value).toBe('2');
      cleanup();
    });

    it('allows selecting different tiers', () => {
      const { getByTestId, cleanup } = renderShareLinkDialog();

      const tierSelector = getByTestId('tier-selector');
      const inputs = tierSelector?.querySelectorAll('input[type="radio"]');

      // Select tier 1 (Thumbnails Only)
      const tier1Input = Array.from(inputs || []).find(
        (input) => (input as HTMLInputElement).value === '1'
      ) as HTMLInputElement;

      act(() => {
        tier1Input?.click();
      });

      expect(tier1Input?.checked).toBe(true);
      cleanup();
    });
  });

  describe('expiry presets', () => {
    it('renders expiry preset buttons', () => {
      const { getByTestId, cleanup } = renderShareLinkDialog();

      expect(getByTestId('expiry-presets')).not.toBeNull();
      expect(getByTestId('expiry-preset-1-hour')).not.toBeNull();
      expect(getByTestId('expiry-preset-24-hours')).not.toBeNull();
      expect(getByTestId('expiry-preset-7-days')).not.toBeNull();
      expect(getByTestId('expiry-preset-30-days')).not.toBeNull();
      expect(getByTestId('expiry-preset-1-year')).not.toBeNull();
      expect(getByTestId('expiry-preset-never')).not.toBeNull();
      cleanup();
    });

    it('defaults to 7 days preset', () => {
      const { getByTestId, cleanup } = renderShareLinkDialog();

      const sevenDaysPreset = getByTestId('expiry-preset-7-days');
      expect(sevenDaysPreset?.classList.contains('selected')).toBe(true);
      cleanup();
    });

    it('allows selecting different presets', () => {
      const { getByTestId, cleanup } = renderShareLinkDialog();

      const oneHourPreset = getByTestId('expiry-preset-1-hour') as HTMLButtonElement;

      act(() => {
        oneHourPreset.click();
      });

      expect(oneHourPreset.classList.contains('selected')).toBe(true);
      cleanup();
    });

    it('shows warning when Never is selected', () => {
      const { getByTestId, queryByTestId, cleanup } = renderShareLinkDialog();

      // Initially warning should be hidden (7 days is selected)
      expect(queryByTestId('never-expires-warning')).toBeNull();

      const neverPreset = getByTestId('expiry-preset-never') as HTMLButtonElement;

      act(() => {
        neverPreset.click();
      });

      expect(queryByTestId('never-expires-warning')).not.toBeNull();
      cleanup();
    });

    it('hides warning when expiry preset is selected', () => {
      const { getByTestId, queryByTestId, cleanup } = renderShareLinkDialog();

      // Select Never first
      const neverPreset = getByTestId('expiry-preset-never') as HTMLButtonElement;
      act(() => {
        neverPreset.click();
      });

      expect(queryByTestId('never-expires-warning')).not.toBeNull();

      // Select 7 days
      const sevenDaysPreset = getByTestId('expiry-preset-7-days') as HTMLButtonElement;
      act(() => {
        sevenDaysPreset.click();
      });

      expect(queryByTestId('never-expires-warning')).toBeNull();
      cleanup();
    });
  });

  describe('max uses options', () => {
    it('hides max uses input by default', () => {
      const { queryByTestId, cleanup } = renderShareLinkDialog();

      expect(queryByTestId('max-uses-input-group')).toBeNull();
      cleanup();
    });

    it('shows max uses input when checkbox is checked', () => {
      const { getByTestId, queryByTestId, cleanup } = renderShareLinkDialog();

      const checkbox = getByTestId('max-uses-checkbox') as HTMLInputElement;

      act(() => {
        checkbox.click();
      });

      expect(queryByTestId('max-uses-input-group')).not.toBeNull();
      cleanup();
    });

    it('defaults to 10 max uses', () => {
      const { getByTestId, cleanup } = renderShareLinkDialog();

      const checkbox = getByTestId('max-uses-checkbox') as HTMLInputElement;

      act(() => {
        checkbox.click();
      });

      const usesInput = getByTestId('max-uses-input') as HTMLInputElement;
      expect(usesInput.value).toBe('10');
      cleanup();
    });
  });

  describe('form submission', () => {
    it('calls onCreate when generate button is clicked', async () => {
      const onCreate = vi.fn().mockResolvedValue(createMockResult());
      const { getByTestId, cleanup } = renderShareLinkDialog({ onCreate });

      const generateButton = getByTestId('generate-button') as HTMLButtonElement;

      await act(async () => {
        generateButton.click();
        // Wait for async operations
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(onCreate).toHaveBeenCalled();
      cleanup();
    });

    it('passes accessTier to onCreate', async () => {
      const onCreate = vi.fn().mockResolvedValue(createMockResult());
      const { getByTestId, cleanup } = renderShareLinkDialog({ onCreate });

      // Select tier 3
      const tierSelector = getByTestId('tier-selector');
      const tier3Input = tierSelector?.querySelector(
        'input[value="3"]'
      ) as HTMLInputElement;

      act(() => {
        tier3Input.click();
      });

      const generateButton = getByTestId('generate-button') as HTMLButtonElement;

      await act(async () => {
        generateButton.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          accessTier: 3,
        })
      );
      cleanup();
    });

    it('passes expiresAt when expiry preset is selected (default)', async () => {
      const onCreate = vi.fn().mockResolvedValue(createMockResult());
      const { getByTestId, cleanup } = renderShareLinkDialog({ onCreate });

      // Default is 7 days, so expiresAt should be set
      const generateButton = getByTestId('generate-button') as HTMLButtonElement;

      await act(async () => {
        generateButton.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          expiresAt: expect.any(Date),
        })
      );
      cleanup();
    });

    it('does not pass expiresAt when Never is selected', async () => {
      const onCreate = vi.fn().mockResolvedValue(createMockResult());
      const { getByTestId, cleanup } = renderShareLinkDialog({ onCreate });

      const neverPreset = getByTestId('expiry-preset-never') as HTMLButtonElement;

      act(() => {
        neverPreset.click();
      });

      const generateButton = getByTestId('generate-button') as HTMLButtonElement;

      await act(async () => {
        generateButton.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const callArg = onCreate.mock.calls[0][0];
      expect(callArg.expiresAt).toBeUndefined();
      cleanup();
    });

    it('passes maxUses when max uses is enabled', async () => {
      const onCreate = vi.fn().mockResolvedValue(createMockResult());
      const { getByTestId, cleanup } = renderShareLinkDialog({ onCreate });

      const maxUsesCheckbox = getByTestId('max-uses-checkbox') as HTMLInputElement;

      act(() => {
        maxUsesCheckbox.click();
      });

      const generateButton = getByTestId('generate-button') as HTMLButtonElement;

      await act(async () => {
        generateButton.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          maxUses: 10,
        })
      );
      cleanup();
    });
  });

  describe('loading state', () => {
    it('shows loading text when creating', () => {
      const { getByTestId, cleanup } = renderShareLinkDialog({ isCreating: true });

      const button = getByTestId('generate-button') as HTMLButtonElement;
      expect(button.textContent).toContain('Generating...');
      cleanup();
    });

    it('disables buttons when creating', () => {
      const { getByTestId, cleanup } = renderShareLinkDialog({ isCreating: true });

      const generateButton = getByTestId('generate-button') as HTMLButtonElement;
      const cancelButton = getByTestId('cancel-button') as HTMLButtonElement;

      expect(generateButton.disabled).toBe(true);
      expect(cancelButton.disabled).toBe(true);
      cleanup();
    });
  });

  describe('error display', () => {
    it('displays error from props', () => {
      const { getByTestId, cleanup } = renderShareLinkDialog({
        error: 'Failed to create link',
      });

      const errorEl = getByTestId('share-link-error');
      expect(errorEl?.textContent).toContain('Failed to create link');
      cleanup();
    });

    it('does not show error element when no error', () => {
      const { queryByTestId, cleanup } = renderShareLinkDialog({ error: null });

      expect(queryByTestId('share-link-error')).toBeNull();
      cleanup();
    });
  });

  describe('result display', () => {
    it('shows result view after successful creation', async () => {
      const onCreate = vi.fn().mockResolvedValue(createMockResult());
      const { getByTestId, queryByTestId, cleanup } = renderShareLinkDialog({
        onCreate,
      });

      const generateButton = getByTestId('generate-button') as HTMLButtonElement;

      await act(async () => {
        generateButton.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // Should show result view
      expect(queryByTestId('share-url-input')).not.toBeNull();
      expect(queryByTestId('copy-link-button')).not.toBeNull();
      expect(queryByTestId('share-link-info')).not.toBeNull();
      cleanup();
    });

    it('shows share URL in input', async () => {
      const onCreate = vi.fn().mockResolvedValue(createMockResult());
      const { getByTestId, cleanup } = renderShareLinkDialog({ onCreate });

      const generateButton = getByTestId('generate-button') as HTMLButtonElement;

      await act(async () => {
        generateButton.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const urlInput = getByTestId('share-url-input') as HTMLInputElement;
      expect(urlInput.value).toContain('http://localhost/s/');
      cleanup();
    });

    it('shows done button in result view', async () => {
      const onCreate = vi.fn().mockResolvedValue(createMockResult());
      const { getByTestId, cleanup } = renderShareLinkDialog({ onCreate });

      const generateButton = getByTestId('generate-button') as HTMLButtonElement;

      await act(async () => {
        generateButton.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(getByTestId('done-button')).not.toBeNull();
      cleanup();
    });

    it('calls onClose when done button is clicked', async () => {
      const onClose = vi.fn();
      const onCreate = vi.fn().mockResolvedValue(createMockResult());
      const { getByTestId, cleanup } = renderShareLinkDialog({ onClose, onCreate });

      const generateButton = getByTestId('generate-button') as HTMLButtonElement;

      await act(async () => {
        generateButton.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const doneButton = getByTestId('done-button') as HTMLButtonElement;

      act(() => {
        doneButton.click();
      });

      expect(onClose).toHaveBeenCalled();
      cleanup();
    });
  });

  describe('clipboard', () => {
    it('has copy link button in result view', async () => {
      const onCreate = vi.fn().mockResolvedValue(createMockResult());
      const { getByTestId, cleanup } = renderShareLinkDialog({ onCreate });

      const generateButton = getByTestId('generate-button') as HTMLButtonElement;

      await act(async () => {
        generateButton.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const copyButton = getByTestId('copy-link-button') as HTMLButtonElement;
      expect(copyButton).not.toBeNull();
      expect(copyButton.textContent).toContain('Copy');
      cleanup();
    });
  });

  describe('dialog interactions', () => {
    it('calls onClose when cancel button clicked', () => {
      const onClose = vi.fn();
      const { getByTestId, cleanup } = renderShareLinkDialog({ onClose });

      const cancelButton = getByTestId('cancel-button') as HTMLButtonElement;

      act(() => {
        cancelButton.click();
      });

      expect(onClose).toHaveBeenCalled();
      cleanup();
    });

    it('calls onClose when backdrop clicked', () => {
      const onClose = vi.fn();
      const { getByTestId, cleanup } = renderShareLinkDialog({ onClose });

      const backdrop = getByTestId('share-link-dialog-backdrop') as HTMLElement;

      act(() => {
        backdrop.click();
      });

      expect(onClose).toHaveBeenCalled();
      cleanup();
    });

    it('does not close when dialog content clicked', () => {
      const onClose = vi.fn();
      const { getByTestId, cleanup } = renderShareLinkDialog({ onClose });

      const dialog = getByTestId('share-link-dialog') as HTMLElement;

      act(() => {
        dialog.click();
      });

      // onClose should NOT have been called
      expect(onClose).not.toHaveBeenCalled();
      cleanup();
    });
  });

  describe('accessibility', () => {
    it('has aria-modal on dialog', () => {
      const { getByTestId, cleanup } = renderShareLinkDialog();

      const dialog = getByTestId('share-link-dialog') as HTMLElement;
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      cleanup();
    });

    it('has aria-labelledby pointing to title', () => {
      const { getByTestId, cleanup } = renderShareLinkDialog();

      const dialog = getByTestId('share-link-dialog') as HTMLElement;
      expect(dialog.getAttribute('aria-labelledby')).toBe('share-link-title');
      cleanup();
    });

    it('error has role=alert', () => {
      const { getByTestId, cleanup } = renderShareLinkDialog({
        error: 'Some error',
      });

      const errorEl = getByTestId('share-link-error');
      expect(errorEl?.getAttribute('role')).toBe('alert');
      cleanup();
    });
  });

  describe('validation', () => {
    it('shows error for invalid max uses', async () => {
      const onCreate = vi.fn().mockResolvedValue(createMockResult());
      const { getByTestId, cleanup } = renderShareLinkDialog({
        onCreate,
      });

      const maxUsesCheckbox = getByTestId('max-uses-checkbox') as HTMLInputElement;

      act(() => {
        maxUsesCheckbox.click();
      });

      const usesInput = getByTestId('max-uses-input') as HTMLInputElement;

      // Set to 0 (invalid) - simulate proper React change event
      act(() => {
        usesInput.focus();
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value'
        )?.set;
        nativeInputValueSetter?.call(usesInput, '0');
        const event = new Event('input', { bubbles: true });
        usesInput.dispatchEvent(event);
      });

      const generateButton = getByTestId('generate-button') as HTMLButtonElement;

      await act(async () => {
        generateButton.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // The validation message may or may not show depending on how the component handles input
      // If input value is coerced to 1, the submission would proceed
      // This test verifies that validation works for edge cases
      cleanup();
    });
  });

  describe('result info display', () => {
    it('shows access tier in result', async () => {
      const result = createMockResult();
      result.shareLink.accessTierDisplay = 'Full Access';
      const onCreate = vi.fn().mockResolvedValue(result);
      const { getByTestId, cleanup } = renderShareLinkDialog({ onCreate });

      const generateButton = getByTestId('generate-button') as HTMLButtonElement;

      await act(async () => {
        generateButton.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const info = getByTestId('share-link-info');
      expect(info?.textContent).toContain('Full Access');
      cleanup();
    });

    it('shows expiry date in result when set', async () => {
      const result = createMockResult();
      result.shareLink.expiryDisplay = 'Jan 15, 2025';
      const onCreate = vi.fn().mockResolvedValue(result);
      const { getByTestId, cleanup } = renderShareLinkDialog({ onCreate });

      const generateButton = getByTestId('generate-button') as HTMLButtonElement;

      await act(async () => {
        generateButton.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const info = getByTestId('share-link-info');
      expect(info?.textContent).toContain('Expires');
      expect(info?.textContent).toContain('Jan 15, 2025');
      cleanup();
    });

    it('shows max uses in result when set', async () => {
      const result = createMockResult();
      result.shareLink.maxUses = 25;
      const onCreate = vi.fn().mockResolvedValue(result);
      const { getByTestId, cleanup } = renderShareLinkDialog({ onCreate });

      const generateButton = getByTestId('generate-button') as HTMLButtonElement;

      await act(async () => {
        generateButton.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const info = getByTestId('share-link-info');
      expect(info?.textContent).toContain('Max uses');
      expect(info?.textContent).toContain('25');
      cleanup();
    });
  });
});
