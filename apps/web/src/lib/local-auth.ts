/**
 * LocalAuth Client
 *
 * Implements Ed25519 challenge-response authentication for LocalAuth mode.
 * This is used when the backend is configured for standalone authentication
 * (not behind a trusted reverse proxy).
 */

import { fromBase64, toBase64 } from './api';
import { getCryptoClient } from './crypto-client';

// =============================================================================
// Types
// =============================================================================

/** Response from /api/auth/init */
export interface AuthInitResponse {
  challengeId: string;
  challenge: string; // base64
  userSalt: string; // base64
  timestamp: number;
}

/** Response from /api/auth/verify */
export interface AuthVerifyResponse {
  success: boolean;
  userId: string;
  accountSalt: string | null;
  wrappedAccountKey: string | null;
  wrappedIdentitySeed: string | null;
  identityPubkey: string | null;
}

/** Response from /api/auth/register */
export interface AuthRegisterResponse {
  id: string;
  username: string;
  isAdmin: boolean;
}

// =============================================================================
// LocalAuth API Client
// =============================================================================

/**
 * Initialize authentication - get challenge and user salt.
 * @param username - Username to authenticate
 * @returns Challenge data
 */
export async function initAuth(username: string): Promise<AuthInitResponse> {
  const response = await fetch('/api/auth/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ username }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `Auth init failed: ${response.status}`);
  }

  return response.json();
}

/**
 * Verify challenge signature and complete login.
 * @param username - Username
 * @param challengeId - Challenge ID from initAuth
 * @param signature - Ed25519 signature of challenge (base64)
 * @param timestamp - Optional timestamp for replay protection
 * @returns Verification response with wrapped keys
 */
export async function verifyAuth(
  username: string,
  challengeId: string,
  signature: string,
  timestamp?: number,
): Promise<AuthVerifyResponse> {
  const response = await fetch('/api/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      username,
      challengeId,
      signature,
      timestamp,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `Auth verify failed: ${response.status}`);
  }

  return response.json();
}

/**
 * Register a new user with LocalAuth.
 * @param params - Registration parameters
 * @returns Registration response
 */
export async function registerUser(params: {
  username: string;
  authPubkey: string; // base64
  identityPubkey: string; // base64
  userSalt: string; // base64
  accountSalt: string; // base64
  wrappedAccountKey?: string; // base64
  wrappedIdentitySeed?: string; // base64
}): Promise<AuthRegisterResponse> {
  const response = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(params),
  });

  if (response.status === 409) {
    throw new Error('Username already exists');
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `Registration failed: ${response.status}`);
  }

  return response.json();
}

// =============================================================================
// High-Level Authentication Flow
// =============================================================================

/**
 * Perform LocalAuth login with Ed25519 challenge-response.
 *
 * Flow:
 * 1. Get challenge from server (with user salt)
 * 2. Initialize crypto with password + salt
 * 3. Sign challenge with identity key
 * 4. Verify signature on server, get session
 *
 * @param username - Username to login as
 * @param password - User's password
 * @returns User salt and account salt for crypto initialization
 */
export async function localAuthLogin(
  username: string,
  password: string,
): Promise<{
  userId: string;
  userSalt: Uint8Array;
  accountSalt: Uint8Array;
  isNewUser: boolean;
  wrappedAccountKey: Uint8Array | null;
}> {
  // Step 1: Get challenge from server
  const { challengeId, challenge, userSalt, timestamp } =
    await initAuth(username);

  const userSaltBytes = fromBase64(userSalt);

  // Step 2: Derive the deterministic auth keypair from password + userSalt
  // This is separate from the random account key - it's derived directly from password+salt
  // so we can authenticate before getting the wrapped account key from the server
  const cryptoClient = await getCryptoClient();
  await cryptoClient.deriveAuthKey(password, userSaltBytes);

  // Step 3: Sign challenge with the derived auth key
  const challengeBytes = fromBase64(challenge);
  const signature = await cryptoClient.signAuthChallenge(
    challengeBytes,
    username,
    timestamp,
  );
  const signatureBase64 = toBase64(signature);

  // Derive account salt for later use
  const accountSaltBytes = await deriveAccountSalt(userSaltBytes);

  // Step 4: Verify with server
  try {
    const verifyResult = await verifyAuth(
      username,
      challengeId,
      signatureBase64,
      timestamp,
    );

    // If server has a wrapped account key, we need to re-init with it
    // to get the correct identity for epoch key operations
    const serverAccountSalt = verifyResult.accountSalt
      ? fromBase64(verifyResult.accountSalt)
      : accountSaltBytes;

    // Return wrapped key so caller can re-init if needed
    const wrappedAccountKey = verifyResult.wrappedAccountKey
      ? fromBase64(verifyResult.wrappedAccountKey)
      : null;

    return {
      userId: verifyResult.userId,
      userSalt: userSaltBytes,
      accountSalt: serverAccountSalt,
      wrappedAccountKey,
      isNewUser: false,
    };
  } catch (error) {
    // Pass through authentication errors - user must explicitly register if they don't have an account.
    // We intentionally do NOT auto-register on "Invalid credentials" because:
    // 1. The backend returns the same error for "user doesn't exist" and "wrong password" (anti-enumeration)
    // 2. Auto-registering on wrong password would leak that the username exists
    // 3. Users should explicitly choose "Create Account" to register
    throw error;
  }
}

/**
 * Register a new user with LocalAuth.
 * This is the explicit registration flow - user must choose to register.
 *
 * @param username - Username to register
 * @param password - User's password
 * @returns User credentials after successful registration and login
 */
export async function localAuthRegister(
  username: string,
  password: string,
): Promise<{
  userId: string;
  userSalt: Uint8Array;
  accountSalt: Uint8Array;
  isNewUser: boolean;
  wrappedAccountKey: Uint8Array | null;
}> {
  // Step 1: Get a challenge to derive the user salt
  // (server returns deterministic fake salt for non-existent users)
  const { userSalt } = await initAuth(username);
  const userSaltBytes = fromBase64(userSalt);

  // Step 2: Register the new user
  return await registerNewUser(username, password, userSaltBytes);
}

/**
 * Internal: Register a new user and return their credentials.
 * After registration, performs login to establish session cookie.
 * This is called by localAuthRegister after user explicitly chooses to register.
 */
async function registerNewUser(
  username: string,
  password: string,
  userSalt: Uint8Array,
): Promise<{
  userId: string;
  userSalt: Uint8Array;
  accountSalt: Uint8Array;
  isNewUser: boolean;
  wrappedAccountKey: Uint8Array | null;
}> {
  // Generate account salt
  const accountSalt = await deriveAccountSalt(userSalt);

  const cryptoClient = await getCryptoClient();

  // Step 1: Derive the deterministic auth keypair from password + userSalt
  // This is used for challenge-response authentication
  await cryptoClient.deriveAuthKey(password, userSalt);

  // Get the auth public key (deterministically derived from password+salt)
  const authPubkey = await cryptoClient.getAuthPublicKey();
  if (!authPubkey) {
    throw new Error('Failed to derive auth key');
  }

  // Step 2: Initialize crypto with random account key for identity operations
  await cryptoClient.init(password, userSalt, accountSalt);
  await cryptoClient.deriveIdentity();

  // Get identity public key (derived from random account key, used for epoch key encryption)
  const identityPubkey = await cryptoClient.getIdentityPublicKey();
  if (!identityPubkey) {
    throw new Error('Failed to derive identity key');
  }

  // Get wrapped account key for server storage (CRITICAL for identity persistence)
  const wrappedAccountKey = await cryptoClient.getWrappedAccountKey();
  if (!wrappedAccountKey) {
    throw new Error('Failed to get wrapped account key');
  }

  // Register with server (include wrapped account key for future logins)
  await registerUser({
    username,
    authPubkey: toBase64(authPubkey),
    identityPubkey: toBase64(identityPubkey),
    userSalt: toBase64(userSalt),
    accountSalt: toBase64(accountSalt),
    wrappedAccountKey: toBase64(wrappedAccountKey),
  });

  // Now login to get session cookie (user exists now)
  const { challengeId, challenge, timestamp } = await initAuth(username);

  // Sign the new challenge (authKeypair still available from deriveAuthKey above)
  const challengeBytes = fromBase64(challenge);
  const signature = await cryptoClient.signAuthChallenge(
    challengeBytes,
    username,
    timestamp,
  );
  const signatureBase64 = toBase64(signature);

  // Verify and get session
  const verifyResult = await verifyAuth(
    username,
    challengeId,
    signatureBase64,
    timestamp,
  );

  return {
    userId: verifyResult.userId,
    userSalt,
    accountSalt,
    isNewUser: true,
    wrappedAccountKey: null, // New user already has correct keys loaded
  };
}

/**
 * Derive account salt from user salt.
 * This provides a deterministic mapping from user salt to account salt.
 */
async function deriveAccountSalt(userSalt: Uint8Array): Promise<Uint8Array> {
  // Use Web Crypto to derive account salt
  // Create a copy to avoid SharedArrayBuffer issues
  const saltBuffer = new Uint8Array(userSalt).buffer;
  const key = await crypto.subtle.importKey(
    'raw',
    saltBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode('mosaic_account_salt'),
  );

  // Take first 16 bytes as account salt
  return new Uint8Array(signature).slice(0, 16);
}

// =============================================================================
// Mode Detection
// =============================================================================

/**
 * Check if the backend is in LocalAuth mode.
 * Does this by checking /api/auth/config endpoint.
 */
export async function isLocalAuthMode(): Promise<boolean> {
  const status = await checkServerStatus();
  return status.isLocalAuth;
}

export interface ServerStatus {
  isOnline: boolean;
  isLocalAuth: boolean;
  isProxyAuth: boolean;
  statusCode?: number;
  error?: string;
}

/**
 * Check server connectivity and authentication mode.
 * Uses /api/auth/config endpoint which returns both auth mode flags.
 */
export async function checkServerStatus(): Promise<ServerStatus> {
  try {
    // First try the new /api/auth/config endpoint
    const configResponse = await fetch('/api/auth/config');

    if (configResponse.ok) {
      const config = await configResponse.json();
      return {
        isOnline: true,
        isLocalAuth: config.localAuthEnabled === true,
        isProxyAuth: config.proxyAuthEnabled === true,
        statusCode: configResponse.status,
      };
    }

    // Fallback for older backends: probe /api/auth/init
    const response = await fetch('/api/auth/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '__check__' }),
    });

    // 404 means the endpoint doesn't exist -> ProxyAuth mode (but server is online)
    if (response.status === 404) {
      return {
        isOnline: true,
        isLocalAuth: false,
        isProxyAuth: true,
        statusCode: 404,
      };
    }

    // 5xx means server error
    if (response.status >= 500) {
      let errorDetail = `Server error: ${response.status}`;
      try {
        const text = await response.text();
        if (text) {
          try {
            const json = JSON.parse(text);
            errorDetail = json.error || json.message || errorDetail;
          } catch {
            errorDetail = text.slice(0, 100);
          }
        }
      } catch {
        // Ignore body read errors
      }

      return {
        isOnline: true,
        isLocalAuth: true,
        isProxyAuth: false,
        statusCode: response.status,
        error: errorDetail,
      };
    }

    // 200-499 (except 404) usually means the endpoint exists -> LocalAuth mode
    return {
      isOnline: true,
      isLocalAuth: true,
      isProxyAuth: false,
      statusCode: response.status,
    };
  } catch (err) {
    // Network error (fetch failed completely)
    return {
      isOnline: false,
      isLocalAuth: false,
      isProxyAuth: false,
      error: err instanceof Error ? err.message : 'Connection failed',
    };
  }
}

// =============================================================================
// Development Authentication (Dev Mode Only)
// =============================================================================

/** Response from /api/dev-auth/login */
export interface DevLoginResponse {
  userId: string;
  username: string;
  userSalt: string; // base64
  accountSalt: string; // base64
  isNewUser: boolean;
}

/**
 * Quick login for development mode.
 * Creates user and session without cryptographic verification.
 * Only works when backend is in Development + LocalAuth mode.
 */
export async function devLogin(username: string): Promise<DevLoginResponse> {
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

  return response.json();
}

/**
 * Update crypto keys after client-side initialization (dev mode).
 */
export async function devUpdateKeys(keys: {
  authPubkey?: string;
  identityPubkey?: string;
  wrappedAccountKey?: string;
  wrappedIdentitySeed?: string;
}): Promise<void> {
  const response = await fetch('/api/dev-auth/update-keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(keys),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `Dev key update failed: ${response.status}`);
  }
}
