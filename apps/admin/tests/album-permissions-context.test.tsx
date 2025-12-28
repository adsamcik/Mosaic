/**
 * Tests for AlbumPermissionsContext
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AlbumPermissionsProvider,
  useAlbumPermissions,
  useHasPermission,
} from '../src/contexts/AlbumPermissionsContext';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  root.unmount();
  container.remove();
});

// Test component to read permissions
function PermissionsDisplay() {
  const permissions = useAlbumPermissions();
  return createElement('div', null, [
    createElement('span', { key: 'role', 'data-testid': 'role' }, permissions.role),
    createElement('span', { key: 'is-owner', 'data-testid': 'is-owner' }, String(permissions.isOwner)),
    createElement('span', { key: 'can-upload', 'data-testid': 'can-upload' }, String(permissions.canUpload)),
    createElement('span', { key: 'can-delete', 'data-testid': 'can-delete' }, String(permissions.canDelete)),
    createElement('span', { key: 'can-manage-members', 'data-testid': 'can-manage-members' }, String(permissions.canManageMembers)),
    createElement('span', { key: 'can-manage-share-links', 'data-testid': 'can-manage-share-links' }, String(permissions.canManageShareLinks)),
    createElement('span', { key: 'can-edit-album', 'data-testid': 'can-edit-album' }, String(permissions.canEditAlbum)),
    createElement('span', { key: 'can-select', 'data-testid': 'can-select' }, String(permissions.canSelect)),
    createElement('span', { key: 'can-download', 'data-testid': 'can-download' }, String(permissions.canDownload)),
    createElement('span', { key: 'access-tier', 'data-testid': 'access-tier' }, permissions.accessTier ?? 'undefined'),
  ]);
}

// Test component for useHasPermission hook
function HasPermissionDisplay({ permission }: { permission: 'canUpload' | 'canDelete' | 'canSelect' }) {
  const has = useHasPermission(permission);
  return createElement('span', { 'data-testid': 'has-permission' }, String(has));
}

function getTestId(id: string): string {
  return container.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';
}

describe('AlbumPermissionsContext', () => {
  describe('owner role', () => {
    it('should grant all permissions to owner', () => {
      act(() => {
        root.render(
          createElement(
            AlbumPermissionsProvider,
            { role: 'owner', children: createElement(PermissionsDisplay) }
          )
        );
      });

      expect(getTestId('role')).toBe('owner');
      expect(getTestId('is-owner')).toBe('true');
      expect(getTestId('can-upload')).toBe('true');
      expect(getTestId('can-delete')).toBe('true');
      expect(getTestId('can-manage-members')).toBe('true');
      expect(getTestId('can-manage-share-links')).toBe('true');
      expect(getTestId('can-edit-album')).toBe('true');
      expect(getTestId('can-select')).toBe('true');
      expect(getTestId('can-download')).toBe('true');
    });
  });

  describe('editor role', () => {
    it('should grant upload and delete permissions but not member management', () => {
      act(() => {
        root.render(
          createElement(
            AlbumPermissionsProvider,
            { role: 'editor', children: createElement(PermissionsDisplay) }
          )
        );
      });

      expect(getTestId('role')).toBe('editor');
      expect(getTestId('is-owner')).toBe('false');
      expect(getTestId('can-upload')).toBe('true');
      expect(getTestId('can-delete')).toBe('true');
      expect(getTestId('can-manage-members')).toBe('false');
      expect(getTestId('can-manage-share-links')).toBe('false');
      expect(getTestId('can-edit-album')).toBe('false');
      expect(getTestId('can-select')).toBe('true');
      expect(getTestId('can-download')).toBe('true');
    });
  });

  describe('viewer role', () => {
    it('should grant read-only permissions', () => {
      act(() => {
        root.render(
          createElement(
            AlbumPermissionsProvider,
            { role: 'viewer', children: createElement(PermissionsDisplay) }
          )
        );
      });

      expect(getTestId('role')).toBe('viewer');
      expect(getTestId('is-owner')).toBe('false');
      expect(getTestId('can-upload')).toBe('false');
      expect(getTestId('can-delete')).toBe('false');
      expect(getTestId('can-manage-members')).toBe('false');
      expect(getTestId('can-manage-share-links')).toBe('false');
      expect(getTestId('can-edit-album')).toBe('false');
      expect(getTestId('can-select')).toBe('true');
      expect(getTestId('can-download')).toBe('true');
    });
  });

  describe('anonymous role', () => {
    it('should grant minimal permissions without access tier', () => {
      act(() => {
        root.render(
          createElement(
            AlbumPermissionsProvider,
            { role: 'anonymous', children: createElement(PermissionsDisplay) }
          )
        );
      });

      expect(getTestId('role')).toBe('anonymous');
      expect(getTestId('is-owner')).toBe('false');
      expect(getTestId('can-upload')).toBe('false');
      expect(getTestId('can-delete')).toBe('false');
      expect(getTestId('can-manage-members')).toBe('false');
      expect(getTestId('can-select')).toBe('false');
      expect(getTestId('can-download')).toBe('false');
      expect(getTestId('access-tier')).toBe('undefined');
    });

    it('should allow download with full access tier (3)', () => {
      act(() => {
        root.render(
          createElement(
            AlbumPermissionsProvider,
            { role: 'anonymous', accessTier: 3, children: createElement(PermissionsDisplay) }
          )
        );
      });

      expect(getTestId('can-download')).toBe('true');
      expect(getTestId('access-tier')).toBe('3');
    });

    it('should not allow download with preview access tier (2)', () => {
      act(() => {
        root.render(
          createElement(
            AlbumPermissionsProvider,
            { role: 'anonymous', accessTier: 2, children: createElement(PermissionsDisplay) }
          )
        );
      });

      expect(getTestId('can-download')).toBe('false');
      expect(getTestId('access-tier')).toBe('2');
    });

    it('should not allow download with thumbnail access tier (1)', () => {
      act(() => {
        root.render(
          createElement(
            AlbumPermissionsProvider,
            { role: 'anonymous', accessTier: 1, children: createElement(PermissionsDisplay) }
          )
        );
      });

      expect(getTestId('can-download')).toBe('false');
      expect(getTestId('access-tier')).toBe('1');
    });
  });

  describe('useHasPermission hook', () => {
    it('should return true when user has permission', () => {
      act(() => {
        root.render(
          createElement(
            AlbumPermissionsProvider,
            { role: 'owner', children: createElement(HasPermissionDisplay, { permission: 'canUpload' }) }
          )
        );
      });

      expect(getTestId('has-permission')).toBe('true');
    });

    it('should return false when user lacks permission', () => {
      act(() => {
        root.render(
          createElement(
            AlbumPermissionsProvider,
            { role: 'viewer', children: createElement(HasPermissionDisplay, { permission: 'canUpload' }) }
          )
        );
      });

      expect(getTestId('has-permission')).toBe('false');
    });
  });

  describe('default context value', () => {
    it('should provide anonymous permissions outside provider', () => {
      act(() => {
        root.render(createElement(PermissionsDisplay));
      });

      expect(getTestId('role')).toBe('anonymous');
      expect(getTestId('is-owner')).toBe('false');
      expect(getTestId('can-upload')).toBe('false');
    });
  });
});
