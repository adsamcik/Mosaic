/**
 * Mosaic Crypto Library - Mock Implementation
 *
 * Mock implementation of CryptoLib for parallel development.
 * Returns deterministic fake values for testing UI and API integration.
 *
 * WARNING: This is NOT cryptographically secure. Use only for development.
 */

import type { CryptoLib } from './index';
import type {
  DerivedKeys,
  EpochKey,
  IdentityKeypair,
  EpochKeyBundle,
  EncryptedShard,
  SealedBundle,
  BundleValidationContext,
} from './types';
import {
  ENVELOPE_MAGIC,
  ENVELOPE_VERSION,
  ENVELOPE_HEADER_SIZE,
} from './types';

/**
 * Create a deterministic Uint8Array filled with a pattern.
 */
function mockBytes(length: number, seed: number): Uint8Array {
  const arr = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    arr[i] = (seed + i) & 0xff;
  }
  return arr;
}

/**
 * Simple mock hash function (NOT cryptographic).
 */
function mockHash(data: Uint8Array): string {
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const byte = data[i] ?? 0;
    hash = ((hash << 5) - hash + byte) | 0;
  }
  return `mock-sha256-${Math.abs(hash).toString(16).padStart(8, '0')}`;
}

/**
 * Build a mock envelope header.
 */
function buildMockHeader(epochId: number, shardIndex: number): Uint8Array {
  const header = new Uint8Array(ENVELOPE_HEADER_SIZE);

  // Magic "SGzk"
  header[0] = 0x53; // S
  header[1] = 0x47; // G
  header[2] = 0x7a; // z
  header[3] = 0x6b; // k

  // Version
  header[4] = ENVELOPE_VERSION;

  // Epoch ID (LE u32)
  header[5] = epochId & 0xff;
  header[6] = (epochId >> 8) & 0xff;
  header[7] = (epochId >> 16) & 0xff;
  header[8] = (epochId >> 24) & 0xff;

  // Shard Index (LE u32)
  header[9] = shardIndex & 0xff;
  header[10] = (shardIndex >> 8) & 0xff;
  header[11] = (shardIndex >> 16) & 0xff;
  header[12] = (shardIndex >> 24) & 0xff;

  // Nonce (24 bytes of mock random)
  for (let i = 0; i < 24; i++) {
    header[13 + i] = (epochId + shardIndex + i) & 0xff;
  }

  // Reserved (27 bytes of zero) - already zero from initialization

  return header;
}

/**
 * Mock implementation of CryptoLib.
 */
export const mockCrypto: CryptoLib = {
  async init(): Promise<void> {
    // No-op for mock
  },

  isReady(): boolean {
    return true;
  },

  async deriveKeys(
    password: string,
    _salt: Uint8Array,
    _accountSalt: Uint8Array,
  ): Promise<DerivedKeys> {
    // Generate deterministic mock keys based on password hash
    const pwHash = password.split('').reduce((a, c) => a + c.charCodeAt(0), 0);

    return {
      masterKey: mockBytes(32, pwHash),
      rootKey: mockBytes(32, pwHash + 1),
      accountKey: mockBytes(32, pwHash + 2),
      accountKeyWrapped: mockBytes(48, pwHash + 3), // nonce(24) + ciphertext(24)
    };
  },

  deriveIdentityKeypair(seed: Uint8Array): IdentityKeypair {
    const seedSum = seed.reduce((a, b) => a + b, 0);

    return {
      ed25519: {
        publicKey: mockBytes(32, seedSum),
        secretKey: mockBytes(64, seedSum + 1),
      },
      x25519: {
        publicKey: mockBytes(32, seedSum + 2),
        secretKey: mockBytes(32, seedSum + 3),
      },
    };
  },

  generateEpochKey(epochId: number): EpochKey {
    const epochSeed = mockBytes(32, epochId * 100);
    return {
      epochId,
      epochSeed,
      thumbKey: mockBytes(32, epochId * 100 + 10),
      previewKey: mockBytes(32, epochId * 100 + 20),
      fullKey: mockBytes(32, epochId * 100 + 30),
      signKeypair: {
        publicKey: mockBytes(32, epochId * 100 + 1),
        secretKey: mockBytes(64, epochId * 100 + 2),
      },
    };
  },

  wrapKey(key: Uint8Array, wrapper: Uint8Array): Uint8Array {
    // Mock: prepend 24-byte nonce, XOR key with wrapper pattern
    const result = new Uint8Array(24 + key.length + 16);
    // Mock nonce
    for (let i = 0; i < 24; i++) {
      const wrapperByte = wrapper[i % wrapper.length] ?? 0;
      result[i] = (wrapperByte + i) & 0xff;
    }
    // Mock encrypted key (XOR)
    for (let i = 0; i < key.length; i++) {
      const keyByte = key[i] ?? 0;
      const wrapperByte = wrapper[i % wrapper.length] ?? 0;
      result[24 + i] = keyByte ^ wrapperByte;
    }
    // Mock tag
    for (let i = 0; i < 16; i++) {
      result[24 + key.length + i] = 0xaa;
    }
    return result;
  },

  unwrapKey(wrapped: Uint8Array, wrapper: Uint8Array): Uint8Array {
    // Mock: extract and XOR to reverse
    const keyLength = wrapped.length - 24 - 16;
    const result = new Uint8Array(keyLength);
    for (let i = 0; i < keyLength; i++) {
      const wrappedByte = wrapped[24 + i] ?? 0;
      const wrapperByte = wrapper[i % wrapper.length] ?? 0;
      result[i] = wrappedByte ^ wrapperByte;
    }
    return result;
  },

  async encryptShard(
    data: Uint8Array,
    _readKey: Uint8Array,
    epochId: number,
    shardIndex: number,
  ): Promise<EncryptedShard> {
    const header = buildMockHeader(epochId, shardIndex);

    // Mock ciphertext: header + data + 16-byte mock tag
    const ciphertext = new Uint8Array(ENVELOPE_HEADER_SIZE + data.length + 16);
    ciphertext.set(header, 0);
    ciphertext.set(data, ENVELOPE_HEADER_SIZE);
    // Mock tag
    for (let i = 0; i < 16; i++) {
      ciphertext[ENVELOPE_HEADER_SIZE + data.length + i] = 0xbb;
    }

    return {
      ciphertext,
      sha256: mockHash(ciphertext),
    };
  },

  async decryptShard(
    envelope: Uint8Array,
    _readKey: Uint8Array,
  ): Promise<Uint8Array> {
    // Mock: strip header and tag, return payload
    if (envelope.length < ENVELOPE_HEADER_SIZE + 16) {
      throw new Error('Invalid envelope: too short');
    }
    return envelope.slice(ENVELOPE_HEADER_SIZE, envelope.length - 16);
  },

  parseShardHeader(envelope: Uint8Array): {
    epochId: number;
    shardId: number;
    nonce: Uint8Array;
  } {
    if (envelope.length < ENVELOPE_HEADER_SIZE) {
      throw new Error('Invalid envelope: too short for header');
    }

    // Verify magic
    const magic = String.fromCharCode(
      envelope[0] ?? 0,
      envelope[1] ?? 0,
      envelope[2] ?? 0,
      envelope[3] ?? 0,
    );
    if (magic !== ENVELOPE_MAGIC) {
      throw new Error(
        `Invalid magic: expected ${ENVELOPE_MAGIC}, got ${magic}`,
      );
    }

    const epochId =
      (envelope[5] ?? 0) |
      ((envelope[6] ?? 0) << 8) |
      ((envelope[7] ?? 0) << 16) |
      ((envelope[8] ?? 0) << 24);
    const shardId =
      (envelope[9] ?? 0) |
      ((envelope[10] ?? 0) << 8) |
      ((envelope[11] ?? 0) << 16) |
      ((envelope[12] ?? 0) << 24);
    const nonce = envelope.slice(13, 37);

    return { epochId, shardId, nonce };
  },

  verifyShard(ciphertext: Uint8Array, expectedSha256: string): boolean {
    return mockHash(ciphertext) === expectedSha256;
  },

  signManifest(manifest: Uint8Array, signSecretKey: Uint8Array): Uint8Array {
    // Mock: return deterministic 64-byte signature
    const sig = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
      const manifestByte = manifest[i % manifest.length] ?? 0;
      const keyByte = signSecretKey[i % signSecretKey.length] ?? 0;
      sig[i] = (manifestByte + keyByte) & 0xff;
    }
    return sig;
  },

  verifyManifest(
    _manifest: Uint8Array,
    signature: Uint8Array,
    _signPublicKey: Uint8Array,
  ): boolean {
    // Mock: always return true for testing
    return signature.length === 64;
  },

  sealAndSignBundle(
    bundle: EpochKeyBundle,
    _recipientEd25519Pub: Uint8Array,
    ownerIdentityKeypair: IdentityKeypair,
  ): SealedBundle {
    // Mock: create deterministic sealed output
    const bundleStr = JSON.stringify({
      v: bundle.version,
      a: bundle.albumId,
      e: bundle.epochId,
    });
    const sealed = new TextEncoder().encode(bundleStr);

    return {
      sealed,
      signature: mockBytes(64, bundle.epochId),
      sharerPubkey: ownerIdentityKeypair.ed25519.publicKey,
    };
  },

  verifyAndOpenBundle(
    sealed: Uint8Array,
    _signature: Uint8Array,
    _ownerEd25519Pub: Uint8Array,
    myIdentityKeypair: IdentityKeypair,
    expectedContext: BundleValidationContext,
  ): EpochKeyBundle {
    // Mock: parse the mock sealed data and return a bundle
    const text = new TextDecoder().decode(sealed);
    let parsed: { v: number; a: string; e: number };

    try {
      parsed = JSON.parse(text);
    } catch {
      // Return a default mock bundle
      parsed = {
        v: 1,
        a: expectedContext.albumId,
        e: expectedContext.minEpochId,
      };
    }

    return {
      version: parsed.v,
      albumId: parsed.a,
      epochId: parsed.e,
      recipientPubkey: myIdentityKeypair.ed25519.publicKey,
      epochSeed: mockBytes(32, parsed.e * 10),
      signKeypair: {
        publicKey: mockBytes(32, parsed.e * 10 + 1),
        secretKey: mockBytes(64, parsed.e * 10 + 2),
      },
    };
  },

  memzero(buffer: Uint8Array): void {
    // Actually zero the buffer for correctness
    buffer.fill(0);
  },

  randomBytes(length: number): Uint8Array {
    // Use crypto.getRandomValues if available, else mock
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      return crypto.getRandomValues(new Uint8Array(length));
    }
    // Fallback mock random
    return mockBytes(length, Math.floor(Math.random() * 256));
  },

  sha256(data: Uint8Array): string {
    return mockHash(data);
  },
};

export default mockCrypto;
