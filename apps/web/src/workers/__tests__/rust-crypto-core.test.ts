import { describe, expect, it, vi } from 'vitest';
import {
  buildLegacyManifestTranscript,
  parseEnvelopeHeaderFromRust,
  rustCodeToWorkerCode,
  verifyLegacyManifestWithRust,
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
  it('builds the legacy manifest transcript signed by the TypeScript reference path', () => {
    const manifest = new Uint8Array([1, 2, 3]);

    const transcript = buildLegacyManifestTranscript(manifest);

    expect(new TextDecoder().decode(transcript.slice(0, 18))).toBe(
      'Mosaic_Manifest_v1',
    );
    expect([...transcript.slice(18)]).toEqual([1, 2, 3]);
    expect([...manifest]).toEqual([1, 2, 3]);
  });

  it('verifies legacy manifest signatures by passing the prefixed transcript to Rust', () => {
    const verifyManifestWithIdentity = vi.fn().mockReturnValue(0);
    const rust = {
      verifyManifestWithIdentity,
      parseEnvelopeHeader: vi.fn(),
    } satisfies RustCryptoCore;

    const verified = verifyLegacyManifestWithRust(
      rust,
      new Uint8Array([9, 8]),
      new Uint8Array(64),
      new Uint8Array(32),
    );

    expect(verified).toBe(true);
    expect(verifyManifestWithIdentity).toHaveBeenCalledTimes(1);
    const [transcript] = verifyManifestWithIdentity.mock.calls[0] as [
      Uint8Array,
      Uint8Array,
      Uint8Array,
    ];
    expect(new TextDecoder().decode(transcript.slice(0, 18))).toBe(
      'Mosaic_Manifest_v1',
    );
    expect([...transcript.slice(18)]).toEqual([9, 8]);
  });

  it('rejects malformed manifest verification inputs before calling Rust', () => {
    const verifyManifestWithIdentity = vi.fn().mockReturnValue(0);
    const rust = {
      verifyManifestWithIdentity,
      parseEnvelopeHeader: vi.fn(),
    } satisfies RustCryptoCore;

    expect(
      verifyLegacyManifestWithRust(
        rust,
        new Uint8Array([1]),
        new Uint8Array(63),
        new Uint8Array(32),
      ),
    ).toBe(false);
    expect(
      verifyLegacyManifestWithRust(
        rust,
        new Uint8Array([1]),
        new Uint8Array(64),
        new Uint8Array(31),
      ),
    ).toBe(false);
    expect(verifyManifestWithIdentity).not.toHaveBeenCalled();
  });

  it('parses only the transmitted 64-byte envelope header through Rust', () => {
    const parsed = headerResult(0);
    const parseEnvelopeHeader = vi.fn().mockReturnValue(parsed);
    const rust = {
      verifyManifestWithIdentity: vi.fn(),
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
      verifyManifestWithIdentity: vi.fn(),
      parseEnvelopeHeader: vi.fn().mockReturnValue(parsed),
    } satisfies RustCryptoCore;

    expect(() =>
      parseEnvelopeHeaderFromRust(rust, new Uint8Array(64)),
    ).toThrow('Rust envelope header parse failed with code 100');
    expect(parsed.free).toHaveBeenCalledTimes(1);
  });
});
