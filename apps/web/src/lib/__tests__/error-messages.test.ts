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

  it('maps v1 client workflow and media codes to curated safe messages', () => {
    const cases: Array<[WorkerCryptoErrorCode, string]> = [
      [WorkerCryptoErrorCode.ShardIntegrityFailed, 'integrity checks'],
      [WorkerCryptoErrorCode.UnsupportedMediaFormat, 'not supported'],
      [WorkerCryptoErrorCode.ManifestSetConflict, 'album changed'],
      [WorkerCryptoErrorCode.DownloadDecrypt, 'Unable to decrypt'],
      [WorkerCryptoErrorCode.PinValidationFailed, 'pairing PIN'],
    ];

    for (const [code, expected] of cases) {
      expect(
        toSafeErrorMessage(new WorkerCryptoError(code, `raw error ${code}`)),
        `code=${code}`,
      ).toContain(expected);
    }
  });
});
