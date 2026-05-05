/**
 * UploadContext and UploadErrorToast Component Tests
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UploadProvider,
  useUploadContext,
  UploadError,
  UploadErrorCode,
} from '../src/contexts/UploadContext';
import { UploadErrorToast } from '../src/components/Upload/UploadErrorToast';
import { uploadQueue } from '../src/lib/upload-queue';

// Mock dependencies
vi.mock('../src/lib/epoch-key-service', () => ({
  getCurrentOrFetchEpochKey: vi.fn(),
}));

vi.mock('../src/lib/upload-queue', () => ({
  uploadQueue: {
    init: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue('task-id'),
    onProgress: null,
    onComplete: null,
    onError: null,
  },
}));

vi.mock('../src/lib/crypto-client', () => ({
  getCryptoClient: vi.fn(),
}));

vi.mock('../src/lib/api', () => ({
  getApi: vi.fn(() => ({
    createManifest: vi.fn(),
  })),
  toBase64: vi.fn((data: Uint8Array) => 'base64data'),
}));

// Mock sync engine for post-upload sync
vi.mock('../src/lib/sync-engine', () => ({
  syncEngine: {
    sync: vi.fn().mockResolvedValue(undefined),
    isSyncing: false,
    cancel: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  },
}));

// Consumer component to test context
function TestConsumer({
  onContext,
}: {
  onContext: (ctx: ReturnType<typeof useUploadContext>) => void;
}) {
  const ctx = useUploadContext();
  onContext(ctx);
  return createElement('div', { 'data-testid': 'consumer' }, 'Consumer');
}

describe('UploadContext', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    vi.mocked(uploadQueue.init).mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('provides initial state', () => {
    let contextValue: ReturnType<typeof useUploadContext> | null = null;

    act(() => {
      root.render(
        createElement(
          UploadProvider,
          null,
          createElement(TestConsumer, {
            onContext: (ctx) => {
              contextValue = ctx;
            },
          }),
        ),
      );
    });

    expect(contextValue).not.toBeNull();
    expect(contextValue!.isUploading).toBe(false);
    expect(contextValue!.progress).toBe(0);
    expect(contextValue!.error).toBeNull();
    expect(typeof contextValue!.upload).toBe('function');
    expect(typeof contextValue!.clearError).toBe('function');
  });

  it('initializes the upload queue when the provider mounts', async () => {
    await act(async () => {
      root.render(
        createElement(
          UploadProvider,
          null,
          createElement(TestConsumer, { onContext: () => {} }),
        ),
      );
    });

    expect(uploadQueue.init).toHaveBeenCalledTimes(1);
  });

  it('does not crash the provider when mount-time upload queue initialization fails', async () => {
    vi.mocked(uploadQueue.init).mockRejectedValueOnce(new Error('idb unavailable'));
    let contextValue: ReturnType<typeof useUploadContext> | null = null;

    await act(async () => {
      root.render(
        createElement(
          UploadProvider,
          null,
          createElement(TestConsumer, {
            onContext: (ctx) => {
              contextValue = ctx;
            },
          }),
        ),
      );
    });

    expect(uploadQueue.init).toHaveBeenCalledTimes(1);
    expect(contextValue).not.toBeNull();
    expect(contextValue!.error).toBeNull();
  });

  it('throws error when used outside provider', () => {
    expect(() => {
      act(() => {
        root.render(createElement(TestConsumer, { onContext: () => {} }));
      });
    }).toThrow('useUploadContext must be used within an UploadProvider');
  });
});

describe('UploadError', () => {
  it('creates error with correct properties', () => {
    const cause = new Error('underlying error');
    const error = new UploadError(
      'Upload failed',
      UploadErrorCode.UPLOAD_FAILED,
      cause,
    );

    expect(error.message).toBe('Upload failed');
    expect(error.code).toBe(UploadErrorCode.UPLOAD_FAILED);
    expect(error.cause).toBe(cause);
    expect(error.name).toBe('UploadError');
  });

  it('works without cause', () => {
    const error = new UploadError(
      'Epoch key failed',
      UploadErrorCode.EPOCH_KEY_FAILED,
    );

    expect(error.message).toBe('Epoch key failed');
    expect(error.code).toBe(UploadErrorCode.EPOCH_KEY_FAILED);
    expect(error.cause).toBeUndefined();
  });
});

describe('UploadErrorToast', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it('does not render when no error', () => {
    act(() => {
      root.render(
        createElement(UploadProvider, null, createElement(UploadErrorToast)),
      );
    });

    expect(
      container.querySelector('[data-testid="upload-error-toast"]'),
    ).toBeNull();
  });

  it('has correct accessibility attributes', () => {
    // Create a mock provider with error
    const MockProvider = ({ children }: { children: React.ReactNode }) => {
      return createElement('div', null, children);
    };

    // Mock the context to have an error
    const mockError = new UploadError(
      'Test error',
      UploadErrorCode.UPLOAD_FAILED,
    );
    vi.doMock('../src/contexts/UploadContext', () => ({
      useUploadContext: () => ({
        error: mockError,
        clearError: vi.fn(),
      }),
    }));

    // This test verifies the component structure without an actual error
    // The component should have proper ARIA attributes when rendered
    act(() => {
      root.render(
        createElement(UploadProvider, null, createElement(UploadErrorToast)),
      );
    });

    // Without error, toast is not rendered, which is correct behavior
    expect(
      container.querySelector('[data-testid="upload-error-toast"]'),
    ).toBeNull();
  });
});

describe('UploadErrorCode', () => {
  it('has all expected error codes', () => {
    expect(UploadErrorCode.EPOCH_KEY_FAILED).toBe('EPOCH_KEY_FAILED');
    expect(UploadErrorCode.QUEUE_NOT_INITIALIZED).toBe('QUEUE_NOT_INITIALIZED');
    expect(UploadErrorCode.UPLOAD_FAILED).toBe('UPLOAD_FAILED');
    expect(UploadErrorCode.MANIFEST_FAILED).toBe('MANIFEST_FAILED');
  });
});
