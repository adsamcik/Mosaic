/**
 * Slice 7 — `AlbumContentContext` integration tests.
 *
 * Verifies that the album-content context routes encrypt/decrypt through
 * the worker's handle-based methods (`encryptAlbumContent`,
 * `decryptAlbumContent`) and never reads the deprecated `epochSeed`
 * placeholder on `EpochKeyBundle`.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  api: {
    getAlbumContent: vi.fn(),
    updateAlbumContent: vi.fn(),
  },
  crypto: {
    encryptAlbumContent: vi.fn(),
    decryptAlbumContent: vi.fn(),
  },
  epochStore: {
    getCurrentEpochKey: vi.fn(),
  },
}));

vi.mock('../src/lib/api', async () => {
  const actual: { ApiError: typeof Error } = {
    // Minimal shape — the production module exports an `ApiError` class
    // we don't exercise in this test, plus the helpers below.
    ApiError: class ApiErrorMock extends Error {
      readonly status: number;
      constructor(status: number, message: string) {
        super(message);
        this.status = status;
      }
    } as unknown as typeof Error,
  };
  return {
    getApi: () => mocks.api,
    toBase64: (arr: Uint8Array) =>
      Buffer.from(arr).toString('base64'),
    fromBase64: (s: string) =>
      new Uint8Array(Buffer.from(s, 'base64')),
    ApiError: actual.ApiError,
  };
});

vi.mock('../src/lib/crypto-client', () => ({
  getCryptoClient: () => Promise.resolve(mocks.crypto),
}));

vi.mock('../src/lib/epoch-key-store', () => ({
  getCurrentEpochKey: (...args: unknown[]) =>
    mocks.epochStore.getCurrentEpochKey(...args),
}));

vi.mock('../src/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  AlbumContentProvider,
  useAlbumContent,
  type AlbumContentContextValue,
} from '../src/contexts/AlbumContentContext';

function flush(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('AlbumContentContext (Slice 7 — handle-based encryption)', () => {
  let container: HTMLElement;
  let root: Root;
  let hookResult: AlbumContentContextValue | null;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    hookResult = null;

    mocks.epochStore.getCurrentEpochKey.mockReturnValue({
      epochId: 1,
      epochHandleId: 'epch_test-album-content',
      signPublicKey: new Uint8Array(32).fill(2),
      epochSeed: new Uint8Array(0),
      signKeypair: {
        publicKey: new Uint8Array(32).fill(2),
        secretKey: new Uint8Array(0),
      },
    });

    // Slice 7 contract: `decryptAlbumContent` takes `(epochHandleId,
    // nonce, ciphertext)` and returns plaintext bytes.
    mocks.crypto.decryptAlbumContent.mockResolvedValue(
      new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          blocks: [
            {
              id: 'b1',
              type: 'heading',
              level: 1,
              text: 'Hello',
              position: 'a',
            },
          ],
        }),
      ),
    );
    mocks.crypto.encryptAlbumContent.mockResolvedValue({
      nonce: new Uint8Array(24).fill(7),
      ciphertext: new Uint8Array(50).fill(8),
    });

    mocks.api.getAlbumContent.mockResolvedValue({
      encryptedContent: 'AAAA',
      nonce: 'BBBB',
      epochId: 1,
      version: 5,
    });
    mocks.api.updateAlbumContent.mockResolvedValue({ version: 6 });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function renderProvider(albumId: string, epochId: number): void {
    function Harness() {
      hookResult = useAlbumContent();
      return null;
    }

    act(() => {
      root.render(
        createElement(
          AlbumContentProvider,
          { albumId, epochId },
          createElement(Harness),
        ),
      );
    });
  }

  it('decrypts loaded content via crypto.decryptAlbumContent(handleId, nonce, ciphertext)', async () => {
    renderProvider('album-1', 1);
    await flush();
    await flush();

    expect(mocks.crypto.decryptAlbumContent).toHaveBeenCalledTimes(1);
    const call = mocks.crypto.decryptAlbumContent.mock.calls[0]!;
    // First arg is the opaque handle id; second is nonce, third is
    // ciphertext. No raw epoch seed bytes anywhere.
    expect(call[0]).toBe('epch_test-album-content');
    expect(call[1]).toBeInstanceOf(Uint8Array);
    expect(call[2]).toBeInstanceOf(Uint8Array);
    // No additional args (legacy contract had `epochId`).
    expect(call.length).toBe(3);
  });

  it('encrypts on save via crypto.encryptAlbumContent(handleId, plaintext)', async () => {
    renderProvider('album-1', 1);
    await flush();
    await flush();

    expect(hookResult).not.toBeNull();
    let saved = false;
    await act(async () => {
      saved = await hookResult!.saveContent();
    });

    expect(saved).toBe(true);
    expect(mocks.crypto.encryptAlbumContent).toHaveBeenCalledTimes(1);
    const call = mocks.crypto.encryptAlbumContent.mock.calls[0]!;
    expect(call[0]).toBe('epch_test-album-content');
    expect(call[1]).toBeInstanceOf(Uint8Array);
    // Slice 7 — exactly two arguments (handle + plaintext); no seed/epoch id.
    expect(call.length).toBe(2);
  });

  it('routes update through api.updateAlbumContent with handle-encrypted payload', async () => {
    renderProvider('album-1', 1);
    await flush();
    await flush();

    expect(hookResult).not.toBeNull();
    await act(async () => {
      await hookResult!.saveContent();
    });

    expect(mocks.api.updateAlbumContent).toHaveBeenCalledTimes(1);
    const call = mocks.api.updateAlbumContent.mock.calls[0]!;
    const [albumId, payload] = call as [
      string,
      {
        encryptedContent: string;
        nonce: string;
        epochId: number;
        expectedVersion: number;
      },
    ];
    expect(albumId).toBe('album-1');
    expect(payload.epochId).toBe(1);
    // Versioning carries from the prior load (5 → expected 5 on first save).
    expect(payload.expectedVersion).toBe(5);
    expect(typeof payload.encryptedContent).toBe('string');
    expect(typeof payload.nonce).toBe('string');
  });

  it('refuses to save when no epoch handle is cached for the album', async () => {
    mocks.epochStore.getCurrentEpochKey.mockReturnValue(null);
    renderProvider('album-1', 1);
    await flush();

    expect(hookResult).not.toBeNull();
    let saved = true;
    await act(async () => {
      saved = await hookResult!.saveContent();
    });
    expect(saved).toBe(false);
    expect(mocks.crypto.encryptAlbumContent).not.toHaveBeenCalled();
    expect(mocks.api.updateAlbumContent).not.toHaveBeenCalled();
  });
});
