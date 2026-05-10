import { describe, expect, it, vi } from 'vitest';
import {
  parseEnvelopeHeaderFromRust,
  rustCodeToWorkerCode,
  type RustCryptoCore,
} from '../rust-crypto-core';
import { WorkerCryptoErrorCode } from '../types';

function headerResult(
  code: number,
  epochId = 17,
  shardIndex = 23,
  tier = 3,
) {
  return {
    code,
    epochId,
    shardIndex,
    tier,
    free: vi.fn(),
  };
}

describe('rust-crypto-core', () => {

  it('maps every stable Rust ClientErrorCode to its matching worker code', () => {
    const rustClientErrorCodes = [
      0, 100, 101, 102, 103, 104, 200, 201, 202, 203, 204, 205, 206, 207, 208,
      209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222,
      223, 224, 225, 226, 227, 300, 400, 401, 402, 403, 500, 600, 601, 602,
      603, 604, 605, 606, 607, 608, 609, 610, 611, 612, 613, 614, 615, 616,
      617, 618, 700, 701, 702, 703, 704, 705, 706, 707, 708, 709, 710, 711,
      800,
    ] as const;

    for (const code of rustClientErrorCodes) {
      expect(rustCodeToWorkerCode(code)).toBe(code);
    }
  });

  it('collapses unknown Rust codes without accepting worker-only codes from Rust', () => {
    expect(rustCodeToWorkerCode(999)).toBe(WorkerCryptoErrorCode.InternalStatePoisoned);
    expect(rustCodeToWorkerCode(WorkerCryptoErrorCode.StaleHandle)).toBe(
      WorkerCryptoErrorCode.InternalStatePoisoned,
    );
  });
  it('parses only the transmitted 64-byte envelope header through Rust', () => {
    const parsed = headerResult(0);
    const parseEnvelopeHeader = vi.fn().mockReturnValue(parsed);
    const rust = {
      parseEnvelopeHeader,
    } satisfies RustCryptoCore;

    const envelope = new Uint8Array(80);
    envelope[63] = 7;
    envelope[64] = 99;

    const header = parseEnvelopeHeaderFromRust(rust, envelope);

    expect(header).toEqual({ epochId: 17, shardId: 23, tier: 3 });
    expect(parseEnvelopeHeader).toHaveBeenCalledTimes(1);
    const [headerBytes] = parseEnvelopeHeader.mock.calls[0] as [Uint8Array];
    expect(headerBytes).toHaveLength(64);
    expect(headerBytes[63]).toBe(7);
    expect(parsed.free).toHaveBeenCalledTimes(1);
  });

  it('surfaces Rust header parse errors and still releases the result object', () => {
    const parsed = headerResult(100);
    const rust = {
      parseEnvelopeHeader: vi.fn().mockReturnValue(parsed),
    } satisfies RustCryptoCore;

    expect(() =>
      parseEnvelopeHeaderFromRust(rust, new Uint8Array(64)),
    ).toThrow('Rust envelope header parse failed with code 100');
    expect(parsed.free).toHaveBeenCalledTimes(1);
  });
});
