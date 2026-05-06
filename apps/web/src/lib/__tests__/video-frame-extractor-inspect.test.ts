import { beforeEach, describe, expect, it, vi } from 'vitest';

const wasmMocks = vi.hoisted(() => ({
  initRustWasm: vi.fn().mockResolvedValue(undefined),
  canonicalTierLayout: vi.fn(),
  inspectImage: vi.fn(),
  inspectVideoContainer: vi.fn(),
  stripAvifMetadata: vi.fn(),
  stripHeicMetadata: vi.fn(),
  stripJpegMetadata: vi.fn(),
  stripPngMetadata: vi.fn(),
  stripVideoMetadata: vi.fn(),
  stripWebpMetadata: vi.fn(),
}));

vi.mock('../../generated/mosaic-wasm/mosaic_wasm.js', () => ({
  default: wasmMocks.initRustWasm,
  canonicalTierLayout: wasmMocks.canonicalTierLayout,
  inspectImage: wasmMocks.inspectImage,
  inspectVideoContainer: wasmMocks.inspectVideoContainer,
  stripAvifMetadata: wasmMocks.stripAvifMetadata,
  stripHeicMetadata: wasmMocks.stripHeicMetadata,
  stripJpegMetadata: wasmMocks.stripJpegMetadata,
  stripPngMetadata: wasmMocks.stripPngMetadata,
  stripVideoMetadata: wasmMocks.stripVideoMetadata,
  stripWebpMetadata: wasmMocks.stripWebpMetadata,
}));

vi.mock('../thumbnail-generator', () => ({
  getPreferredImageFormat: vi.fn(() => 'image/jpeg'),
}));

import { inspectVideoContainerBlob } from '../video-frame-extractor';

interface VideoInspectMockResult {
  code: number;
  container: string;
  durationMs: bigint;
  frameRateFps: number;
  heightPx: number;
  orientation: string;
  videoCodec: string;
  widthPx: number;
  free: () => void;
}

function videoResult(container: string, codec: string): VideoInspectMockResult {
  return {
    code: 0,
    container,
    durationMs: 12_345n,
    frameRateFps: 29.97,
    heightPx: 1080,
    orientation: 'rotate-90',
    videoCodec: codec,
    widthPx: 1920,
    free: vi.fn(),
  };
}

describe('inspectVideoContainerBlob Rust inspection dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wasmMocks.inspectVideoContainer.mockImplementation((bytes: Uint8Array) => {
      switch (bytes[0]) {
        case 1:
          return videoResult('mp4', 'h264');
        case 2:
          return videoResult('mov', 'h265');
        case 3:
          return videoResult('webm', 'vp9');
        default:
          return { ...videoResult('', ''), code: 1 };
      }
    });
  });

  it.each([
    ['MP4', new Uint8Array([1, 0x00, 0x00, 0x00])],
    ['MOV', new Uint8Array([2, 0x00, 0x00, 0x00])],
    ['WebM', new Uint8Array([3, 0x1a, 0x45, 0xdf, 0xa3])],
  ])('calls inspectVideoContainer for %s fixtures and exposes container sidecar tags', async (label, bytes) => {
    const result = await inspectVideoContainerBlob(new Blob([bytes], { type: `video/${label.toLowerCase()}` }));

    expect(wasmMocks.inspectVideoContainer).toHaveBeenCalledWith(bytes);
    expect(result.duration).toBe(12.345);
    expect(result.durationMs).toBe(12_345n);
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    expect(result.frameRateFps).toBe(29.97);
    expect(result.orientation).toBe('rotate-90');
    expect(result.sidecarTags).toEqual([
      'codec_fourcc',
      'duration_ms',
      'frame_rate_x100',
      'video_orientation',
      'video_dimensions',
      'video_container_format',
    ]);
  });
});
