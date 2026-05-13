import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseProblemDetails, registerUser } from '../local-auth';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('local-auth ProblemDetails parsing', () => {
  it('returns ProblemDetails detail when present', async () => {
    const response = new Response(
      JSON.stringify({
        title: 'Unauthorized',
        detail: 'Authentication required',
        status: 401,
        correlationId: 'correlation-id',
      }),
      {
        status: 401,
        headers: { 'content-type': 'application/problem+json' },
      },
    );

    await expect(parseProblemDetails(response)).resolves.toBe(
      'Authentication required',
    );
  });

  it('returns ProblemDetails title when detail is absent', async () => {
    const response = new Response(
      JSON.stringify({
        title: 'Admin required',
        status: 403,
      }),
      {
        status: 403,
        headers: { 'content-type': 'application/problem+json' },
      },
    );

    await expect(parseProblemDetails(response)).resolves.toBe('Admin required');
  });

  it('returns legacy error JSON when present', async () => {
    const response = new Response(
      JSON.stringify({
        error: 'Legacy auth failure',
      }),
      {
        status: 400,
        headers: { 'content-type': 'application/json' },
      },
    );

    await expect(parseProblemDetails(response)).resolves.toBe(
      'Legacy auth failure',
    );
  });

  it('returns HTTP status fallback for empty non-JSON failures', async () => {
    const response = new Response('', {
      status: 500,
      headers: { 'content-type': 'text/plain' },
    });

    await expect(parseProblemDetails(response)).resolves.toBe('HTTP 500');
  });

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
      }),
    ).rejects.toThrow(/Authentication required/);
  });
});
