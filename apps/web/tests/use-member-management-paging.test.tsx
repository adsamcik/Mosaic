import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlbumMember } from '../src/lib/api-types';

const mocks = vi.hoisted(() => ({
  listAlbumMembers: vi.fn(),
  getCurrentUser: vi.fn(),
}));

vi.mock('../src/lib/api', () => ({
  getApi: () => ({
    listAlbumMembers: mocks.listAlbumMembers,
    getCurrentUser: mocks.getCurrentUser,
    getUser: vi.fn(),
    getUserByPubkey: vi.fn(),
    inviteToAlbum: vi.fn(),
    removeAlbumMember: vi.fn(),
  }),
  toBase64: (data: Uint8Array) => Buffer.from(data).toString('base64'),
  fromBase64: (str: string) => new Uint8Array(Buffer.from(str, 'base64')),
  async paginateAll<T>(
    fetchPage: (skip: number, take: number) => Promise<T[]>,
    pageSize = 100,
  ): Promise<T[]> {
    const out: T[] = [];
    for (let skip = 0; ; skip += pageSize) {
      const page = await fetchPage(skip, pageSize);
      out.push(...page);
      if (page.length < pageSize) break;
    }
    return out;
  },
}));

vi.mock('../src/lib/crypto-client', () => ({
  getCryptoClient: vi.fn(),
}));

vi.mock('../src/lib/epoch-key-service', () => ({
  fetchAndUnwrapEpochKeys: vi.fn(),
}));

vi.mock('../src/lib/epoch-rotation-service', () => ({
  clearPhotoCaches: vi.fn(),
  rotateEpoch: vi.fn(),
  EpochRotationError: class EpochRotationError extends Error {},
}));

import { useMemberManagement } from '../src/hooks/useMemberManagement';

function createMember(index: number): AlbumMember {
  return {
    userId: `user-${index.toString().padStart(3, '0')}`,
    role: index === 0 ? 'owner' : 'viewer',
    joinedAt: '2024-01-01T00:00:00Z',
    invitedBy: 'user-000',
    user: {
      id: `user-${index.toString().padStart(3, '0')}`,
      authSub: `auth-${index}`,
      identityPubkey: `pubkey-${index}`,
    },
  };
}

function renderHook() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function Host() {
    const result = useMemberManagement('album-1');
    return createElement('div', {
      'data-testid': 'member-state',
      'data-count': String(result.members.length),
      'data-loading': String(result.isLoading),
      'data-owner': String(result.isOwner),
    });
  }

  act(() => {
    root.render(createElement(Host));
  });

  const getState = () => {
    const el = container.querySelector('[data-testid="member-state"]');
    return {
      count: Number(el?.getAttribute('data-count') ?? 0),
      isLoading: el?.getAttribute('data-loading') === 'true',
      isOwner: el?.getAttribute('data-owner') === 'true',
    };
  };

  return {
    getState,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > 1000) {
      throw new Error('waitFor timed out');
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

describe('useMemberManagement pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    mocks.getCurrentUser.mockResolvedValue({
      id: 'user-000',
      authSub: 'owner-auth',
      identityPubkey: 'owner-pubkey',
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('loads every member page instead of only the backend default first page', async () => {
    const members = Array.from({ length: 150 }, (_, i) => createMember(i));
    mocks.listAlbumMembers
      .mockResolvedValueOnce(members.slice(0, 100))
      .mockResolvedValueOnce(members.slice(100));

    const { getState, cleanup } = renderHook();

    await waitFor(() => getState().count === 150);

    expect(mocks.listAlbumMembers).toHaveBeenNthCalledWith(
      1,
      'album-1',
      0,
      100,
    );
    expect(mocks.listAlbumMembers).toHaveBeenNthCalledWith(
      2,
      'album-1',
      100,
      100,
    );
    expect(getState()).toEqual({
      count: 150,
      isLoading: false,
      isOwner: true,
    });

    cleanup();
  });
});
