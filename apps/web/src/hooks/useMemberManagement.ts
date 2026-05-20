/**
 * Member Management Hook
 *
 * Provides member listing, invitation, and removal for albums.
 * Handles cryptographic operations for sealing epoch keys to recipients.
 */

import { useCallback, useEffect, useState } from 'react';
import { fromBase64, getApi, paginateAll, toBase64 } from '../lib/api';
import type {
  AlbumMember,
  InviteEpochKey,
  UserPublic,
} from '../lib/api-types';
import { getCryptoClient } from '../lib/crypto-client';
import { fetchAndUnwrapEpochKeys } from '../lib/epoch-key-service';
import {
  clearPhotoCaches,
  EpochRotationError,
  removeMemberAndRotateEpoch,
} from '../lib/epoch-rotation-service';
import { createLogger } from '../lib/logger';
import { signAndPublishRoster } from '../lib/roster-sign';

const log = createLogger('useMemberManagement');

/**
 * Best-effort publish of the owner-signed member roster after a
 * membership change. Failures are logged but never bubbled up — the
 * user's invite / remove already succeeded server-side, and the worst
 * outcome is that the visitor's UI shows an "unverified roster" banner
 * until the next mutation. Audit `threat-model C-3` (batch C2c-5).
 */
async function publishRosterBestEffort(
  albumId: string,
  members: ReadonlyArray<{ userId: string; role: string }>,
): Promise<void> {
  try {
    const result = await signAndPublishRoster(albumId, members);
    log.debug('Published signed roster', {
      albumId,
      rosterVersion: result.rosterVersion,
      signerEpochId: result.signerEpochId,
      memberCount: members.length,
    });
  } catch (err) {
    log.warn('Best-effort roster publish failed (visitor UI will show "unverified")', {
      albumId,
      memberCount: members.length,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Error thrown by member management operations */
export class MemberManagementError extends Error {
  constructor(
    message: string,
    public readonly code: MemberManagementErrorCode,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'MemberManagementError';
  }
}

/** Member management error codes */
export enum MemberManagementErrorCode {
  /** Failed to fetch members */
  FETCH_FAILED = 'FETCH_FAILED',
  /** Failed to lookup user */
  USER_LOOKUP_FAILED = 'USER_LOOKUP_FAILED',
  /** User not found */
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  /** Identity not derived */
  IDENTITY_NOT_DERIVED = 'IDENTITY_NOT_DERIVED',
  /** Failed to create epoch key bundle */
  BUNDLE_CREATION_FAILED = 'BUNDLE_CREATION_FAILED',
  /** Failed to invite member */
  INVITE_FAILED = 'INVITE_FAILED',
  /** Failed to remove member */
  REMOVE_FAILED = 'REMOVE_FAILED',
  /** Cannot invite self */
  CANNOT_INVITE_SELF = 'CANNOT_INVITE_SELF',
  /** User already member */
  ALREADY_MEMBER = 'ALREADY_MEMBER',
  /** No epoch keys available */
  NO_EPOCH_KEYS = 'NO_EPOCH_KEYS',
  /** Failed to rotate epoch key */
  ROTATION_FAILED = 'ROTATION_FAILED',
}

/** Member with additional display info */
export interface MemberInfo extends AlbumMember {
  displayName: string;
}

/** Removal progress step for UI feedback */
export type RemovalProgressStep =
  | 'removing' // Removing member from server
  | 'rotating' // Rotating epoch keys
  | 'clearing' // Clearing caches
  | 'complete'; // Operation complete

/** Hook return type */
export interface UseMemberManagementReturn {
  /** List of album members */
  members: MemberInfo[];
  /** Whether members are loading */
  isLoading: boolean;
  /** Error during fetch */
  error: Error | null;
  /** Refresh member list */
  refetch: () => Promise<void>;
  /** Invite a new member */
  inviteMember: (
    recipientId: string,
    role: 'editor' | 'viewer',
  ) => Promise<MemberInfo>;
  /** Whether invite is in progress */
  isInviting: boolean;
  /** Error during invite */
  inviteError: string | null;
  /** Remove a member (without key rotation) */
  removeMember: (userId: string) => Promise<void>;
  /** Remove a member and rotate epoch keys */
  removeMemberWithRotation: (
    userId: string,
    onProgress?: (step: RemovalProgressStep) => void,
  ) => Promise<void>;
  /** Whether remove is in progress */
  isRemoving: boolean;
  /** Current removal progress step */
  removalStep: RemovalProgressStep | null;
  /** Lookup user by ID or pubkey */
  lookupUser: (query: string) => Promise<UserPublic>;
  /** Whether lookup is in progress */
  isLookingUp: boolean;
  /** Current user is owner */
  isOwner: boolean;
}

/**
 * Hook to manage album members (list, invite, remove)
 *
 * @param albumId - Album ID
 * @returns Member management functions and state
 */
export function useMemberManagement(
  albumId: string,
): UseMemberManagementReturn {
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isInviting, setIsInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const [removalStep, setRemovalStep] = useState<RemovalProgressStep | null>(
    null,
  );
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  /**
   * Transform API member to MemberInfo with display name
   */
  const toMemberInfo = useCallback((member: AlbumMember): MemberInfo => {
    // Use user's ID prefix as display name for now
    // In a full implementation, we'd decrypt user display names
    const displayName = member.user?.id
      ? `User ${member.user.id.slice(0, 8)}`
      : `User ${member.userId.slice(0, 8)}`;

    return {
      ...member,
      displayName,
    };
  }, []);

  /**
   * Fetch members from API
   */
  const fetchMembers = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const api = getApi();

      // Get current user to determine ownership
      const user = await api.getCurrentUser();
      setCurrentUserId(user.id);

      const apiMembers = await paginateAll((skip, take) =>
        api.listAlbumMembers(albumId, skip, take),
      );
      const memberInfos = apiMembers.map(toMemberInfo);

      setMembers(memberInfos);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setError(
        new MemberManagementError(
          `Failed to fetch members: ${error.message}`,
          MemberManagementErrorCode.FETCH_FAILED,
          error,
        ),
      );
    } finally {
      setIsLoading(false);
    }
  }, [albumId, toMemberInfo]);

  /**
   * Lookup a user by ID or identity pubkey
   */
  const lookupUser = useCallback(async (query: string): Promise<UserPublic> => {
    setIsLookingUp(true);
    try {
      const api = getApi();

      // Try to determine if query is a pubkey (base64) or user ID (UUID)
      // UUIDs are 36 chars with dashes, base64 pubkeys are 43-44 chars
      const isLikelyPubkey =
        query.length > 36 ||
        query.includes('+') ||
        query.includes('/') ||
        query.includes('=');

      if (isLikelyPubkey) {
        return await api.getUserByPubkey(query);
      } else {
        return await api.getUser(query);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (
        error.message.includes('404') ||
        error.message.includes('not found')
      ) {
        throw new MemberManagementError(
          'User not found',
          MemberManagementErrorCode.USER_NOT_FOUND,
          error,
        );
      }
      throw new MemberManagementError(
        `Failed to lookup user: ${error.message}`,
        MemberManagementErrorCode.USER_LOOKUP_FAILED,
        error,
      );
    } finally {
      setIsLookingUp(false);
    }
  }, []);

  /**
   * Invite a new member to the album
   *
   * This function:
   * 1. Validates the recipient
   * 2. Fetches all epoch keys for the album
   * 3. Creates sealed bundles for each epoch key
   * 4. Sends invite request to API
   */
  const inviteMember = useCallback(
    async (
      recipientId: string,
      role: 'editor' | 'viewer',
    ): Promise<MemberInfo> => {
      setIsInviting(true);
      setInviteError(null);

      try {
        const api = getApi();
        const crypto = await getCryptoClient();

        // Check if already a member
        const existingMember = members.find((m) => m.userId === recipientId);
        if (existingMember) {
          throw new MemberManagementError(
            'User is already a member of this album',
            MemberManagementErrorCode.ALREADY_MEMBER,
          );
        }

        // Cannot invite self
        if (recipientId === currentUserId) {
          throw new MemberManagementError(
            'Cannot invite yourself',
            MemberManagementErrorCode.CANNOT_INVITE_SELF,
          );
        }

        // Get recipient's identity public key
        const recipient = await api.getUser(recipientId);
        if (!recipient.identityPubkey) {
          throw new MemberManagementError(
            'Recipient has not set up their identity keypair',
            MemberManagementErrorCode.USER_LOOKUP_FAILED,
          );
        }
        const recipientPubkey = fromBase64(recipient.identityPubkey);

        // Ensure identity is derived
        const identityPubkey = await crypto.getIdentityPublicKey();
        if (!identityPubkey) {
          throw new MemberManagementError(
            'Identity not derived - please log in again',
            MemberManagementErrorCode.IDENTITY_NOT_DERIVED,
          );
        }

        // Fetch and unwrap epoch keys for this album
        const epochBundles = await fetchAndUnwrapEpochKeys(albumId);
        if (epochBundles.length === 0) {
          throw new MemberManagementError(
            'No epoch keys available for this album',
            MemberManagementErrorCode.NO_EPOCH_KEYS,
          );
        }

        // Create sealed bundles for each epoch
        const epochKeys: InviteEpochKey[] = [];

        for (const bundle of epochBundles) {
          try {
            // Slice 3 — bundle payload bytes never cross Comlink. The
            // worker resolves the cached epoch handle id internally and
            // seals + signs in Rust.
            const sealed = await crypto.createEpochKeyBundle(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              bundle.epochHandleId as any,
              albumId,
              recipientPubkey,
            );

            // Per-key `recipientId` is intentionally omitted — the
            // backend `EpochKeyCreate` DTO does not accept it and runs
            // with `UnmappedMemberHandling.Disallow`, so including it
            // produces a JSON model-validation 400. The recipient is
            // already carried on the outer InviteRequest.
            epochKeys.push({
              epochId: bundle.epochId,
              encryptedKeyBundle: toBase64(
                new Uint8Array([
                  ...sealed.signature,
                  ...sealed.encryptedBundle,
                ]),
              ),
              ownerSignature: toBase64(sealed.signature),
              sharerPubkey: toBase64(identityPubkey),
              signPubkey: toBase64(bundle.signPublicKey),
            });
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            throw new MemberManagementError(
              `Failed to create key bundle for epoch ${bundle.epochId}: ${error.message}`,
              MemberManagementErrorCode.BUNDLE_CREATION_FAILED,
              error,
            );
          }
        }

        // Send invite to API
        const newMember = await api.inviteToAlbum(albumId, {
          recipientId,
          role,
          epochKeys,
        });

        const memberInfo = toMemberInfo(newMember);

        // Update local state
        const nextMembers = [...members, memberInfo];
        setMembers(nextMembers);

        // C2c-5: re-sign and publish the owner-signed roster so visitor
        // clients see verified role badges. Best-effort — invite already
        // succeeded server-side.
        void publishRosterBestEffort(
          albumId,
          nextMembers.map((m) => ({ userId: m.userId, role: m.role })),
        );

        return memberInfo;
      } catch (err) {
        const message =
          err instanceof MemberManagementError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Failed to invite member';
        setInviteError(message);
        throw err;
      } finally {
        setIsInviting(false);
      }
    },
    [albumId, currentUserId, members, toMemberInfo],
  );

  /**
   * Remove a member from the album
   */
  const removeMember = useCallback(
    async (userId: string) => {
      setIsRemoving(true);
      setRemovalStep('removing');
      try {
        const api = getApi();
        await api.removeAlbumMember(albumId, userId);

        // Update local state
        const nextMembers = members.filter((m) => m.userId !== userId);
        setMembers(nextMembers);

        // C2c-5: re-sign and publish the owner-signed roster.
        void publishRosterBestEffort(
          albumId,
          nextMembers.map((m) => ({ userId: m.userId, role: m.role })),
        );
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        throw new MemberManagementError(
          `Failed to remove member: ${error.message}`,
          MemberManagementErrorCode.REMOVE_FAILED,
          error,
        );
      } finally {
        setIsRemoving(false);
        setRemovalStep(null);
      }
    },
    [albumId, members],
  );

  /**
   * Remove a member and rotate epoch keys.
   *
   * This is the secure removal path that:
   * 1. Removes the member from the album
   * 2. Generates a fresh epoch key (CRITICAL: completely random)
   * 3. Distributes the new key to all remaining members
   * 4. Clears local caches
   *
   * Use this when you want to ensure the removed member
   * cannot access any future photos.
   */
  const removeMemberWithRotation = useCallback(
    async (
      userId: string,
      onProgress?: (step: RemovalProgressStep) => void,
    ) => {
      setIsRemoving(true);
      setRemovalStep('removing');
      onProgress?.('removing');

      try {
        // Single atomic backend call replaces the historical two-step
        // (DELETE member -> POST rotate). Closes the TOCTOU window where
        // a still-active member could upload content under the OLD epoch
        // between the two API calls — readable by the just-removed
        // member who retained their copy of the old epoch keys.
        // Audit "epoch-rotation High".
        setRemovalStep('rotating');
        onProgress?.('rotating');
        await removeMemberAndRotateEpoch(albumId, userId);
        const nextMembers = members.filter((m) => m.userId !== userId);
        setMembers(nextMembers);

        setRemovalStep('clearing');
        onProgress?.('clearing');
        await clearPhotoCaches(albumId);

        // C2c-5: re-sign the roster under the NEW epoch (rotation just
        // bumped CurrentEpochId so the next signed roster binds to the
        // post-rotation signing key). Best-effort: rotation already
        // succeeded server-side.
        void publishRosterBestEffort(
          albumId,
          nextMembers.map((m) => ({ userId: m.userId, role: m.role })),
        );

        setRemovalStep('complete');
        onProgress?.('complete');
      } catch (err) {
        if (err instanceof EpochRotationError) {
          throw new MemberManagementError(
            `Failed to rotate keys: ${err.message}`,
            MemberManagementErrorCode.ROTATION_FAILED,
            err,
          );
        }

        const error = err instanceof Error ? err : new Error(String(err));
        throw new MemberManagementError(
          `Failed to remove member: ${error.message}`,
          MemberManagementErrorCode.REMOVE_FAILED,
          error,
        );
      } finally {
        setIsRemoving(false);
        setRemovalStep(null);
      }
    },
    [albumId, members],
  );

  // Determine if current user is owner
  const isOwner =
    currentUserId !== null &&
    members.some((m) => m.userId === currentUserId && m.role === 'owner');

  // Fetch members on mount and when albumId changes
  useEffect(() => {
    void fetchMembers();
  }, [fetchMembers]);

  return {
    members,
    isLoading,
    error,
    refetch: fetchMembers,
    inviteMember,
    isInviting,
    inviteError,
    removeMember,
    removeMemberWithRotation,
    isRemoving,
    removalStep,
    lookupUser,
    isLookingUp,
    isOwner,
  };
}
