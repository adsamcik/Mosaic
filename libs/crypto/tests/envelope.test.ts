import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { encryptShard, decryptShard, peekHeader, verifyShard, parseShardHeader } from '../src/envelope';
import { ENVELOPE_HEADER_SIZE, ENVELOPE_VERSION, MAX_SHARD_SIZE, CryptoErrorCode, ShardTier } from '../src/types';

beforeAll(async () => {
  await sodium.ready;
});

describe('envelope', () => {
  const tierKey = sodium.randombytes_buf(32);
  const testData = new TextEncoder().encode('Hello, encrypted world!');

  it('round-trips encrypt/decrypt', async () => {
    const { ciphertext } = await encryptShard(testData, tierKey, 1, 0, ShardTier.ORIGINAL);
    const decrypted = await decryptShard(ciphertext, tierKey);
    expect(decrypted).toEqual(testData);
  });

  it('round-trips encrypt/decrypt with empty data', async () => {
    const emptyData = new Uint8Array(0);
    const { ciphertext } = await encryptShard(emptyData, tierKey, 1, 0, ShardTier.ORIGINAL);
    // Ciphertext should contain header (64 bytes) + auth tag (16 bytes for XChaCha20-Poly1305)
    expect(ciphertext.length).toBe(ENVELOPE_HEADER_SIZE + 16);
    const decrypted = await decryptShard(ciphertext, tierKey);
    expect(decrypted).toEqual(emptyData);
    expect(decrypted.length).toBe(0);
  });

  it('includes epochId, shardId, and tier in header', async () => {
    const { ciphertext } = await encryptShard(testData, tierKey, 42, 7, ShardTier.PREVIEW);
    const header = peekHeader(ciphertext);
    expect(header.epochId).toBe(42);
    expect(header.shardId).toBe(7);
    expect(header.tier).toBe(ShardTier.PREVIEW);
  });

  it('produces different ciphertext each time (random nonce)', async () => {
    const { ciphertext: c1 } = await encryptShard(testData, tierKey, 1, 0, ShardTier.ORIGINAL);
    const { ciphertext: c2 } = await encryptShard(testData, tierKey, 1, 0, ShardTier.ORIGINAL);
    expect(c1).not.toEqual(c2);
  });

  it('fails decrypt with wrong key', async () => {
    const { ciphertext } = await encryptShard(testData, tierKey, 1, 0, ShardTier.ORIGINAL);
    const wrongKey = sodium.randombytes_buf(32);
    await expect(decryptShard(ciphertext, wrongKey)).rejects.toThrow();
  });

  it('fails decrypt with corrupted ciphertext', async () => {
    const { ciphertext } = await encryptShard(testData, tierKey, 1, 0, ShardTier.ORIGINAL);
    ciphertext[ENVELOPE_HEADER_SIZE + 5] ^= 0xff;
    await expect(decryptShard(ciphertext, tierKey)).rejects.toThrow();
  });

  it('fails decrypt with corrupted header (AAD verification)', async () => {
    const { ciphertext } = await encryptShard(testData, tierKey, 1, 0, ShardTier.ORIGINAL);
    ciphertext[5] ^= 0xff; // Corrupt epochId byte
    await expect(decryptShard(ciphertext, tierKey)).rejects.toThrow();
  });

  it('fails if reserved bytes are non-zero', async () => {
    const { ciphertext } = await encryptShard(testData, tierKey, 1, 0, ShardTier.ORIGINAL);
    ciphertext[40] = 0x01; // Set a reserved byte
    await expect(decryptShard(ciphertext, tierKey)).rejects.toThrow('reserved');
  });

  it('produces consistent SHA256 hash', async () => {
    const result = await encryptShard(testData, tierKey, 1, 0, ShardTier.ORIGINAL);
    const verified = await verifyShard(result.ciphertext, result.sha256);
    expect(verified).toBe(true);
  });

  it('rejects invalid key length on encrypt', async () => {
    await expect(encryptShard(testData, new Uint8Array(16), 1, 0, ShardTier.ORIGINAL)).rejects.toThrow('32 bytes');
  });

  it('rejects invalid key length on decrypt with short key', async () => {
    const { ciphertext } = await encryptShard(testData, tierKey, 1, 0, ShardTier.ORIGINAL);
    await expect(decryptShard(ciphertext, new Uint8Array(16))).rejects.toThrow('32 bytes');
  });

  it('rejects invalid key length on decrypt with long key', async () => {
    const { ciphertext } = await encryptShard(testData, tierKey, 1, 0, ShardTier.ORIGINAL);
    const longKey = new Uint8Array(64); // Too long
    await expect(decryptShard(ciphertext, longKey)).rejects.toThrow('32 bytes');
  });

  it('rejects shard data exceeding MAX_SHARD_SIZE', async () => {
    const oversizedData = new Uint8Array(MAX_SHARD_SIZE + 1);
    await expect(encryptShard(oversizedData, tierKey, 1, 0, ShardTier.ORIGINAL)).rejects.toThrow('too large');
  });

  it('rejects envelope with no ciphertext (header only)', async () => {
    // Create a valid header but no ciphertext
    const headerOnly = new Uint8Array(ENVELOPE_HEADER_SIZE);
    // Set magic bytes
    headerOnly.set([0x53, 0x47, 0x7a, 0x6b], 0);
    // Set version
    headerOnly[4] = ENVELOPE_VERSION;
    // Set tier (position 37)
    headerOnly[37] = ShardTier.ORIGINAL;
    // Need to set a valid nonce (positions 13-36)
    headerOnly.set(sodium.randombytes_buf(24), 13);
    
    await expect(decryptShard(headerOnly, tierKey)).rejects.toThrow('no ciphertext');
  });

  it('parseShardHeader returns complete header fields', async () => {
    const { ciphertext } = await encryptShard(testData, tierKey, 42, 7, ShardTier.THUMB);
    const header = parseShardHeader(ciphertext);
    expect(header.magic).toBe('SGzk');
    expect(header.version).toBe(ENVELOPE_VERSION);
    expect(header.epochId).toBe(42);
    expect(header.shardId).toBe(7);
    expect(header.tier).toBe(ShardTier.THUMB);
    expect(header.nonce.length).toBe(24);
    expect(header.reserved.length).toBe(26); // 26 reserved bytes now (1 byte used for tier)
    // Reserved bytes should all be zero
    for (const byte of header.reserved) {
      expect(byte).toBe(0);
    }
  });

  it('verifyShard returns false for mismatched hash', async () => {
    const { ciphertext } = await encryptShard(testData, tierKey, 1, 0, ShardTier.ORIGINAL);
    // Use a properly formatted but incorrect base64url hash
    const wrongHash = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const verified = await verifyShard(ciphertext, wrongHash);
    expect(verified).toBe(false);
  });

  it('verifyShard returns false when hash differs by one character', async () => {
    const { ciphertext, sha256 } = await encryptShard(testData, tierKey, 1, 0, ShardTier.ORIGINAL);
    // Flip one character in the hash to ensure comparison catches differences
    const charToChange = sha256[0] === 'A' ? 'B' : 'A';
    const wrongHash = charToChange + sha256.slice(1);
    const verified = await verifyShard(ciphertext, wrongHash);
    expect(verified).toBe(false);
  });

  it('rejects envelope too short for header', async () => {
    const tooShort = new Uint8Array(32);
    await expect(decryptShard(tooShort, tierKey)).rejects.toThrow('too short');
  });

  it('rejects invalid magic bytes', async () => {
    const { ciphertext } = await encryptShard(testData, tierKey, 1, 0, ShardTier.ORIGINAL);
    ciphertext[0] = 0x00; // Corrupt first magic byte
    await expect(decryptShard(ciphertext, tierKey)).rejects.toThrow('magic');
  });

  it('rejects unsupported version', async () => {
    const { ciphertext } = await encryptShard(testData, tierKey, 1, 0, ShardTier.ORIGINAL);
    ciphertext[4] = 0xff; // Set unsupported version
    await expect(decryptShard(ciphertext, tierKey)).rejects.toThrow('version');
  });

  it('encrypts with different tier keys', async () => {
    const thumbKey = sodium.randombytes_buf(32);
    const previewKey = sodium.randombytes_buf(32);
    const fullKey = sodium.randombytes_buf(32);

    const { ciphertext: c1 } = await encryptShard(testData, thumbKey, 1, 0, ShardTier.THUMB);
    const { ciphertext: c2 } = await encryptShard(testData, previewKey, 1, 0, ShardTier.PREVIEW);
    const { ciphertext: c3 } = await encryptShard(testData, fullKey, 1, 0, ShardTier.ORIGINAL);

    // Each can only be decrypted with its own key
    const d1 = await decryptShard(c1, thumbKey);
    const d2 = await decryptShard(c2, previewKey);
    const d3 = await decryptShard(c3, fullKey);

    expect(d1).toEqual(testData);
    expect(d2).toEqual(testData);
    expect(d3).toEqual(testData);

    // Cross-decryption fails
    await expect(decryptShard(c1, previewKey)).rejects.toThrow();
    await expect(decryptShard(c2, fullKey)).rejects.toThrow();
  });

  it('rejects invalid tier value in envelope', async () => {
    const { ciphertext } = await encryptShard(testData, tierKey, 1, 0, ShardTier.ORIGINAL);
    // Tier byte is at position 37, set to invalid value
    ciphertext[37] = 0; // Invalid: tier must be 1, 2, or 3
    await expect(decryptShard(ciphertext, tierKey)).rejects.toThrow('Invalid shard tier');
  });

  it('rejects tier value too high', async () => {
    const { ciphertext } = await encryptShard(testData, tierKey, 1, 0, ShardTier.ORIGINAL);
    ciphertext[37] = 99; // Invalid: tier must be 1, 2, or 3
    await expect(decryptShard(ciphertext, tierKey)).rejects.toThrow('Invalid shard tier');
  });
});
