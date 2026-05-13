import { beforeEach, describe, expect, it, vi } from 'vitest';

const handleSessionExpired = vi.fn();

vi.mock('../session', () => ({
  session: { handleSessionExpired },
}));

describe('apiRequest 401 session expiry handling', () => {
  beforeEach(() => {
    handleSessionExpired.mockClear();
  });

  it('notifies session expiry and still throws ApiError with status 401', async () => {
    const { ApiError, getApi } = await import('../api');
    const problem = {
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Session expired',
    };
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(problem), {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'content-type': 'application/problem+json' },
      }),
    );

    let thrown: unknown;
    try {
      await getApi().getCurrentUser();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ApiError);
    expect(thrown).toMatchObject({
      status: 401,
      problem,
    });
    expect(handleSessionExpired).toHaveBeenCalledWith('cookie-expired');
  });
});
