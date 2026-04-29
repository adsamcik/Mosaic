/**
 * LoginForm Component Tests
 *
 * Covers security findings:
 *  L4 — clearCorruptedSession requires explicit confirmation
 *  L5 — password / username inputs declare correct autoComplete values
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

// ---------------------------------------------------------------------------
// Hoisted mocks for the lib modules LoginForm depends on. We can't reference
// outer-scope variables inside vi.mock factories, so vi.hoisted gives us a
// stable handle.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  checkServerStatus: vi.fn(),
  clearCorruptedSession: vi.fn(),
  restoreSession: vi.fn(),
  localLogin: vi.fn(),
  localRegister: vi.fn(),
  login: vi.fn(),
}));

vi.mock('../../src/lib/local-auth', () => ({
  checkServerStatus: mocks.checkServerStatus,
}));

vi.mock('../../src/lib/session', () => ({
  session: {
    clearCorruptedSession: mocks.clearCorruptedSession,
    restoreSession: mocks.restoreSession,
    localLogin: mocks.localLogin,
    localRegister: mocks.localRegister,
    login: mocks.login,
  },
}));

import { LoginForm } from '../../src/components/Auth/LoginForm';
import type { User } from '../../src/lib/api-types';

function createPendingUser(): User {
  return {
    id: 'user-1',
    authSub: 'sub-1',
    createdAt: new Date().toISOString(),
  };
}

interface RenderResult {
  container: HTMLDivElement;
  cleanup: () => void;
}

async function renderLogin(
  props: { pendingSessionUser?: User | null } = {},
): Promise<RenderResult> {
  const container = document.createElement('div');
  document.body.appendChild(container);

  let root: ReturnType<typeof createRoot>;
  await act(async () => {
    root = createRoot(container);
    root.render(createElement(LoginForm, props));
  });

  // Flush the chain of microtasks created by the on-mount checkServer()
  // promise so the form transitions out of its "checking auth mode" state.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  return {
    container,
    cleanup: () => {
      act(() => {
        root!.unmount();
      });
      container.remove();
    },
  };
}

describe('LoginForm', () => {
  let originalConfirm: typeof window.confirm;
  let reloadSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';

    mocks.checkServerStatus.mockResolvedValue({
      isOnline: true,
      isLocalAuth: true,
      isProxyAuth: false,
      statusCode: 200,
    });
    mocks.clearCorruptedSession.mockResolvedValue(undefined);

    originalConfirm = window.confirm;

    // Stub window.location.reload so the clear-session handler doesn't try
    // to navigate during tests. happy-dom's location.reload is a normal
    // (configurable) function, so direct assignment via defineProperty works.
    reloadSpy = vi.fn();
    Object.defineProperty(window.location, 'reload', {
      configurable: true,
      writable: true,
      value: reloadSpy,
    });
  });

  afterEach(() => {
    window.confirm = originalConfirm;
    document.body.innerHTML = '';
  });

  // -------------------------------------------------------------------------
  // L4: Clear-session button must require explicit confirmation
  // -------------------------------------------------------------------------
  describe('L4: clear session confirmation', () => {
    it('does not clear session when window.confirm returns false', async () => {
      const confirmSpy = vi.fn(() => false);
      window.confirm = confirmSpy;

      const { container, cleanup } = await renderLogin({
        pendingSessionUser: createPendingUser(),
      });

      const button = container.querySelector(
        '[data-testid="clear-session-button"]',
      ) as HTMLButtonElement | null;
      expect(button).not.toBeNull();

      await act(async () => {
        button!.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(confirmSpy).toHaveBeenCalledTimes(1);
      // The confirmation copy is what the user sees; verify a message was passed.
      const message = confirmSpy.mock.calls[0]![0];
      expect(typeof message).toBe('string');
      expect((message as string).length).toBeGreaterThan(0);

      // Destructive side effects must NOT have run.
      expect(mocks.clearCorruptedSession).not.toHaveBeenCalled();
      expect(reloadSpy).not.toHaveBeenCalled();

      cleanup();
    });

    it('clears session and reloads when window.confirm returns true', async () => {
      const confirmSpy = vi.fn(() => true);
      window.confirm = confirmSpy;

      const { container, cleanup } = await renderLogin({
        pendingSessionUser: createPendingUser(),
      });

      const button = container.querySelector(
        '[data-testid="clear-session-button"]',
      ) as HTMLButtonElement | null;
      expect(button).not.toBeNull();

      await act(async () => {
        button!.click();
        // Allow the awaited clearCorruptedSession promise to resolve.
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(mocks.clearCorruptedSession).toHaveBeenCalledTimes(1);
      expect(reloadSpy).toHaveBeenCalledTimes(1);

      cleanup();
    });
  });

  // -------------------------------------------------------------------------
  // L5: Password autoComplete attributes
  // -------------------------------------------------------------------------
  describe('L5: password autoComplete attributes', () => {
    it('sets autoComplete="current-password" on the login password field', async () => {
      const { container, cleanup } = await renderLogin();

      const password = container.querySelector(
        'input#password',
      ) as HTMLInputElement | null;
      expect(password).not.toBeNull();
      expect(password!.getAttribute('autocomplete')).toBe('current-password');

      cleanup();
    });

    it('sets autoComplete="username" on the login username field', async () => {
      const { container, cleanup } = await renderLogin();

      const username = container.querySelector(
        'input#username',
      ) as HTMLInputElement | null;
      expect(username).not.toBeNull();
      expect(username!.getAttribute('autocomplete')).toBe('username');

      cleanup();
    });

    it('sets autoComplete="current-password" in session-restore mode', async () => {
      const { container, cleanup } = await renderLogin({
        pendingSessionUser: createPendingUser(),
      });

      const password = container.querySelector(
        'input#password',
      ) as HTMLInputElement | null;
      expect(password).not.toBeNull();
      expect(password!.getAttribute('autocomplete')).toBe('current-password');

      cleanup();
    });

    it('sets autoComplete="new-password" on password and confirm-password fields in register mode', async () => {
      const { container, cleanup } = await renderLogin();

      const toggle = container.querySelector(
        'button.mode-toggle-button',
      ) as HTMLButtonElement | null;
      expect(toggle).not.toBeNull();
      await act(async () => {
        toggle!.click();
      });

      const password = container.querySelector(
        'input#password',
      ) as HTMLInputElement | null;
      const confirm = container.querySelector(
        'input#confirmPassword',
      ) as HTMLInputElement | null;

      expect(password).not.toBeNull();
      expect(password!.getAttribute('autocomplete')).toBe('new-password');
      expect(confirm).not.toBeNull();
      expect(confirm!.getAttribute('autocomplete')).toBe('new-password');

      cleanup();
    });
  });
});
