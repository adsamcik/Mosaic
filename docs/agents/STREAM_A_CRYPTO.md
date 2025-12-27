# Stream A: Crypto Core Implementation

**Duration:** 1 week  
**Depends On:** Phase 0 (interfaces + Argon2id params)  
**Parallel With:** Stream B (Backend), Stream C (Frontend)  
**Deliverable:** `libs/crypto/` - fully tested TypeScript library

---

## Context

You are implementing the cryptographic core for Mosaic, a zero-knowledge photo gallery. All encryption/decryption happens client-side. The server NEVER sees plaintext.

**Critical Security Properties:**
- Nonces MUST be unique per encryption (24 random bytes)
- Keys MUST be wiped from memory after use (`sodium.memzero`)
- Reserved header bytes MUST be validated as zero on decrypt
- Ed25519 → X25519 conversion MUST use libsodium's functions (clamping)

---

## Dependencies

```json
{
  "dependencies": {
    "libsodium-wrappers": "^0.7.13"
  },
  "devDependencies": {
    "vitest": "^1.0.0",
    "@vitest/coverage-v8": "^1.0.0",
    "typescript": "^5.3.0"
  }
}
```

---

## Module Structure

```
libs/crypto/
├── src/
│   ├── index.ts           # Public exports
│   ├── types.ts           # Type definitions (from Phase 0)
│   ├── keychain.ts        # Key derivation (Argon2id + HKDF)
│   ├── keybox.ts          # XChaCha20-Poly1305 wrap/unwrap
│   ├── envelope.ts        # Sharded envelope format
│   ├── epochs.ts          # Epoch key management
│   ├── signer.ts          # Ed25519 signing
│   ├── identity.ts        # Identity keypair + Ed25519↔X25519
│   ├── sharing.ts         # Authenticated sealed boxes
│   └── utils.ts           # Helpers (concat, compare, etc.)
├── tests/
│   ├── keychain.test.ts
│   ├── keybox.test.ts
│   ├── envelope.test.ts
│   ├── epochs.test.ts
│   ├── signer.test.ts
│   ├── identity.test.ts
│   └── sharing.test.ts
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## Task 1: Keychain Module

### File: `src/keychain.ts`

```typescript
import sodium from 'libsodium-wrappers';
import type { DerivedKeys, Argon2Params } from './types';

export function getArgon2Params(): Argon2Params {
  const isMobile = /Android|iPhone|iPad/.test(navigator.userAgent);
  return isMobile 
    ? { memory: 32 * 1024, iterations: 4, parallelism: 1 }
    : { memory: 64 * 1024, iterations: 3, parallelism: 1 };
}

export async function deriveKeys(
  password: string, 
  userSalt: Uint8Array,      // 16 bytes, stored on server
  accountSalt: Uint8Array    // 16 bytes, stored on server
): Promise<DerivedKeys> {
  await sodium.ready;
  
  const params = getArgon2Params();
  
  // L0: Master Key (Argon2id)
  const masterKey = sodium.crypto_pwhash(
    32,
    password,
    userSalt,
    params.iterations,
    params.memory * 1024,  // Convert KiB to bytes
    sodium.crypto_pwhash_ALG_ARGON2ID13
  );
  
  // L1: Root Key (HKDF - but libsodium doesn't have HKDF, use crypto_kdf)
  // Alternative: use crypto_generichash with key
  const rootKey = sodium.crypto_generichash(
    32,
    sodium.from_string('SafeGallery_Root_v1'),
    masterKey
  );
  // Mix in account salt for domain separation
  const rootKeyFinal = sodium.crypto_generichash(32, accountSalt, rootKey);
  
  // Clean intermediate
  sodium.memzero(rootKey);
  
  // L2: Account Key - generated separately, this just derives wrapping key
  // The actual L2 is random and wrapped by rootKeyFinal
  
  return {
    masterKey,
    rootKey: rootKeyFinal,
    // Caller generates random L2 and calls wrapKey(l2, rootKeyFinal)
  };
}
```

### Tests Required

```typescript
// tests/keychain.test.ts
describe('keychain', () => {
  it('should derive consistent keys from same inputs', async () => {
    const password = 'test-password';
    const salt = sodium.randombytes_buf(16);
    const accountSalt = sodium.randombytes_buf(16);
    
    const keys1 = await deriveKeys(password, salt, accountSalt);
    const keys2 = await deriveKeys(password, salt, accountSalt);
    
    expect(keys1.masterKey).toEqual(keys2.masterKey);
    expect(keys1.rootKey).toEqual(keys2.rootKey);
  });
  
  it('should produce different keys for different passwords');
  it('should produce different keys for different salts');
  it('should produce 32-byte keys');
});
```

---

## Task 2: Keybox Module

### File: `src/keybox.ts`

```typescript
import sodium from 'libsodium-wrappers';

const NONCE_LENGTH = 24;
const TAG_LENGTH = 16;

/**
 * Wrap a key using XChaCha20-Poly1305
 * Format: nonce (24) || ciphertext || tag (16)
 */
export function wrapKey(key: Uint8Array, wrapper: Uint8Array): Uint8Array {
  if (wrapper.length !== 32) {
    throw new Error('Wrapper key must be 32 bytes');
  }
  
  const nonce = sodium.randombytes_buf(NONCE_LENGTH);
  const ciphertext = sodium.crypto_secretbox_easy(key, nonce, wrapper);
  
  // Prepend nonce
  const result = new Uint8Array(NONCE_LENGTH + ciphertext.length);
  result.set(nonce, 0);
  result.set(ciphertext, NONCE_LENGTH);
  
  return result;
}

/**
 * Unwrap a key
 */
export function unwrapKey(wrapped: Uint8Array, wrapper: Uint8Array): Uint8Array {
  if (wrapper.length !== 32) {
    throw new Error('Wrapper key must be 32 bytes');
  }
  if (wrapped.length < NONCE_LENGTH + TAG_LENGTH + 1) {
    throw new Error('Wrapped key too short');
  }
  
  const nonce = wrapped.slice(0, NONCE_LENGTH);
  const ciphertext = wrapped.slice(NONCE_LENGTH);
  
  const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, wrapper);
  if (!plaintext) {
    throw new Error('Failed to unwrap key - authentication failed');
  }
  
  return plaintext;
}
```

### Tests Required

```typescript
describe('keybox', () => {
  it('should round-trip wrap/unwrap');
  it('should fail unwrap with wrong wrapper key');
  it('should fail unwrap with corrupted ciphertext');
  it('should produce different ciphertext each time (random nonce)');
  it('should reject wrapper keys that are not 32 bytes');
});
```

---

## Task 3: Envelope Module

### File: `src/envelope.ts`

This is the most critical module. Implements the 64-byte header format.

```typescript
import sodium from 'libsodium-wrappers';
import type { ShardHeader, EncryptedShard } from './types';
import { sha256 } from './utils';

const MAGIC = new Uint8Array([0x53, 0x47, 0x7a, 0x6b]); // "SGzk"
const VERSION = 0x03;
const HEADER_SIZE = 64;
const NONCE_OFFSET = 13;
const NONCE_LENGTH = 24;
const RESERVED_OFFSET = 37;
const RESERVED_LENGTH = 27;

/**
 * Build envelope header
 */
function buildHeader(epochId: number, shardId: number): Uint8Array {
  const header = new Uint8Array(HEADER_SIZE);
  const view = new DataView(header.buffer);
  
  // Magic (4 bytes)
  header.set(MAGIC, 0);
  
  // Version (1 byte)
  header[4] = VERSION;
  
  // EpochID (4 bytes, little-endian)
  view.setUint32(5, epochId, true);
  
  // ShardID (4 bytes, little-endian)
  view.setUint32(9, shardId, true);
  
  // Nonce (24 bytes) - CRITICAL: fresh random bytes
  const nonce = sodium.randombytes_buf(NONCE_LENGTH);
  header.set(nonce, NONCE_OFFSET);
  
  // Reserved (27 bytes) - must be zero (already zeroed)
  
  return header;
}

/**
 * Parse and validate envelope header
 */
function parseHeader(envelope: Uint8Array): ShardHeader {
  if (envelope.length < HEADER_SIZE) {
    throw new Error('Envelope too short');
  }
  
  const header = envelope.slice(0, HEADER_SIZE);
  const view = new DataView(header.buffer, header.byteOffset);
  
  // Validate magic
  if (!sodium.compare(header.slice(0, 4), MAGIC)) {
    throw new Error('Invalid envelope magic');
  }
  
  // Validate version
  const version = header[4];
  if (version < VERSION) {
    throw new Error(`Unsupported envelope version: ${version}`);
  }
  
  // Validate reserved bytes are zero
  const reserved = header.slice(RESERVED_OFFSET, RESERVED_OFFSET + RESERVED_LENGTH);
  if (!reserved.every(b => b === 0)) {
    throw new Error('Invalid envelope: reserved bytes must be zero');
  }
  
  return {
    magic: 'SGzk',
    version,
    epochId: view.getUint32(5, true),
    shardId: view.getUint32(9, true),
    nonce: header.slice(NONCE_OFFSET, NONCE_OFFSET + NONCE_LENGTH),
    reserved,
  };
}

/**
 * Encrypt a shard
 */
export async function encryptShard(
  data: Uint8Array,
  readKey: Uint8Array,
  epochId: number,
  shardIndex: number
): Promise<EncryptedShard> {
  if (readKey.length !== 32) {
    throw new Error('ReadKey must be 32 bytes');
  }
  
  const header = buildHeader(epochId, shardIndex);
  const nonce = header.slice(NONCE_OFFSET, NONCE_OFFSET + NONCE_LENGTH);
  
  // Encrypt with header as AAD
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    data,
    header,  // AAD
    null,    // nsec (unused)
    nonce,
    readKey
  );
  
  // Combine header + ciphertext
  const envelope = new Uint8Array(HEADER_SIZE + ciphertext.length);
  envelope.set(header, 0);
  envelope.set(ciphertext, HEADER_SIZE);
  
  return {
    ciphertext: envelope,
    sha256: await sha256(envelope),
  };
}

/**
 * Decrypt a shard
 */
export async function decryptShard(
  envelope: Uint8Array,
  readKey: Uint8Array
): Promise<Uint8Array> {
  if (readKey.length !== 32) {
    throw new Error('ReadKey must be 32 bytes');
  }
  
  // Parse and validate header
  const header = parseHeader(envelope);
  const headerBytes = envelope.slice(0, HEADER_SIZE);
  const ciphertext = envelope.slice(HEADER_SIZE);
  
  // Decrypt with header as AAD
  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,           // nsec (unused)
    ciphertext,
    headerBytes,    // AAD
    header.nonce,
    readKey
  );
  
  if (!plaintext) {
    throw new Error('Decryption failed - authentication error');
  }
  
  return plaintext;
}

/**
 * Extract header without decrypting (for routing/epoch lookup)
 */
export function peekHeader(envelope: Uint8Array): ShardHeader {
  return parseHeader(envelope);
}
```

### Tests Required

```typescript
describe('envelope', () => {
  it('should round-trip encrypt/decrypt');
  it('should fail decrypt with wrong key');
  it('should fail decrypt with corrupted header');
  it('should fail decrypt with corrupted ciphertext');
  it('should fail if reserved bytes are non-zero');
  it('should produce different ciphertext each time (random nonce)');
  it('should include epochId and shardId in header');
  it('should verify header via AAD (reject header tampering)');
  it('should produce consistent SHA256 hash');
});
```

---

## Task 4: Identity Module

### File: `src/identity.ts`

```typescript
import sodium from 'libsodium-wrappers';
import type { IdentityKeypair } from './types';

/**
 * Generate identity keypair from seed
 * Returns both Ed25519 (signing) and X25519 (encryption) keypairs
 */
export function deriveIdentityKeypair(seed: Uint8Array): IdentityKeypair {
  if (seed.length !== 32) {
    throw new Error('Identity seed must be 32 bytes');
  }
  
  // Generate Ed25519 keypair from seed
  const ed25519 = sodium.crypto_sign_seed_keypair(seed);
  
  // Convert to X25519 for encryption
  const x25519Secret = sodium.crypto_sign_ed25519_sk_to_curve25519(ed25519.privateKey);
  const x25519Public = sodium.crypto_sign_ed25519_pk_to_curve25519(ed25519.publicKey);
  
  return {
    ed25519: {
      publicKey: ed25519.publicKey,
      secretKey: ed25519.privateKey,
    },
    x25519: {
      publicKey: x25519Public,
      secretKey: x25519Secret,
    },
  };
}

/**
 * Convert Ed25519 public key to X25519 (for encrypting to recipient)
 */
export function ed25519PubToX25519(ed25519Pub: Uint8Array): Uint8Array {
  if (ed25519Pub.length !== 32) {
    throw new Error('Ed25519 public key must be 32 bytes');
  }
  return sodium.crypto_sign_ed25519_pk_to_curve25519(ed25519Pub);
}

/**
 * Generate random identity seed (for new accounts)
 */
export function generateIdentitySeed(): Uint8Array {
  return sodium.randombytes_buf(32);
}
```

### Tests Required

```typescript
describe('identity', () => {
  it('should derive consistent keypairs from same seed');
  it('should produce valid Ed25519 signatures');
  it('should produce valid X25519 key exchange');
  it('should convert Ed25519 pubkey to X25519');
  it('should reject invalid seed lengths');
});
```

---

## Task 5: Signer Module

### File: `src/signer.ts`

```typescript
import sodium from 'libsodium-wrappers';
import { concat } from './utils';

const SHARD_CONTEXT = new TextEncoder().encode('SG_Shard_v1');
const MANIFEST_CONTEXT = new TextEncoder().encode('SG_Manifest_v1');

/**
 * Sign manifest (for upload authentication)
 */
export function signManifest(
  manifest: Uint8Array, 
  signSecretKey: Uint8Array
): Uint8Array {
  const message = concat(MANIFEST_CONTEXT, manifest);
  return sodium.crypto_sign_detached(message, signSecretKey);
}

/**
 * Verify manifest signature
 */
export function verifyManifest(
  manifest: Uint8Array,
  signature: Uint8Array,
  signPublicKey: Uint8Array
): boolean {
  const message = concat(MANIFEST_CONTEXT, manifest);
  return sodium.crypto_sign_verify_detached(signature, message, signPublicKey);
}

/**
 * Sign shard (header + ciphertext)
 */
export function signShard(
  header: Uint8Array,
  ciphertext: Uint8Array,
  signSecretKey: Uint8Array
): Uint8Array {
  const message = concat(SHARD_CONTEXT, header, ciphertext);
  return sodium.crypto_sign_detached(message, signSecretKey);
}

/**
 * Verify shard signature
 */
export function verifyShard(
  header: Uint8Array,
  ciphertext: Uint8Array,
  signature: Uint8Array,
  signPublicKey: Uint8Array
): boolean {
  const message = concat(SHARD_CONTEXT, header, ciphertext);
  return sodium.crypto_sign_verify_detached(signature, message, signPublicKey);
}
```

---

## Task 6: Sharing Module

### File: `src/sharing.ts`

```typescript
import sodium from 'libsodium-wrappers';
import type { EpochKeyBundle, SealedBundle, IdentityKeypair } from './types';
import { ed25519PubToX25519 } from './identity';
import { concat } from './utils';

const BUNDLE_CONTEXT = new TextEncoder().encode('Mosaic_EpochBundle_v1');

/**
 * Seal epoch key bundle for recipient and sign with owner's identity
 */
export function sealAndSignBundle(
  bundle: EpochKeyBundle,
  recipientEd25519Pub: Uint8Array,
  ownerIdentity: IdentityKeypair
): SealedBundle {
  // Serialize bundle
  const bundleBytes = new TextEncoder().encode(JSON.stringify({
    version: bundle.version,
    albumId: bundle.albumId,
    epochId: bundle.epochId,
    recipientPubkey: sodium.to_base64(bundle.recipientPubkey),
    readKey: sodium.to_base64(bundle.readKey),
    signKeypair: {
      publicKey: sodium.to_base64(bundle.signKeypair.publicKey),
      secretKey: sodium.to_base64(bundle.signKeypair.secretKey),
    },
  }));
  
  // Convert recipient pubkey to X25519
  const recipientX25519Pub = ed25519PubToX25519(recipientEd25519Pub);
  
  // Seal (anonymous encryption)
  const sealed = sodium.crypto_box_seal(bundleBytes, recipientX25519Pub);
  
  // Sign the sealed ciphertext
  const toSign = concat(BUNDLE_CONTEXT, sealed);
  const signature = sodium.crypto_sign_detached(toSign, ownerIdentity.ed25519.secretKey);
  
  return {
    sealed,
    signature,
    sharerPubkey: ownerIdentity.ed25519.publicKey,
  };
}

/**
 * Verify owner signature and open sealed bundle
 */
export function verifyAndOpenBundle(
  sealed: Uint8Array,
  signature: Uint8Array,
  ownerEd25519Pub: Uint8Array,
  myIdentity: IdentityKeypair,
  expectedContext: { albumId: string; minEpochId: number }
): EpochKeyBundle {
  // Verify signature FIRST
  const toVerify = concat(BUNDLE_CONTEXT, sealed);
  if (!sodium.crypto_sign_verify_detached(signature, toVerify, ownerEd25519Pub)) {
    throw new Error('Invalid bundle signature - not from claimed owner');
  }
  
  // Open sealed box
  const bundleBytes = sodium.crypto_box_seal_open(
    sealed,
    myIdentity.x25519.publicKey,
    myIdentity.x25519.secretKey
  );
  
  if (!bundleBytes) {
    throw new Error('Failed to open sealed bundle');
  }
  
  // Parse and validate
  const bundle = JSON.parse(new TextDecoder().decode(bundleBytes));
  
  if (bundle.albumId !== expectedContext.albumId) {
    throw new Error('Bundle albumId mismatch');
  }
  if (bundle.epochId < expectedContext.minEpochId) {
    throw new Error('Bundle epochId too old');
  }
  
  // Verify recipient binding
  const myPubkeyBase64 = sodium.to_base64(myIdentity.ed25519.publicKey);
  if (bundle.recipientPubkey !== myPubkeyBase64) {
    throw new Error('Bundle not intended for this recipient');
  }
  
  return {
    version: bundle.version,
    albumId: bundle.albumId,
    epochId: bundle.epochId,
    recipientPubkey: sodium.from_base64(bundle.recipientPubkey),
    readKey: sodium.from_base64(bundle.readKey),
    signKeypair: {
      publicKey: sodium.from_base64(bundle.signKeypair.publicKey),
      secretKey: sodium.from_base64(bundle.signKeypair.secretKey),
    },
  };
}
```

---

## Task 7: Utils Module

### File: `src/utils.ts`

```typescript
import sodium from 'libsodium-wrappers';

/**
 * Concatenate multiple Uint8Arrays
 */
export function concat(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * Constant-time comparison
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return sodium.compare(a, b) === 0;
}

/**
 * Compute SHA256 hash (returns base64)
 */
export async function sha256(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return sodium.to_base64(new Uint8Array(hashBuffer));
}

/**
 * Secure memory wipe
 */
export function memzero(buffer: Uint8Array): void {
  sodium.memzero(buffer);
}
```

---

## Exit Criteria

- [ ] All modules implemented per specifications above
- [ ] All tests passing with >90% coverage
- [ ] No ESLint/TypeScript errors
- [ ] Bundle size < 300KB (excl. libsodium)
- [ ] Reviewed for security invariants:
  - [ ] Nonces always fresh random
  - [ ] Keys wiped after use
  - [ ] Reserved bytes validated
  - [ ] Domain separation contexts used

---

## Handoff

Once complete:
1. Publish package to workspace: `npm run build`
2. Notify Stream C (Frontend) that real crypto is ready
3. Integration tests with backend can begin
