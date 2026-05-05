import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { click, render, requireElement } from '../../Download/__tests__/DownloadTestUtils';
import type { TierKey } from '../../../hooks/useLinkKeys';
import type { AccessTier as AccessTierType } from '../../../lib/api-types';
import {
  STORAGE_KEY,
  __resetVisitorDisclosureCacheForTests,
} from '../../../hooks/useVisitorDownloadDisclosure';

// --- mocks ----------------------------------------------------------------
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
const promptMock = vi.fn(async () => null);
vi.mock('../../../hooks/useAlbumDownloadModePicker', () => ({
  useAlbumDownloadModePicker: vi.fn(() => ({
    pickerElement: null,
    prompt: promptMock,
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

// Make the visitor scope deterministic & synchronous so the gate is
// reachable on first render. We assert by scope-key prefix only.
vi.mock('../../../lib/scope-key', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/scope-key')>(
    '../../../lib/scope-key',
  );
  return {
    ...actual,
    ensureScopeKeySodiumReady: vi.fn(async () => undefined),
    deriveVisitorScopeKey: vi.fn(
      (linkId: string) => `visitor:${linkId}`,
    ),
  };
});

import { SharedGallery } from '../SharedGallery';
import { AccessTier } from '../../../lib/api-types';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  promptMock.mockReset();
  promptMock.mockResolvedValue(null);
  localStorage.clear();
  __resetVisitorDisclosureCacheForTests();
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

// Mount the gallery with one decryptable photo so the download button
// becomes enabled (button gates on photos.length > 0).
async function mountWithOnePhoto(linkId: string) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes('skip=0')) {
      return {
        ok: true,
        json: async () => [
          {
            id: 'p1',
            versionCreated: 1,
            isDeleted: false,
            encryptedMeta: btoa('x'),
            signature: btoa('s'),
            signerPubkey: btoa('p'),
            shardIds: ['s1'],
          },
        ],
      };
    }
    return { ok: true, json: async () => [] };
  });
  const { getCryptoClient } = await import('../../../lib/crypto-client');
  (getCryptoClient as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({
    decryptShardWithTierKey: vi.fn(async () =>
      new TextEncoder().encode(JSON.stringify({ id: 'p1' })),
    ),
  });
  return await render(
    <SharedGallery
      linkId={linkId}
      albumId="alb"
      accessTier={AccessTier.FULL}
      grantToken={null}
      tierKeys={makeTierKeys(AccessTier.FULL)}
      isLoadingKeys={false}
    />,
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('SharedGallery visitor disclosure gate', () => {
  it('shows disclosure on first download click — does NOT call mode picker yet', async () => {
    const r = await mountWithOnePhoto('LINK-A');
    await flush();
    const btn = r.container.querySelector('[data-testid="shared-gallery-download-all"]');
    expect(btn).not.toBeNull();
    await click(requireElement(btn));
    await flush();
    expect(
      r.container.querySelector('[data-testid="visitor-download-disclosure"]'),
    ).not.toBeNull();
    expect(promptMock).not.toHaveBeenCalled();
    await r.unmount();
  });

  it('after acknowledge, mode picker is prompted and disclosure unmounts', async () => {
    const r = await mountWithOnePhoto('LINK-A');
    await flush();
    await click(
      requireElement(r.container.querySelector('[data-testid="shared-gallery-download-all"]')),
    );
    await flush();
    await click(
      requireElement(
        r.container.querySelector('[data-testid="visitor-download-disclosure-acknowledge"]'),
      ),
    );
    await flush();
    expect(promptMock).toHaveBeenCalledTimes(1);
    expect(
      r.container.querySelector('[data-testid="visitor-download-disclosure"]'),
    ).toBeNull();
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored).toEqual(['visitor:LINK-A']);
    await r.unmount();
  });

  it('cancel from disclosure does NOT proceed to picker', async () => {
    const r = await mountWithOnePhoto('LINK-A');
    await flush();
    await click(
      requireElement(r.container.querySelector('[data-testid="shared-gallery-download-all"]')),
    );
    await flush();
    await click(
      requireElement(
        r.container.querySelector('[data-testid="visitor-download-disclosure-cancel"]'),
      ),
    );
    await flush();
    expect(promptMock).not.toHaveBeenCalled();
    expect(
      r.container.querySelector('[data-testid="visitor-download-disclosure"]'),
    ).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    await r.unmount();
  });

  it('already-acknowledged scope skips disclosure on click', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['visitor:LINK-B']));
    __resetVisitorDisclosureCacheForTests();
    const r = await mountWithOnePhoto('LINK-B');
    await flush();
    await click(
      requireElement(r.container.querySelector('[data-testid="shared-gallery-download-all"]')),
    );
    await flush();
    expect(
      r.container.querySelector('[data-testid="visitor-download-disclosure"]'),
    ).toBeNull();
    expect(promptMock).toHaveBeenCalledTimes(1);
    await r.unmount();
  });

  it('different share-link scope keys are isolated', async () => {
    // An UNRELATED share link is acknowledged. The current link
    // (LINK-C) must still see the disclosure.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(['visitor:UNRELATED-SCOPE']),
    );
    __resetVisitorDisclosureCacheForTests();
    const r = await mountWithOnePhoto('LINK-C');
    await flush();
    await click(
      requireElement(r.container.querySelector('[data-testid="shared-gallery-download-all"]')),
    );
    await flush();
    expect(
      r.container.querySelector('[data-testid="visitor-download-disclosure"]'),
    ).not.toBeNull();
    expect(promptMock).not.toHaveBeenCalled();
    await r.unmount();
  });
});