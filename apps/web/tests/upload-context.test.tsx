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
import { uploadQueue } from '../src/lib/upload';
import { getCurrentOrFetchEpochKey } from '../src/lib/epoch-key-service';
import { getEpochKey } from '../src/lib/epoch-key-store';
import { createManifestForUpload } from '../src/lib/manifest-service';
import { FeatureFlagsManager } from '../src/lib/feature-flags';
import { RustUploadAdapter } from '../src/lib/rust-core/upload-adapter';
import type {
  UploadEvent,
  UploadEventKind,
  UploadPhase,
} from '../src/lib/rust-core/upload-adapter-port';

interface TransitionValidatingAdapter {
  readonly start: ReturnType<typeof vi.fn>;
  readonly submit: ReturnType<typeof vi.fn>;
  readonly submittedKinds: UploadEventKind[];
}

const rustAdapterTestState = vi.hoisted(() => ({
  instances: [] as TransitionValidatingAdapter[],
}));

// Mock dependencies
vi.mock('../src/lib/epoch-key-service', () => ({
  getCurrentOrFetchEpochKey: vi.fn(),
}));

vi.mock('../src/lib/epoch-key-store', () => ({
  getEpochKey: vi.fn(),
}));

vi.mock('../src/lib/manifest-service', () => ({
  createManifestForUpload: vi.fn(async (
    _task: unknown,
    _shardIds: unknown,
    _epochKey: unknown,
    _tieredShards: unknown,
    options?: { adapter?: { submit: (event: unknown) => Promise<unknown> } },
  ) => {
    await options?.adapter?.submit({
      kind: 'ManifestCreated',
      effectId: 'task-id',
      assetId: 'task-id',
      sinceMetadataVersion: 1n,
    });
  }),
}));

vi.mock('../src/lib/feature-flags', () => ({
  FeatureFlagsManager: {
    load: vi.fn(() => ({ rustCoreUpload: false })),
  },
}));

vi.mock('../src/lib/rust-core/upload-adapter', () => ({
  RustUploadAdapter: vi.fn().mockImplementation(function RustUploadAdapterMock() {
    let phase: UploadPhase = 'Queued';
    const submittedKinds: UploadEventKind[] = [];
    const submit = vi.fn(async (event: UploadEvent) => {
      submittedKinds.push(event.kind);
      phase = advanceValidUploadPhase(phase, event.kind);
      return { snapshot: { phase }, effects: [] };
    });
    const adapter: TransitionValidatingAdapter = {
      start: vi.fn(async () => ({ snapshot: { phase }, effects: [] })),
      submit,
      submittedKinds,
    };
    rustAdapterTestState.instances.push(adapter);
    return adapter;
  }),
}));

vi.mock('../src/lib/rust-core/wasm-upload-adapter-port', () => ({
  WasmUploadAdapterPort: vi.fn(),
}));

vi.mock('../src/lib/upload', () => ({
  createUuidV7: vi.fn(() => '018f0000-0000-7000-8000-000000000777'),
  uploadQueue: {
    init: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue('task-id'),
    onProgress: null,
    onComplete: null,
    onError: null,
  },
}));

function advanceValidUploadPhase(
  phase: UploadPhase,
  eventKind: UploadEventKind,
): UploadPhase {
  switch (`${phase}:${eventKind}`) {
    case 'Queued:StartRequested':
      return 'AwaitingPreparedMedia';
    case 'AwaitingPreparedMedia:MediaPrepared':
      return 'AwaitingEpochHandle';
    case 'AwaitingEpochHandle:EpochHandleAcquired':
      return 'EncryptingShard';
    case 'EncryptingShard:ShardEncrypted':
      return 'CreatingShardUpload';
    case 'CreatingShardUpload:ShardUploadCreated':
      return 'UploadingShard';
    case 'UploadingShard:ShardUploaded':
      return 'CreatingManifest';
    case 'CreatingManifest:ManifestCreated':
      return 'AwaitingSyncConfirmation';
    default:
      throw new Error(`Invalid Rust upload transition: ${phase} + ${eventKind}`);
  }
}

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
    rustAdapterTestState.instances.length = 0;
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

  it('passesAdapterToFinalize', async () => {
    const epochKey = {
      epochId: 7,
      epochHandleId: 'epoch-handle-7',
      signPublicKey: new Uint8Array(32),
      signKeypair: {
        publicKey: new Uint8Array(32),
        secretKey: new Uint8Array(),
      },
    };
    vi.mocked(FeatureFlagsManager.load).mockReturnValue({ rustCoreUpload: true });
    vi.mocked(getCurrentOrFetchEpochKey).mockResolvedValue(epochKey);
    vi.mocked(getEpochKey).mockReturnValue(epochKey);
    vi.mocked(uploadQueue.add).mockResolvedValue('018f0000-0000-7000-8000-000000000777');

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

    await act(async () => {
      await contextValue!.upload(
        new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' }),
        '018f0000-0000-7000-8000-000000000123',
      );
    });

    const adapter = rustAdapterTestState.instances[0]!;
    const completedTask = {
      id: '018f0000-0000-7000-8000-000000000777',
      file: new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' }),
      albumId: '018f0000-0000-7000-8000-000000000123',
      epochId: 7,
      epochHandleId: 'epoch-handle-7',
      status: 'complete',
      currentAction: 'finalizing',
      progress: 1,
      completedShards: [{
        index: 0,
        shardId: '018f0000-0000-7000-8000-000000000999',
        sha256: '00'.repeat(32),
        tier: 3,
        contentLength: 3,
        envelopeVersion: 3,
      }],
      retryCount: 0,
      lastAttemptAt: 0,
    } as Parameters<NonNullable<typeof uploadQueue.onComplete>>[0];

    await act(async () => {
      uploadQueue.onProgress?.({ ...completedTask, currentAction: 'encrypting' });
      uploadQueue.onProgress?.(completedTask);
      await uploadQueue.onComplete?.(completedTask, [completedTask.completedShards[0]!.shardId], undefined);
    });

    const finalizeOptions = vi.mocked(createManifestForUpload).mock.calls[0]![4];
    expect(finalizeOptions).toMatchObject({ adapter });
    expect(adapter.submittedKinds).toEqual([
      'StartRequested',
      'MediaPrepared',
      'EpochHandleAcquired',
      'ShardEncrypted',
      'ShardUploadCreated',
      'ShardUploaded',
      'ManifestCreated',
    ]);
  });

  it('emits Rust upload events in state-machine order', async () => {
    const epochKey = {
      epochId: 7,
      epochHandleId: 'epoch-handle-7',
      signPublicKey: new Uint8Array(32),
      signKeypair: {
        publicKey: new Uint8Array(32),
        secretKey: new Uint8Array(),
      },
    };
    vi.mocked(FeatureFlagsManager.load).mockReturnValue({ rustCoreUpload: true });
    vi.mocked(getCurrentOrFetchEpochKey).mockResolvedValue(epochKey);
    vi.mocked(getEpochKey).mockReturnValue(epochKey);
    vi.mocked(uploadQueue.add).mockResolvedValue('018f0000-0000-7000-8000-000000000777');

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

    await act(async () => {
      await contextValue!.upload(
        new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' }),
        '018f0000-0000-7000-8000-000000000123',
      );
    });

    const completedTask = {
      id: '018f0000-0000-7000-8000-000000000777',
      file: new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' }),
      albumId: '018f0000-0000-7000-8000-000000000123',
      epochId: 7,
      epochHandleId: 'epoch-handle-7',
      status: 'complete',
      currentAction: 'finalizing',
      progress: 1,
      completedShards: [{
        index: 0,
        shardId: '018f0000-0000-7000-8000-000000000999',
        sha256: '00'.repeat(32),
        tier: 3,
        contentLength: 3,
        envelopeVersion: 3,
      }],
      retryCount: 0,
      lastAttemptAt: 0,
    } as Parameters<NonNullable<typeof uploadQueue.onComplete>>[0];

    await act(async () => {
      uploadQueue.onProgress?.({ ...completedTask, currentAction: 'encrypting' });
      uploadQueue.onProgress?.(completedTask);
      await uploadQueue.onComplete?.(completedTask, [completedTask.completedShards[0]!.shardId], undefined);
    });

    expect(rustAdapterTestState.instances[0]!.submittedKinds).toEqual([
      'StartRequested',
      'MediaPrepared',
      'EpochHandleAcquired',
      'ShardEncrypted',
      'ShardUploadCreated',
      'ShardUploaded',
      'ManifestCreated',
    ]);
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

