/**
 * LocalAuth Client
 *
 * Implements Ed25519 challenge-response authentication for LocalAuth mode.
 * This is used when the backend is configured for standalone authentication
 * (not behind a trusted reverse proxy).
 */

import { ApiError, apiRequest, fromBase64, toBase64 } from './api';
import { getCryptoClient } from './crypto-client';
import {
  parseServerArgon2Params,
  selectRegistrationArgon2Params,
  type Argon2Params,
} from '@mosaic/crypto';
import initRustWasm, {
  deriveAccountSalt,
} from '../generated/mosaic-wasm/mosaic_wasm.js';
import type { WorkerKdfParams } from '../workers/types';

export { normalizePasswordForKdf } from './local-auth-normalization';

// =============================================================================
// Types
// =============================================================================

/** Response from /api/v1/auth/init */
export interface AuthInitResponse {
  challengeId: string;
  challenge: string; // base64
  userSalt: string; // base64
  timestamp: number;
  kdfMemoryKib: number;
  kdfIterations: number;
  kdfParallelism: number;
  kdfAlgVersion: number;
}

/** Response from /api/v1/auth/verify */
export interface AuthVerifyResponse {
  success: boolean;
  userId: string;
  accountSalt: string | null;
  wrappedAccountKey: string | null;
  wrappedIdentitySeed: string | null;
  identityPubkey: string | null;
  kdfMemoryKib: number;
  kdfIterations: number;
  kdfParallelism: number;
  kdfAlgVersion: number;
}

/** Response from /api/v1/auth/register */
export interface AuthRegisterResponse {
  id: string;
  username: string;
  isAdmin: boolean;
}

interface ErrorResponseBody {
  detail?: unknown;
  title?: unknown;
  error?: unknown;
}

function isErrorResponseBody(value: unknown): value is ErrorResponseBody {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}

export async function parseProblemDetails(response: Response): Promise<string> {
  const fallback = `HTTP ${response.status}`;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('json')) {
    return fallback;
  }

  try {
    const body: unknown = await response.json();
    if (!isErrorResponseBody(body)) {
      return fallback;
    }

    return firstNonEmptyString(body.detail, body.title, body.error) ?? fallback;
  } catch {
    return fallback;
  }
}

function toWorkerKdfParams(params: Argon2Params): WorkerKdfParams {
  return {
    memoryKib: params.memory,
    iterations: params.iterations,
    parallelism: params.parallelism,
  };
}

function parseAuthKdfProfile(payload: {
  kdfMemoryKib?: number;
  kdfIterations?: number;
  kdfParallelism?: number;
  kdfAlgVersion?: number;
}): Argon2Params {
  if (
    payload.kdfMemoryKib === undefined ||
    payload.kdfIterations === undefined ||
    payload.kdfParallelism === undefined ||
    payload.kdfAlgVersion === undefined
  ) {
    return selectRegistrationArgon2Params();
  }

  return parseServerArgon2Params({
    memoryKib: payload.kdfMemoryKib,
    iterations: payload.kdfIterations,
    parallelism: payload.kdfParallelism,
    algVersion: payload.kdfAlgVersion,
  });
}

function apiErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return firstNonEmptyString(
      error.problem?.detail,
      error.problem?.title,
      error.problem?.error,
      error.message,
    ) ?? `HTTP ${error.status}`;
  }

  return error instanceof Error ? error.message : 'Request failed';
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
  return apiRequest<AuthInitResponse>('/auth/init', {
    method: 'POST',
    body: { username },
  });
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
  try {
    return await apiRequest<AuthVerifyResponse>('/auth/verify', {
      method: 'POST',
      body: {
        username,
        challengeId,
        signature,
        timestamp,
      },
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      throw new Error('Invalid credentials');
    }
    throw new Error(apiErrorMessage(error));
  }
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
  kdfMemoryKib: number;
  kdfIterations: number;
  kdfParallelism: number;
  kdfAlgVersion: number;
}): Promise<AuthRegisterResponse> {
  try {
    return await apiRequest<AuthRegisterResponse>('/auth/register', {
      method: 'POST',
      body: params,
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      throw new Error('Username already exists');
    }
    throw new Error(apiErrorMessage(error));
  }
}

// =============================================================================
// High-Level Authentication Flow
// =============================================================================

let rustWasmInitPromise: Promise<unknown> | null = null;

async function ensureLocalAuthRustWasmInitialized(): Promise<void> {
  rustWasmInitPromise ??= initRustWasm();
  await rustWasmInitPromise;
}

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
  kdfParams: Argon2Params;
}> {
  // Step 1: Get challenge from server
  const initResponse = await initAuth(username);
  const { challengeId, challenge, userSalt, timestamp } = initResponse;

  const userSaltBytes = fromBase64(userSalt);
  const kdfParams = parseAuthKdfProfile(initResponse);

  // Step 2: Derive the deterministic auth keypair from password + userSalt
  // This is separate from the random account key - it's derived directly from password+salt
  // so we can authenticate before getting the wrapped account key from the server
  const cryptoClient = await getCryptoClient();
  await cryptoClient.deriveAuthKey(password, userSaltBytes, toWorkerKdfParams(kdfParams));

  // Step 3: Sign challenge with the derived auth key
  const challengeBytes = fromBase64(challenge);
  const signature = await cryptoClient.signAuthChallenge(
    challengeBytes,
    username,
    timestamp,
  );
  const signatureBase64 = toBase64(signature);

  // Derive account salt for later use
  await ensureLocalAuthRustWasmInitialized();
  const accountSaltBytes = await deriveAccountSalt(userSaltBytes);

  // Step 4: Verify with server.
  //
  // We intentionally let any verifyAuth error propagate. Auto-registering on
  // an authentication failure is forbidden because:
  //   1. The backend returns the same error for "user doesn't exist" and
  //      "wrong password" (anti-enumeration).
  //   2. Auto-registering on wrong password would leak that the username
  //      exists.
  //   3. Users must explicitly choose "Create Account" to register.
  const verifyResult = await verifyAuth(
    username,
    challengeId,
    signatureBase64,
    timestamp,
  );
  const verifiedKdfParams = parseAuthKdfProfile(verifyResult);

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
    kdfParams: verifiedKdfParams,
    isNewUser: false,
  };
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
  kdfParams: Argon2Params;
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
  kdfParams: Argon2Params;
}> {
  // Generate account salt
  await ensureLocalAuthRustWasmInitialized();
  const accountSalt = await deriveAccountSalt(userSalt);

  const cryptoClient = await getCryptoClient();
  const kdfParams = selectRegistrationArgon2Params();
  const workerKdfParams = toWorkerKdfParams(kdfParams);

  // Step 1: Derive the deterministic auth keypair from password + userSalt
  // This is used for challenge-response authentication
  await cryptoClient.deriveAuthKey(password, userSalt, workerKdfParams);

  // Get the auth public key (deterministically derived from password+salt)
  const authPubkey = await cryptoClient.getAuthPublicKey();
  if (!authPubkey) {
    throw new Error('Failed to derive auth key');
  }

  // Step 2: Initialize crypto with random account key for identity operations
  await cryptoClient.init(password, userSalt, accountSalt, workerKdfParams);
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
    kdfMemoryKib: kdfParams.memory,
    kdfIterations: kdfParams.iterations,
    kdfParallelism: kdfParams.parallelism,
    kdfAlgVersion: kdfParams.algVersion,
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
    kdfParams: parseAuthKdfProfile(verifyResult),
  };
}

// =============================================================================
// Mode Detection
// =============================================================================

/**
 * Check if the backend is in LocalAuth mode.
 * Does this by checking /api/v1/auth/config endpoint.
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
 * Uses /api/v1/auth/config endpoint which returns both auth mode flags.
 */
export async function checkServerStatus(): Promise<ServerStatus> {
  try {
    const config = await apiRequest<{ localAuthEnabled?: boolean; proxyAuthEnabled?: boolean }>(
      '/auth/config',
    );
    return {
      isOnline: true,
      isLocalAuth: config.localAuthEnabled === true,
      isProxyAuth: config.proxyAuthEnabled === true,
      statusCode: 200,
    };
  } catch {
    // Fall back to probing /auth/init for older backends that predate /auth/config.
  }

  try {
    await apiRequest<AuthInitResponse>('/auth/init', {
      method: 'POST',
      body: { username: '__check__' },
    });

    return {
      isOnline: true,
      isLocalAuth: true,
      isProxyAuth: false,
      statusCode: 200,
    };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return {
        isOnline: true,
        isLocalAuth: false,
        isProxyAuth: true,
        statusCode: 404,
      };
    }

    if (err instanceof ApiError && err.status >= 500) {
      const message = apiErrorMessage(err);
      return {
        isOnline: true,
        isLocalAuth: true,
        isProxyAuth: false,
        statusCode: err.status,
        error: message === err.message ? `Server error: ${err.status}` : message,
      };
    }

    if (err instanceof ApiError) {
      return {
        isOnline: true,
        isLocalAuth: true,
        isProxyAuth: false,
        statusCode: err.status,
      };
    }

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

/** Response from /api/v1/dev-auth/login */
export interface DevLoginResponse {
  userId: string;
  username: string;
  userSalt: string; // base64
  accountSalt: string; // base64
  isNewUser: boolean;
}

/**
 * Defense-in-depth guard: refuse to call dev-only endpoints from a production
 * build. The backend should also reject these routes in production, but this
 * client-side check prevents silent forwards-compat regressions if a dev-only
 * function is accidentally wired into a production code path.
 */
function assertDevMode(): void {
  if (!import.meta.env.DEV) {
    throw new Error(
      'Dev-only endpoint called in production build. Refusing.',
    );
  }
}

/**
 * Quick login for development mode.
 * Creates user and session without cryptographic verification.
 * Only works when backend is in Development + LocalAuth mode.
 */
export async function devLogin(username: string): Promise<DevLoginResponse> {
  assertDevMode();
  try {
    return await apiRequest<DevLoginResponse>('/dev-auth/login', {
      method: 'POST',
      body: { username },
    });
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
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
  assertDevMode();
  try {
    await apiRequest<void>('/dev-auth/update-keys', {
      method: 'POST',
      body: keys,
    });
  } catch (error) {
    throw new Error(apiErrorMessage(error));
  }
}
