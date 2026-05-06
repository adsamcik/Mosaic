import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeatureFlagsManager } from '../src/lib/feature-flags';
import { UploadProvider, useUploadContext } from '../src/contexts/UploadContext';

const mocks = vi.hoisted(() => ({
  uploadQueueInit: vi.fn(async () => undefined),
  uploadQueueAdd: vi.fn(async () => 'legacy-task-id'),
  uploadQueueResetLegacy: vi.fn(async () => 0),
  createUuidV7: vi.fn(() => '018f0000-0000-7000-8000-000000000301'),
  rustInit: vi.fn(async () => undefined),
  initUploadJob: vi.fn(() => JSON.stringify({
    code: 0,
    schemaVersion: 1,
    jobId: '018f0000-0000-7000-8000-000000000301',
    albumId: 'album-123',
    phase: 'Queued',
    shardRefCount: 0,
  })),
  advanceUploadJob: vi.fn(() => JSON.stringify({
    code: 0,
    schemaVersion: 1,
    jobId: '018f0000-0000-7000-8000-000000000301',
    albumId: 'album-123',
    phase: 'AwaitingPreparedMedia',
    shardRefCount: 0,
  })),
}));

vi.mock('../src/lib/upload-queue', () => ({
  uploadQueue: {
    init: mocks.uploadQueueInit,
    add: mocks.uploadQueueAdd,
    resetLegacyUploadQueue: mocks.uploadQueueResetLegacy,
  },
  createUuidV7: mocks.createUuidV7,
}));

vi.mock('idb', () => ({
  openDB: vi.fn(async () => ({
    put: vi.fn(async () => undefined),
    get: vi.fn(async () => undefined),
  })),
}));

vi.mock('../src/lib/upload-store-bridge', () => ({
  initUploadStoreBridge: vi.fn(() => () => undefined),
}));

vi.mock('../src/lib/epoch-key-service', () => ({
  getCurrentOrFetchEpochKey: vi.fn(async () => ({
    epochId: 7,
    epochHandleId: 'epoch-handle-7',
    signPublicKey: new Uint8Array(32),
    signKeypair: {
      publicKey: new Uint8Array(32),
      secretKey: new Uint8Array(0),
    },
  })),
}));

vi.mock('../src/lib/epoch-key-store', () => ({
  getEpochKey: vi.fn(),
}));

vi.mock('../src/lib/manifest-service', () => ({
  createManifestForUpload: vi.fn(),
}));

vi.mock('../src/lib/sync-engine', () => ({
  syncEngine: {
    sync: vi.fn(),
  },
}));

vi.mock('../src/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../src/generated/mosaic-wasm/mosaic_wasm.js', () => ({
  default: mocks.rustInit,
  initUploadJob: mocks.initUploadJob,
  advanceUploadJob: mocks.advanceUploadJob,
  clientCoreStateMachineSnapshot: vi.fn(() => '{}'),
}));

function UploadProbe({ onReady }: { readonly onReady: (upload: (file: File, albumId: string) => Promise<void>) => void }) {
  const { upload } = useUploadContext();
  useEffect(() => {
    onReady(upload);
  }, [onReady, upload]);
  return null;
}

async function renderUploadProvider(): Promise<{
  readonly upload: (file: File, albumId: string) => Promise<void>;
  readonly cleanup: () => void;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let capturedUpload: ((file: File, albumId: string) => Promise<void>) | null = null;

  await act(async () => {
    root.render(createElement(
      UploadProvider,
      null,
      createElement(UploadProbe, {
        onReady: (upload) => {
          capturedUpload = upload;
        },
      }),
    ));
  });

  if (capturedUpload === null) {
    throw new Error('Upload context was not captured');
  }

  return {
    upload: capturedUpload,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('UploadContext Rust-core upload rollout flag', () => {
  beforeEach(() => {
    FeatureFlagsManager.reset();
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    FeatureFlagsManager.reset();
    document.body.innerHTML = '';
  });

  it('keeps the legacy upload queue path when rustCoreUpload is false', async () => {
    const { upload, cleanup } = await renderUploadProvider();

    try {
      await act(async () => {
        await upload(new File(['jpeg'], 'photo.jpg', { type: 'image/jpeg' }), 'album-123');
      });

      expect(mocks.initUploadJob).not.toHaveBeenCalled();
      expect(mocks.uploadQueueAdd).toHaveBeenCalledWith(
        expect.any(File),
        'album-123',
        7,
        'epoch-handle-7',
      );
    } finally {
      cleanup();
    }
  });

  it('starts the RustUploadAdapter before the legacy queue during staged rollout', async () => {
    FeatureFlagsManager.save({ rustCoreUpload: true });
    mocks.createUuidV7
      .mockReturnValueOnce('018f0000-0000-7000-8000-000000000401')
      .mockReturnValueOnce('018f0000-0000-7000-8000-000000000402')
      .mockReturnValueOnce('018f0000-0000-7000-8000-000000000403')
      .mockReturnValueOnce('018f0000-0000-7000-8000-000000000404');
    const { upload, cleanup } = await renderUploadProvider();

    try {
      await act(async () => {
        await upload(new File(['jpeg'], 'photo.jpg', { type: 'image/jpeg' }), 'album-123');
      });

      expect(mocks.rustInit).toHaveBeenCalled();
      expect(mocks.initUploadJob).toHaveBeenCalledOnce();
      expect(mocks.initUploadJob).toHaveBeenCalledWith(
        '018f0000-0000-7000-8000-000000000401',
        'album-123',
        '018f0000-0000-7000-8000-000000000402',
        '018f0000-0000-7000-8000-000000000403',
        3,
      );
      expect(mocks.advanceUploadJob).toHaveBeenCalledOnce();
      expect(mocks.advanceUploadJob.mock.calls[0]?.[10]).toBe('StartRequested');
      expect(mocks.advanceUploadJob.mock.calls[0]?.[11]).toBe('018f0000-0000-7000-8000-000000000404');
      expect(mocks.advanceUploadJob.mock.calls[0]?.[11]).not.toBe(mocks.advanceUploadJob.mock.calls[0]?.[9]);
      expect(mocks.uploadQueueAdd).toHaveBeenCalledOnce();
    } finally {
      cleanup();
    }
  });

  it('falls back to the legacy upload queue when Rust preflight throws', async () => {
    FeatureFlagsManager.save({ rustCoreUpload: true });
    mocks.advanceUploadJob.mockImplementationOnce(() => {
      throw new Error('advance failed');
    });
    const { upload, cleanup } = await renderUploadProvider();

    try {
      await act(async () => {
        await upload(new File(['jpeg'], 'photo.jpg', { type: 'image/jpeg' }), 'album-123');
      });

      expect(mocks.initUploadJob).toHaveBeenCalledOnce();
      expect(mocks.advanceUploadJob).toHaveBeenCalledOnce();
      expect(mocks.uploadQueueAdd).toHaveBeenCalledWith(
        expect.any(File),
        'album-123',
        7,
        'epoch-handle-7',
      );
    } finally {
      cleanup();
    }
  });
});
