/**
 * ShareLinksList Component Tests
 *
 * Tests the ShareLinksList component using vitest + happy-dom.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShareLinksList } from '../src/components/ShareLinks/ShareLinksList';
import type { ShareLinkInfo } from '../src/hooks/useShareLinks';

// Helper to create mock share link info
function createMockShareLinkInfo(id: string, overrides = {}): ShareLinkInfo {
  return {
    id,
    linkId: `link-id-${id}`,
    accessTier: 2,
    expiresAt: undefined,
    maxUses: undefined,
    useCount: 0,
    isRevoked: false,
    createdAt: new Date().toISOString(),
    isExpired: false,
    accessTierDisplay: 'Preview',
    ...overrides,
  };
}

// Helper to render ShareLinksList
function renderShareLinksList(
  props: Partial<Parameters<typeof ShareLinksList>[0]> = {},
) {
  const defaultProps = {
    shareLinks: [],
    isLoading: false,
    error: null,
    onRevoke: vi.fn().mockResolvedValue(undefined),
    isRevoking: false,
    onCreateClick: vi.fn(),
    isOwner: true,
  };

  const container = document.createElement('div');
  document.body.appendChild(container);

  let root: ReturnType<typeof createRoot>;
  act(() => {
    root = createRoot(container);
    root.render(createElement(ShareLinksList, { ...defaultProps, ...props }));
  });

  const getByTestId = (testId: string) =>
    document.querySelector(`[data-testid="${testId}"]`);
  const queryByTestId = (testId: string) =>
    document.querySelector(`[data-testid="${testId}"]`);
  const getAllByTestId = (testId: string) =>
    document.querySelectorAll(`[data-testid="${testId}"]`);

  const cleanup = () => {
    act(() => {
      root!.unmount();
    });
    container.remove();
  };

  const rerender = (
    newProps: Partial<Parameters<typeof ShareLinksList>[0]>,
  ) => {
    act(() => {
      root.render(
        createElement(ShareLinksList, {
          ...defaultProps,
          ...props,
          ...newProps,
        }),
      );
    });
  };

  return {
    container,
    getByTestId,
    queryByTestId,
    getAllByTestId,
    cleanup,
    rerender,
    props: { ...defaultProps, ...props },
  };
}

describe('ShareLinksList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  describe('rendering', () => {
    it('renders the list container', () => {
      const { getByTestId, cleanup } = renderShareLinksList();

      expect(getByTestId('share-links-list')).not.toBeNull();
      cleanup();
    });

    it('shows loading state', () => {
      const { getByTestId, cleanup } = renderShareLinksList({
        isLoading: true,
      });

      expect(getByTestId('share-links-loading')).not.toBeNull();
      expect(getByTestId('share-links-loading')?.textContent).toContain(
        'Loading',
      );
      cleanup();
    });

    it('shows error state', () => {
      const { getByTestId, cleanup } = renderShareLinksList({
        error: new Error('Network error'),
      });

      expect(getByTestId('share-links-error')).not.toBeNull();
      expect(getByTestId('share-links-error')?.textContent).toContain(
        'Network error',
      );
      cleanup();
    });

    it('shows empty state when no links', () => {
      const { getByTestId, cleanup } = renderShareLinksList({ shareLinks: [] });

      expect(getByTestId('share-links-empty')).not.toBeNull();
      expect(getByTestId('share-links-empty')?.textContent).toContain(
        'No share links',
      );
      cleanup();
    });

    it('shows create button for owner', () => {
      const { getByTestId, cleanup } = renderShareLinksList({ isOwner: true });

      expect(getByTestId('create-share-link-button')).not.toBeNull();
      cleanup();
    });

    it('hides create button for non-owner', () => {
      const { queryByTestId, cleanup } = renderShareLinksList({
        isOwner: false,
      });

      expect(queryByTestId('create-share-link-button')).toBeNull();
      cleanup();
    });
  });

  describe('link list display', () => {
    it('renders active links', () => {
      const links = [
        createMockShareLinkInfo('link-1'),
        createMockShareLinkInfo('link-2'),
      ];
      const { getAllByTestId, cleanup } = renderShareLinksList({
        shareLinks: links,
      });

      const items = getAllByTestId('share-link-item');
      expect(items.length).toBe(2);
      cleanup();
    });

    it('displays access tier badge', () => {
      const links = [
        createMockShareLinkInfo('link-1', { accessTierDisplay: 'Full Access' }),
      ];
      const { getByTestId, cleanup } = renderShareLinksList({
        shareLinks: links,
      });

      const badge = getByTestId('tier-badge');
      expect(badge?.textContent).toContain('Full Access');
      cleanup();
    });

    it('displays use count', () => {
      const links = [createMockShareLinkInfo('link-1', { useCount: 5 })];
      const { getByTestId, cleanup } = renderShareLinksList({
        shareLinks: links,
      });

      const useCount = getByTestId('use-count');
      expect(useCount?.textContent).toContain('5 uses');
      cleanup();
    });

    it('displays max uses when set', () => {
      const links = [
        createMockShareLinkInfo('link-1', { useCount: 3, maxUses: 10 }),
      ];
      const { getByTestId, cleanup } = renderShareLinksList({
        shareLinks: links,
      });

      const useCount = getByTestId('use-count');
      expect(useCount?.textContent).toContain('3 uses');
      expect(useCount?.textContent).toContain('/ 10 max');
      cleanup();
    });

    it('displays expiry date when set', () => {
      const links = [
        createMockShareLinkInfo('link-1', { expiryDisplay: 'Jan 15, 2025' }),
      ];
      const { getByTestId, cleanup } = renderShareLinksList({
        shareLinks: links,
      });

      const expiry = getByTestId('expiry-date');
      expect(expiry?.textContent).toContain('Expires');
      expect(expiry?.textContent).toContain('Jan 15, 2025');
      cleanup();
    });

    it('displays created date', () => {
      const links = [createMockShareLinkInfo('link-1')];
      const { getByTestId, cleanup } = renderShareLinksList({
        shareLinks: links,
      });

      const created = getByTestId('created-date');
      expect(created?.textContent).toContain('Created');
      cleanup();
    });

    it('shows expired badge for expired links', () => {
      const links = [createMockShareLinkInfo('link-1', { isExpired: true })];
      const { getByTestId, cleanup } = renderShareLinksList({
        shareLinks: links,
      });

      expect(getByTestId('expired-badge')).not.toBeNull();
      expect(getByTestId('expired-badge')?.textContent).toContain('Expired');
      cleanup();
    });
  });

  describe('link actions', () => {
    it('has copy button for each link', () => {
      const links = [createMockShareLinkInfo('link-1')];
      const { getByTestId, cleanup } = renderShareLinksList({
        shareLinks: links,
      });

      expect(getByTestId('copy-link-button')).not.toBeNull();
      cleanup();
    });

    it('has revoke button for owner', () => {
      const links = [createMockShareLinkInfo('link-1')];
      const { getByTestId, cleanup } = renderShareLinksList({
        shareLinks: links,
        isOwner: true,
      });

      expect(getByTestId('revoke-link-button')).not.toBeNull();
      cleanup();
    });

    it('hides revoke button for non-owner', () => {
      const links = [createMockShareLinkInfo('link-1')];
      const { queryByTestId, cleanup } = renderShareLinksList({
        shareLinks: links,
        isOwner: false,
      });

      expect(queryByTestId('revoke-link-button')).toBeNull();
      cleanup();
    });
  });

  describe('create link button', () => {
    it('calls onCreateClick when clicked', () => {
      const onCreateClick = vi.fn();
      const { getByTestId, cleanup } = renderShareLinksList({ onCreateClick });

      const button = getByTestId(
        'create-share-link-button',
      ) as HTMLButtonElement;

      act(() => {
        button.click();
      });

      expect(onCreateClick).toHaveBeenCalled();
      cleanup();
    });
  });

  describe('revoke confirmation', () => {
    it('shows confirmation dialog when revoke clicked', () => {
      const links = [createMockShareLinkInfo('link-1')];
      const { getByTestId, queryByTestId, cleanup } = renderShareLinksList({
        shareLinks: links,
      });

      // Initially no confirm dialog
      expect(queryByTestId('revoke-confirm-dialog')).toBeNull();

      const revokeButton = getByTestId(
        'revoke-link-button',
      ) as HTMLButtonElement;

      act(() => {
        revokeButton.click();
      });

      // Now should show confirm dialog
      expect(getByTestId('revoke-confirm-dialog')).not.toBeNull();
      cleanup();
    });

    it('calls onRevoke when confirm clicked', async () => {
      const onRevoke = vi.fn().mockResolvedValue(undefined);
      const links = [createMockShareLinkInfo('link-1')];
      const { getByTestId, cleanup } = renderShareLinksList({
        shareLinks: links,
        onRevoke,
      });

      const revokeButton = getByTestId(
        'revoke-link-button',
      ) as HTMLButtonElement;

      act(() => {
        revokeButton.click();
      });

      const confirmButton = getByTestId(
        'confirm-revoke-button',
      ) as HTMLButtonElement;

      await act(async () => {
        confirmButton.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(onRevoke).toHaveBeenCalledWith('link-1');
      cleanup();
    });

    it('closes confirmation when cancel clicked', () => {
      const links = [createMockShareLinkInfo('link-1')];
      const { getByTestId, queryByTestId, cleanup } = renderShareLinksList({
        shareLinks: links,
      });

      const revokeButton = getByTestId(
        'revoke-link-button',
      ) as HTMLButtonElement;

      act(() => {
        revokeButton.click();
      });

      expect(getByTestId('revoke-confirm-dialog')).not.toBeNull();

      const cancelButton = getByTestId(
        'cancel-revoke-button',
      ) as HTMLButtonElement;

      act(() => {
        cancelButton.click();
      });

      expect(queryByTestId('revoke-confirm-dialog')).toBeNull();
      cleanup();
    });

    it('shows loading state during revoke', () => {
      const links = [createMockShareLinkInfo('link-1')];
      const { getByTestId, rerender, cleanup } = renderShareLinksList({
        shareLinks: links,
        isRevoking: false,
      });

      // First click revoke to show the dialog (when not yet revoking)
      const revokeButton = getByTestId(
        'revoke-link-button',
      ) as HTMLButtonElement;

      act(() => {
        revokeButton.click();
      });

      // Now set isRevoking to true and rerender to see loading state
      rerender({ isRevoking: true });

      const confirmButton = getByTestId(
        'confirm-revoke-button',
      ) as HTMLButtonElement;
      expect(confirmButton.textContent).toContain('Revoking...');
      expect(confirmButton.disabled).toBe(true);
      cleanup();
    });
  });

  describe('revoked links section', () => {
    it('shows revoked links in separate section', () => {
      const links = [
        createMockShareLinkInfo('active', { isRevoked: false }),
        createMockShareLinkInfo('revoked', { isRevoked: true }),
      ];
      const { getByTestId, cleanup } = renderShareLinksList({
        shareLinks: links,
      });

      expect(getByTestId('revoked-links-section')).not.toBeNull();
      cleanup();
    });

    it('lists revoked links when section is expanded', () => {
      const links = [createMockShareLinkInfo('revoked', { isRevoked: true })];
      const { getByTestId, cleanup } = renderShareLinksList({
        shareLinks: links,
      });

      const section = getByTestId(
        'revoked-links-section',
      ) as HTMLDetailsElement;

      act(() => {
        section.open = true;
      });

      expect(getByTestId('revoked-share-links')).not.toBeNull();
      cleanup();
    });

    it('shows count of revoked links', () => {
      const links = [
        createMockShareLinkInfo('revoked-1', { isRevoked: true }),
        createMockShareLinkInfo('revoked-2', { isRevoked: true }),
      ];
      const { getByTestId, cleanup } = renderShareLinksList({
        shareLinks: links,
      });

      const section = getByTestId('revoked-links-section');
      expect(section?.textContent).toContain('2');
      cleanup();
    });
  });

  describe('filtering', () => {
    it('separates active and revoked links correctly', () => {
      const links = [
        createMockShareLinkInfo('active-1', { isRevoked: false }),
        createMockShareLinkInfo('active-2', { isRevoked: false }),
        createMockShareLinkInfo('revoked-1', { isRevoked: true }),
      ];
      const { getByTestId, getAllByTestId, cleanup } = renderShareLinksList({
        shareLinks: links,
      });

      const activeLinks = getAllByTestId('share-link-item');
      expect(activeLinks.length).toBe(2); // Only active links in main list

      const revokedSection = getByTestId('revoked-links-section');
      expect(revokedSection?.textContent).toContain('1'); // 1 revoked link
      cleanup();
    });
  });

  describe('accessibility', () => {
    it('confirm dialog has aria-modal', () => {
      const links = [createMockShareLinkInfo('link-1')];
      const { getByTestId, cleanup } = renderShareLinksList({
        shareLinks: links,
      });

      const revokeButton = getByTestId(
        'revoke-link-button',
      ) as HTMLButtonElement;

      act(() => {
        revokeButton.click();
      });

      const dialog = getByTestId('revoke-confirm-dialog') as HTMLElement;
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      cleanup();
    });

    it('confirm dialog has aria-labelledby', () => {
      const links = [createMockShareLinkInfo('link-1')];
      const { getByTestId, cleanup } = renderShareLinksList({
        shareLinks: links,
      });

      const revokeButton = getByTestId(
        'revoke-link-button',
      ) as HTMLButtonElement;

      act(() => {
        revokeButton.click();
      });

      const dialog = getByTestId('revoke-confirm-dialog') as HTMLElement;
      expect(dialog.getAttribute('aria-labelledby')).toBe(
        'revoke-confirm-title',
      );
      cleanup();
    });
  });

  describe('empty states', () => {
    it('shows helpful message for owners in empty state', () => {
      const { getByTestId, cleanup } = renderShareLinksList({
        shareLinks: [],
        isOwner: true,
      });

      const empty = getByTestId('share-links-empty');
      expect(empty?.textContent).toContain('Create a share link');
      cleanup();
    });

    it('shows simple message for non-owners in empty state', () => {
      const { getByTestId, cleanup } = renderShareLinksList({
        shareLinks: [],
        isOwner: false,
      });

      const empty = getByTestId('share-links-empty');
      expect(empty?.textContent).toContain('No share links');
      // Should NOT contain the create suggestion
      expect(empty?.textContent).not.toContain('Create a share link');
      cleanup();
    });
  });
});
