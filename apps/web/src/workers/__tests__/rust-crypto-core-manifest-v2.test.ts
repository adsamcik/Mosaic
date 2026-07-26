import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockData = vi.hoisted(() => ({
  initRustWasm: vi.fn(async () => undefined),
  manifestTranscriptBytes: vi.fn(),
  manifestTranscriptBytesV2: vi.fn(),
}));

vi.mock('../../generated/mosaic-wasm/mosaic_wasm.js', () => ({
  default: mockData.initRustWasm,
  manifestTranscriptBytes: mockData.manifestTranscriptBytes,
  manifestTranscriptBytesV2: mockData.manifestTranscriptBytesV2,
}));

import { RustHandleFacade } from '../rust-crypto-core';

function bytesResult(bytes: readonly number[]) {
  return {
    code: 0,
    bytes: new Uint8Array(bytes),
    free: vi.fn(),
  };
}

const baseInput = {
  albumId: '00000000-0000-4000-8000-000000000001',
  epochId: 7,
  encryptedMeta: new Uint8Array([1, 2, 3]),
  shards: [],
} as const;

describe('RustHandleFacade manifest transcript v2 bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockData.manifestTranscriptBytes.mockReturnValue(bytesResult([1]));
    mockData.manifestTranscriptBytesV2.mockReturnValue(bytesResult([2]));
  });

  it('keeps unsequenced legacy manifests on the v1 binding', () => {
    const facade = new RustHandleFacade();

    expect(facade.manifestTranscriptBytes(baseInput)).toEqual(
      new Uint8Array([1]),
    );
    expect(mockData.manifestTranscriptBytes).toHaveBeenCalledTimes(1);
    expect(mockData.manifestTranscriptBytesV2).not.toHaveBeenCalled();
  });

  it('binds a valid sequence through the v2 wasm export as a bigint', () => {
    const facade = new RustHandleFacade();

    expect(
      facade.manifestTranscriptBytes({ ...baseInput, manifestSeq: 17 }),
    ).toEqual(new Uint8Array([2]));
    expect(mockData.manifestTranscriptBytes).not.toHaveBeenCalled();
    expect(mockData.manifestTranscriptBytesV2).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      7,
      17n,
      baseInput.encryptedMeta,
      expect.any(Uint8Array),
    );
  });

  it('rejects a zero sequence before it reaches the v2 wasm export', () => {
    const facade = new RustHandleFacade();

    expect(() =>
      facade.manifestTranscriptBytes({ ...baseInput, manifestSeq: 0 }),
    ).toThrow('manifestSeq must be a positive safe integer');
    expect(mockData.manifestTranscriptBytes).not.toHaveBeenCalled();
    expect(mockData.manifestTranscriptBytesV2).not.toHaveBeenCalled();
  });
});
