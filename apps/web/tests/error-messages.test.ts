/**
 * Slice 7 — `error-messages.ts` tests.
 *
 * Verifies the user-friendly error mapping over the new Rust-mirrored
 * `WorkerCryptoErrorCode` contract from the crypto worker, plus the
 * worker-only handle-lifecycle codes added by Slice 1.
 */

import { describe, expect, it } from 'vitest';

import {
  WorkerCryptoError,
  WorkerCryptoErrorCode,
} from '../src/workers/types';
import {
  getErrorType,
  getSafeErrorInfo,
  toSafeErrorMessage,
} from '../src/lib/error-messages';

describe('toSafeErrorMessage — WorkerCryptoError mapping', () => {
  it('maps AuthenticationFailed to a clear "unable to decrypt" message', () => {
    const err = new WorkerCryptoError(
      WorkerCryptoErrorCode.AuthenticationFailed,
      'rust: aead auth failed',
    );
    const msg = toSafeErrorMessage(err);
    expect(msg.toLowerCase()).toContain('unable to decrypt');
  });

  it('maps InvalidEnvelope (and 100-series envelope errors) to "invalid data format"', () => {
    const codes = [
      WorkerCryptoErrorCode.InvalidEnvelope,
      WorkerCryptoErrorCode.InvalidHeaderLength,
      WorkerCryptoErrorCode.InvalidMagic,
      WorkerCryptoErrorCode.InvalidTier,
      WorkerCryptoErrorCode.NonZeroReservedByte,
      WorkerCryptoErrorCode.MissingCiphertext,
    ];
    for (const code of codes) {
      const err = new WorkerCryptoError(code, 'rust: envelope error');
      const msg = toSafeErrorMessage(err);
      expect(msg.toLowerCase(), `code=${code}`).toContain(
        'invalid data format',
      );
    }
  });

  it('maps InvalidKeyLength to a "security key error" message', () => {
    const err = new WorkerCryptoError(
      WorkerCryptoErrorCode.InvalidKeyLength,
      'rust: key length 0',
    );
    expect(toSafeErrorMessage(err).toLowerCase()).toContain('security key');
  });

  it('maps the Slice 1 handle-lifecycle codes to "encryption session" wording', () => {
    const handleCodes = [
      WorkerCryptoErrorCode.StaleHandle,
      WorkerCryptoErrorCode.HandleNotFound,
      WorkerCryptoErrorCode.ClosedHandle,
      WorkerCryptoErrorCode.SecretHandleNotFound,
    ];
    for (const code of handleCodes) {
      const err = new WorkerCryptoError(code, 'handle-lifecycle');
      const msg = toSafeErrorMessage(err).toLowerCase();
      expect(msg, `code=${code}`).toContain('encryption session');
    }
  });

  it('maps WorkerNotInitialized to "encryption not ready"', () => {
    const err = new WorkerCryptoError(
      WorkerCryptoErrorCode.WorkerNotInitialized,
      'no account handle',
    );
    expect(toSafeErrorMessage(err).toLowerCase()).toContain(
      'encryption not ready',
    );
  });

  it('maps bundle-verification codes to album-key-bundle phrasing', () => {
    const bundleCodes: Array<{
      code: WorkerCryptoErrorCode;
      contains: string;
    }> = [
      {
        code: WorkerCryptoErrorCode.BundleSignatureInvalid,
        contains: 'signature',
      },
      {
        code: WorkerCryptoErrorCode.BundleAlbumIdMismatch,
        contains: 'does not match this album',
      },
      {
        code: WorkerCryptoErrorCode.BundleEpochTooOld,
        contains: 'outdated',
      },
      {
        code: WorkerCryptoErrorCode.BundleSealOpenFailed,
        contains: 'unseal',
      },
    ];
    for (const { code, contains } of bundleCodes) {
      const err = new WorkerCryptoError(code, 'rust: bundle error');
      expect(toSafeErrorMessage(err).toLowerCase(), `code=${code}`).toContain(
        contains,
      );
    }
  });

  it('falls back to the generic message for unmapped codes', () => {
    // Pick a code value that's not in the Rust-mirrored or worker-only
    // ranges. `9999` is well outside both.
    const err = new WorkerCryptoError(
      9999 as WorkerCryptoErrorCode,
      'unmapped',
    );
    expect(toSafeErrorMessage(err)).toBe(
      'An unexpected error occurred. Please try again.',
    );
  });

  it('respects a caller-provided fallback for unmapped codes', () => {
    const err = new WorkerCryptoError(
      9999 as WorkerCryptoErrorCode,
      'unmapped',
    );
    expect(toSafeErrorMessage(err, 'try again later')).toBe(
      'try again later',
    );
  });

  it('detects WorkerCryptoError shape across realms (Comlink-cloned plain objects)', () => {
    // Simulate a Comlink-cloned error: structured-clone preserves own
    // properties and `name`, so `WorkerCryptoError.is()` must accept
    // the cloned shape.
    const cloned = {
      name: 'WorkerCryptoError' as const,
      message: 'cross-realm clone',
      code: WorkerCryptoErrorCode.AuthenticationFailed,
    };
    const msg = toSafeErrorMessage(cloned);
    expect(msg.toLowerCase()).toContain('unable to decrypt');
  });
});

describe('toSafeErrorMessage — non-crypto error paths', () => {
  it('returns the fallback for null/undefined errors', () => {
    expect(toSafeErrorMessage(null)).toBe(
      'An unexpected error occurred. Please try again.',
    );
    expect(toSafeErrorMessage(undefined)).toBe(
      'An unexpected error occurred. Please try again.',
    );
  });

  it('detects fetch network errors via TypeError', () => {
    const err = new TypeError('Failed to fetch');
    expect(toSafeErrorMessage(err)).toBe(
      'Network error. Please check your connection.',
    );
  });

  it('returns "request was cancelled" for AbortError DOMExceptions', () => {
    // Construct a DOMException with name === 'AbortError'.
    const err = new DOMException('aborted', 'AbortError');
    expect(toSafeErrorMessage(err)).toBe('Request was cancelled.');
  });

  it('does not leak generic Error messages — falls back to safe text', () => {
    const err = new Error('some internal stack trace with secret/path');
    expect(toSafeErrorMessage(err)).toBe(
      'An unexpected error occurred. Please try again.',
    );
  });
});

describe('getErrorType / getSafeErrorInfo', () => {
  it('returns "null" for null input', () => {
    expect(getErrorType(null)).toBe('null');
    expect(getErrorType(undefined)).toBe('null');
  });

  it('includes numeric codes from WorkerCryptoError in the type label', () => {
    const err = new WorkerCryptoError(
      WorkerCryptoErrorCode.AuthenticationFailed,
      'auth',
    );
    expect(getErrorType(err)).toBe(
      `WorkerCryptoError[${WorkerCryptoErrorCode.AuthenticationFailed}]`,
    );
  });

  it('captures numeric codes in the structured info object', () => {
    const err = new WorkerCryptoError(
      WorkerCryptoErrorCode.StaleHandle,
      'stale',
    );
    expect(getSafeErrorInfo(err)).toEqual({
      type: `WorkerCryptoError[${WorkerCryptoErrorCode.StaleHandle}]`,
      code: String(WorkerCryptoErrorCode.StaleHandle),
    });
  });

  it('returns just the type for plain Errors with no code', () => {
    expect(getErrorType(new Error('boom'))).toBe('Error');
    expect(getSafeErrorInfo(new Error('boom'))).toEqual({ type: 'Error' });
  });
});
