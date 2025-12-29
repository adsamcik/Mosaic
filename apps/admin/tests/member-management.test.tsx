/**
 * MemberList and InviteMemberDialog Component Tests
 *
 * Tests the member management components using vitest + happy-dom.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InviteMemberDialog } from '../src/components/Members/InviteMemberDialog';
import { MemberList } from '../src/components/Members/MemberList';

// Mock the useMemberManagement hook
vi.mock('../src/hooks/useMemberManagement', () => ({
  useMemberManagement: vi.fn(() => ({
    members: [
      {
        userId: 'user-1',
        role: 'owner',
        joinedAt: '2024-01-01T00:00:00Z',
        displayName: 'User user-1',
      },
      {
        userId: 'user-2',
        role: 'editor',
        joinedAt: '2024-01-02T00:00:00Z',
        displayName: 'User user-2',
      },
      {
        userId: 'user-3',
        role: 'viewer',
        joinedAt: '2024-01-03T00:00:00Z',
        displayName: 'User user-3',
      },
    ],
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    inviteMember: vi.fn().mockResolvedValue({}),
    isInviting: false,
    inviteError: null,
    removeMember: vi.fn().mockResolvedValue(undefined),
    removeMemberWithRotation: vi.fn().mockResolvedValue(undefined),
    isRemoving: false,
    removalStep: null,
    lookupUser: vi.fn().mockResolvedValue({ id: 'user-4', identityPubkey: 'abc123' }),
    isLookingUp: false,
    isOwner: true,
  })),
}));

// Helper to render MemberList and get elements
function renderMemberList(props: Partial<Parameters<typeof MemberList>[0]> = {}) {
  const defaultProps = {
    albumId: 'album-1',
    isOpen: true,
    onClose: vi.fn(),
  };

  const container = document.createElement('div');
  document.body.appendChild(container);

  let root: ReturnType<typeof createRoot>;
  act(() => {
    root = createRoot(container);
    root.render(createElement(MemberList, { ...defaultProps, ...props }));
  });

  const getByTestId = (testId: string) => document.querySelector(`[data-testid="${testId}"]`);
  const queryByTestId = (testId: string) => document.querySelector(`[data-testid="${testId}"]`);
  const getAllByTestId = (testId: string) => document.querySelectorAll(`[data-testid="${testId}"]`);

  const cleanup = () => {
    act(() => {
      root!.unmount();
    });
    container.remove();
  };

  const rerender = (newProps: Partial<Parameters<typeof MemberList>[0]>) => {
    act(() => {
      root.render(createElement(MemberList, { ...defaultProps, ...props, ...newProps }));
    });
  };

  return { container, getByTestId, queryByTestId, getAllByTestId, cleanup, rerender, props: { ...defaultProps, ...props } };
}

// Helper to render InviteMemberDialog
function renderInviteDialog(props: Partial<Parameters<typeof InviteMemberDialog>[0]> = {}) {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onInvite: vi.fn().mockResolvedValue(undefined),
    lookupUser: vi.fn().mockResolvedValue({ id: 'user-new', identityPubkey: 'xyz789' }),
    isInviting: false,
    isLookingUp: false,
    error: null,
  };

  const container = document.createElement('div');
  document.body.appendChild(container);

  let root: ReturnType<typeof createRoot>;
  act(() => {
    root = createRoot(container);
    root.render(createElement(InviteMemberDialog, { ...defaultProps, ...props }));
  });

  const getByTestId = (testId: string) => document.querySelector(`[data-testid="${testId}"]`);
  const queryByTestId = (testId: string) => document.querySelector(`[data-testid="${testId}"]`);

  const cleanup = () => {
    act(() => {
      root!.unmount();
    });
    container.remove();
  };

  const rerender = (newProps: Partial<Parameters<typeof InviteMemberDialog>[0]>) => {
    act(() => {
      root.render(createElement(InviteMemberDialog, { ...defaultProps, ...props, ...newProps }));
    });
  };

  return { container, getByTestId, queryByTestId, cleanup, rerender, props: { ...defaultProps, ...props } };
}

describe('MemberList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  describe('rendering', () => {
    it('renders nothing when closed', () => {
      const { queryByTestId, cleanup } = renderMemberList({ isOpen: false });

      expect(queryByTestId('member-panel')).toBeNull();
      cleanup();
    });

    it('renders panel when open', () => {
      const { getByTestId, cleanup } = renderMemberList();

      expect(getByTestId('member-panel')).not.toBeNull();
      cleanup();
    });

    it('renders member list', () => {
      const { getByTestId, getAllByTestId, cleanup } = renderMemberList();

      expect(getByTestId('member-list')).not.toBeNull();
      expect(getAllByTestId('member-item').length).toBe(3);
      cleanup();
    });

    it('renders invite button for owner', () => {
      const { getByTestId, cleanup } = renderMemberList();

      expect(getByTestId('invite-button')).not.toBeNull();
      cleanup();
    });

    it('renders close button', () => {
      const { getByTestId, cleanup } = renderMemberList();

      expect(getByTestId('close-members-button')).not.toBeNull();
      cleanup();
    });
  });

  describe('interactions', () => {
    it('calls onClose when close button clicked', () => {
      const onClose = vi.fn();
      const { getByTestId, cleanup } = renderMemberList({ onClose });

      const closeButton = getByTestId('close-members-button') as HTMLButtonElement;
      act(() => {
        closeButton.click();
      });

      expect(onClose).toHaveBeenCalled();
      cleanup();
    });

    it('calls onClose when backdrop clicked', () => {
      const onClose = vi.fn();
      const { getByTestId, cleanup } = renderMemberList({ onClose });

      const backdrop = getByTestId('member-panel-backdrop') as HTMLElement;
      act(() => {
        backdrop.click();
      });

      expect(onClose).toHaveBeenCalled();
      cleanup();
    });
  });

  describe('accessibility', () => {
    it('has appropriate aria attributes on panel', () => {
      const { getByTestId, cleanup } = renderMemberList();

      const panel = getByTestId('member-panel') as HTMLElement;
      expect(panel.getAttribute('role')).toBe('complementary');
      expect(panel.getAttribute('aria-label')).toBe('Album members');
      cleanup();
    });

    it('has aria-label on close button', () => {
      const { getByTestId, cleanup } = renderMemberList();

      const closeButton = getByTestId('close-members-button') as HTMLButtonElement;
      expect(closeButton.getAttribute('aria-label')).toBe('member.closePanel');
      cleanup();
    });
  });
});

describe('InviteMemberDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  describe('rendering', () => {
    it('renders nothing when closed', () => {
      const { queryByTestId, cleanup } = renderInviteDialog({ isOpen: false });

      expect(queryByTestId('invite-member-dialog')).toBeNull();
      cleanup();
    });

    it('renders dialog when open', () => {
      const { getByTestId, cleanup } = renderInviteDialog();

      expect(getByTestId('invite-member-dialog')).not.toBeNull();
      cleanup();
    });

    it('renders user query input', () => {
      const { getByTestId, cleanup } = renderInviteDialog();

      expect(getByTestId('user-query-input')).not.toBeNull();
      cleanup();
    });

    it('renders lookup button', () => {
      const { getByTestId, cleanup } = renderInviteDialog();

      expect(getByTestId('lookup-button')).not.toBeNull();
      cleanup();
    });

    it('renders role selector', () => {
      const { getByTestId, cleanup } = renderInviteDialog();

      expect(getByTestId('role-selector')).not.toBeNull();
      cleanup();
    });

    it('renders cancel and invite buttons', () => {
      const { getByTestId, cleanup } = renderInviteDialog();

      expect(getByTestId('cancel-invite-button')).not.toBeNull();
      expect(getByTestId('submit-invite-button')).not.toBeNull();
      cleanup();
    });
  });

  describe('form state', () => {
    it('disables invite button when no user found', () => {
      const { getByTestId, cleanup } = renderInviteDialog();

      const button = getByTestId('submit-invite-button') as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      cleanup();
    });

    it('shows loading state during invite', () => {
      const { getByTestId, cleanup } = renderInviteDialog({ isInviting: true });

      const button = getByTestId('submit-invite-button') as HTMLButtonElement;
      expect(button.textContent).toContain('member.invite.inviting');
      expect(button.disabled).toBe(true);
      cleanup();
    });

    it('shows loading state during lookup', () => {
      const { getByTestId, cleanup } = renderInviteDialog({ isLookingUp: true });

      const button = getByTestId('lookup-button') as HTMLButtonElement;
      expect(button.textContent).toContain('member.invite.looking');
      cleanup();
    });

    it('displays error from props', () => {
      const { getByTestId, cleanup } = renderInviteDialog({ error: 'Failed to invite' });

      const errorElement = getByTestId('invite-error');
      expect(errorElement).not.toBeNull();
      expect(errorElement?.textContent).toContain('Failed to invite');
      cleanup();
    });
  });

  describe('closing behavior', () => {
    it('calls onClose when cancel button clicked', () => {
      const onClose = vi.fn();
      const { getByTestId, cleanup } = renderInviteDialog({ onClose });

      const cancelButton = getByTestId('cancel-invite-button') as HTMLButtonElement;
      act(() => {
        cancelButton.click();
      });

      expect(onClose).toHaveBeenCalled();
      cleanup();
    });

    it('calls onClose when backdrop clicked', () => {
      const onClose = vi.fn();
      const { getByTestId, cleanup } = renderInviteDialog({ onClose });

      const backdrop = getByTestId('invite-member-dialog-backdrop') as HTMLElement;
      act(() => {
        backdrop.click();
      });

      expect(onClose).toHaveBeenCalled();
      cleanup();
    });

    it('does not close on backdrop click when inviting', () => {
      const onClose = vi.fn();
      const { getByTestId, cleanup } = renderInviteDialog({ onClose, isInviting: true });

      const backdrop = getByTestId('invite-member-dialog-backdrop') as HTMLElement;
      act(() => {
        backdrop.click();
      });

      expect(onClose).not.toHaveBeenCalled();
      cleanup();
    });
  });

  describe('accessibility', () => {
    it('has dialog element', () => {
      const { container, cleanup } = renderInviteDialog();

      const dialog = container.querySelector('dialog[open]');
      expect(dialog).not.toBeNull();
      cleanup();
    });

    it('has aria-labelledby pointing to title', () => {
      const { getByTestId, cleanup } = renderInviteDialog();

      const dialog = getByTestId('invite-member-dialog') as HTMLElement;
      expect(dialog.getAttribute('aria-labelledby')).toBe('invite-member-dialog-title');
      cleanup();
    });

    it('has aria-modal attribute', () => {
      const { getByTestId, cleanup } = renderInviteDialog();

      const dialog = getByTestId('invite-member-dialog') as HTMLElement;
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      cleanup();
    });
  });
});

describe('MemberList - Remove Member Dialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  describe('showing remove dialog', () => {
    it('shows confirmation dialog when remove button is clicked', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);

      let root: ReturnType<typeof createRoot>;
      await act(async () => {
        root = createRoot(container);
        root.render(createElement(MemberList, { albumId: 'album-1', isOpen: true, onClose: vi.fn() }));
      });

      // Click remove button for user-2 (editor)
      const removeButton = document.querySelector('[data-testid="remove-member-user-2"]') as HTMLButtonElement;
      expect(removeButton).not.toBeNull();
      
      await act(async () => {
        removeButton.click();
      });

      // Dialog should appear
      const dialog = document.querySelector('[data-testid="remove-member-dialog"]');
      expect(dialog).not.toBeNull();

      await act(async () => {
        root!.unmount();
      });
      container.remove();
    });

    it('shows member name in confirmation dialog', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);

      let root: ReturnType<typeof createRoot>;
      await act(async () => {
        root = createRoot(container);
        root.render(createElement(MemberList, { albumId: 'album-1', isOpen: true, onClose: vi.fn() }));
      });

      const removeButton = document.querySelector('[data-testid="remove-member-user-2"]') as HTMLButtonElement;
      await act(async () => {
        removeButton.click();
      });

      const dialog = document.querySelector('[data-testid="remove-member-dialog"]');
      expect(dialog?.textContent).toContain('User user-2');

      await act(async () => {
        root!.unmount();
      });
      container.remove();
    });

    it('shows warning about key rotation in dialog', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);

      let root: ReturnType<typeof createRoot>;
      await act(async () => {
        root = createRoot(container);
        root.render(createElement(MemberList, { albumId: 'album-1', isOpen: true, onClose: vi.fn() }));
      });

      const removeButton = document.querySelector('[data-testid="remove-member-user-2"]') as HTMLButtonElement;
      await act(async () => {
        removeButton.click();
      });

      const dialog = document.querySelector('[data-testid="remove-member-dialog"]');
      expect(dialog?.textContent).toContain('member.removeDialog.warning');

      await act(async () => {
        root!.unmount();
      });
      container.remove();
    });
  });

  describe('dialog actions', () => {
    it('closes dialog when cancel is clicked', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);

      let root: ReturnType<typeof createRoot>;
      await act(async () => {
        root = createRoot(container);
        root.render(createElement(MemberList, { albumId: 'album-1', isOpen: true, onClose: vi.fn() }));
      });

      // Open dialog
      const removeButton = document.querySelector('[data-testid="remove-member-user-2"]') as HTMLButtonElement;
      await act(async () => {
        removeButton.click();
      });

      // Click cancel
      const cancelButton = document.querySelector('[data-testid="cancel-remove-button"]') as HTMLButtonElement;
      await act(async () => {
        cancelButton.click();
      });

      // Dialog should be closed
      const dialog = document.querySelector('[data-testid="remove-member-dialog"]');
      expect(dialog).toBeNull();

      await act(async () => {
        root!.unmount();
      });
      container.remove();
    });

    it('closes dialog when backdrop is clicked', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);

      let root: ReturnType<typeof createRoot>;
      await act(async () => {
        root = createRoot(container);
        root.render(createElement(MemberList, { albumId: 'album-1', isOpen: true, onClose: vi.fn() }));
      });

      // Open dialog
      const removeButton = document.querySelector('[data-testid="remove-member-user-2"]') as HTMLButtonElement;
      await act(async () => {
        removeButton.click();
      });

      // Click backdrop
      const backdrop = document.querySelector('[data-testid="remove-dialog-backdrop"]') as HTMLElement;
      await act(async () => {
        backdrop.click();
      });

      // Dialog should be closed
      const dialog = document.querySelector('[data-testid="remove-member-dialog"]');
      expect(dialog).toBeNull();

      await act(async () => {
        root!.unmount();
      });
      container.remove();
    });
  });

  describe('accessibility', () => {
    it('remove dialog has proper aria attributes', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);

      let root: ReturnType<typeof createRoot>;
      await act(async () => {
        root = createRoot(container);
        root.render(createElement(MemberList, { albumId: 'album-1', isOpen: true, onClose: vi.fn() }));
      });

      const removeButton = document.querySelector('[data-testid="remove-member-user-2"]') as HTMLButtonElement;
      await act(async () => {
        removeButton.click();
      });

      const dialog = document.querySelector('[data-testid="remove-member-dialog"]') as HTMLElement;
      expect(dialog.getAttribute('aria-labelledby')).toBe('remove-member-title');
      expect(dialog.getAttribute('aria-modal')).toBe('true');

      await act(async () => {
        root!.unmount();
      });
      container.remove();
    });
  });
});
