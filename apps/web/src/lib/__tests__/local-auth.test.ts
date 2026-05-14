import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerUser } from '../local-auth';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('local-auth API errors', () => {
  it('registerUser surfaces 401 ProblemDetails detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              title: 'Unauthorized',
              detail: 'Authentication required',
              status: 401,
            }),
            {
              status: 401,
              headers: { 'content-type': 'application/problem+json' },
            },
          ),
      ),
    );

    await expect(
      registerUser({
        username: 'alice',
        authPubkey: 'auth-pubkey',
        identityPubkey: 'identity-pubkey',
        userSalt: 'user-salt',
        accountSalt: 'account-salt',
        kdfMemoryKib: 65536,
        kdfIterations: 3,
        kdfParallelism: 1,
        kdfAlgVersion: 0x13,
      }),
    ).rejects.toThrow(/Authentication required/);
  });
});
