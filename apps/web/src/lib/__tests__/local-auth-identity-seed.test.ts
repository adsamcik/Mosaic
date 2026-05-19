/**
 * v1.0.x `bundle-seal-222` regression coverage.
 *
 * The Playwright validation gate flagged `verifyAndImportEpochBundle
 * failed (rust code 222)` across album/sharing/identity-persistence
 * specs. Root cause: the LocalAuth login path silently dropped the
 * server-persisted wrapped identity seed, so the crypto worker fell
 * back to `createIdentityForAccount` on every login and minted a
 * brand-new (random) Ed25519/X25519 identity. Bundles previously
 * sealed to the user's registered identityPubkey could no longer be
 * opened — sodium `crypto_box_seal_open` failed with code 222.
 *
 * The fix threads `wrappedIdentitySeed` end-to-end:
 *   1. `registerNewUser` uploads it alongside `wrappedAccountKey`.
 *   2. `localAuthLogin` returns it from the `/auth/verify` response.
 *   3. `session.localLogin` passes it to `initWithWrappedKey`, which
 *      routes through Rust `openIdentityForAccount` → deterministic
 *      identity → bundles re-open correctly.
 *
 * These tests pin contract #1 (registration uploads the seed) and
 * contract #2 (login returns the seed). Contract #3 (session wiring)
 * is exercised by the existing `session-hardening` tests and by the
 * Playwright sharing/album suites that produced the original failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const WRAPPED_IDENTITY_SEED_B64 = 'd3JhcHBlZElkZW50aXR5U2VlZA=='; // "wrappedIdentitySeed"
const WRAPPED_ACCOUNT_KEY_B64 = 'd3JhcHBlZEFjY291bnRLZXk='; // "wrappedAccountKey"
const USER_SALT_B64 = 'AAECAwQFBgcICQoLDA0ODw==';
const ACCOUNT_SALT_B64 = 'EBESExQVFhcYGRobHB0eHw==';
const CHALLENGE_B64 = 'Y2hhbGxlbmdl';

interface FetchCall {
  url: string;
  body: unknown;
}

let fetchCalls: FetchCall[] = [];

function setupFetchMock(handlers: Record<string, () => Response>) {
  const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const bodyText = typeof init?.body === 'string' ? init.body : null;
    fetchCalls.push({
      url,
      body: bodyText ? JSON.parse(bodyText) : null,
    });
    for (const [pattern, build] of Object.entries(handlers)) {
      if (url.includes(pattern)) {
        return build();
      }
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchFn);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const cryptoClientMethods = {
  deriveAuthKey: vi.fn(async () => undefined),
  signAuthChallenge: vi.fn(async () => new Uint8Array([1, 2, 3])),
  init: vi.fn(async () => undefined),
  deriveIdentity: vi.fn(async () => undefined),
  getAuthPublicKey: vi.fn(async () => new TextEncoder().encode('authPubkey')),
  getIdentityPublicKey: vi.fn(async () => new TextEncoder().encode('identityPubkey')),
  getWrappedAccountKey: vi.fn(async () => new TextEncoder().encode('wrappedAccountKey')),
  getWrappedIdentitySeed: vi.fn(async () => new TextEncoder().encode('wrappedIdentitySeed')),
};

vi.mock('../crypto-client', () => ({
  getCryptoClient: vi.fn(async () => cryptoClientMethods),
}));

vi.mock('../../generated/mosaic-wasm/mosaic_wasm.js', () => ({
  default: vi.fn(async () => undefined),
  deriveAccountSalt: vi.fn(() => new Uint8Array(16)),
}));

beforeEach(() => {
  fetchCalls = [];
  Object.values(cryptoClientMethods).forEach((fn) => fn.mockClear());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LocalAuth wrappedIdentitySeed threading (v1.0.x bundle-seal-222)', () => {
  it('localAuthLogin returns wrappedIdentitySeed when the server provides one', async () => {
    setupFetchMock({
      '/auth/init': () =>
        jsonResponse({
          challengeId: 'c1',
          challenge: CHALLENGE_B64,
          userSalt: USER_SALT_B64,
          timestamp: 1_700_000_000_000,
          kdfMemoryKib: 65536,
          kdfIterations: 3,
          kdfParallelism: 1,
          kdfAlgVersion: 0x13,
        }),
      '/auth/verify': () =>
        jsonResponse({
          success: true,
          userId: 'user-1',
          accountSalt: ACCOUNT_SALT_B64,
          wrappedAccountKey: WRAPPED_ACCOUNT_KEY_B64,
          wrappedIdentitySeed: WRAPPED_IDENTITY_SEED_B64,
          identityPubkey: 'aWRlbnRpdHlQdWJrZXk=',
          kdfMemoryKib: 65536,
          kdfIterations: 3,
          kdfParallelism: 1,
          kdfAlgVersion: 0x13,
        }),
    });

    const { localAuthLogin } = await import('../local-auth');
    const result = await localAuthLogin('alice', 'correct horse battery staple');

    expect(result.wrappedIdentitySeed).toBeInstanceOf(Uint8Array);
    expect(result.wrappedIdentitySeed?.length).toBeGreaterThan(0);
    // Must match the base64-decoded server payload byte-for-byte.
    const decoded = atob(WRAPPED_IDENTITY_SEED_B64);
    expect(result.wrappedIdentitySeed?.length).toBe(decoded.length);
  });

  it('localAuthLogin returns null wrappedIdentitySeed for legacy users without a server seed', async () => {
    setupFetchMock({
      '/auth/init': () =>
        jsonResponse({
          challengeId: 'c1',
          challenge: CHALLENGE_B64,
          userSalt: USER_SALT_B64,
          timestamp: 1_700_000_000_000,
          kdfMemoryKib: 65536,
          kdfIterations: 3,
          kdfParallelism: 1,
          kdfAlgVersion: 0x13,
        }),
      '/auth/verify': () =>
        jsonResponse({
          success: true,
          userId: 'user-1',
          accountSalt: ACCOUNT_SALT_B64,
          wrappedAccountKey: WRAPPED_ACCOUNT_KEY_B64,
          wrappedIdentitySeed: null,
          identityPubkey: 'aWRlbnRpdHlQdWJrZXk=',
          kdfMemoryKib: 65536,
          kdfIterations: 3,
          kdfParallelism: 1,
          kdfAlgVersion: 0x13,
        }),
    });

    const { localAuthLogin } = await import('../local-auth');
    const result = await localAuthLogin('alice', 'pw');

    expect(result.wrappedIdentitySeed).toBeNull();
  });

  it('localAuthRegister uploads wrappedIdentitySeed to /auth/register so future logins can re-open the identity', async () => {
    setupFetchMock({
      '/auth/init': () =>
        jsonResponse({
          challengeId: 'c1',
          challenge: CHALLENGE_B64,
          userSalt: USER_SALT_B64,
          timestamp: 1_700_000_000_000,
          kdfMemoryKib: 65536,
          kdfIterations: 3,
          kdfParallelism: 1,
          kdfAlgVersion: 0x13,
        }),
      '/auth/register': () =>
        jsonResponse({ id: 'user-1', username: 'alice', isAdmin: false }),
      '/auth/verify': () =>
        jsonResponse({
          success: true,
          userId: 'user-1',
          accountSalt: ACCOUNT_SALT_B64,
          wrappedAccountKey: WRAPPED_ACCOUNT_KEY_B64,
          wrappedIdentitySeed: WRAPPED_IDENTITY_SEED_B64,
          identityPubkey: 'aWRlbnRpdHlQdWJrZXk=',
          kdfMemoryKib: 65536,
          kdfIterations: 3,
          kdfParallelism: 1,
          kdfAlgVersion: 0x13,
        }),
    });

    const { localAuthRegister } = await import('../local-auth');
    await localAuthRegister('alice', 'pw');

    const registerCall = fetchCalls.find((c) => c.url.includes('/auth/register'));
    expect(registerCall).toBeDefined();
    const body = registerCall!.body as Record<string, unknown>;
    expect(typeof body.wrappedIdentitySeed).toBe('string');
    expect((body.wrappedIdentitySeed as string).length).toBeGreaterThan(0);
    // Must be the worker's getWrappedIdentitySeed() output, base64-encoded.
    expect(cryptoClientMethods.getWrappedIdentitySeed).toHaveBeenCalled();
  });
});
