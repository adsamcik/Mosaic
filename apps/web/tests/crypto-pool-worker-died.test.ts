/**
 * v1.0.x sweep 37 — narrow `isWorkerDiedError` so legitimate DownloadError
 * instances are NOT treated as worker-death signals, even when their
 * message contains the word "worker". Pool churn (terminate + respawn)
 * should only happen on true port/transport failures.
 */

import { describe, expect, it } from 'vitest';
import {
  DownloadError,
  __cryptoPoolTestUtils,
} from '../src/workers/crypto-pool';

const { isWorkerDiedError } = __cryptoPoolTestUtils;

describe('isWorkerDiedError (v1.0.x sweep 37)', () => {
  it('does NOT match a legitimate DownloadError that mentions "worker"', () => {
    const err = new DownloadError(
      'Decrypt',
      'Decryption failed inside the crypto worker for shard 7',
    );
    expect(isWorkerDiedError(err)).toBe(false);
  });

  it('does NOT match a DownloadError with code IllegalState', () => {
    const err = new DownloadError('IllegalState', 'pool is shut down');
    expect(isWorkerDiedError(err)).toBe(false);
  });

  it('does NOT match a generic Error whose message contains "worker"', () => {
    const err = new Error('worker reported an integrity mismatch');
    expect(isWorkerDiedError(err)).toBe(false);
  });

  it('does NOT match a generic Error whose message contains "terminated"', () => {
    // The old predicate matched any "terminated" substring. The narrowed
    // predicate requires an explicit `terminated === true` flag, so a
    // free-form message must not trigger pool churn.
    const err = new Error('upload session was terminated by the server');
    expect(isWorkerDiedError(err)).toBe(false);
  });

  it('does NOT match non-Error values', () => {
    expect(isWorkerDiedError(undefined)).toBe(false);
    expect(isWorkerDiedError(null)).toBe(false);
    expect(isWorkerDiedError('worker died')).toBe(false);
    expect(isWorkerDiedError({ message: 'worker died' })).toBe(false);
  });

  it('matches a DataCloneError by name', () => {
    const err = new Error('Could not clone object');
    err.name = 'DataCloneError';
    expect(isWorkerDiedError(err)).toBe(true);
  });

  it('matches an error whose message contains "MessagePort closed"', () => {
    const err = new Error('Comlink: MessagePort closed before response arrived');
    expect(isWorkerDiedError(err)).toBe(true);
  });

  it('matches an error carrying an explicit `terminated === true` flag', () => {
    const err = Object.assign(new Error('slot torn down'), {
      terminated: true,
    });
    expect(isWorkerDiedError(err)).toBe(true);
  });

  it('does NOT match an error with a falsy `terminated` value', () => {
    const err = Object.assign(new Error('slot torn down'), {
      terminated: 'yes',
    });
    expect(isWorkerDiedError(err)).toBe(false);
  });
});
