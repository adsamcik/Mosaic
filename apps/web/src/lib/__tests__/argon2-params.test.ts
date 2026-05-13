import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseServerArgon2Params,
  selectRegistrationArgon2Params,
} from '@mosaic/crypto';

function stubNavigator(userAgent: string, deviceMemory?: number): void {
  vi.stubGlobal('navigator', {
    userAgent,
    ...(deviceMemory === undefined ? {} : { deviceMemory }),
  });
}

describe('Argon2 KDF profile selection and parsing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('selects desktop parameters for desktop registration', () => {
    vi.stubEnv('VITE_E2E_WEAK_KEYS', 'false');
    stubNavigator(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      8,
    );

    expect(selectRegistrationArgon2Params()).toEqual({
      memory: 64 * 1024,
      iterations: 3,
      parallelism: 1,
      algVersion: 0x13,
    });
  });

  it('selects mobile parameters for mobile registration', () => {
    vi.stubEnv('VITE_E2E_WEAK_KEYS', 'false');
    stubNavigator(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
      8,
    );

    expect(selectRegistrationArgon2Params()).toEqual({
      memory: 32 * 1024,
      iterations: 4,
      parallelism: 1,
      algVersion: 0x13,
    });
  });

  it('validates and normalizes the server-pinned login profile', () => {
    expect(
      parseServerArgon2Params({
        memoryKib: 32768,
        iterations: 4,
        parallelism: 1,
        algVersion: 0x13,
      }),
    ).toEqual({
      memory: 32768,
      iterations: 4,
      parallelism: 1,
      algVersion: 0x13,
    });
  });

  it('rejects invalid server-pinned login profiles', () => {
    expect(() =>
      parseServerArgon2Params({
        memoryKib: 0,
        iterations: 4,
        parallelism: 1,
        algVersion: 0x13,
      }),
    ).toThrow(/memory/i);

    expect(() =>
      parseServerArgon2Params({
        memoryKib: 32768,
        iterations: 0,
        parallelism: 1,
        algVersion: 0x13,
      }),
    ).toThrow(/iteration/i);

    expect(() =>
      parseServerArgon2Params({
        memoryKib: 32768,
        iterations: 4,
        parallelism: 1,
        algVersion: 0x10,
      }),
    ).toThrow(/version/i);
  });
});
