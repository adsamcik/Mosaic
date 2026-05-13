import { describe, expect, it } from 'vitest';
import { WorkerCryptoError, WorkerCryptoErrorCode } from '../../workers/types';
import { toSafeErrorMessage } from '../error-messages';

describe('toSafeErrorMessage', () => {
  it('maps WorkerCryptoError code 207 to the curated safe message', () => {
    const error = new WorkerCryptoError(
      WorkerCryptoErrorCode.WrappedKeyTooShort,
      'wrapped key too short: raw thiserror text',
    );

    expect(toSafeErrorMessage(error)).toBe(
      'Security key error. Please try logging in again.',
    );
  });

  it('maps Comlink-cloned WorkerCryptoError objects by stable code', () => {
    const error = {
      name: 'WorkerCryptoError',
      code: WorkerCryptoErrorCode.AuthenticationFailed,
      message: 'raw worker authentication failure',
    };

    expect(toSafeErrorMessage(error)).toBe(
      'Unable to decrypt content. The data may be corrupted or the key is wrong.',
    );
  });
});
