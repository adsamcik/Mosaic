import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockData = vi.hoisted(() => {
  const state = {
    shareHandle: 41n,
    tierHandle: 73n,
    linkId: new Uint8Array([1, 2, 3, 4]),
    linkUrlToken: new Uint8Array(32).fill(9),
    nonce: new Uint8Array(24).fill(2),
    encryptedKey: new Uint8Array(48).fill(3),
    plaintext: new Uint8Array([7, 8, 9]),
  };
  function result<T extends object>(value: T): T & { code: number; free(): void } {
    return { code: 0, free: vi.fn(), ...value };
  }
  const wasmMock = {
    default: vi.fn(async () => undefined),
    createLinkShareHandle: vi.fn(() =>
      result({
        handle: state.shareHandle,
        linkId: state.linkId,
        linkUrlToken: state.linkUrlToken,
        tier: 1,
        nonce: state.nonce,
        encryptedKey: state.encryptedKey,
      }),
    ),
    wrapLinkTierHandle: vi.fn(() =>
      result({ tier: 2, nonce: state.nonce, encryptedKey: state.encryptedKey }),
    ),
    importLinkTierHandle: vi.fn(() =>
      result({ handle: state.tierHandle, linkId: state.linkId, tier: 2 }),
    ),
    decryptShardWithLinkTierHandle: vi.fn(() =>
      result({ plaintext: state.plaintext }),
    ),
    importLinkShareHandle: vi.fn(() =>
      result({ handle: state.shareHandle, linkId: state.linkId, tier: 0 }),
    ),
    closeLinkShareHandle: vi.fn(() => 0),
    closeLinkTierHandle: vi.fn(() => 0),
  };
  return { state, wasmMock };
});

vi.mock('../../generated/mosaic-wasm/mosaic_wasm.js', () => mockData.wasmMock);

import { RustHandleFacade } from '../rust-crypto-core';

describe('RustHandleFacade link-share handle round trip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates, wraps, imports, and decrypts through handles without raw wrapping keys', async () => {
    const facade = new RustHandleFacade();
    await facade.init();

    const created = facade.createLinkShareHandle('album', 11n, 1);
    expect(created.handle).toBe(mockData.state.shareHandle);
    expect([...created.linkUrlToken]).toEqual([...mockData.state.linkUrlToken]);
    expect([...created.linkId]).toEqual([...mockData.state.linkId]);

    const wrapped = facade.wrapLinkTierHandle(created.handle, 11n, 2);
    expect(wrapped.tier).toBe(2);

    const imported = facade.importLinkTierHandle(
      created.linkUrlToken,
      wrapped.nonce,
      wrapped.encryptedKey,
      'album',
      2,
    );
    expect(imported.handle).toBe(mockData.state.tierHandle);
    expect([...imported.linkId]).toEqual([...created.linkId]);

    const plaintext = facade.decryptShardWithLinkTierHandle(
      imported.handle,
      new Uint8Array([4, 5, 6]),
    );
    expect([...plaintext]).toEqual([...mockData.state.plaintext]);
    expect(mockData.wasmMock.createLinkShareHandle).toHaveBeenCalledWith('album', 11n, 1);
    expect(mockData.wasmMock.wrapLinkTierHandle).toHaveBeenCalledWith(mockData.state.shareHandle, 11n, 2);
    expect(mockData.wasmMock.importLinkTierHandle).toHaveBeenCalledWith(
      mockData.state.linkUrlToken,
      mockData.state.nonce,
      mockData.state.encryptedKey,
      'album',
      2,
    );
    expect(mockData.wasmMock.decryptShardWithLinkTierHandle).toHaveBeenCalledWith(
      mockData.state.tierHandle,
      new Uint8Array([4, 5, 6]),
    );
  });
});