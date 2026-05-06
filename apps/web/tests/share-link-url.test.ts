import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockBuildShareLinkUrl = vi.fn();

vi.mock('../src/lib/crypto-client', () => ({
  getCryptoClient: () => Promise.resolve({
    buildShareLinkUrl: mockBuildShareLinkUrl,
  }),
}));

import { buildShareLinkUrl } from '../src/lib/share-link-url';

describe('buildShareLinkUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildShareLinkUrl.mockResolvedValue('https://photos.example/s/link#k=token');
  });

  it('delegates share-link URL assembly to the Rust crypto worker', async () => {
    await expect(buildShareLinkUrl({
      baseUrl: 'https://photos.example',
      albumId: '018f0000-0000-7000-8000-000000000002',
      linkId: 'link',
      linkUrlToken: 'token',
    })).resolves.toBe('https://photos.example/s/link#k=token');

    expect(mockBuildShareLinkUrl).toHaveBeenCalledWith({
      baseUrl: 'https://photos.example',
      albumId: '018f0000-0000-7000-8000-000000000002',
      linkId: 'link',
      linkUrlToken: 'token',
    });
  });

  it('throws when Rust rejects malformed URL inputs', async () => {
    mockBuildShareLinkUrl.mockResolvedValue('');

    await expect(buildShareLinkUrl({
      baseUrl: 'https://photos.example',
      albumId: 'not-a-uuid',
      linkId: 'link',
      linkUrlToken: 'token',
    })).rejects.toThrow('Failed to build share link URL');
  });
});
