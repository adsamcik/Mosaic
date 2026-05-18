import { describe, it, expect } from 'vitest';
import {
  computeContentHash,
  computeContentHashStreaming,
  STREAMING_HASH_CHUNK_BYTES,
} from '../content-hash';

/**
 * v1.0.x s47-y1: large files must stream their content hash instead of
 * allocating one ArrayBuffer covering the whole plaintext. This test
 * asserts the streaming variant produces a bit-identical result to the
 * one-shot path, even when the input crosses several internal chunk
 * boundaries.
 */
describe('computeContentHashStreaming (s47-y1)', () => {
  it('produces the same hash as computeContentHash for small inputs', async () => {
    const bytes = new Uint8Array(1024);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = i & 0xff;
    }
    const file = new File([bytes], 'small.bin', { type: 'application/octet-stream' });

    const streamingHash = await computeContentHashStreaming(file);
    const oneShotHash = await computeContentHash(bytes);

    expect(streamingHash).toBe(oneShotHash);
  });

  it('produces the same hash across many chunks (forces multi-chunk path)', async () => {
    const totalBytes = STREAMING_HASH_CHUNK_BYTES * 2 + 1024;
    const bytes = new Uint8Array(totalBytes);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = (i * 31) & 0xff;
    }
    const file = new File([bytes], 'big.bin', { type: 'application/octet-stream' });

    const streamingHash = await computeContentHashStreaming(file);
    const oneShotHash = await computeContentHash(bytes);

    expect(streamingHash).toBe(oneShotHash);
  });

  it('handles empty files', async () => {
    const file = new File([], 'empty.bin');
    const streamingHash = await computeContentHashStreaming(file);
    const oneShotHash = await computeContentHash(new Uint8Array(0));
    expect(streamingHash).toBe(oneShotHash);
  });
});
