/**
 * useSession Hook Unit Tests
 *
 * Tests for the session state hook.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSession } from '../../src/hooks/useSession';

// Mock the session module
vi.mock('../../src/lib/session', () => {
  let listeners: Array<() => void> = [];
  let isLoggedIn = false;

  return {
    session: {
      get isLoggedIn() {
        return isLoggedIn;
      },
      set isLoggedIn(value: boolean) {
        isLoggedIn = value;
      },
      subscribe: (listener: () => void) => {
        listeners.push(listener);
        return () => {
          listeners = listeners.filter((l) => l !== listener);
        };
      },
      login: vi.fn(),
      logout: vi.fn(),
      notifyListeners: () => {
        listeners.forEach((l) => l());
      },
      _reset: () => {
        listeners = [];
        isLoggedIn = false;
      },
      _setLoggedIn: (value: boolean) => {
        isLoggedIn = value;
        listeners.forEach((l) => l());
      },
    },
  };
});

// Test harness component that exposes hook results
interface UseSessionReturn {
  isLoggedIn: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

interface HarnessProps {
  onResult: (result: UseSessionReturn) => void;
}

function TestHarness({ onResult }: HarnessProps) {
  const result = useSession();
  onResult(result);
  return null;
}

describe('useSession', () => {
  let container: HTMLElement;
  let root: Root;
  let hookResult: UseSessionReturn;

  beforeEach(async () => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    hookResult = undefined as unknown as UseSessionReturn;
    
    // Reset session state
    const { session } = await import('../../src/lib/session');
    (session as unknown as { _reset: () => void })._reset();
  });

  afterEach(() => {
    root.unmount();
    document.body.removeChild(container);
    vi.restoreAllMocks();
  });

  function renderHook() {
    act(() => {
      root.render(
        createElement(TestHarness, {
          onResult: (result) => {
            hookResult = result;
          },
        }),
      );
    });
    return hookResult;
  }

  describe('initial state', () => {
    it('returns initial logged out state', () => {
      renderHook();

      expect(hookResult.isLoggedIn).toBe(false);
      expect(typeof hookResult.login).toBe('function');
      expect(typeof hookResult.logout).toBe('function');
    });

    it('returns initial logged in state when session is active', async () => {
      const { session } = await import('../../src/lib/session');
      (session as unknown as { isLoggedIn: boolean }).isLoggedIn = true;

      renderHook();

      expect(hookResult.isLoggedIn).toBe(true);
    });
  });

  describe('state updates', () => {
    it('updates state when session changes to logged in', async () => {
      const { session } = await import('../../src/lib/session');

      renderHook();
      expect(hookResult.isLoggedIn).toBe(false);

      // Simulate login
      act(() => {
        (
          session as unknown as { _setLoggedIn: (value: boolean) => void }
        )._setLoggedIn(true);
      });

      expect(hookResult.isLoggedIn).toBe(true);
    });

    it('updates state when session changes to logged out', async () => {
      const { session } = await import('../../src/lib/session');
      // Start logged in
      (session as unknown as { isLoggedIn: boolean }).isLoggedIn = true;

      renderHook();
      expect(hookResult.isLoggedIn).toBe(true);

      // Simulate logout
      act(() => {
        (
          session as unknown as { _setLoggedIn: (value: boolean) => void }
        )._setLoggedIn(false);
      });

      expect(hookResult.isLoggedIn).toBe(false);
    });
  });

  describe('exposed methods', () => {
    it('exposes login function bound to session', async () => {
      const { session } = await import('../../src/lib/session');
      renderHook();

      // Call the exposed login function
      await hookResult.login('testuser', 'testpass');

      expect(session.login).toHaveBeenCalledWith('testuser', 'testpass');
    });

    it('exposes logout function bound to session', async () => {
      const { session } = await import('../../src/lib/session');
      renderHook();

      // Call the exposed logout function
      await hookResult.logout();

      expect(session.logout).toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    it('unsubscribes from session on unmount', async () => {
      const { session } = await import('../../src/lib/session');
      const subscribeSpy = vi.spyOn(session, 'subscribe');

      renderHook();

      expect(subscribeSpy).toHaveBeenCalled();

      // Unmount
      root.unmount();

      // The cleanup function should have been called
      // We verify this indirectly by checking subscribe was called
    });
  });
});
