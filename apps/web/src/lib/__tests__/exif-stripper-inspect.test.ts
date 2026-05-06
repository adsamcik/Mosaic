import { beforeEach, describe, expect, it, vi } from 'vitest';

const wasmMocks = vi.hoisted(() => ({
  initRustWasm: vi.fn().mockResolvedValue(undefined),
  inspectImage: vi.fn(),
  canonicalTierLayout: vi.fn(),
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
  stripAvifMetadata: wasmMocks.stripAvifMetadata,
  stripHeicMetadata: wasmMocks.stripHeicMetadata,
  stripJpegMetadata: wasmMocks.stripJpegMetadata,
  stripPngMetadata: wasmMocks.stripPngMetadata,
  stripVideoMetadata: wasmMocks.stripVideoMetadata,
  stripWebpMetadata: wasmMocks.stripWebpMetadata,
}));

import { inspectImageBlob } from '../exif-stripper';

interface ImageInspectMockResult {
  code: number;
  format: number;
  mimeType: string;
  width: number;
  height: number;
  orientation: number;
  encodedSidecarFields: Uint8Array;
  cameraMake: string;
  cameraModel: string;
  deviceTimestampMs: bigint;
  hasDeviceTimestampMs: boolean;
  subsecondsMs: number;
  hasSubsecondsMs: boolean;
  gpsLatMicrodegrees: number;
  gpsLonMicrodegrees: number;
  gpsAltitudeMeters: number;
  gpsAccuracyMeters: number;
  hasGps: boolean;
  free: () => void;
}

const formatCodes = new Map([
  ['image/jpeg', 1],
  ['image/png', 2],
  ['image/webp', 3],
  ['image/avif', 4],
  ['image/heic', 5],
]);

function tlv(tag: number, value: Uint8Array = new Uint8Array([tag])): Uint8Array {
  return new Uint8Array([
    tag & 0xff,
    (tag >>> 8) & 0xff,
    value.byteLength & 0xff,
    (value.byteLength >>> 8) & 0xff,
    (value.byteLength >>> 16) & 0xff,
    (value.byteLength >>> 24) & 0xff,
    ...value,
  ]);
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function imageResult(mimeType: string): ImageInspectMockResult {
  return {
    code: 0,
    format: formatCodes.get(mimeType) ?? 1,
    mimeType,
    width: 4032,
    height: 3024,
    orientation: 6,
    encodedSidecarFields: concatBytes(tlv(1), tlv(2), tlv(3), tlv(5), tlv(7), tlv(8), tlv(9)),
    cameraMake: 'MosaicCam',
    cameraModel: 'Inspect 1',
    deviceTimestampMs: 1_704_067_200_000n,
    hasDeviceTimestampMs: true,
    subsecondsMs: 123,
    hasSubsecondsMs: true,
    gpsLatMicrodegrees: 50_087_451,
    gpsLonMicrodegrees: 14_420_671,
    gpsAltitudeMeters: 250,
    gpsAccuracyMeters: 5,
    hasGps: true,
    free: vi.fn(),
  };
}

describe('inspectImageBlob Rust inspection dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wasmMocks.inspectImage.mockImplementation((bytes: Uint8Array) => imageResult(bytes[0] === 5 ? 'image/heic' : [...formatCodes.keys()][bytes[0]! - 1]!));
  });

  it.each([
    ['JPEG', 'image/jpeg', new Uint8Array([1, 0xff, 0xd8])],
    ['PNG', 'image/png', new Uint8Array([2, 0x89, 0x50])],
    ['WebP', 'image/webp', new Uint8Array([3, 0x52, 0x49])],
    ['AVIF', 'image/avif', new Uint8Array([4, 0x00, 0x00])],
    ['HEIC', 'image/heic', new Uint8Array([5, 0x00, 0x00])],
  ])('calls inspectImage for %s fixtures and exposes active sidecar tags', async (_label, mimeType, bytes) => {
    const result = await inspectImageBlob(new Blob([bytes], { type: mimeType }), mimeType);

    expect(wasmMocks.inspectImage).toHaveBeenCalledWith(bytes);
    expect(result.mimeType).toBe(mimeType);
    expect(result.width).toBe(4032);
    expect(result.height).toBe(3024);
    expect(result.orientation).toBe(6);
    expect(result.sidecarTags).toEqual([
      'orientation',
      'original_dimensions',
      'device_timestamp_ms',
      'camera_make',
      'camera_model',
      'subseconds_ms',
      'gps',
    ]);
    expect(result.cameraMake).toBe('MosaicCam');
    expect(result.cameraModel).toBe('Inspect 1');
    expect(result.gps).toEqual({
      latitudeMicrodegrees: 50_087_451,
      longitudeMicrodegrees: 14_420_671,
      altitudeMeters: 250,
      accuracyMeters: 5,
    });
  });
});
