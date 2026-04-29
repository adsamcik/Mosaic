/**
 * Local Auth Dev-Mode Guard Tests (L7)
 *
 * Verifies that dev-only entry points (`devLogin`, `devUpdateKeys`) refuse
 * to run when `import.meta.env.DEV` is false. The backend should also reject
 * these routes in production, but a client-side guard is defense in depth
 * and prevents silent forwards-compat regressions if a dev-only function is
 * accidentally wired into a production code path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { devLogin, devUpdateKeys } from '../local-auth';

describe('local-auth dev-mode guard (L7)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('devLogin', () => {
    it('throws when called from a production build (DEV=false)', async () => {
      vi.stubEnv('DEV', false);
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      await expect(devLogin('alice')).rejects.toThrow(
        /production build/i,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('does not call fetch when DEV=false (verifying short-circuit)', async () => {
      vi.stubEnv('DEV', false);
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      await expect(devLogin('alice')).rejects.toThrow();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('proceeds and calls fetch when DEV=true', async () => {
      vi.stubEnv('DEV', true);
      const fetchSpy = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              userId: 'u1',
              username: 'alice',
              userSalt: 'AAAA',
              accountSalt: 'BBBB',
              isNewUser: false,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      );
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      const result = await devLogin('alice');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const call = fetchSpy.mock.calls[0];
      expect(call?.[0]).toBe('/api/dev-auth/login');
      expect(call?.[1]?.method).toBe('POST');
      expect(result.username).toBe('alice');
    });
  });

  describe('devUpdateKeys', () => {
    it('throws when called from a production build (DEV=false)', async () => {
      vi.stubEnv('DEV', false);
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      await expect(devUpdateKeys({ authPubkey: 'X' })).rejects.toThrow(
        /production build/i,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('proceeds and calls fetch when DEV=true', async () => {
      vi.stubEnv('DEV', true);
      const fetchSpy = vi.fn<typeof fetch>(
        async () =>
          new Response('', {
            status: 204,
          }),
      );
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      await expect(
        devUpdateKeys({ authPubkey: 'X', identityPubkey: 'Y' }),
      ).resolves.toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const call = fetchSpy.mock.calls[0];
      expect(call?.[0]).toBe('/api/dev-auth/update-keys');
      expect(call?.[1]?.method).toBe('POST');
    });
  });
});
