import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { generateEpochKey, serializeEpochKeyPublic, wrapEpochKey, unwrapEpochKey, rotateEpochKey, isValidEpochKey, deriveTierKeys } from '../src/epochs';

beforeAll(async () => {
  await sodium.ready;
});

describe('epochs', () => {
  const wrapper = sodium.randombytes_buf(32);

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

  it('serializes epoch key public info', () => {
    const epoch = generateEpochKey(5);
    const serialized = serializeEpochKeyPublic(epoch);
    expect(serialized.epochId).toBe(5);
    expect(typeof serialized.signPublicKey).toBe('string');
  });

  it('round-trips wrap/unwrap', () => {
    const epoch = generateEpochKey(5);
    const wrapped = wrapEpochKey(epoch, wrapper);
    const unwrapped = unwrapEpochKey(wrapped.epochId, wrapped.signPublicKey, wrapped.wrapped, wrapper);
    
    expect(unwrapped.epochId).toBe(epoch.epochId);
    expect(unwrapped.epochSeed).toEqual(epoch.epochSeed);
    expect(unwrapped.thumbKey).toEqual(epoch.thumbKey);
    expect(unwrapped.previewKey).toEqual(epoch.previewKey);
    expect(unwrapped.fullKey).toEqual(epoch.fullKey);
    expect(unwrapped.signKeypair.publicKey).toEqual(epoch.signKeypair.publicKey);
    expect(unwrapped.signKeypair.secretKey).toEqual(epoch.signKeypair.secretKey);
  });

  it('rotates epoch with incremented id', () => {
    const current = generateEpochKey(3);
    const next = rotateEpochKey(current);
    expect(next.epochId).toBe(4);
    expect(next.epochSeed).not.toEqual(current.epochSeed);
    expect(next.fullKey).not.toEqual(current.fullKey);
  });

  it('validates epoch key structure', () => {
    const valid = generateEpochKey(1);
    expect(isValidEpochKey(valid)).toBe(true);
    
    expect(isValidEpochKey({ ...valid, epochId: -1 })).toBe(false);
    expect(isValidEpochKey({ ...valid, epochSeed: new Uint8Array(16) })).toBe(false);
    expect(isValidEpochKey({ ...valid, thumbKey: new Uint8Array(16) })).toBe(false);
    expect(isValidEpochKey({ ...valid, previewKey: new Uint8Array(16) })).toBe(false);
    expect(isValidEpochKey({ ...valid, fullKey: new Uint8Array(16) })).toBe(false);
    expect(isValidEpochKey({ ...valid, signKeypair: { ...valid.signKeypair, publicKey: new Uint8Array(16) } })).toBe(false);
    expect(isValidEpochKey({ ...valid, signKeypair: { ...valid.signKeypair, secretKey: new Uint8Array(16) } })).toBe(false);
  });
});
