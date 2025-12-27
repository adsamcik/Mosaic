import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { encryptShard, decryptShard, peekHeader, verifyShard } from '../src/envelope';
import { ENVELOPE_HEADER_SIZE, ENVELOPE_VERSION } from '../src/types';

beforeAll(async () => {
  await sodium.ready;
});

describe('envelope', () => {
  const readKey = sodium.randombytes_buf(32);
  const testData = new TextEncoder().encode('Hello, encrypted world!');

  it('round-trips encrypt/decrypt', async () => {
    const { ciphertext } = await encryptShard(testData, readKey, 1, 0);
    const decrypted = await decryptShard(ciphertext, readKey);
    expect(decrypted).toEqual(testData);
  });

  it('includes epochId and shardId in header', async () => {
    const { ciphertext } = await encryptShard(testData, readKey, 42, 7);
    const header = peekHeader(ciphertext);
    expect(header.epochId).toBe(42);
    expect(header.shardId).toBe(7);
  });

  it('produces different ciphertext each time (random nonce)', async () => {
    const { ciphertext: c1 } = await encryptShard(testData, readKey, 1, 0);
    const { ciphertext: c2 } = await encryptShard(testData, readKey, 1, 0);
    expect(c1).not.toEqual(c2);
  });

  it('fails decrypt with wrong key', async () => {
    const { ciphertext } = await encryptShard(testData, readKey, 1, 0);
    const wrongKey = sodium.randombytes_buf(32);
    await expect(decryptShard(ciphertext, wrongKey)).rejects.toThrow();
  });

  it('fails decrypt with corrupted ciphertext', async () => {
    const { ciphertext } = await encryptShard(testData, readKey, 1, 0);
    ciphertext[ENVELOPE_HEADER_SIZE + 5] ^= 0xff;
    await expect(decryptShard(ciphertext, readKey)).rejects.toThrow();
  });

  it('fails decrypt with corrupted header (AAD verification)', async () => {
    const { ciphertext } = await encryptShard(testData, readKey, 1, 0);
    ciphertext[5] ^= 0xff; // Corrupt epochId byte
    await expect(decryptShard(ciphertext, readKey)).rejects.toThrow();
  });

  it('fails if reserved bytes are non-zero', async () => {
    const { ciphertext } = await encryptShard(testData, readKey, 1, 0);
    ciphertext[40] = 0x01; // Set a reserved byte
    await expect(decryptShard(ciphertext, readKey)).rejects.toThrow('reserved');
  });

  it('produces consistent SHA256 hash', async () => {
    const result = await encryptShard(testData, readKey, 1, 0);
    const verified = await verifyShard(result.ciphertext, result.sha256);
    expect(verified).toBe(true);
  });

  it('rejects invalid key length', async () => {
    await expect(encryptShard(testData, new Uint8Array(16), 1, 0)).rejects.toThrow();
    const { ciphertext } = await encryptShard(testData, readKey, 1, 0);
    await expect(decryptShard(ciphertext, new Uint8Array(16))).rejects.toThrow();
  });
});
