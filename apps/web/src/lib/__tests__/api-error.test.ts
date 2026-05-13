import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from '../api';
import { toSafeErrorMessage } from '../error-messages';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ApiError ProblemDetails handling', () => {
  it('parses application/problem+json detail and correlationId', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            type: 'https://mosaic.local/problems/conflict',
            title: 'Conflict',
            status: 409,
            detail:
              'The resource was modified by another request. Please reload and try again.',
            correlationId: 'problem-correlation-id',
          }),
          {
            status: 409,
            statusText: 'Conflict',
            headers: {
              'content-type': 'application/problem+json',
              'x-correlation-id': 'header-correlation-id',
            },
          },
        ),
      ),
    );

    await expect(createApiClient().getHealth()).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      message:
        'The resource was modified by another request. Please reload and try again.',
      correlationId: 'problem-correlation-id',
      problem: {
        detail:
          'The resource was modified by another request. Please reload and try again.',
        correlationId: 'problem-correlation-id',
      },
    });
  });

  it('preserves header correlationId when ProblemDetails omits the extension', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            title: 'Too many requests',
            status: 429,
            detail: 'Too many requests. Please try again later.',
          }),
          {
            status: 429,
            statusText: 'Too Many Requests',
            headers: {
              'content-type': 'application/problem+json',
              'x-correlation-id': 'header-only-correlation-id',
            },
          },
        ),
      ),
    );

    try {
      await createApiClient().getHealth();
      throw new Error('Expected API request to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).correlationId).toBe('header-only-correlation-id');
    }
  });

  it('toSafeErrorMessage prefers ProblemDetails detail over generic status mapping', () => {
    const error = new ApiError(
      409,
      'Conflict',
      undefined,
      {
        title: 'Conflict',
        status: 409,
        detail:
          'The resource was modified by another request. Please reload and try again.',
        correlationId: 'safe-message-correlation-id',
      },
      'safe-message-correlation-id',
    );

    expect(toSafeErrorMessage(error)).toBe(
      'The resource was modified by another request. Please reload and try again.',
    );
  });
});
