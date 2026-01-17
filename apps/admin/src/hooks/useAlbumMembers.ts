/**
 * Album Members Hook
 *
 * Simplified hook to get album member info and current user's role.
 */

import { useCallback, useEffect, useState } from 'react';
import { getApi } from '../lib/api';
import type { AlbumMember, AlbumRole } from '../lib/api-types';
import { createLogger } from '../lib/logger';

const log = createLogger('useAlbumMembers');

/** Hook return type */
export interface UseAlbumMembersReturn {
  /** List of album members */
  members: AlbumMember[];
  /** Current user's role in the album */
  currentUserRole: AlbumRole | null;
  /** Whether the current user is the owner */
  isOwner: boolean;
  /** Whether the current user can edit (owner or editor) */
  canEdit: boolean;
  /** Whether data is loading */
  isLoading: boolean;
  /** Error during fetch */
  error: Error | null;
  /** Refresh members list */
  refetch: () => Promise<void>;
}

/**
 * Hook to get album members and current user's role
 *
 * @param albumId - Album ID
 * @returns Members and role information
 */
export function useAlbumMembers(albumId: string): UseAlbumMembersReturn {
  const [members, setMembers] = useState<AlbumMember[]>([]);
  const [currentUserRole, setCurrentUserRole] = useState<AlbumRole | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchMembers = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const api = getApi();

      // Get current user
      const currentUser = await api.getCurrentUser();

      // Fetch members
      const albumMembers = await api.listAlbumMembers(albumId);
      setMembers(albumMembers);

      // Find current user's role
      const userMembership = albumMembers.find(
        (m) => m.userId === currentUser.id,
      );

      if (userMembership) {
        setCurrentUserRole(userMembership.role);
      } else {
        setCurrentUserRole(null);
      }
    } catch (err) {
      const fetchError = err instanceof Error ? err : new Error(String(err));
      log.error('Failed to fetch album members:', fetchError);
      setError(fetchError);
    } finally {
      setIsLoading(false);
    }
  }, [albumId]);

  useEffect(() => {
    void fetchMembers();
  }, [fetchMembers]);

  const isOwner = currentUserRole === 'owner';
  const canEdit = currentUserRole === 'owner' || currentUserRole === 'editor';

  return {
    members,
    currentUserRole,
    isOwner,
    canEdit,
    isLoading,
    error,
    refetch: fetchMembers,
  };
}
