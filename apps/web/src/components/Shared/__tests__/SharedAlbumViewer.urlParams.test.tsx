/**
 * Regression: validation-final-gate-shares-c-f
 *
 * Anonymous viewers landing on `/s/{linkId}#k={secret}` must capture the link
 * secret from the URL fragment even under React 19 StrictMode's simulated
 * unmount/remount. A previous implementation parsed the URL inside a
 * `useEffect` *and* stripped `window.location.hash` in the same effect, so
 * StrictMode's second pass observed the already-empty hash and overwrote
 * the captured secret with `null`, causing the viewer to permanently render
 * the "missing secret key" error for every live share link.
 *
 * This unit test renders the share viewer inside `<StrictMode>` and asserts
 * that the "missing secret" error UI does NOT appear when a valid `#k=...`
 * fragment is present in the URL.
 */
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  render,
  flushMicrotasks,
} from '../../Download/__tests__/DownloadTestUtils';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const dict: Record<string, string> = {
        'shared.invalidLink': 'Invalid Share Link',
        'shared.missingSecret': 'The share link is missing the secret key.',
        'shared.linkFormatHint': 'Share links should end with #k=...',
        'shared.unableToAccess': 'Unable to Access',
        'shared.linkInvalidOrExpired': 'The share link is invalid or expired.',
        'shared.validating': 'Validating share link…',
      };
      return dict[key] ?? key;
    },
  }),
}));

vi.mock('../../../hooks/useLinkKeys', async () => {
  const actual =
    await vi.importActual<typeof import('../../../hooks/useLinkKeys')>(
      '../../../hooks/useLinkKeys',
    );
  return {
    // Preserve the real fragment parser so we exercise the production path.
    parseLinkFragment: actual.parseLinkFragment,
    // Stub the network/crypto-heavy hook: pretend the link is valid the
    // moment a non-null secret is supplied. This isolates the test to the
    // URL-parsing concern (the actual subject of the regression).
    useLinkKeys: (linkId: string | null, linkSecret: string | null) => ({
      isLoading: false,
      error: null,
      albumId: linkId ? 'album-xyz' : null,
      accessTier: linkSecret ? 2 : null,
      unwrappedAccessTier: linkSecret ? 2 : null,
      hasTierMismatch: false,
      tierKeys: new Map(),
      encryptedName: null,
      grantToken: null,
      isValid: Boolean(linkId && linkSecret),
    }),
  };
});

vi.mock('../SharedGallery', () => ({
  SharedGallery: () => (
    <div data-testid="shared-gallery-stub">gallery rendered</div>
  ),
}));

vi.mock('../../../lib/album-metadata-service', () => ({
  decryptAlbumNameWithTierKey: vi.fn().mockResolvedValue('Stub Album'),
}));

vi.mock('../../../styles/shared-album.css', () => ({}));
vi.mock('../../../../src/styles/globals.css', () => ({}));

import { SharedAlbumViewer } from '../SharedAlbumViewer';

const LINK_ID = 'KuKyOaVC4sc7qXavQsUS3g';
const LINK_SECRET = 'j9eDYuIh4_0ZHIVfcUN7u3LfoIPagFkY3-pqpJbd3B8';
const ORIGINAL_HREF = window.location.href;

function setLocation(pathname: string, hash: string) {
  // happy-dom (and jsdom) permit replacing window.location only via the URL
  // setter on the same Location instance — Location is non-configurable.
  window.history.replaceState(null, '', `${pathname}${hash}`);
}

beforeEach(() => {
  setLocation(`/s/${LINK_ID}`, `#k=${LINK_SECRET}`);
});

afterEach(() => {
  window.history.replaceState(null, '', ORIGINAL_HREF);
  vi.clearAllMocks();
});

describe('SharedAlbumViewer URL fragment handling (StrictMode-safe)', () => {
  it('captures the link secret from the URL fragment when mounted under StrictMode', async () => {
    const { container, unmount } = await render(
      <StrictMode>
        <SharedAlbumViewer linkId={LINK_ID} />
      </StrictMode>,
    );

    await flushMicrotasks();

    // The gallery (i.e. successful redemption) must render — and the
    // "missing secret" error UI must NOT appear, even though StrictMode
    // mounted the component twice.
    expect(
      container.querySelector('[data-testid="shared-gallery-stub"]'),
    ).not.toBeNull();
    expect(container.querySelector('.shared-viewer-error')).toBeNull();
    expect(container.textContent ?? '').not.toContain(
      'The share link is missing the secret key.',
    );
    await unmount();
  });

  it('strips the #k=... fragment from the URL after capture', async () => {
    const { container, unmount } = await render(
      <StrictMode>
        <SharedAlbumViewer linkId={LINK_ID} />
      </StrictMode>,
    );

    await flushMicrotasks();

    expect(
      container.querySelector('[data-testid="shared-gallery-stub"]'),
    ).not.toBeNull();
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe(`/s/${LINK_ID}`);
    await unmount();
  });

  it('renders the missing-secret error when no fragment is present', async () => {
    setLocation(`/s/${LINK_ID}`, '');

    const { container, unmount } = await render(
      <StrictMode>
        <SharedAlbumViewer linkId={LINK_ID} />
      </StrictMode>,
    );

    await flushMicrotasks();

    expect(container.querySelector('.shared-viewer-error')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="shared-gallery-stub"]'),
    ).toBeNull();
    await unmount();
  });
});
