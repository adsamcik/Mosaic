/**
 * Session KDF / account-handle helpers and error types.
 *
 * Extracted from `session.ts` (Sweep 39). These functions translate the raw
 * Argon2id parameters and account-salt fields stored on the `User` API DTO
 * into the strongly-typed shapes used by the crypto worker and Rust account
 * handle. Pure utilities — no side effects.
 */
import { parseServerArgon2Params, type Argon2Params } from '@mosaic/crypto';
import type { User } from './api-types';

// Inline base64 decode to keep this module independent of `./api` (avoids
// the api.ts <-> session.ts cycle from extending through this file).
function decodeBase64(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
import type { WorkerKdfParams } from '../workers/types';
import { WorkerCryptoError, WorkerCryptoErrorCode } from '../workers/types';

/**
 * Error thrown when a first-login wrapped-key upload would clobber a
 * concurrently-uploaded wrapped key from another device (M4).
 *
 * Threat model: two devices belonging to the same user perform their
 * "first" login at roughly the same time. Each device fetches the user
 * record (no `wrappedAccountKey` yet), generates its own L2 account
 * key, and races to PUT it. Without a guard the loser silently
 * overwrites the winner's wrapped key — the next time the winning
 * device tries to unwrap, it will fail with an authentication error
 * because the wrap key on the server is for a different L2.
 *
 * Mitigation: re-fetch /users/me immediately before the PUT. If the
 * server now reports a wrappedAccountKey the other device beat us;
 * abort with this error. The caller (UI / login flow) should prompt
 * the user to retry login, which falls into the "wrapped key present"
 * branch and successfully unwraps with the same password.
 */
export class WrappedKeyConflictError extends Error {
  constructor(
    message: string = 'Another device uploaded a wrapped account key first - please retry login',
  ) {
    super(message);
    this.name = 'WrappedKeyConflictError';
  }
}

export function defaultKdfProfile(): Argon2Params {
  return parseServerArgon2Params({
    memoryKib: 64 * 1024,
    iterations: 3,
    parallelism: 1,
    algVersion: 0x13,
  });
}

export function legacyAccountSaltFromUserId(userId: string): Uint8Array {
  const userIdBytes = new TextEncoder().encode(userId).slice(0, 16);
  const accountSalt = new Uint8Array(16);
  accountSalt.set(userIdBytes);
  return accountSalt;
}

export function resolveAccountSalt(user: User): Uint8Array {
  if (!user.accountSalt) {
    return legacyAccountSaltFromUserId(user.id);
  }

  const accountSalt = decodeBase64(user.accountSalt);
  if (accountSalt.length !== 16) {
    throw new Error('Invalid account salt length');
  }

  return accountSalt;
}

export function resolveKdfProfile(user: User): Argon2Params {
  if (
    user.kdfMemoryKib === undefined ||
    user.kdfIterations === undefined ||
    user.kdfParallelism === undefined ||
    user.kdfAlgVersion === undefined
  ) {
    return defaultKdfProfile();
  }

  return parseServerArgon2Params({
    memoryKib: user.kdfMemoryKib,
    iterations: user.kdfIterations,
    parallelism: user.kdfParallelism,
    algVersion: user.kdfAlgVersion,
  });
}

export function toWorkerKdfParams(params: Argon2Params): WorkerKdfParams {
  return {
    memoryKib: params.memory,
    iterations: params.iterations,
    parallelism: params.parallelism,
  };
}

export function isWorkerCryptoErrorCode(
  error: unknown,
  code: WorkerCryptoErrorCode,
): boolean {
  return WorkerCryptoError.is(error) && error.code === code;
}

export function isLegacyFallbackEligibleError(error: unknown): boolean {
  if (!WorkerCryptoError.is(error)) {
    return false;
  }

  return (
    error.code === WorkerCryptoErrorCode.AuthenticationFailed ||
    error.code === WorkerCryptoErrorCode.InvalidEnvelope ||
    error.code === WorkerCryptoErrorCode.InvalidInputLength ||
    error.code === WorkerCryptoErrorCode.InvalidSaltLength
  );
}
