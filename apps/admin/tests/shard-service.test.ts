/**
 * Shard Service Unit Tests
 *
 * Tests for the shard download service.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    downloadShard,
    downloadShards,
    ShardDownloadError,
} from '../src/lib/shard-service';

// Store original fetch
const originalFetch = globalThis.fetch;

describe('ShardDownloadError', () => {
  it('creates error with shard ID and cause', () => {
    const cause = new Error('Network failure');
    const error = new ShardDownloadError('shard-123', cause);

    expect(error.shardId).toBe('shard-123');
    expect(error.cause).toBe(cause);
    expect(error.message).toBe(
      'Failed to download shard shard-123: Network failure'
    );
    expect(error.name).toBe('ShardDownloadError');
  });

  it('is instanceof Error', () => {
    const error = new ShardDownloadError('shard-123', new Error('test'));
    expect(error).toBeInstanceOf(Error);
  });
});

describe('downloadShard', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('downloads shard successfully without progress callback', async () => {
    const testData = new Uint8Array([1, 2, 3, 4, 5]);
    
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: vi.fn().mockResolvedValue(testData.buffer),
    });

    const result = await downloadShard('shard-123');

    expect(mockFetch).toHaveBeenCalledWith('/api/shards/shard-123', {
      credentials: 'same-origin',
    });
    expect(result).toEqual(testData);
  });

  it('downloads shard with progress callback', async () => {
    const testData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const progressCallback = vi.fn();

    // Create a mock ReadableStream
    const chunks = [
      new Uint8Array([1, 2, 3, 4, 5]),
      new Uint8Array([6, 7, 8, 9, 10]),
    ];
    let chunkIndex = 0;

    const mockReader = {
      read: vi.fn().mockImplementation(() => {
        if (chunkIndex < chunks.length) {
          const chunk = chunks[chunkIndex++];
          return Promise.resolve({ done: false, value: chunk });
        }
        return Promise.resolve({ done: true, value: undefined });
      }),
    };

    const mockResponse = {
      ok: true,
      status: 200,
      headers: {
        get: vi.fn((name: string) => (name === 'content-length' ? '10' : null)),
      },
      body: {
        getReader: () => mockReader,
      },
    };

    mockFetch.mockResolvedValue(mockResponse);

    const result = await downloadShard('shard-456', progressCallback);

    expect(mockFetch).toHaveBeenCalledWith('/api/shards/shard-456', {
      credentials: 'same-origin',
    });
    expect(result).toEqual(testData);
    expect(progressCallback).toHaveBeenCalledTimes(2);
    expect(progressCallback).toHaveBeenCalledWith(5, 10);
    expect(progressCallback).toHaveBeenCalledWith(10, 10);
  });

  it('handles HTTP errors', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    const progressCallback = vi.fn();

    await expect(downloadShard('missing-shard', progressCallback)).rejects.toThrow(
      ShardDownloadError
    );
  });

  it('handles network errors', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const progressCallback = vi.fn();

    await expect(downloadShard('shard-123', progressCallback)).rejects.toThrow(
      ShardDownloadError
    );

    try {
      await downloadShard('shard-123', progressCallback);
    } catch (error) {
      expect(error).toBeInstanceOf(ShardDownloadError);
      expect((error as ShardDownloadError).shardId).toBe('shard-123');
    }
  });

  it('falls back to arrayBuffer when no body stream', async () => {
    const testData = new Uint8Array([1, 2, 3, 4, 5]);
    const progressCallback = vi.fn();

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: vi.fn(() => '5'),
      },
      body: null,
      arrayBuffer: vi.fn().mockResolvedValue(testData.buffer),
    });

    const result = await downloadShard('shard-789', progressCallback);

    expect(result).toEqual(testData);
    expect(progressCallback).toHaveBeenCalledWith(5, 5);
  });
});

describe('downloadShards', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns empty array for empty input', async () => {
    const result = await downloadShards([]);
    expect(result).toEqual([]);
  });

  it('downloads multiple shards in order', async () => {
    const shard1 = new Uint8Array([1, 2, 3]);
    const shard2 = new Uint8Array([4, 5, 6]);
    const shard3 = new Uint8Array([7, 8, 9]);

    mockFetch.mockImplementation((url: string) => {
      const shardId = url.split('/').pop();
      let data: Uint8Array;
      if (shardId === 'shard-1') data = shard1;
      else if (shardId === 'shard-2') data = shard2;
      else if (shardId === 'shard-3') data = shard3;
      else throw new Error('Unknown shard');

      // Create mock with streaming response for progress tracking
      const mockReader = {
        read: vi.fn()
          .mockResolvedValueOnce({ done: false, value: data })
          .mockResolvedValueOnce({ done: true, value: undefined }),
      };

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: vi.fn(() => String(data.length)),
        },
        body: {
          getReader: () => mockReader,
        },
      });
    });

    const result = await downloadShards(['shard-1', 'shard-2', 'shard-3']);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(shard1);
    expect(result[1]).toEqual(shard2);
    expect(result[2]).toEqual(shard3);
  });

  it('throws ShardDownloadError on failure', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
    });

    await expect(downloadShards(['shard-fail'])).rejects.toThrow(
      ShardDownloadError
    );
  });

  it('reports combined progress', async () => {
    const shard1 = new Uint8Array([1, 2, 3]);
    const shard2 = new Uint8Array([4, 5, 6]);

    let callCount = 0;
    mockFetch.mockImplementation((url: string) => {
      const shardId = url.split('/').pop();
      const data = shardId === 'shard-1' ? shard1 : shard2;
      callCount++;

      // Mock with streaming response
      const mockReader = {
        read: vi.fn()
          .mockResolvedValueOnce({ done: false, value: data })
          .mockResolvedValueOnce({ done: true, value: undefined }),
      };

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: vi.fn(() => String(data.length)),
        },
        body: {
          getReader: () => mockReader,
        },
      });
    });

    const progressCallback = vi.fn();

    await downloadShards(['shard-1', 'shard-2'], progressCallback);

    // Progress should have been called
    expect(progressCallback).toHaveBeenCalled();
    // Should have fetched both shards
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
