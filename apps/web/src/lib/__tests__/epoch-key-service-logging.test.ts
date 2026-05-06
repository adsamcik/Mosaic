/**
 * Epoch Key Service Logging Hygiene Tests (L6)
 *
 * Verifies that the "Got epoch key from cache" debug log does not include
 * the 8-byte signing-public-key prefix. Public keys are non-secret, but
 * logging them aids correlation/fingerprinting if logs ever leak and
 * provides no diagnostic value beyond the structured fields already
 * present (albumId, epochId).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLog = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  startTimer: vi.fn(() => ({ end: vi.fn(), elapsed: vi.fn() })),
  child: vi.fn(),
  scope: 'EpochKeyService',
}));

vi.mock('../logger', () => ({
  createLogger: vi.fn(() => mockLog),
  logger: mockLog,
}));

// API and crypto-client are imported by epoch-key-service. They are not
// reached on the cache-hit path, but the module must still resolve them.
vi.mock('../api', () => ({
  getApi: vi.fn(),
  fromBase64: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
  toBase64: (arr: Uint8Array) => btoa(String.fromCharCode(...arr)),
}));

vi.mock('../crypto-client', () => ({
  getCryptoClient: vi.fn(),
}));

import { getCurrentOrFetchEpochKey } from '../epoch-key-service';
import { clearAllEpochKeys, setEpochKey } from '../epoch-key-store';

describe('Epoch Key Service - logging hygiene (L6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllEpochKeys();
  });

  afterEach(() => {
    clearAllEpochKeys();
  });

  it('does not include signPublicKeyPrefix in "Got epoch key from cache" log', async () => {
    const albumId = 'album-l6';
    const publicKey = new Uint8Array(32).fill(0xab);
    const secretKey = new Uint8Array(64).fill(0xcd);

    setEpochKey(albumId, {
      epochId: 7,
      epochHandleId: 'epoch-handle-7' as never,
      signKeypair: { publicKey, secretKey },
    });

    const bundle = await getCurrentOrFetchEpochKey(albumId);
    expect(bundle.epochId).toBe(7);

    const cacheHitCall = mockLog.debug.mock.calls.find(
      (call) => call[0] === 'Got epoch key from cache',
    );
    expect(cacheHitCall).toBeDefined();

    const context = cacheHitCall?.[1] as Record<string, unknown> | undefined;
    expect(context).toBeDefined();
    expect(context).toHaveProperty('albumId', albumId);
    expect(context).toHaveProperty('epochId', 7);
    expect(context).not.toHaveProperty('signPublicKeyPrefix');

    // Defense-in-depth: no key bytes (in any form) should leak into the log.
    const serialized = JSON.stringify(context);
    expect(serialized).not.toMatch(/abababababababab/i);
    expect(serialized).not.toMatch(/cdcdcdcd/i);
  });
});
