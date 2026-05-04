import { describe, expect, it } from 'vitest';
import { deriveVisitorDownloadScope, VISITOR_STAGING_GC_MAX_AGE_MS } from '../visitor-job-scope';

describe('visitor download manager spike scope helper', () => {
  it('derives a stable owner key for the same share link and album', () => {
    const first = deriveVisitorDownloadScope({ linkId: 'link-A', albumId: 'album-A' });
    const second = deriveVisitorDownloadScope({ linkId: 'link-A', albumId: 'album-A' });

    expect(second).toEqual(first);
  });

  it('keeps different share links to the same album in separate visitor scopes', () => {
    const first = deriveVisitorDownloadScope({ linkId: 'link-A', albumId: 'album-A' });
    const second = deriveVisitorDownloadScope({ linkId: 'link-B', albumId: 'album-A' });

    expect(second.ownerKey).not.toBe(first.ownerKey);
    expect(second.channelName).not.toBe(first.channelName);
  });

  it('does not place raw share link ids in derived storage or channel names', () => {
    const scope = deriveVisitorDownloadScope({ linkId: 'raw-share-link-id', albumId: 'album-A' });

    expect(scope.ownerKey).not.toContain('raw-share-link-id');
    expect(scope.channelName).not.toContain('raw-share-link-id');
    expect(scope.disclosureStorageKey).not.toContain('raw-share-link-id');
  });

  it('documents the proposed 24 hour visitor staging TTL', () => {
    const scope = deriveVisitorDownloadScope({ linkId: 'link-A', albumId: 'album-A' });

    expect(scope.gcMaxAgeMs).toBe(VISITOR_STAGING_GC_MAX_AGE_MS);
  });

  it('rejects missing visitor context', () => {
    expect(() => deriveVisitorDownloadScope({ linkId: ' ', albumId: 'album-A' })).toThrow(/linkId/);
    expect(() => deriveVisitorDownloadScope({ linkId: 'link-A', albumId: ' ' })).toThrow(/albumId/);
  });
});
