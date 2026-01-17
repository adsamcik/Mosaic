/**
 * Tests for authentication challenge-response module.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import {
  generateAuthChallenge,
  signAuthChallenge,
  verifyAuthChallenge,
  deriveAuthKeypair,
  generateFakeUserSalt,
  generateFakeChallenge,
  CHALLENGE_SIZE,
} from '../src/auth';
import { CryptoError } from '../src/types';
import { randomBytes, toBase64 } from '../src/utils';

// Fast Argon2 params for testing
const fastParams = {
  memoryKiB: 1024,
  iterations: 1,
  parallelism: 1,
};

beforeAll(async () => {
  await sodium.ready;
});

describe('generateAuthChallenge', () => {
  it('generates 32-byte challenge', () => {
    const challenge = generateAuthChallenge();
    expect(challenge).toHaveLength(CHALLENGE_SIZE);
    expect(challenge).toHaveLength(32);
  });

  it('generates unique challenges', () => {
    const c1 = generateAuthChallenge();
    const c2 = generateAuthChallenge();
    expect(c1).not.toEqual(c2);
  });
});

describe('signAuthChallenge', () => {
  let keypair: { publicKey: Uint8Array; privateKey: Uint8Array };
  let challenge: Uint8Array;
  const username = 'alice';

  beforeAll(() => {
    keypair = sodium.crypto_sign_keypair();
    challenge = randomBytes(32);
  });

  it('signs challenge successfully', () => {
    const signature = signAuthChallenge(
      challenge,
      username,
      keypair.privateKey,
    );
    expect(signature).toBeDefined();
    expect(typeof signature).toBe('string');
    // Base64-encoded 64-byte signature
    expect(signature.length).toBeGreaterThan(80);
  });

  it('produces deterministic signatures for same inputs', () => {
    const sig1 = signAuthChallenge(challenge, username, keypair.privateKey);
    const sig2 = signAuthChallenge(challenge, username, keypair.privateKey);
    expect(sig1).toEqual(sig2);
  });

  it('produces different signatures for different challenges', () => {
    const challenge2 = randomBytes(32);
    const sig1 = signAuthChallenge(challenge, username, keypair.privateKey);
    const sig2 = signAuthChallenge(challenge2, username, keypair.privateKey);
    expect(sig1).not.toEqual(sig2);
  });

  it('produces different signatures for different usernames', () => {
    const sig1 = signAuthChallenge(challenge, 'alice', keypair.privateKey);
    const sig2 = signAuthChallenge(challenge, 'bob', keypair.privateKey);
    expect(sig1).not.toEqual(sig2);
  });

  it('includes timestamp in signature when provided', () => {
    const now = Date.now();
    const sig1 = signAuthChallenge(
      challenge,
      username,
      keypair.privateKey,
      now,
    );
    const sig2 = signAuthChallenge(
      challenge,
      username,
      keypair.privateKey,
      now + 1000,
    );
    expect(sig1).not.toEqual(sig2);
  });

  it('throws on invalid challenge length', () => {
    const shortChallenge = randomBytes(16);
    expect(() =>
      signAuthChallenge(shortChallenge, username, keypair.privateKey),
    ).toThrow(CryptoError);
    expect(() =>
      signAuthChallenge(shortChallenge, username, keypair.privateKey),
    ).toThrow(/must be 32 bytes/);
  });

  it('throws on invalid key length', () => {
    const shortKey = randomBytes(32);
    expect(() => signAuthChallenge(challenge, username, shortKey)).toThrow(
      CryptoError,
    );
    expect(() => signAuthChallenge(challenge, username, shortKey)).toThrow(
      /must be 64 bytes/,
    );
  });

  it('throws on empty username', () => {
    expect(() => signAuthChallenge(challenge, '', keypair.privateKey)).toThrow(
      CryptoError,
    );
    expect(() => signAuthChallenge(challenge, '', keypair.privateKey)).toThrow(
      /cannot be empty/,
    );
  });
});

describe('verifyAuthChallenge', () => {
  let keypair: { publicKey: Uint8Array; privateKey: Uint8Array };
  let challenge: Uint8Array;
  const username = 'alice';

  beforeAll(() => {
    keypair = sodium.crypto_sign_keypair();
    challenge = randomBytes(32);
  });

  it('verifies valid signature', () => {
    const signature = signAuthChallenge(
      challenge,
      username,
      keypair.privateKey,
    );
    const isValid = verifyAuthChallenge(
      challenge,
      username,
      signature,
      keypair.publicKey,
    );
    expect(isValid).toBe(true);
  });

  it('verifies signature with timestamp', () => {
    const now = Date.now();
    const signature = signAuthChallenge(
      challenge,
      username,
      keypair.privateKey,
      now,
    );
    const isValid = verifyAuthChallenge(
      challenge,
      username,
      signature,
      keypair.publicKey,
      now,
    );
    expect(isValid).toBe(true);
  });

  it('rejects signature with wrong timestamp', () => {
    const now = Date.now();
    const signature = signAuthChallenge(
      challenge,
      username,
      keypair.privateKey,
      now,
    );
    const isValid = verifyAuthChallenge(
      challenge,
      username,
      signature,
      keypair.publicKey,
      now + 1000,
    );
    expect(isValid).toBe(false);
  });

  it('rejects signature without timestamp when timestamp was used', () => {
    const now = Date.now();
    const signature = signAuthChallenge(
      challenge,
      username,
      keypair.privateKey,
      now,
    );
    const isValid = verifyAuthChallenge(
      challenge,
      username,
      signature,
      keypair.publicKey,
    );
    expect(isValid).toBe(false);
  });

  it('rejects wrong challenge', () => {
    const signature = signAuthChallenge(
      challenge,
      username,
      keypair.privateKey,
    );
    const wrongChallenge = randomBytes(32);
    const isValid = verifyAuthChallenge(
      wrongChallenge,
      username,
      signature,
      keypair.publicKey,
    );
    expect(isValid).toBe(false);
  });

  it('rejects wrong username', () => {
    const signature = signAuthChallenge(
      challenge,
      username,
      keypair.privateKey,
    );
    const isValid = verifyAuthChallenge(
      challenge,
      'bob',
      signature,
      keypair.publicKey,
    );
    expect(isValid).toBe(false);
  });

  it('rejects wrong public key', () => {
    const otherKeypair = sodium.crypto_sign_keypair();
    const signature = signAuthChallenge(
      challenge,
      username,
      keypair.privateKey,
    );
    const isValid = verifyAuthChallenge(
      challenge,
      username,
      signature,
      otherKeypair.publicKey,
    );
    expect(isValid).toBe(false);
  });

  it('rejects tampered signature', () => {
    const signature = signAuthChallenge(
      challenge,
      username,
      keypair.privateKey,
    );
    const tampered = signature.substring(0, signature.length - 2) + 'XX';
    const isValid = verifyAuthChallenge(
      challenge,
      username,
      tampered,
      keypair.publicKey,
    );
    expect(isValid).toBe(false);
  });

  it('returns false for invalid base64 signature', () => {
    const isValid = verifyAuthChallenge(
      challenge,
      username,
      '!!!invalid!!!',
      keypair.publicKey,
    );
    expect(isValid).toBe(false);
  });

  it('returns false for wrong-length signature', () => {
    const shortSig = toBase64(randomBytes(32));
    const isValid = verifyAuthChallenge(
      challenge,
      username,
      shortSig,
      keypair.publicKey,
    );
    expect(isValid).toBe(false);
  });

  it('returns false for invalid challenge length', () => {
    const signature = signAuthChallenge(
      challenge,
      username,
      keypair.privateKey,
    );
    const shortChallenge = randomBytes(16);
    const isValid = verifyAuthChallenge(
      shortChallenge,
      username,
      signature,
      keypair.publicKey,
    );
    expect(isValid).toBe(false);
  });

  it('returns false for invalid public key length', () => {
    const signature = signAuthChallenge(
      challenge,
      username,
      keypair.privateKey,
    );
    const shortPubKey = randomBytes(16);
    const isValid = verifyAuthChallenge(
      challenge,
      username,
      signature,
      shortPubKey,
    );
    expect(isValid).toBe(false);
  });

  it('returns false for empty username', () => {
    const signature = signAuthChallenge(
      challenge,
      username,
      keypair.privateKey,
    );
    const isValid = verifyAuthChallenge(
      challenge,
      '',
      signature,
      keypair.publicKey,
    );
    expect(isValid).toBe(false);
  });

  it('returns false when sodium throws during verification', async () => {
    // Create a valid-looking but corrupted public key that will cause sodium to throw
    const signature = signAuthChallenge(
      challenge,
      username,
      keypair.privateKey,
    );
    // Use all-zero public key which is not a valid curve point
    const invalidPubKey = new Uint8Array(32);
    const isValid = verifyAuthChallenge(
      challenge,
      username,
      signature,
      invalidPubKey,
    );
    expect(isValid).toBe(false);
  });
});

describe('deriveAuthKeypair', () => {
  const password = 'test-password';
  let userSalt: Uint8Array;

  beforeAll(() => {
    userSalt = randomBytes(16);
  });

  it('derives Ed25519 keypair', async () => {
    const keypair = await deriveAuthKeypair(password, userSalt, fastParams);
    expect(keypair.publicKey).toHaveLength(32);
    expect(keypair.secretKey).toHaveLength(64);
  });

  it('is deterministic for same inputs', async () => {
    const kp1 = await deriveAuthKeypair(password, userSalt, fastParams);
    const kp2 = await deriveAuthKeypair(password, userSalt, fastParams);
    expect(kp1.publicKey).toEqual(kp2.publicKey);
    expect(kp1.secretKey).toEqual(kp2.secretKey);
  });

  it('produces different keys for different passwords', async () => {
    const kp1 = await deriveAuthKeypair('password1', userSalt, fastParams);
    const kp2 = await deriveAuthKeypair('password2', userSalt, fastParams);
    expect(kp1.publicKey).not.toEqual(kp2.publicKey);
  });

  it('produces different keys for different salts', async () => {
    const salt2 = randomBytes(16);
    const kp1 = await deriveAuthKeypair(password, userSalt, fastParams);
    const kp2 = await deriveAuthKeypair(password, salt2, fastParams);
    expect(kp1.publicKey).not.toEqual(kp2.publicKey);
  });

  it('throws on invalid salt length', async () => {
    const shortSalt = randomBytes(8);
    await expect(
      deriveAuthKeypair(password, shortSalt, fastParams),
    ).rejects.toThrow(CryptoError);
    await expect(
      deriveAuthKeypair(password, shortSalt, fastParams),
    ).rejects.toThrow(/must be 16 bytes/);
  });

  it('produces valid signing keypair', async () => {
    const keypair = await deriveAuthKeypair(password, userSalt, fastParams);
    const challenge = generateAuthChallenge();
    const signature = signAuthChallenge(
      challenge,
      'testuser',
      keypair.secretKey,
    );
    const isValid = verifyAuthChallenge(
      challenge,
      'testuser',
      signature,
      keypair.publicKey,
    );
    expect(isValid).toBe(true);
  });

  it('uses default params when not provided', async () => {
    // This will be slow but should work
    const keypair = await deriveAuthKeypair(password, userSalt);
    expect(keypair.publicKey).toHaveLength(32);
    expect(keypair.secretKey).toHaveLength(64);
  });
});

describe('generateFakeUserSalt', () => {
  let serverSecret: Uint8Array;

  beforeAll(() => {
    serverSecret = randomBytes(32);
  });

  it('generates 16-byte salt', () => {
    const salt = generateFakeUserSalt('nonexistent', serverSecret);
    expect(salt).toHaveLength(16);
  });

  it('is deterministic for same username', () => {
    const salt1 = generateFakeUserSalt('alice', serverSecret);
    const salt2 = generateFakeUserSalt('alice', serverSecret);
    expect(salt1).toEqual(salt2);
  });

  it('produces different salts for different usernames', () => {
    const salt1 = generateFakeUserSalt('alice', serverSecret);
    const salt2 = generateFakeUserSalt('bob', serverSecret);
    expect(salt1).not.toEqual(salt2);
  });

  it('produces different salts for different server secrets', () => {
    const secret2 = randomBytes(32);
    const salt1 = generateFakeUserSalt('alice', serverSecret);
    const salt2 = generateFakeUserSalt('alice', secret2);
    expect(salt1).not.toEqual(salt2);
  });

  it('throws on invalid server secret length', () => {
    const shortSecret = randomBytes(16);
    expect(() => generateFakeUserSalt('alice', shortSecret)).toThrow(
      CryptoError,
    );
    expect(() => generateFakeUserSalt('alice', shortSecret)).toThrow(
      /must be 32 bytes/,
    );
  });
});

describe('generateFakeChallenge', () => {
  let serverSecret: Uint8Array;
  let timestamp: number;

  beforeAll(() => {
    serverSecret = randomBytes(32);
    timestamp = Date.now();
  });

  it('generates 32-byte challenge', () => {
    const challenge = generateFakeChallenge(
      'nonexistent',
      serverSecret,
      timestamp,
    );
    expect(challenge).toHaveLength(CHALLENGE_SIZE);
  });

  it('is deterministic for same inputs', () => {
    const c1 = generateFakeChallenge('alice', serverSecret, timestamp);
    const c2 = generateFakeChallenge('alice', serverSecret, timestamp);
    expect(c1).toEqual(c2);
  });

  it('produces different challenges for different usernames', () => {
    const c1 = generateFakeChallenge('alice', serverSecret, timestamp);
    const c2 = generateFakeChallenge('bob', serverSecret, timestamp);
    expect(c1).not.toEqual(c2);
  });

  it('produces different challenges for different timestamps', () => {
    const c1 = generateFakeChallenge('alice', serverSecret, timestamp);
    const c2 = generateFakeChallenge('alice', serverSecret, timestamp + 1);
    expect(c1).not.toEqual(c2);
  });

  it('throws on invalid server secret length', () => {
    const shortSecret = randomBytes(16);
    expect(() =>
      generateFakeChallenge('alice', shortSecret, timestamp),
    ).toThrow(CryptoError);
  });
});

describe('full auth flow', () => {
  it('complete challenge-response authentication', async () => {
    const password = 'my-secure-password';
    const userSalt = randomBytes(16);

    // Simulate user registration - store public key
    const keypair = await deriveAuthKeypair(password, userSalt, fastParams);
    const storedPublicKey = keypair.publicKey;

    // Simulate login - server generates challenge
    const serverChallenge = generateAuthChallenge();
    const timestamp = Date.now();

    // Client signs challenge
    const { secretKey } = await deriveAuthKeypair(
      password,
      userSalt,
      fastParams,
    );
    const signature = signAuthChallenge(
      serverChallenge,
      'alice',
      secretKey,
      timestamp,
    );

    // Server verifies
    const isValid = verifyAuthChallenge(
      serverChallenge,
      'alice',
      signature,
      storedPublicKey,
      timestamp,
    );
    expect(isValid).toBe(true);
  });

  it('rejects wrong password in auth flow', async () => {
    const correctPassword = 'correct-password';
    const wrongPassword = 'wrong-password';
    const userSalt = randomBytes(16);

    // Register with correct password
    const { publicKey: storedPublicKey } = await deriveAuthKeypair(
      correctPassword,
      userSalt,
      fastParams,
    );

    // Try to login with wrong password
    const serverChallenge = generateAuthChallenge();
    const { secretKey: wrongSecretKey } = await deriveAuthKeypair(
      wrongPassword,
      userSalt,
      fastParams,
    );
    const signature = signAuthChallenge(
      serverChallenge,
      'alice',
      wrongSecretKey,
    );

    // Verification should fail
    const isValid = verifyAuthChallenge(
      serverChallenge,
      'alice',
      signature,
      storedPublicKey,
    );
    expect(isValid).toBe(false);
  });

  it('fake user flow prevents enumeration', () => {
    const serverSecret = randomBytes(32);
    const timestamp = Date.now();

    // Real user would return actual stored salt
    const realUserSalt = randomBytes(16);

    // Fake user gets deterministic fake salt
    const fakeUserSalt = generateFakeUserSalt('nonexistent', serverSecret);
    const fakeChallenge = generateFakeChallenge(
      'nonexistent',
      serverSecret,
      timestamp,
    );

    // Both look like valid 16-byte salts and 32-byte challenges
    expect(realUserSalt).toHaveLength(16);
    expect(fakeUserSalt).toHaveLength(16);
    expect(fakeChallenge).toHaveLength(32);

    // Fake salt is consistent for same username
    const fakeUserSalt2 = generateFakeUserSalt('nonexistent', serverSecret);
    expect(fakeUserSalt).toEqual(fakeUserSalt2);
  });
});
