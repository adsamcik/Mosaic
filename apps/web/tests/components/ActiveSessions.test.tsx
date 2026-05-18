/**
 * ActiveSessions Component Tests (v1.0.x sweep38)
 *
 * Covers:
 *  - Renders sessions from GET /auth/sessions
 *  - Hides revoke for current session, shows for others
 *  - DELETE /auth/sessions/{id} on individual revoke (after confirmation)
 *  - POST /auth/sessions/revoke-others on bulk action (after confirmation)
 *  - Hides entirely on 404 (proxy-auth mode)
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
}));

vi.mock('../../src/lib/api', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/lib/api')>(
      '../../src/lib/api',
    );
  return {
    ...actual,
    apiRequest: mocks.apiRequest,
  };
});

import { ActiveSessions } from '../../src/components/Settings/ActiveSessions';
import { ApiError } from '../../src/lib/api';

interface RenderResult {
  container: HTMLDivElement;
  cleanup: () => void;
}

async function renderComponent(): Promise<RenderResult> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(ActiveSessions));
  });
  // Wait for the initial reload effect to resolve.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    container,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function makeSession(
  id: string,
  isCurrent: boolean,
  deviceName = `Device ${id}`,
  ipAddress = '192.168.1.1',
) {
  return {
    id,
    deviceName,
    ipAddress,
    createdAt: '2025-01-01T00:00:00Z',
    lastSeenAt: '2025-01-02T00:00:00Z',
    isCurrent,
  };
}

describe('ActiveSessions (sweep38)', () => {
  beforeEach(() => {
    mocks.apiRequest.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders sessions from the API', async () => {
    mocks.apiRequest.mockResolvedValueOnce([
      makeSession('a', true),
      makeSession('b', false),
    ]);
    const r = await renderComponent();
    try {
      expect(mocks.apiRequest).toHaveBeenCalledWith('/auth/sessions');
      expect(r.container.querySelector('[data-testid="session-row-a"]')).toBeTruthy();
      expect(r.container.querySelector('[data-testid="session-row-b"]')).toBeTruthy();
      expect(r.container.querySelector('[data-testid="session-current-a"]')).toBeTruthy();
      expect(r.container.querySelector('[data-testid="revoke-button-a"]')).toBeNull();
      expect(r.container.querySelector('[data-testid="revoke-button-b"]')).toBeTruthy();
    } finally {
      r.cleanup();
    }
  });

  it('hides the section when /auth/sessions returns 404 (non-local-auth)', async () => {
    mocks.apiRequest.mockRejectedValueOnce(new ApiError(404, 'Not Found'));
    const r = await renderComponent();
    try {
      expect(r.container.querySelector('[data-testid="sessions-section"]')).toBeNull();
    } finally {
      r.cleanup();
    }
  });

  it('calls DELETE after the user confirms individual revoke', async () => {
    mocks.apiRequest.mockResolvedValueOnce([
      makeSession('a', true),
      makeSession('b', false),
    ]);
    const r = await renderComponent();
    try {
      const revokeBtn = r.container.querySelector(
        '[data-testid="revoke-button-b"]',
      ) as HTMLButtonElement;
      await act(async () => {
        revokeBtn.click();
      });
      expect(
        r.container.querySelector('[data-testid="sessions-confirm-dialog"]'),
      ).toBeTruthy();
      mocks.apiRequest.mockResolvedValueOnce(undefined);
      const confirmBtn = r.container.querySelector(
        '[data-testid="sessions-confirm-button"]',
      ) as HTMLButtonElement;
      await act(async () => {
        confirmBtn.click();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mocks.apiRequest).toHaveBeenCalledWith('/auth/sessions/b', {
        method: 'DELETE',
      });
      expect(r.container.querySelector('[data-testid="session-row-b"]')).toBeNull();
    } finally {
      r.cleanup();
    }
  });

  it('calls revoke-others when user confirms bulk action', async () => {
    mocks.apiRequest.mockResolvedValueOnce([
      makeSession('a', true),
      makeSession('b', false),
      makeSession('c', false),
    ]);
    const r = await renderComponent();
    try {
      const allBtn = r.container.querySelector(
        '[data-testid="revoke-all-others-button"]',
      ) as HTMLButtonElement;
      await act(async () => {
        allBtn.click();
      });
      mocks.apiRequest.mockResolvedValueOnce({ revokedCount: 2 });
      const confirmBtn = r.container.querySelector(
        '[data-testid="sessions-confirm-button"]',
      ) as HTMLButtonElement;
      await act(async () => {
        confirmBtn.click();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(mocks.apiRequest).toHaveBeenCalledWith(
        '/auth/sessions/revoke-others',
        { method: 'POST' },
      );
      expect(r.container.querySelector('[data-testid="session-row-b"]')).toBeNull();
      expect(r.container.querySelector('[data-testid="session-row-c"]')).toBeNull();
      expect(r.container.querySelector('[data-testid="session-row-a"]')).toBeTruthy();
    } finally {
      r.cleanup();
    }
  });

  it('cancels the dialog without calling the API', async () => {
    mocks.apiRequest.mockResolvedValueOnce([
      makeSession('a', true),
      makeSession('b', false),
    ]);
    const r = await renderComponent();
    try {
      const revokeBtn = r.container.querySelector(
        '[data-testid="revoke-button-b"]',
      ) as HTMLButtonElement;
      await act(async () => {
        revokeBtn.click();
      });
      const cancelBtn = r.container.querySelector(
        '[data-testid="sessions-cancel-button"]',
      ) as HTMLButtonElement;
      await act(async () => {
        cancelBtn.click();
      });
      expect(
        r.container.querySelector('[data-testid="sessions-confirm-dialog"]'),
      ).toBeNull();
      // Only the initial GET was called.
      expect(mocks.apiRequest).toHaveBeenCalledTimes(1);
    } finally {
      r.cleanup();
    }
  });
});
