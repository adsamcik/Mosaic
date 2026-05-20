/**
 * Password Rotation Helper
 *
 * Zero-knowledge client-side password rotation. The plaintext passwords
 * NEVER leave the browser. The helper:
 *  1. Issues a challenge via `POST /auth/init` for the current user.
 *  2. Re-derives the current password's auth keypair in the crypto
 *     worker and signs the challenge (proof of possession of the
 *     current password).
 *  3. Generates a fresh 16-byte user salt and derives the matching
 *     account salt.
 *  4. Re-wraps the open L2 account key under a fresh L1 derived from
 *     `newPassword + newUserSalt + newAccountSalt`. The new wrapped
 *     account key is produced inside the WASM facade — L2 never crosses
 *     the worker boundary.
 *  5. Derives the new auth public key for the new password.
 *  6. POSTs `{challengeId, currentSignature, timestamp, newUserSalt,
 *     newAuthPubkey, newWrappedAccountKey}` to
 *     `POST /auth/password-rotation`.
 *
 * The KDF profile (Argon2id memory / iterations / parallelism) is
 * preserved across rotation — the backend rotation endpoint does NOT
 * accept new KDF parameters, so the new L1 must be derived with the
 * user's existing profile so that the next login can unwrap the new
 * envelope.
 */

import { apiRequest, ApiError, fromBase64, getApi, toBase64 } from './api';
import { getCryptoClient } from './crypto-client';
import { initAuth, parseAuthKdfProfile, toWorkerKdfParams } from './local-auth';
import initRustWasm, {
  deriveAccountSalt,
} from '../generated/mosaic-wasm/mosaic_wasm.js';

export interface RotatePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export interface RotatePasswordResponse {
  saltVersion?: number;
  revokedSessions?: number;
}

interface PasswordRotationServerResponse {
  saltVersion: number;
  revokedSessionCount: number;
}

export class PasswordRotationError extends Error {
  constructor(
    message: string,
    public readonly reason: 'bad-current' | 'too-short' | 'generic',
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'PasswordRotationError';
  }
}

function wrapApiError(err: unknown): never {
  if (err instanceof PasswordRotationError) throw err;
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) {
      throw new PasswordRotationError(
        'Current password is incorrect.',
        'bad-current',
        err.status,
      );
    }
    throw new PasswordRotationError(
      'Could not change password.',
      'generic',
      err.status,
    );
  }
  throw new PasswordRotationError('Could not change password.', 'generic');
}

/**
 * Rotate the user's password.
 *
 * Performs a zero-knowledge challenge-response handshake and re-wraps
 * the L2 account key under a fresh L1 derived from the new password.
 * On success the backend bumps `SaltVersion` and revokes every other
 * active session for this user.
 *
 * @throws PasswordRotationError with `reason='bad-current'` if the
 *   current password signature is rejected, `reason='too-short'` if
 *   the new password fails local length validation, or
 *   `reason='generic'` for any other failure.
 */
export async function rotatePassword(
  request: RotatePasswordRequest,
): Promise<RotatePasswordResponse> {
  if (request.newPassword.length < 12) {
    throw new PasswordRotationError(
      'New password must be at least 12 characters.',
      'too-short',
    );
  }

  try {
    // 1. Resolve the username + KDF profile from the active session.
    const me = await getApi().getCurrentUser();
    const username = me.authSub ?? me.id;

    // 2. Issue a fresh challenge bound to this username.
    const init = await initAuth(username);
    const challengeBytes = fromBase64(init.challenge);
    const currentUserSaltBytes = fromBase64(init.userSalt);
    const currentKdfParams = parseAuthKdfProfile(init);
    const currentWorkerKdf = toWorkerKdfParams(currentKdfParams);

    const cryptoClient = await getCryptoClient();

    // 3. Derive the current password's auth keypair and sign the
    //    challenge transcript. This proves possession of the current
    //    password without revealing it.
    await cryptoClient.deriveAuthKey(
      request.currentPassword,
      currentUserSaltBytes,
      currentWorkerKdf,
    );
    const currentSignature = await cryptoClient.signAuthChallenge(
      challengeBytes,
      username,
      init.timestamp,
    );

    // 4. Confirm we have an open account handle (otherwise we cannot
    //    re-wrap L2 under the new L1).
    const accountHandleId = await cryptoClient.getAccountHandleId();
    if (accountHandleId === null || accountHandleId === undefined) {
      throw new PasswordRotationError(
        'Account is not unlocked; cannot re-wrap account key.',
        'generic',
      );
    }

    // 5. Generate fresh salts. Account salt is deterministic over the
    //    user salt so the next login can re-derive it from /me.
    const newUserSalt = new Uint8Array(16);
    crypto.getRandomValues(newUserSalt);
    await initRustWasm();
    const newAccountSalt = deriveAccountSalt(newUserSalt);

    // 6. The rotation endpoint does NOT update KDF params on the user
    //    row. Re-use the existing profile so the next login's
    //    `unlockAccountKey` call uses matching Argon2 parameters.
    const reuseKdf = toWorkerKdfParams({
      memory: me.kdfMemoryKib,
      iterations: me.kdfIterations,
      parallelism: me.kdfParallelism,
      algVersion: 0x13,
    });

    // 7. Re-wrap L2 inside the WASM facade. L2 never crosses the
    //    Comlink boundary. The returned envelope is opaque ciphertext.
    const { wrappedAccountKey: newWrappedAccountKey } =
      await cryptoClient.rewrapAccountKey({
        accountHandleId,
        newPassword: request.newPassword,
        newUserSalt,
        newAccountSalt,
        kdf: reuseKdf,
      });

    // 8. Derive the new auth public key. This also rotates the
    //    in-worker pre-auth slot to the new credentials so subsequent
    //    challenge signatures (e.g. from another tab) use the new
    //    keypair after this call returns.
    const newAuthPubkey = await cryptoClient.deriveAuthKey(
      request.newPassword,
      newUserSalt,
      reuseKdf,
    );

    // 9. Post the envelope. NO plaintext passwords are sent.
    //
    // `newAccountSalt` MUST be included alongside `newUserSalt`: the
    // server persists it as `user.AccountSalt`, and the next login uses
    // it to re-derive the L1 that unwraps the freshly-rewrapped
    // `newWrappedAccountKey`. Omitting it leaves the server-side
    // AccountSalt stale, so subsequent logins succeed at /auth/verify
    // (signature matches the new AuthPubkey) but the wrappedAccountKey
    // fails to unwrap and the login form stays visible (v1.0.x
    // validation-final-gate-auth-f).
    const response = await apiRequest<PasswordRotationServerResponse>(
      '/auth/password-rotation',
      {
        method: 'POST',
        body: {
          challengeId: init.challengeId,
          currentSignature: toBase64(currentSignature),
          timestamp: init.timestamp,
          newUserSalt: toBase64(newUserSalt),
          newAccountSalt: toBase64(newAccountSalt),
          newAuthPubkey: toBase64(newAuthPubkey),
          newWrappedAccountKey: toBase64(newWrappedAccountKey),
        },
      },
    );

    return {
      saltVersion: response.saltVersion,
      revokedSessions: response.revokedSessionCount,
    };
  } catch (err) {
    wrapApiError(err);
  }
}

/** Lightweight password strength heuristic (no zxcvbn dependency). */
export type PasswordStrength = 'weak' | 'ok' | 'strong';

export function estimatePasswordStrength(password: string): PasswordStrength {
  const len = password.length;
  if (len < 12) return 'weak';
  let classes = 0;
  if (/[a-z]/.test(password)) classes++;
  if (/[A-Z]/.test(password)) classes++;
  if (/[0-9]/.test(password)) classes++;
  if (/[^A-Za-z0-9]/.test(password)) classes++;
  if (len >= 16 && classes >= 3) return 'strong';
  if (len >= 12 && classes >= 2) return 'ok';
  return 'weak';
}
