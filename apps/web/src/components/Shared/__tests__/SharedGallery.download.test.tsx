import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../Download/__tests__/DownloadTestUtils';
import type { TierKey } from '../../../hooks/useLinkKeys';
import type { AccessTier as AccessTierType } from '../../../lib/api-types';

// --- mocks: keep SharedGallery decoupled from network/crypto/workers ----

vi.mock('../../../hooks/useVisitorAlbumDownload', () => ({
  useVisitorAlbumDownload: vi.fn(() => ({
    isDownloading: false,
    jobProgress: null,
    error: null,
    startDownload: vi.fn(async () => undefined),
    cancel: vi.fn(),
    supportsStreaming: true,
  })),
}));
vi.mock('../../../hooks/useAlbumDownloadModePicker', () => ({
  useAlbumDownloadModePicker: vi.fn(() => ({
    pickerElement: null,
    prompt: vi.fn(async () => null),
  })),
}));
vi.mock('../../../hooks/useDownloadManager', () => ({
  useDownloadManager: vi.fn(() => ({
    ready: false, jobs: [], resumableJobs: [], api: null, error: null,
    subscribe: () => () => undefined,
    pauseJob: vi.fn(), resumeJob: vi.fn(), cancelJob: vi.fn(), computeAlbumDiff: vi.fn(),
  })),
}));
vi.mock('../../../lib/crypto-client', () => ({ getCryptoClient: vi.fn() }));
vi.mock('../SharedMosaicPhotoGrid', () => ({ SharedMosaicPhotoGrid: () => null }));
vi.mock('../SharedPhotoGrid', () => ({ SharedPhotoGrid: () => null }));

import { SharedGallery } from '../SharedGallery';
import { useVisitorAlbumDownload } from '../../../hooks/useVisitorAlbumDownload';
import { useAlbumDownloadModePicker } from '../../../hooks/useAlbumDownloadModePicker';
import { AccessTier } from '../../../lib/api-types';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  (useVisitorAlbumDownload as unknown as { mockClear: () => void }).mockClear();
  (useAlbumDownloadModePicker as unknown as { mockClear: () => void }).mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function makeTierKeys(tier: AccessTierType): Map<number, Map<AccessTierType, TierKey>> {
  const inner = new Map<AccessTierType, TierKey>();
  inner.set(tier, { key: new Uint8Array(32).fill(7) } as TierKey);
  const outer = new Map<number, Map<AccessTierType, TierKey>>();
  outer.set(7, inner);
  return outer;
}

describe('SharedGallery tier-3 download gate', () => {
  it('does NOT render a download button when access tier is below FULL', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
    const r = await render(
      <SharedGallery
        linkId="L1"
        albumId="alb"
        accessTier={AccessTier.PREVIEW}
        grantToken={null}
        tierKeys={makeTierKeys(AccessTier.PREVIEW)}
        isLoadingKeys={false}
      />,
    );
    // The download button is keyed off accessTier === FULL && photos.length > 0;
    // for tier=2 it must never render regardless of photo count.
    const btn = r.container.querySelector('[data-testid="shared-gallery-download-all"]');
    expect(btn).toBeNull();
    await r.unmount();
  });

  it('wires the visitor download hook with the share-link inputs', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
    const r = await render(
      <SharedGallery
        linkId="L-abcd"
        albumId="alb"
        accessTier={AccessTier.FULL}
        grantToken="g-tok"
        tierKeys={makeTierKeys(AccessTier.FULL)}
        isLoadingKeys={false}
      />,
    );
    // The hook must be invoked with linkId + grantToken from the props.
    const calls = (useVisitorAlbumDownload as unknown as { mock: { calls: ReadonlyArray<ReadonlyArray<{ linkId: string; grantToken: string | null; getTier3Key: (e: number) => unknown }>> } }).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const firstCall = calls[0]!;
    const opts = firstCall[0]!;
    expect(opts.linkId).toBe('L-abcd');
    expect(opts.grantToken).toBe('g-tok');
    // getTier3Key must resolve via the tier-3 key in tierKeys.
    const resolved = opts.getTier3Key(7);
    expect(resolved).toBeInstanceOf(Uint8Array);
    // Mode picker is also wired in (though no element rendered yet).
    expect((useAlbumDownloadModePicker as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(0);
    await r.unmount();
  });
});
