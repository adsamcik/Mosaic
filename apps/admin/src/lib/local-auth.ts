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
  timestamp?: number
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
  password: string
): Promise<{
  userId: string;
  userSalt: Uint8Array;
  accountSalt: Uint8Array;
  isNewUser: boolean;
}> {
  // Step 1: Get challenge from server
  const { challengeId, challenge, userSalt, timestamp } = await initAuth(username);
  
  const userSaltBytes = fromBase64(userSalt);
  
  // Step 2: Try to authenticate
  // Derive account salt from a hash of user salt (deterministic per user)
  const accountSaltBytes = await deriveAccountSalt(userSaltBytes);
  
  // Initialize crypto to derive identity key
  const cryptoClient = await getCryptoClient();
  await cryptoClient.init(password, userSaltBytes, accountSaltBytes);
  await cryptoClient.deriveIdentity();
  
  // Step 3: Sign challenge
  const challengeBytes = fromBase64(challenge);
  const signature = await cryptoClient.signAuthChallenge(challengeBytes, username, timestamp);
  const signatureBase64 = toBase64(signature);
  
  // Step 4: Verify with server
  try {
    const verifyResult = await verifyAuth(username, challengeId, signatureBase64, timestamp);
    
    // If server has different account salt, use that
    const serverAccountSalt = verifyResult.accountSalt 
      ? fromBase64(verifyResult.accountSalt) 
      : accountSaltBytes;
    
    return {
      userId: verifyResult.userId,
      userSalt: userSaltBytes,
      accountSalt: serverAccountSalt,
      isNewUser: false,
    };
  } catch (error) {
    // If verification failed, user might not exist - try to register
    if (error instanceof Error && error.message.includes('Invalid credentials')) {
      return registerNewUser(username, password, userSaltBytes);
    }
    throw error;
  }
}

/**
 * Register a new user and return their credentials.
 * After registration, performs login to establish session cookie.
 */
async function registerNewUser(
  username: string,
  password: string,
  userSalt: Uint8Array
): Promise<{
  userId: string;
  userSalt: Uint8Array;
  accountSalt: Uint8Array;
  isNewUser: boolean;
}> {
  // Generate account salt
  const accountSalt = await deriveAccountSalt(userSalt);
  
  // Initialize crypto
  const cryptoClient = await getCryptoClient();
  await cryptoClient.init(password, userSalt, accountSalt);
  await cryptoClient.deriveIdentity();
  
  // Get public keys
  const authPubkey = await cryptoClient.getAuthPublicKey();
  const identityPubkey = await cryptoClient.getIdentityPublicKey();
  
  if (!authPubkey || !identityPubkey) {
    throw new Error('Failed to derive identity keys');
  }
  
  // Register with server
  await registerUser({
    username,
    authPubkey: toBase64(authPubkey),
    identityPubkey: toBase64(identityPubkey),
    userSalt: toBase64(userSalt),
    accountSalt: toBase64(accountSalt),
  });
  
  // Now login to get session cookie (user exists now)
  const { challengeId, challenge, timestamp } = await initAuth(username);
  
  // Sign the new challenge
  const challengeBytes = fromBase64(challenge);
  const signature = await cryptoClient.signAuthChallenge(challengeBytes, username, timestamp);
  const signatureBase64 = toBase64(signature);
  
  // Verify and get session
  const verifyResult = await verifyAuth(username, challengeId, signatureBase64, timestamp);
  
  return {
    userId: verifyResult.userId,
    userSalt,
    accountSalt,
    isNewUser: true,
  };
}

/**
 * Derive account salt from user salt.
 * This provides a deterministic mapping from user salt to account salt.
 */
async function deriveAccountSalt(userSalt: Uint8Array): Promise<Uint8Array> {
  // Use Web Crypto to derive account salt
  const key = await crypto.subtle.importKey(
    'raw',
    userSalt,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode('mosaic_account_salt')
  );
  
  // Take first 16 bytes as account salt
  return new Uint8Array(signature).slice(0, 16);
}

// =============================================================================
// Mode Detection
// =============================================================================

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
