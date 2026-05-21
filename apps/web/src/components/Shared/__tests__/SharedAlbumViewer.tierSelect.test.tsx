/**
 * Regression: validation-final-gate-v3-10-rust-215-album-name.
 *
 * Album names are encrypted with the worker's `encryptAlbumName` helper,
 * which pins `(shardIndex=0, tier=ShardTier::Thumbnail)` — i.e. the
 * envelope's tier byte is always `1`. The Rust link-tier handle pins a
 * specific tier and rejects envelopes whose `header.tier()` differs
 * (`ClientErrorCode::LinkTierMismatch` == rust code 215).
 *
 * Previously SharedAlbumViewer iterated tier keys in the order
 * `[3, 2, 1]` to pick the "highest tier available" for album-name
 * decryption. That selected a tier-3 link-tier handle when the visitor
 * had a `view` (tier 3) link, causing every album-name decrypt to fail
 * with `decryptShardWithLinkTierHandle failed (rust code 215)` and
 * cascading into a downstream `Errored` download job.
 *
 * This test asserts the fix: SharedAlbumViewer picks the Thumbnail
 * (tier 1) handle for album-name decryption when multiple tier keys are
 * available.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, flushMicrotasks } from '../../Download/__tests__/DownloadTestUtils';
import type { LinkDecryptionKey } from '../../../workers/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const TIER1_HANDLE = 'tier-1-handle' as LinkDecryptionKey;
const TIER2_HANDLE = 'tier-2-handle' as LinkDecryptionKey;
const TIER3_HANDLE = 'tier-3-handle' as LinkDecryptionKey;

const tierKeys = new Map<number, Map<1 | 2 | 3, { epochId: number; tier: 1 | 2 | 3; linkTierHandleId: LinkDecryptionKey }>>();
const epochTiers = new Map<1 | 2 | 3, { epochId: number; tier: 1 | 2 | 3; linkTierHandleId: LinkDecryptionKey }>();
epochTiers.set(1, { epochId: 1, tier: 1, linkTierHandleId: TIER1_HANDLE });
epochTiers.set(2, { epochId: 1, tier: 2, linkTierHandleId: TIER2_HANDLE });
epochTiers.set(3, { epochId: 1, tier: 3, linkTierHandleId: TIER3_HANDLE });
tierKeys.set(1, epochTiers);

vi.mock('../../../hooks/useLinkKeys', async () => {
  const actual =
    await vi.importActual<typeof import('../../../hooks/useLinkKeys')>(
      '../../../hooks/useLinkKeys',
    );
  return {
    parseLinkFragment: actual.parseLinkFragment,
    useLinkKeys: () => ({
      isLoading: false,
      error: null,
      albumId: 'album-tier-test',
      accessTier: 3 as const,
      unwrappedAccessTier: 3 as const,
      hasTierMismatch: false,
      tierKeys,
      encryptedName: 'fake-encrypted-name-base64',
      grantToken: null,
      isValid: true,
    }),
  };
});

vi.mock('../SharedGallery', () => ({
  SharedGallery: () => null,
}));

const decryptSpy = vi
  .fn<
    (encryptedName: string | Uint8Array, tierKey: LinkDecryptionKey, albumId: string) => Promise<string>
  >()
  .mockResolvedValue('Test Album');

vi.mock('../../../lib/album-metadata-service', () => ({
  decryptAlbumNameWithTierKey: (
    encryptedName: string | Uint8Array,
    tierKey: LinkDecryptionKey,
    albumId: string,
  ) => decryptSpy(encryptedName, tierKey, albumId),
}));

vi.mock('../../../styles/shared-album.css', () => ({}));

import { SharedAlbumViewer } from '../SharedAlbumViewer';

const LINK_ID = 'KuKyOaVC4sc7qXavQsUS3g';
const LINK_SECRET = 'j9eDYuIh4_0ZHIVfcUN7u3LfoIPagFkY3-pqpJbd3B8';

describe('SharedAlbumViewer tier-key selection for album-name decrypt', () => {
  it('picks the Thumbnail (tier 1) handle, not the highest tier', async () => {
    window.history.replaceState(null, '', `/s/${LINK_ID}#k=${LINK_SECRET}`);

    const { unmount } = await render(<SharedAlbumViewer linkId={LINK_ID} />);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(decryptSpy).toHaveBeenCalled();
    const [, tierKeyArg] = decryptSpy.mock.calls[0]!;
    expect(tierKeyArg).toBe(TIER1_HANDLE);
    expect(tierKeyArg).not.toBe(TIER3_HANDLE);

    await unmount();
  });
});
