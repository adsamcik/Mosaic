/**
 * Cross-scope BroadcastChannel filter — `useDownloadManager` MUST drop
 * messages whose scopeKey is not visible to the current viewer so that:
 *   - a visitor tab is never woken up by an authenticated tab's events,
 *   - an authenticated tab is never woken up by a different visitor link,
 *   - authenticated viewers still see legacy:* events (v1 → v2 migration).
 *
 * This complements the receive-side filter in DownloadTray.tsx by stopping
 * cross-scope refreshes earlier (saving an OPFS reload per event).
 */
import { describe, expect, it } from 'vitest';

// Replicates `isMessageVisibleInScope` from useDownloadManager.ts.
// Keep in sync with that file.
function isVisible(messageScope: string, currentScope: string | null): boolean {
  if (currentScope === null) return false;
  if (messageScope === currentScope) return true;
  if (messageScope.startsWith('legacy:') && currentScope.startsWith('auth:')) return true;
  return false;
}

const AUTH_A = 'auth:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const AUTH_B = 'auth:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const VISITOR_1 = 'visitor:11111111111111111111111111111111';
const VISITOR_2 = 'visitor:22222222222222222222222222222222';
const LEGACY = 'legacy:cccccccccccccccccccccccccccccccc';

describe('useDownloadManager broadcast scope filter', () => {
  it('null scope drops everything', () => {
    expect(isVisible(AUTH_A, null)).toBe(false);
    expect(isVisible(VISITOR_1, null)).toBe(false);
    expect(isVisible(LEGACY, null)).toBe(false);
  });

  it('visitor never sees auth events', () => {
    expect(isVisible(AUTH_A, VISITOR_1)).toBe(false);
  });

  it('auth never sees visitor events', () => {
    expect(isVisible(VISITOR_1, AUTH_A)).toBe(false);
  });

  it('different visitor scopes are isolated', () => {
    expect(isVisible(VISITOR_1, VISITOR_2)).toBe(false);
    expect(isVisible(VISITOR_2, VISITOR_1)).toBe(false);
  });

  it('different auth identities are isolated', () => {
    expect(isVisible(AUTH_A, AUTH_B)).toBe(false);
  });

  it('exact match passes', () => {
    expect(isVisible(AUTH_A, AUTH_A)).toBe(true);
    expect(isVisible(VISITOR_1, VISITOR_1)).toBe(true);
  });

  it('auth viewers see legacy:* (v1 migration)', () => {
    expect(isVisible(LEGACY, AUTH_A)).toBe(true);
  });

  it('visitors NEVER see legacy:* (no fallback)', () => {
    expect(isVisible(LEGACY, VISITOR_1)).toBe(false);
  });
});