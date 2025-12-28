/**
 * LocalAuth Client
 *
 * Implements authentication flows for LocalAuth mode.
 * In development, uses the simplified dev-auth endpoints.
 * In production LocalAuth, uses full Ed25519 challenge-response.
 */

import { fromBase64 } from './api';

// =============================================================================
// Types
// =============================================================================

/** Response from /api/dev-auth/login */
export interface DevLoginResponse {
  userId: string;
  username: string;
  userSalt: string | null;
  accountSalt: string | null;
}

// =============================================================================
// Development Authentication (Simplified)
// =============================================================================

/**
 * Perform development login.
 * Creates user if not exists, no password verification.
 * Only works when backend is in Development environment.
 *
 * @param username - Username to login as
 * @returns User and account salts
 */
export async function devLogin(username: string): Promise<{
  userId: string;
  userSalt: Uint8Array;
  accountSalt: Uint8Array;
}> {
  const response = await fetch('/api/dev-auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ username }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `Dev login failed: ${response.status}`);
  }

  const data: DevLoginResponse = await response.json();

  if (!data.userSalt || !data.accountSalt) {
    throw new Error('Missing salt data from server');
  }

  return {
    userId: data.userId,
    userSalt: fromBase64(data.userSalt),
    accountSalt: fromBase64(data.accountSalt),
  };
}

/**
 * Check if development auth is available.
 * Returns true if /api/dev-auth/login endpoint exists.
 */
export async function isDevAuthAvailable(): Promise<boolean> {
  try {
    const response = await fetch('/api/dev-auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '' }),
    });

    // 400 = endpoint exists but rejected empty username
    // 404 = endpoint doesn't exist
    return response.status !== 404;
  } catch {
    return false;
  }
}

/**
 * Check if the backend is in LocalAuth mode.
 * Does this by checking if /api/auth/init responds (vs 404 in ProxyAuth mode).
 */
export async function isLocalAuthMode(): Promise<boolean> {
  try {
    const response = await fetch('/api/auth/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '__check__' }),
    });

    // If we get a 400 (bad request for username format), auth endpoints exist
    // If we get 404, auth controller is not registered (ProxyAuth mode)
    return response.status !== 404;
  } catch {
    return false;
  }
}
