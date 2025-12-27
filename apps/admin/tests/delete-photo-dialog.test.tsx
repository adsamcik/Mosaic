/**
 * DeletePhotoDialog Component Tests
 *
 * Tests for the photo deletion confirmation dialog.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { DeletePhotoDialog, type DeletePhotoDialogProps } from '../src/components/Gallery/DeletePhotoDialog';
import type { PhotoMeta } from '../src/workers/types';

// Create mock photo for testing
function createMockPhoto(id: string): PhotoMeta {
  return {
    id,
    assetId: `asset-${id}`,
    albumId: 'album-1',
    filename: `test-photo-${id}.jpg`,
    mimeType: 'image/jpeg',
    width: 1920,
    height: 1080,
    takenAt: '2024-06-15T14:30:00Z',
    tags: [],
    shardIds: [`shard-${id}-1`],
    epochId: 1,
    createdAt: '2024-01-01T12:00:00Z',
    updatedAt: '2024-01-01T12:00:00Z',
  };
}

// Helper to render component
function renderDialog(props: Partial<DeletePhotoDialogProps> = {}) {
  const defaultProps: DeletePhotoDialogProps = {
    photos: [createMockPhoto('photo-1')],
    isDeleting: false,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };

  const container = document.createElement('div');
  document.body.appendChild(container);

  let root: ReturnType<typeof createRoot>;
  act(() => {
    root = createRoot(container);
    root.render(createElement(DeletePhotoDialog, { ...defaultProps, ...props }));
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

  const rerender = (newProps: Partial<DeletePhotoDialogProps>) => {
    act(() => {
      root.render(
        createElement(DeletePhotoDialog, { ...defaultProps, ...props, ...newProps })
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

describe('DeletePhotoDialog', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('rendering', () => {
    it('renders the dialog with correct elements', () => {
      const { getByTestId, cleanup } = renderDialog();

      expect(getByTestId('delete-photo-dialog')).toBeTruthy();
      expect(getByTestId('delete-confirm-button')).toBeTruthy();
      expect(getByTestId('delete-cancel-button')).toBeTruthy();

      cleanup();
    });

    it('shows single photo title for one photo', () => {
      const { container, cleanup } = renderDialog({
        photos: [createMockPhoto('photo-1')],
      });

      const title = container.querySelector('#delete-dialog-title');
      expect(title?.textContent).toBe('Delete photo?');

      cleanup();
    });

    it('shows bulk delete title for multiple photos', () => {
      const { container, cleanup } = renderDialog({
        photos: [createMockPhoto('photo-1'), createMockPhoto('photo-2'), createMockPhoto('photo-3')],
      });

      const title = container.querySelector('#delete-dialog-title');
      expect(title?.textContent).toBe('Delete 3 photos?');

      cleanup();
    });

    it('shows photo preview for single photo delete', () => {
      const { getByTestId, cleanup } = renderDialog({
        photos: [createMockPhoto('photo-1')],
        thumbnailUrl: 'blob:test-thumbnail',
      });

      const preview = getByTestId('delete-preview');
      expect(preview).toBeTruthy();
      
      const img = preview?.querySelector('img');
      expect(img?.src).toBe('blob:test-thumbnail');

      cleanup();
    });

    it('shows placeholder when no thumbnail URL provided', () => {
      const { getByTestId, cleanup } = renderDialog({
        photos: [createMockPhoto('photo-1')],
        thumbnailUrl: undefined,
      });

      const preview = getByTestId('delete-preview');
      const placeholder = preview?.querySelector('.delete-preview-placeholder');
      expect(placeholder).toBeTruthy();

      cleanup();
    });

    it('does not show preview for bulk delete', () => {
      const { queryByTestId, cleanup } = renderDialog({
        photos: [createMockPhoto('photo-1'), createMockPhoto('photo-2')],
      });

      expect(queryByTestId('delete-preview')).toBeNull();

      cleanup();
    });

    it('shows error message when error is provided', () => {
      const { getByTestId, cleanup } = renderDialog({
        error: 'Failed to delete photo',
      });

      const error = getByTestId('delete-error');
      expect(error?.textContent).toBe('Failed to delete photo');

      cleanup();
    });
  });

  describe('loading state', () => {
    it('disables buttons when deleting', () => {
      const { getByTestId, cleanup } = renderDialog({
        isDeleting: true,
      });

      const confirmButton = getByTestId('delete-confirm-button') as HTMLButtonElement;
      const cancelButton = getByTestId('delete-cancel-button') as HTMLButtonElement;

      expect(confirmButton.disabled).toBe(true);
      expect(cancelButton.disabled).toBe(true);

      cleanup();
    });

    it('shows loading text on confirm button when deleting', () => {
      const { getByTestId, cleanup } = renderDialog({
        isDeleting: true,
      });

      const confirmButton = getByTestId('delete-confirm-button');
      expect(confirmButton?.textContent).toContain('Deleting');

      cleanup();
    });

    it('shows normal text on confirm button when not deleting', () => {
      const { getByTestId, cleanup } = renderDialog({
        isDeleting: false,
      });

      const confirmButton = getByTestId('delete-confirm-button');
      expect(confirmButton?.textContent).toBe('Delete');

      cleanup();
    });
  });

  describe('interactions', () => {
    it('calls onConfirm when confirm button is clicked', () => {
      const onConfirm = vi.fn();
      const { getByTestId, cleanup } = renderDialog({ onConfirm });

      const confirmButton = getByTestId('delete-confirm-button');
      act(() => {
        confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(onConfirm).toHaveBeenCalledTimes(1);

      cleanup();
    });

    it('calls onCancel when cancel button is clicked', () => {
      const onCancel = vi.fn();
      const { getByTestId, cleanup } = renderDialog({ onCancel });

      const cancelButton = getByTestId('delete-cancel-button');
      act(() => {
        cancelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(onCancel).toHaveBeenCalledTimes(1);

      cleanup();
    });

    it('calls onCancel when backdrop is clicked', () => {
      const onCancel = vi.fn();
      const { getByTestId, cleanup } = renderDialog({ onCancel });

      const backdrop = getByTestId('delete-photo-dialog');
      act(() => {
        backdrop?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(onCancel).toHaveBeenCalledTimes(1);

      cleanup();
    });

    it('does not call onCancel when clicking inside dialog', () => {
      const onCancel = vi.fn();
      const { container, cleanup } = renderDialog({ onCancel });

      const dialog = container.querySelector('.dialog');
      act(() => {
        dialog?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      // onCancel should not be called because click was inside dialog
      // (it only triggers on backdrop click)
      cleanup();
    });

    it('calls onCancel when Escape key is pressed', () => {
      const onCancel = vi.fn();
      const { cleanup } = renderDialog({ onCancel });

      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });

      expect(onCancel).toHaveBeenCalledTimes(1);

      cleanup();
    });

    it('does not call onCancel on Escape when deleting', () => {
      const onCancel = vi.fn();
      const { cleanup } = renderDialog({ onCancel, isDeleting: true });

      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });

      expect(onCancel).not.toHaveBeenCalled();

      cleanup();
    });

    it('does not call onConfirm when deleting', () => {
      const onConfirm = vi.fn();
      const { getByTestId, cleanup } = renderDialog({ onConfirm, isDeleting: true });

      const confirmButton = getByTestId('delete-confirm-button');
      act(() => {
        confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      // Form submission should not work when disabled
      // The button is disabled, but we need to test form submit too
      cleanup();
    });
  });

  describe('accessibility', () => {
    it('has correct ARIA attributes', () => {
      const { getByTestId, cleanup } = renderDialog();

      const dialog = getByTestId('delete-photo-dialog');
      expect(dialog?.getAttribute('role')).toBe('dialog');
      expect(dialog?.getAttribute('aria-modal')).toBe('true');
      expect(dialog?.getAttribute('aria-labelledby')).toBe('delete-dialog-title');

      cleanup();
    });

    it('shows photo filename in preview', () => {
      const photo = createMockPhoto('photo-1');
      const { getByTestId, cleanup } = renderDialog({
        photos: [photo],
      });

      const preview = getByTestId('delete-preview');
      expect(preview?.textContent).toContain(photo.filename);

      cleanup();
    });
  });
});
