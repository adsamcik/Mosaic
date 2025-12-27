import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { generateEpochKey, serializeEpochKeyPublic, wrapEpochKey, unwrapEpochKey, rotateEpochKey, isValidEpochKey } from '../src/epochs';

beforeAll(async () => {
  await sodium.ready;
});

describe('epochs', () => {
  const wrapper = sodium.randombytes_buf(32);

  it('generates valid epoch keys', () => {
    const epoch = generateEpochKey(1);
    expect(epoch.epochId).toBe(1);
    expect(epoch.readKey.length).toBe(32);
    expect(epoch.signKeypair.publicKey.length).toBe(32);
    expect(epoch.signKeypair.secretKey.length).toBe(64);
    expect(isValidEpochKey(epoch)).toBe(true);
  });

  it('generates different keys each time', () => {
    const e1 = generateEpochKey(1);
    const e2 = generateEpochKey(1);
    expect(e1.readKey).not.toEqual(e2.readKey);
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
    expect(unwrapped.readKey).toEqual(epoch.readKey);
    expect(unwrapped.signKeypair.publicKey).toEqual(epoch.signKeypair.publicKey);
    expect(unwrapped.signKeypair.secretKey).toEqual(epoch.signKeypair.secretKey);
  });

  it('rotates epoch with incremented id', () => {
    const current = generateEpochKey(3);
    const next = rotateEpochKey(current);
    expect(next.epochId).toBe(4);
    expect(next.readKey).not.toEqual(current.readKey);
  });

  it('validates epoch key structure', () => {
    const valid = generateEpochKey(1);
    expect(isValidEpochKey(valid)).toBe(true);
    
    expect(isValidEpochKey({ ...valid, epochId: -1 })).toBe(false);
    expect(isValidEpochKey({ ...valid, readKey: new Uint8Array(16) })).toBe(false);
    expect(isValidEpochKey({ ...valid, signKeypair: { ...valid.signKeypair, publicKey: new Uint8Array(16) } })).toBe(false);
    expect(isValidEpochKey({ ...valid, signKeypair: { ...valid.signKeypair, secretKey: new Uint8Array(16) } })).toBe(false);
  });
});
