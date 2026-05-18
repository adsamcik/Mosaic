/**
 * Password Rotation Helper (v1.0.x sweep38, Item 3)
 *
 * Thin client-side helper that posts a password-change request to the
 * backend `POST /auth/password-rotation` endpoint. The backend owns the
 * actual re-wrap of the Layer-2 account key (server-aided rotation) and
 * is responsible for revoking all sessions other than the current one
 * on success.
 *
 * NOTE: This endpoint is part of the v1.0.x rollout (see backend agent
 * R3A). Until it lands on the deployed backend the call will return a
 * 404, surfaced as `ApiError` to the UI which then displays the generic
 * "could not change password" error. No plaintext key material ever
 * leaves the browser; the helper sends the current and new passwords
 * over TLS to the backend, exactly the same surface area as
 * `local-auth.localLogin`.
 */

import { apiRequest, ApiError } from './api';

export interface RotatePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export interface RotatePasswordResponse {
  revokedSessions?: number;
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

/**
 * Rotate the user's password.
 *
 * On a successful response the backend is expected to have re-wrapped
 * the account key with a freshly-derived Layer-1 root key and revoked
 * every refresh-token session except the one used to authenticate
 * this request.
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
    const response = await apiRequest<RotatePasswordResponse | undefined>(
      '/auth/password-rotation',
      {
        method: 'POST',
        body: {
          currentPassword: request.currentPassword,
          newPassword: request.newPassword,
        },
      },
    );
    return response ?? {};
  } catch (err) {
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
    throw new PasswordRotationError(
      'Could not change password.',
      'generic',
    );
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
