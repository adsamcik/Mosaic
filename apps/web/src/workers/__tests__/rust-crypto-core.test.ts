import { describe, expect, it, vi } from 'vitest';
import {
  buildLegacyManifestTranscript,
  parseEnvelopeHeaderFromRust,
  verifyLegacyManifestWithRust,
  type RustCryptoCore,
} from '../rust-crypto-core';

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
