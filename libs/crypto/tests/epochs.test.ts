import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import {
  generateEpochKey,
  isValidEpochKey,
  deriveTierKeys,
  getTierKey,
} from '../src/epochs';
import { ShardTier } from '../src/types';

beforeAll(async () => {
  await sodium.ready;
});

describe('epochs', () => {
  it('generates valid epoch keys with tiered keys', () => {
    const epoch = generateEpochKey(1);
    expect(epoch.epochId).toBe(1);
    expect(epoch.epochSeed.length).toBe(32);
    expect(epoch.thumbKey.length).toBe(32);
    expect(epoch.previewKey.length).toBe(32);
    expect(epoch.fullKey.length).toBe(32);
    expect(epoch.signKeypair.publicKey.length).toBe(32);
    expect(epoch.signKeypair.secretKey.length).toBe(64);
    expect(isValidEpochKey(epoch)).toBe(true);
  });

  it('generates different keys each time', () => {
    const e1 = generateEpochKey(1);
    const e2 = generateEpochKey(1);
    expect(e1.epochSeed).not.toEqual(e2.epochSeed);
    expect(e1.thumbKey).not.toEqual(e2.thumbKey);
    expect(e1.fullKey).not.toEqual(e2.fullKey);
  });

  it('derives consistent tier keys from seed', () => {
    const epoch = generateEpochKey(1);
    const derived = deriveTierKeys(epoch.epochSeed);
    expect(derived.thumbKey).toEqual(epoch.thumbKey);
    expect(derived.previewKey).toEqual(epoch.previewKey);
    expect(derived.fullKey).toEqual(epoch.fullKey);
  });

  it('validates epoch key structure', () => {
    const valid = generateEpochKey(1);
    expect(isValidEpochKey(valid)).toBe(true);

    expect(isValidEpochKey({ ...valid, epochId: -1 })).toBe(false);
    expect(isValidEpochKey({ ...valid, epochSeed: new Uint8Array(16) })).toBe(
      false,
    );
    expect(isValidEpochKey({ ...valid, thumbKey: new Uint8Array(16) })).toBe(
      false,
    );
    expect(isValidEpochKey({ ...valid, previewKey: new Uint8Array(16) })).toBe(
      false,
    );
    expect(isValidEpochKey({ ...valid, fullKey: new Uint8Array(16) })).toBe(
      false,
    );
    expect(
      isValidEpochKey({
        ...valid,
        signKeypair: { ...valid.signKeypair, publicKey: new Uint8Array(16) },
      }),
    ).toBe(false);
    expect(
      isValidEpochKey({
        ...valid,
        signKeypair: { ...valid.signKeypair, secretKey: new Uint8Array(16) },
      }),
    ).toBe(false);
  });

  it('validates epochId is a number (kills typeof mutation)', () => {
    const valid = generateEpochKey(1);

    // Test non-number epochId values - these should all be invalid
    // This kills the mutation: typeof epochKey.epochId !== 'number' → false
    expect(
      isValidEpochKey({ ...valid, epochId: '1' as unknown as number }),
    ).toBe(false);
    expect(
      isValidEpochKey({ ...valid, epochId: undefined as unknown as number }),
    ).toBe(false);
    expect(
      isValidEpochKey({ ...valid, epochId: null as unknown as number }),
    ).toBe(false);
    expect(
      isValidEpochKey({ ...valid, epochId: {} as unknown as number }),
    ).toBe(false);
  });

  it('accepts epochId=0 as valid (kills boundary mutation)', () => {
    // epochId=0 should be VALID - this kills the mutation: epochId < 0 → epochId <= 0
    const epochZero = generateEpochKey(0);
    expect(epochZero.epochId).toBe(0);
    expect(isValidEpochKey(epochZero)).toBe(true);
  });

  it('rejects invalid seed length in deriveTierKeys', () => {
    const invalidSeed = new Uint8Array(16); // Should be 32 bytes
    expect(() => deriveTierKeys(invalidSeed)).toThrow('32 bytes');
  });

  // ====================================================================
  // Mutation testing: Context string mutations (L15, L17, L19)
  // These tests kill mutants where THUMB_KEY_CONTEXT, PREVIEW_KEY_CONTEXT,
  // or FULL_KEY_CONTEXT are mutated to empty strings.
  // True snapshot tests compare against known-good values.
  // ====================================================================
  describe('tier key context separation', () => {
    it('all three tier keys are DIFFERENT from each other', () => {
      // This is the KEY test - if any context string is mutated to empty,
      // some tier keys would become identical (same seed + same/empty context = same key)
      const seed = new Uint8Array(32).fill(0x42); // Fixed seed for determinism
      const { thumbKey, previewKey, fullKey } = deriveTierKeys(seed);

      // All three keys MUST be different when contexts are different
      // If THUMB_KEY_CONTEXT were empty and PREVIEW_KEY_CONTEXT were empty,
      // thumbKey and previewKey would be identical -> test fails
      expect(thumbKey).not.toEqual(previewKey);
      expect(previewKey).not.toEqual(fullKey);
      expect(thumbKey).not.toEqual(fullKey);
    });

    it('tier keys are deterministic for same seed', () => {
      const seed = new Uint8Array(32).fill(0xaa);
      const derived1 = deriveTierKeys(seed);
      const derived2 = deriveTierKeys(seed);

      expect(derived1.thumbKey).toEqual(derived2.thumbKey);
      expect(derived1.previewKey).toEqual(derived2.previewKey);
      expect(derived1.fullKey).toEqual(derived2.fullKey);
    });

    // These snapshot tests each check ONE specific tier key against its known value.
    // If the corresponding context string is mutated to empty, that tier's key changes.
    it('thumbKey matches expected snapshot (kills THUMB_KEY_CONTEXT mutation)', () => {
      const seed = new Uint8Array(32).fill(0x00);
      const { thumbKey } = deriveTierKeys(seed);
      const thumbHex = Array.from(thumbKey)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      // This value was computed with THUMB_KEY_CONTEXT = 'mosaic:tier:thumb:v1'
      // If context is mutated to empty, this will NOT match.
      expect(thumbHex).toBe(
        'bf0269d2b1da019bb441ff453b911936794ebcdd3cb8a904f65edd969a124148',
      );
    });

    it('previewKey matches expected snapshot (kills PREVIEW_KEY_CONTEXT mutation)', () => {
      const seed = new Uint8Array(32).fill(0x00);
      const { previewKey } = deriveTierKeys(seed);
      const previewHex = Array.from(previewKey)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      // This value was computed with PREVIEW_KEY_CONTEXT = 'mosaic:tier:preview:v1'
      // If context is mutated to empty, this will NOT match.
      expect(previewHex).toBe(
        'd414a5f96fb87136dd1c55eee5520551cec4348a47ea2e39639bff23857f0244',
      );
    });

    it('fullKey matches expected snapshot (kills FULL_KEY_CONTEXT mutation)', () => {
      const seed = new Uint8Array(32).fill(0x00);
      const { fullKey } = deriveTierKeys(seed);
      const fullHex = Array.from(fullKey)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      // This value was computed with FULL_KEY_CONTEXT = 'mosaic:tier:full:v1'
      // If context is mutated to empty, this will NOT match.
      expect(fullHex).toBe(
        '9b633d1b035a316d69a0724f8b99dde184dd38c392c0387bd65920af47273dcd',
      );
    });
  });

  describe('getTierKey', () => {
    it('returns thumbKey for THUMB tier', () => {
      const epoch = generateEpochKey(1);
      const key = getTierKey(epoch, ShardTier.THUMB);
      expect(key).toEqual(epoch.thumbKey);
    });

    it('returns previewKey for PREVIEW tier', () => {
      const epoch = generateEpochKey(1);
      const key = getTierKey(epoch, ShardTier.PREVIEW);
      expect(key).toEqual(epoch.previewKey);
    });

    it('returns fullKey for ORIGINAL tier', () => {
      const epoch = generateEpochKey(1);
      const key = getTierKey(epoch, ShardTier.ORIGINAL);
      expect(key).toEqual(epoch.fullKey);
    });

    it('throws for invalid tier', () => {
      const epoch = generateEpochKey(1);
      expect(() => getTierKey(epoch, 0 as ShardTier)).toThrow(
        'Invalid shard tier',
      );
      expect(() => getTierKey(epoch, 99 as ShardTier)).toThrow(
        'Invalid shard tier',
      );
    });
  });
});
