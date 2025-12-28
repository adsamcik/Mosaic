/**
 * Album Permissions Context
 *
 * Provides role-based permissions for album operations.
 * Centralizes permission logic for consistent UI behavior across components.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { AlbumRole } from '../lib/api-types';

/**
 * Permission capabilities derived from user's role
 */
export interface AlbumPermissions {
  /** User's role in this album */
  role: AlbumRole | 'anonymous';
  /** Whether the current user is the album owner */
  isOwner: boolean;
  /** Whether the user can upload new photos */
  canUpload: boolean;
  /** Whether the user can delete photos */
  canDelete: boolean;
  /** Whether the user can invite/manage members */
  canManageMembers: boolean;
  /** Whether the user can create/manage share links */
  canManageShareLinks: boolean;
  /** Whether the user can edit album settings (name, expiration) */
  canEditAlbum: boolean;
  /** Whether the user can select multiple photos */
  canSelect: boolean;
  /** Whether the user can download photos */
  canDownload: boolean;
  /** Access tier for anonymous share link access (1=thumb, 2=preview, 3=full) */
  accessTier?: 1 | 2 | 3;
}

/**
 * Props for AlbumPermissionsProvider
 */
export interface AlbumPermissionsProviderProps {
  children: ReactNode;
  /** User's role in this album */
  role: AlbumRole | 'anonymous';
  /** Access tier for share links (only for anonymous role) */
  accessTier?: 1 | 2 | 3;
}

/**
 * Default permissions for unauthenticated/no-access state
 */
const defaultPermissions: AlbumPermissions = {
  role: 'anonymous',
  isOwner: false,
  canUpload: false,
  canDelete: false,
  canManageMembers: false,
  canManageShareLinks: false,
  canEditAlbum: false,
  canSelect: false,
  canDownload: false,
};

const AlbumPermissionsContext = createContext<AlbumPermissions>(defaultPermissions);

/**
 * Derive permissions from role
 *
 * Role hierarchy:
 * - owner: Full control (upload, delete, manage members, share links, edit)
 * - editor: Can upload and delete photos, but not manage members/links
 * - viewer: Read-only access, can select and download
 * - anonymous: Share link access based on tier
 */
function derivePermissions(
  role: AlbumRole | 'anonymous',
  accessTier?: 1 | 2 | 3
): AlbumPermissions {
  switch (role) {
    case 'owner':
      return {
        role: 'owner',
        isOwner: true,
        canUpload: true,
        canDelete: true,
        canManageMembers: true,
        canManageShareLinks: true,
        canEditAlbum: true,
        canSelect: true,
        canDownload: true,
      };

    case 'editor':
      return {
        role: 'editor',
        isOwner: false,
        canUpload: true,
        canDelete: true,
        canManageMembers: false,
        canManageShareLinks: false,
        canEditAlbum: false,
        canSelect: true,
        canDownload: true,
      };

    case 'viewer':
      return {
        role: 'viewer',
        isOwner: false,
        canUpload: false,
        canDelete: false,
        canManageMembers: false,
        canManageShareLinks: false,
        canEditAlbum: false,
        canSelect: true,
        canDownload: true,
      };

    case 'anonymous':
      return {
        role: 'anonymous',
        isOwner: false,
        canUpload: false,
        canDelete: false,
        canManageMembers: false,
        canManageShareLinks: false,
        canEditAlbum: false,
        canSelect: false,
        // Anonymous users can download only if they have full access tier
        canDownload: accessTier === 3,
        accessTier,
      };
  }
}

/**
 * Provider component for album permissions
 */
export function AlbumPermissionsProvider({
  children,
  role,
  accessTier,
}: AlbumPermissionsProviderProps) {
  const permissions = useMemo(
    () => derivePermissions(role, accessTier),
    [role, accessTier]
  );

  return (
    <AlbumPermissionsContext.Provider value={permissions}>
      {children}
    </AlbumPermissionsContext.Provider>
  );
}

/**
 * Hook to access album permissions
 *
 * @returns Current user's permissions for the album
 * @throws Error if used outside AlbumPermissionsProvider
 */
export function useAlbumPermissions(): AlbumPermissions {
  const context = useContext(AlbumPermissionsContext);
  return context;
}

/**
 * Hook to check a specific permission
 *
 * @param permission - Permission key to check
 * @returns Whether the user has the permission
 */
export function useHasPermission(
  permission: keyof Omit<AlbumPermissions, 'role' | 'accessTier'>
): boolean {
  const permissions = useAlbumPermissions();
  return Boolean(permissions[permission]);
}

export { AlbumPermissionsContext };
