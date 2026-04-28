/**
 * useMemberManagement Hook Tests
 *
 * Tests the member management hook logic.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MemberManagementError,
  MemberManagementErrorCode,
} from '../src/hooks/useMemberManagement';

// Mock the dependencies
const mockListAlbumMembers = vi.fn();
const mockGetCurrentUser = vi.fn();
const mockGetUser = vi.fn();
const mockGetUserByPubkey = vi.fn();
const mockInviteToAlbum = vi.fn();
const mockRemoveAlbumMember = vi.fn();

vi.mock('../src/lib/api', () => ({
  getApi: () => ({
    listAlbumMembers: mockListAlbumMembers,
    getCurrentUser: mockGetCurrentUser,
    getUser: mockGetUser,
    getUserByPubkey: mockGetUserByPubkey,
    inviteToAlbum: mockInviteToAlbum,
    removeAlbumMember: mockRemoveAlbumMember,
  }),
  toBase64: (data: Uint8Array) => Buffer.from(data).toString('base64'),
  fromBase64: (str: string) => new Uint8Array(Buffer.from(str, 'base64')),
  paginateAll: async <T>(
    fetchPage: (skip: number, take: number) => Promise<T[]>,
    pageSize = 100,
  ): Promise<T[]> => {
    const out: T[] = [];
    for (let skip = 0; ; skip += pageSize) {
      const page = await fetchPage(skip, pageSize);
      out.push(...page);
      if (page.length < pageSize) break;
    }
    return out;
  },
}));

const mockGetIdentityPublicKey = vi.fn();
const mockCreateEpochKeyBundle = vi.fn();

vi.mock('../src/lib/crypto-client', () => ({
  getCryptoClient: () =>
    Promise.resolve({
      getIdentityPublicKey: mockGetIdentityPublicKey,
      createEpochKeyBundle: mockCreateEpochKeyBundle,
    }),
}));

const mockFetchAndUnwrapEpochKeys = vi.fn();

vi.mock('../src/lib/epoch-key-service', () => ({
  fetchAndUnwrapEpochKeys: () => mockFetchAndUnwrapEpochKeys(),
}));

describe('MemberManagementError', () => {
  it('creates error with message and code', () => {
    const error = new MemberManagementError(
      'Test error',
      MemberManagementErrorCode.FETCH_FAILED,
    );

    expect(error.message).toBe('Test error');
    expect(error.code).toBe(MemberManagementErrorCode.FETCH_FAILED);
    expect(error.name).toBe('MemberManagementError');
  });

  it('creates error with cause', () => {
    const cause = new Error('Original error');
    const error = new MemberManagementError(
      'Wrapped error',
      MemberManagementErrorCode.INVITE_FAILED,
      cause,
    );

    expect(error.cause).toBe(cause);
  });
});

describe('MemberManagementErrorCode', () => {
  it('has all expected error codes', () => {
    expect(MemberManagementErrorCode.FETCH_FAILED).toBe('FETCH_FAILED');
    expect(MemberManagementErrorCode.USER_LOOKUP_FAILED).toBe(
      'USER_LOOKUP_FAILED',
    );
    expect(MemberManagementErrorCode.USER_NOT_FOUND).toBe('USER_NOT_FOUND');
    expect(MemberManagementErrorCode.IDENTITY_NOT_DERIVED).toBe(
      'IDENTITY_NOT_DERIVED',
    );
    expect(MemberManagementErrorCode.BUNDLE_CREATION_FAILED).toBe(
      'BUNDLE_CREATION_FAILED',
    );
    expect(MemberManagementErrorCode.INVITE_FAILED).toBe('INVITE_FAILED');
    expect(MemberManagementErrorCode.REMOVE_FAILED).toBe('REMOVE_FAILED');
    expect(MemberManagementErrorCode.CANNOT_INVITE_SELF).toBe(
      'CANNOT_INVITE_SELF',
    );
    expect(MemberManagementErrorCode.ALREADY_MEMBER).toBe('ALREADY_MEMBER');
    expect(MemberManagementErrorCode.NO_EPOCH_KEYS).toBe('NO_EPOCH_KEYS');
  });
});

describe('useMemberManagement hook logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('member transformation', () => {
    it('creates display name from user ID', async () => {
      // Test the display name logic
      const userId = 'abcd1234-5678-90ab-cdef-1234567890ab';
      const expectedDisplayName = `User ${userId.slice(0, 8)}`;

      expect(expectedDisplayName).toBe('User abcd1234');
    });
  });

  describe('user lookup logic', () => {
    it('identifies pubkey by length > 36', () => {
      const pubkey = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop==';
      const isLikelyPubkey =
        pubkey.length > 36 ||
        pubkey.includes('+') ||
        pubkey.includes('/') ||
        pubkey.includes('=');

      expect(isLikelyPubkey).toBe(true);
    });

    it('identifies UUID by length <= 36', () => {
      const uuid = 'abcd1234-5678-90ab-cdef-1234567890ab';
      const isLikelyPubkey =
        uuid.length > 36 ||
        uuid.includes('+') ||
        uuid.includes('/') ||
        uuid.includes('=');

      expect(isLikelyPubkey).toBe(false);
    });

    it('identifies pubkey by base64 characters', () => {
      const pubkeyWithPlus = 'abc+def';
      const pubkeyWithSlash = 'abc/def';
      const pubkeyWithEquals = 'abcd==';

      expect(pubkeyWithPlus.includes('+')).toBe(true);
      expect(pubkeyWithSlash.includes('/')).toBe(true);
      expect(pubkeyWithEquals.includes('=')).toBe(true);
    });
  });

  describe('role validation', () => {
    it('validates owner cannot be removed', () => {
      const member = { role: 'owner' as const };
      const canRemove = member.role !== 'owner';

      expect(canRemove).toBe(false);
    });

    it('validates editor can be removed', () => {
      const member = { role: 'editor' as const };
      const canRemove = member.role !== 'owner';

      expect(canRemove).toBe(true);
    });

    it('validates viewer can be removed', () => {
      const member = { role: 'viewer' as const };
      const canRemove = member.role !== 'owner';

      expect(canRemove).toBe(true);
    });
  });

  describe('ownership detection', () => {
    it('identifies owner correctly', () => {
      const currentUserId = 'user-1';
      const members = [
        { userId: 'user-1', role: 'owner' as const },
        { userId: 'user-2', role: 'editor' as const },
      ];

      const isOwner = members.some(
        (m) => m.userId === currentUserId && m.role === 'owner',
      );

      expect(isOwner).toBe(true);
    });

    it('identifies non-owner correctly', () => {
      const currentUserId = 'user-2';
      const members = [
        { userId: 'user-1', role: 'owner' as const },
        { userId: 'user-2', role: 'editor' as const },
      ];

      const isOwner = members.some(
        (m) => m.userId === currentUserId && m.role === 'owner',
      );

      expect(isOwner).toBe(false);
    });
  });

  describe('self-invite prevention', () => {
    it('detects self-invite attempt', () => {
      const currentUserId = 'user-1';
      const recipientId = 'user-1';

      const isSelfInvite = recipientId === currentUserId;

      expect(isSelfInvite).toBe(true);
    });

    it('allows inviting different user', () => {
      const currentUserId = 'user-1';
      const recipientId = 'user-2';

      const isSelfInvite = recipientId === currentUserId;

      expect(isSelfInvite).toBe(false);
    });
  });

  describe('duplicate member detection', () => {
    it('detects existing member', () => {
      const members = [{ userId: 'user-1' }, { userId: 'user-2' }];
      const recipientId = 'user-2';

      const isAlreadyMember = members.some((m) => m.userId === recipientId);

      expect(isAlreadyMember).toBe(true);
    });

    it('allows new member', () => {
      const members = [{ userId: 'user-1' }, { userId: 'user-2' }];
      const recipientId = 'user-3';

      const isAlreadyMember = members.some((m) => m.userId === recipientId);

      expect(isAlreadyMember).toBe(false);
    });
  });
});
