import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { deriveKeys, unwrapAccountKey, rewrapAccountKey, generateSalts } from '../src/keychain';

beforeAll(async () => {
  await sodium.ready;
});

describe('keychain', () => {
  const password = 'test-password-123';
  const { userSalt, accountSalt } = generateSalts();
  const fastParams = { memory: 1024, iterations: 1, parallelism: 1 }; // Fast for tests

  it('derives consistent keys from same inputs', async () => {
    const keys1 = await deriveKeys(password, userSalt, accountSalt, fastParams);
    const keys2 = await deriveKeys(password, userSalt, accountSalt, fastParams);
    expect(keys1.masterKey).toEqual(keys2.masterKey);
    expect(keys1.rootKey).toEqual(keys2.rootKey);
  });

  it('produces different keys for different passwords', async () => {
    const keys1 = await deriveKeys('password1', userSalt, accountSalt, fastParams);
    const keys2 = await deriveKeys('password2', userSalt, accountSalt, fastParams);
    expect(keys1.masterKey).not.toEqual(keys2.masterKey);
  });

  it('produces different keys for different salts', async () => {
    const { userSalt: salt2 } = generateSalts();
    const keys1 = await deriveKeys(password, userSalt, accountSalt, fastParams);
    const keys2 = await deriveKeys(password, salt2, accountSalt, fastParams);
    expect(keys1.masterKey).not.toEqual(keys2.masterKey);
  });

  it('produces 32-byte keys', async () => {
    const keys = await deriveKeys(password, userSalt, accountSalt, fastParams);
    expect(keys.masterKey.length).toBe(32);
    expect(keys.rootKey.length).toBe(32);
    expect(keys.accountKey.length).toBe(32);
  });

  it('unwraps account key correctly', async () => {
    const keys = await deriveKeys(password, userSalt, accountSalt, fastParams);
    const unwrapped = await unwrapAccountKey(password, userSalt, accountSalt, keys.accountKeyWrapped, fastParams);
    expect(unwrapped).toEqual(keys.accountKey);
  });

  it('fails unwrap with wrong password', async () => {
    const keys = await deriveKeys(password, userSalt, accountSalt, fastParams);
    await expect(unwrapAccountKey('wrong', userSalt, accountSalt, keys.accountKeyWrapped, fastParams)).rejects.toThrow();
  });

  it('rewraps account key with new password', async () => {
    const keys = await deriveKeys(password, userSalt, accountSalt, fastParams);
    const newWrapped = await rewrapAccountKey(keys.accountKey, 'new-password', userSalt, accountSalt, fastParams);
    const unwrapped = await unwrapAccountKey('new-password', userSalt, accountSalt, newWrapped, fastParams);
    expect(unwrapped).toEqual(keys.accountKey);
  });

  it('rejects invalid salt lengths', async () => {
    await expect(deriveKeys(password, new Uint8Array(8), accountSalt, fastParams)).rejects.toThrow();
    await expect(deriveKeys(password, userSalt, new Uint8Array(8), fastParams)).rejects.toThrow();
  });

  it('rejects wrapped account key too short', async () => {
    // Need at least 24 (nonce) + 16 (tag) + 1 (data) = 41 bytes
    const tooShort = new Uint8Array(30);
    await expect(unwrapAccountKey(password, userSalt, accountSalt, tooShort, fastParams)).rejects.toThrow('too short');
  });

  it('rejects invalid salt lengths for unwrapAccountKey', async () => {
    const keys = await deriveKeys(password, userSalt, accountSalt, fastParams);
    await expect(unwrapAccountKey(password, new Uint8Array(8), accountSalt, keys.accountKeyWrapped, fastParams)).rejects.toThrow();
    await expect(unwrapAccountKey(password, userSalt, new Uint8Array(8), keys.accountKeyWrapped, fastParams)).rejects.toThrow();
  });

  it('rejects rewrapAccountKey with invalid account key length', async () => {
    const invalidAccountKey = new Uint8Array(16); // Should be 32 bytes
    await expect(rewrapAccountKey(invalidAccountKey, 'new-password', userSalt, accountSalt, fastParams)).rejects.toThrow('32 bytes');
  });

  it('generates valid random salts', () => {
    const salts1 = generateSalts();
    const salts2 = generateSalts();
    expect(salts1.userSalt.length).toBe(16);
    expect(salts1.accountSalt.length).toBe(16);
    // Should be random (different each time)
    expect(salts1.userSalt).not.toEqual(salts2.userSalt);
    expect(salts1.accountSalt).not.toEqual(salts2.accountSalt);
  });
});
