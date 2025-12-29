/**
 * UploadButton Component Tests
 * Tests the updated UI with SVG icons
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UploadButton } from '../src/components/Upload/UploadButton';

// Mock the UploadContext
const mockUpload = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/contexts/UploadContext', () => ({
  useUploadContext: () => ({
    upload: mockUpload,
    isUploading: false,
    progress: 0,
    error: null,
    clearError: vi.fn(),
  }),
}));

describe('UploadButton', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders the upload button', () => {
    act(() => {
      root.render(createElement(UploadButton, { albumId: 'album-123' }));
    });

    const button = container.querySelector('[data-testid="upload-button"]');
    expect(button).not.toBeNull();
  });

  it('renders SVG icon instead of emoji', () => {
    act(() => {
      root.render(createElement(UploadButton, { albumId: 'album-123' }));
    });

    const button = container.querySelector('[data-testid="upload-button"]');
    // Should have an SVG icon (upload arrow)
    expect(button?.querySelector('svg')).not.toBeNull();
    // Should contain "Upload" translation key
    expect(button?.textContent).toContain('upload.button');
    // Should NOT contain emoji character
    expect(button?.textContent).not.toContain('📷');
  });

  it('has correct CSS class for styling', () => {
    act(() => {
      root.render(createElement(UploadButton, { albumId: 'album-123' }));
    });

    const button = container.querySelector('.upload-button');
    expect(button).not.toBeNull();
  });

  it('has hidden file input', () => {
    act(() => {
      root.render(createElement(UploadButton, { albumId: 'album-123' }));
    });

    const input = container.querySelector('[data-testid="upload-input"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.type).toBe('file');
    expect(input.accept).toBe('image/*');
    expect(input.multiple).toBe(true);
    expect(input.style.display).toBe('none');
  });
});
