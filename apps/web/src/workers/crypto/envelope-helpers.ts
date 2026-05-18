/**
 * Crypto-worker envelope parsing helpers.
 *
 * Extracted from `crypto.worker.ts` (Sweep 39). Pure functions that
 * inspect the on-wire shard envelope header — no state, no side effects.
 *
 * Envelope layout (v0.3 / v0.4):
 *  - V03 (legacy single-shot): 17-byte header [magic(4) | ver(1) | tier(1)
 *    | epoch(4) | shard(4) | nonce-prefix(...)]. Parsed inline in
 *    CryptoWorker today.
 *  - V04 (streaming): 30-byte header [magic(4) | ver(1) | tier(1) |
 *    streamSalt(16) | frameCount(4 LE) | finalFrameSize(4 LE)].
 */
import {
  WorkerCryptoError,
  WorkerCryptoErrorCode,
  type EnvelopeHeader,
} from '../types';

export const ENVELOPE_VERSION_V03 = 0x03;
export const ENVELOPE_VERSION_V04 = 0x04;
export const STREAM_ENVELOPE_HEADER_BYTES = 30;
export const STREAM_FRAME_SIZE_BYTES = 65_536;

export function readU32Le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)
  ) >>> 0;
}

export function parseStreamingEnvelopeHeader(envelope: Uint8Array): EnvelopeHeader {
  if (envelope.length < STREAM_ENVELOPE_HEADER_BYTES) {
    throw new WorkerCryptoError(
      WorkerCryptoErrorCode.InvalidHeaderLength,
      'streaming envelope header is too short',
    );
  }
  if (
    envelope[0] !== 0x53 ||
    envelope[1] !== 0x47 ||
    envelope[2] !== 0x7a ||
    envelope[3] !== 0x6b
  ) {
    throw new WorkerCryptoError(
      WorkerCryptoErrorCode.InvalidMagic,
      'streaming envelope magic is invalid',
    );
  }
  const tier = envelope[5]!;
  if (tier < 1 || tier > 3) {
    throw new WorkerCryptoError(
      WorkerCryptoErrorCode.InvalidTier,
      'streaming envelope tier is invalid',
    );
  }
  const frameCount = readU32Le(envelope, 22);
  const finalFrameSize = readU32Le(envelope, 26);
  if (
    frameCount === 0 ||
    finalFrameSize === 0 ||
    finalFrameSize > STREAM_FRAME_SIZE_BYTES
  ) {
    throw new WorkerCryptoError(
      WorkerCryptoErrorCode.InvalidEnvelope,
      'streaming envelope frame metadata is invalid',
    );
  }

  return {
    magic: 'SGzk',
    version: ENVELOPE_VERSION_V04,
    epoch: 0,
    shard: 0,
    tier,
    streamSalt: new Uint8Array(envelope.subarray(6, 22)),
    frameCount,
    finalFrameSize,
  };
}

export function ensureNonNullRawEpochHandle(epochHandleId: bigint): void {
  if (epochHandleId === 0n) {
    throw new WorkerCryptoError(
      WorkerCryptoErrorCode.HandleNotFound,
      'epoch handle ID 0 is not a valid WASM handle',
    );
  }
}
