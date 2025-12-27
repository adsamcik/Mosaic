# Mosaic Security Model

## Trust Model

### What the Server Knows

- User identity (via authentication proxy)
- Encrypted blob storage locations
- Album membership relationships
- Manifest signatures and signer public keys
- Timestamps and version numbers

### What the Server Cannot Know

- Photo contents (encrypted with epoch ReadKey)
- Photo metadata (encrypted in manifest)
- User passwords or derived keys
- Epoch ReadKeys (encrypted for recipients only)

### Compromise Scenarios

| Scenario | Impact |
|----------|--------|
| Server database breach | Attacker gets encrypted blobs, cannot decrypt |
| Server code execution | Cannot forge manifests (no signing keys) |
| Client device theft | Protected by password-derived keys + idle timeout |
| Password compromise | Access to victim's albums until password changed |

## Key Hierarchy

```
L0 (Master Key)
│   └─ Argon2id(password, salt)
│   └─ NEVER stored, derived on login
│
└── L1 (Root Key)
    │   └─ HKDF-SHA256(L0, account_salt, "SafeGallery_Root_v1")
    │   └─ NEVER stored, derived from L0
    │
    └── L2 (Account Key)
        │   └─ random(32 bytes)
        │   └─ Stored: XChaCha20-Poly1305(L1, L2)
        │
        └── Identity Seed
        │   └─ random(32 bytes)
        │   └─ Stored: XChaCha20-Poly1305(L2, seed)
        │   └─ Derives: Ed25519 (signing) + X25519 (encryption)
        │
        └── L3 (Epoch Keys) - per album
            └─ ReadKey: random(32 bytes) for XChaCha20
            └─ SignKey: Ed25519 keypair for manifests
            └─ Distributed via sealed boxes to members
```

## Epoch Key Lifecycle

### Creation

New epoch keys are generated when:
1. A new album is created
2. A member is removed (key rotation)

### Distribution

```
Owner                           Recipient
  │                                 │
  │  1. Generate epoch keys         │
  │  2. Serialize bundle            │
  │  3. Seal with recipient pubkey  │
  │  4. Sign sealed ciphertext      │
  │  5. Store in epoch_keys table   │
  │──────────────────────────────▶│
  │                                 │
  │                   6. Verify signature
  │                   7. Open sealed box
  │                   8. Validate context
  │                   9. Store locally
```

### Revocation

When a member is removed:
1. Generate **completely new** random epoch keys (never derive from previous)
2. Increment epoch ID
3. Distribute new keys to remaining members only
4. Revoked user retains access to historical epochs (backward secrecy only)

## Cryptographic Primitives

| Operation | Algorithm | Key Size | Notes |
|-----------|-----------|----------|-------|
| Password hashing | Argon2id | 32B output | 32-64MB memory, 3-4 iterations |
| Key derivation | HKDF-SHA256 | 32B output | With context strings |
| Symmetric encryption | XChaCha20-Poly1305 | 32B | 24B nonce, 16B tag |
| Signing | Ed25519 | 32B seed | 64B signature |
| Key exchange | X25519 | 32B | For sealed boxes |
| Hashing | SHA-256 | 32B | For shard verification |

## Envelope Format

Each encrypted shard has a 64-byte header:

```
Offset  Size  Field
──────  ────  ─────────────────
0       4     Magic ("SGzk")
4       1     Version (0x03)
5       4     Epoch ID (LE u32)
9       4     Shard Index (LE u32)
13      24    Nonce
37      27    Reserved (MUST be zero)
```

- **AAD:** Entire 64-byte header
- **Encryption:** XChaCha20-Poly1305
- **Payload:** Up to 6MB chunk + 16B auth tag

## Critical Invariants

### Nonce Uniqueness

**CRITICAL:** Never reuse a nonce with the same key.

```typescript
// CORRECT: Fresh random nonce per encryption
const nonce = sodium.randombytes_buf(24);

// WRONG: Counter-based nonce (risky if state lost)
// WRONG: Derived nonce (collision risk)
// WRONG: Reusing nonce from failed upload
```

### Reserved Byte Validation

On decryption, always verify reserved bytes are zero:

```typescript
if (!header.slice(37, 64).every(b => b === 0)) {
  throw new Error('Invalid envelope: non-zero reserved bytes');
}
```

This enables future format extensions while preventing downgrade attacks.

### Key Wiping

Sensitive keys must be zeroed after use:

```typescript
try {
  const plaintext = decrypt(ciphertext, key);
  return plaintext;
} finally {
  sodium.memzero(key);
}
```

### Shard Integrity

Downloaded shards must be verified against the signed manifest:

```typescript
const actualHash = sha256(downloadedCiphertext);
const expectedHash = manifest.shards[index].sha256;

if (!constantTimeEqual(actualHash, expectedHash)) {
  throw new Error('Shard integrity check failed');
}
```

## Forward Secrecy Limitations

### Epoch Keys

- **Provides:** Backward secrecy (future keys don't expose past content)
- **Does NOT provide:** Forward secrecy (past key compromise exposes past content)
- **Acceptable:** At small scale, key rotation on eviction is sufficient

### Identity Keys (Invite Encryption)

- Uses static identity keys for `crypto_box_seal`
- If identity key is compromised, historical invites are exposed
- **Mitigation:** Invites contain epoch keys, not content directly
- **Mitigation:** Epoch rotation limits blast radius

For real-time messaging features, consider migrating to X3DH.

## Conflict Resolution

Multi-device scenarios use Last-Writer-Wins:

1. Each photo has stable `asset_id` (UUID)
2. Edits include `updated_at` timestamp and `device_id`
3. Conflict resolution: Latest `updated_at` wins, `device_id` as tiebreaker
4. Server accepts all valid manifests; clients merge locally

## Session Security

- **Idle timeout:** 30 minutes of inactivity triggers logout
- **Key clearing:** All session keys zeroed from memory on logout
- **No persistent sessions:** Password required on each login
- **Persistent storage:** OPFS with encrypted SQLite database

## Audit Checklist

Before deployment, verify:

- [ ] Argon2id parameters tuned for target devices (500-1000ms)
- [ ] All nonces generated with `randombytes_buf(24)`
- [ ] Reserved bytes validated on every decrypt
- [ ] Keys wiped with `memzero()` after use
- [ ] Shard hashes verified after download
- [ ] Bundle signatures verified before unsealing
- [ ] COOP/COEP headers configured for SharedArrayBuffer
- [ ] Trusted proxy CIDR list configured correctly
- [ ] Database backups encrypted at rest
