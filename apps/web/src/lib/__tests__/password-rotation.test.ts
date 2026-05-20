/**
 * Password rotation client tests (validation-2026-05-19-auth-03).
 *
 * Verifies that the rewritten `rotatePassword` helper:
 *  - Posts a challenge-response envelope (challengeId, currentSignature,
 *    timestamp, newUserSalt, newAuthPubkey, newWrappedAccountKey)
 *  - NEVER sends `currentPassword` or `newPassword` in the request body
 *  - Re-wraps the L2 account key via the crypto worker rather than
 *    relying on the backend to perform a key derivation
 *  - Maps 401/403 responses to `PasswordRotationError(bad-current)`
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- Hoisted mocks --------------------------------------------------------

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  initAuth: vi.fn(),
  cryptoClient: {
    deriveAuthKey: vi.fn(),
    signAuthChallenge: vi.fn(),
    getAccountHandleId: vi.fn(),
    rewrapAccountKey: vi.fn(),
  },
  deriveAccountSalt: vi.fn(),
  initRustWasm: vi.fn(),
}));

vi.mock('../crypto-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../crypto-client')>();
  return {
    ...actual,
    getCryptoClient: vi.fn(async () => mocks.cryptoClient),
  };
});

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    getApi: vi.fn(() => ({
      getCurrentUser: mocks.getCurrentUser,
    }) as unknown as ReturnType<typeof actual.getApi>),
  };
});

vi.mock('../local-auth', async () => {
  const actual = await vi.importActual<typeof import('../local-auth')>(
    '../local-auth',
  );
  return {
    ...actual,
    initAuth: mocks.initAuth,
  };
});

vi.mock('../../generated/mosaic-wasm/mosaic_wasm.js', () => ({
  default: mocks.initRustWasm,
  deriveAccountSalt: mocks.deriveAccountSalt,
}));

// ---- Helpers --------------------------------------------------------------

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function bytes(...vals: number[]): Uint8Array {
  return new Uint8Array(vals);
}

function fillBytes(length: number, byte = 0x42): Uint8Array {
  const u = new Uint8Array(length);
  u.fill(byte);
  return u;
}

// ---- Test setup -----------------------------------------------------------

describe('rotatePassword (validation-2026-05-19-auth-03)', () => {
  beforeEach(() => {
    mocks.getCurrentUser.mockReset();
    mocks.initAuth.mockReset();
    mocks.cryptoClient.deriveAuthKey.mockReset();
    mocks.cryptoClient.signAuthChallenge.mockReset();
    mocks.cryptoClient.getAccountHandleId.mockReset();
    mocks.cryptoClient.rewrapAccountKey.mockReset();
    mocks.deriveAccountSalt.mockReset();
    mocks.initRustWasm.mockReset();
    mocks.initRustWasm.mockResolvedValue(undefined);

    // Defaults
    mocks.getCurrentUser.mockResolvedValue({
      id: 'user-1',
      authSub: 'alice',
      kdfMemoryKib: 65536,
      kdfIterations: 3,
      kdfParallelism: 1,
      kdfAlgVersion: 0x13,
      createdAt: '2025-01-01T00:00:00Z',
    });
    mocks.initAuth.mockResolvedValue({
      challengeId: '11111111-2222-3333-4444-555555555555',
      challenge: b64(fillBytes(32, 0x11)),
      userSalt: b64(fillBytes(16, 0x22)),
      timestamp: 1700000000,
      kdfMemoryKib: 65536,
      kdfIterations: 3,
      kdfParallelism: 1,
      kdfAlgVersion: 0x13,
    });
    mocks.cryptoClient.deriveAuthKey.mockResolvedValue(fillBytes(32, 0xaa));
    mocks.cryptoClient.signAuthChallenge.mockResolvedValue(fillBytes(64, 0xbb));
    mocks.cryptoClient.getAccountHandleId.mockResolvedValue(7n);
    mocks.cryptoClient.rewrapAccountKey.mockResolvedValue({
      wrappedAccountKey: fillBytes(72, 0xcc),
    });
    mocks.deriveAccountSalt.mockReturnValue(fillBytes(16, 0xdd));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts a challenge-response envelope and never sends plaintext passwords', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({ saltVersion: 2, revokedSessionCount: 3 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { rotatePassword } = await import('../password-rotation');
    const result = await rotatePassword({
      currentPassword: 'CurrentPassword12!',
      newPassword: 'BrandNewPassword99!',
    });

    expect(result).toEqual({ saltVersion: 2, revokedSessions: 3 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init?.body));

    // Required envelope fields are present and base64-encoded.
    expect(body.challengeId).toBe('11111111-2222-3333-4444-555555555555');
    expect(typeof body.currentSignature).toBe('string');
    expect(body.timestamp).toBe(1700000000);
    expect(typeof body.newUserSalt).toBe('string');
    expect(typeof body.newAccountSalt).toBe('string');
    expect(typeof body.newAuthPubkey).toBe('string');
    expect(typeof body.newWrappedAccountKey).toBe('string');

    // Salt and pubkey decode to the right lengths.
    expect(atob(body.newUserSalt).length).toBe(16);
    // v1.0.x validation-final-gate-auth-f: newAccountSalt MUST accompany
    // newUserSalt; the server persists it so the next login derives the
    // same L1 that the client used to rewrap L2.
    expect(atob(body.newAccountSalt).length).toBe(16);
    expect(atob(body.newAuthPubkey).length).toBe(32);
    expect(atob(body.currentSignature).length).toBe(64);

    // ZK invariant: plaintext passwords MUST NOT appear in the body.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('CurrentPassword12!');
    expect(raw).not.toContain('BrandNewPassword99!');
    expect(body).not.toHaveProperty('currentPassword');
    expect(body).not.toHaveProperty('newPassword');

    // Crypto worker was driven through the full handshake.
    expect(mocks.cryptoClient.deriveAuthKey).toHaveBeenCalledTimes(2);
    expect(mocks.cryptoClient.signAuthChallenge).toHaveBeenCalledTimes(1);
    expect(mocks.cryptoClient.getAccountHandleId).toHaveBeenCalledTimes(1);
    expect(mocks.cryptoClient.rewrapAccountKey).toHaveBeenCalledTimes(1);
    const rewrapArgs = mocks.cryptoClient.rewrapAccountKey.mock.calls[0]![0];
    expect(rewrapArgs.accountHandleId).toBe(7n);
    expect(rewrapArgs.newPassword).toBe('BrandNewPassword99!');
    expect(rewrapArgs.newUserSalt).toBeInstanceOf(Uint8Array);
    expect(rewrapArgs.newUserSalt.length).toBe(16);
    expect(rewrapArgs.newAccountSalt).toBeInstanceOf(Uint8Array);
    expect(rewrapArgs.kdf).toEqual({
      memoryKib: 65536,
      iterations: 3,
      parallelism: 1,
    });
  });

  it('maps a 401 response to PasswordRotationError(bad-current)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        new Response(
          JSON.stringify({ title: 'Unauthorized', detail: 'bad sig', status: 401 }),
          { status: 401, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    const { rotatePassword, PasswordRotationError } = await import(
      '../password-rotation'
    );
    const promise = rotatePassword({
      currentPassword: 'wrong-password',
      newPassword: 'NewPassword12345!',
    });
    await expect(promise).rejects.toBeInstanceOf(PasswordRotationError);
    await expect(promise).rejects.toMatchObject({
      reason: 'bad-current',
      status: 401,
    });
  });

  it('rejects short passwords locally without calling the worker or backend', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const { rotatePassword, PasswordRotationError } = await import(
      '../password-rotation'
    );
    await expect(
      rotatePassword({ currentPassword: 'whatever', newPassword: 'short' }),
    ).rejects.toMatchObject({
      name: 'PasswordRotationError',
      reason: 'too-short',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.cryptoClient.deriveAuthKey).not.toHaveBeenCalled();
    void PasswordRotationError;
  });

  it('throws generic error when no account handle is open', async () => {
    mocks.cryptoClient.getAccountHandleId.mockResolvedValueOnce(null);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>());
    const { rotatePassword } = await import('../password-rotation');
    await expect(
      rotatePassword({
        currentPassword: 'CurrentPassword12!',
        newPassword: 'BrandNewPassword99!',
      }),
    ).rejects.toMatchObject({
      name: 'PasswordRotationError',
      reason: 'generic',
    });
  });
});

describe('estimatePasswordStrength', () => {
  it('classifies password strengths', async () => {
    const { estimatePasswordStrength } = await import('../password-rotation');
    expect(estimatePasswordStrength('short')).toBe('weak');
    expect(estimatePasswordStrength('alllowercase')).toBe('weak');
    expect(estimatePasswordStrength('Mixedcase123')).toBe('ok');
    expect(estimatePasswordStrength('LongMixedCase123!')).toBe('strong');
  });
});

// Suppress unused import warning for byte helper kept for future tests.
void bytes;
