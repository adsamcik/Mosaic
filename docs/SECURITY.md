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

## Share Link Security

Share links enable album owners to grant anonymous access to album content without requiring recipients to have accounts. The cryptographic model ensures zero-knowledge properties are maintained.

### Link Secret Generation

When creating a share link, the client generates a **32-byte random secret**:

```typescript
const linkSecret = sodium.randombytes_buf(32);
```

- Generated entirely client-side using CSPRNG
- Never sent to or stored on server in plaintext
- Forms the root of all link-specific key derivation

### Key Derivation

Link-specific keys are derived using BLAKE2b with domain separation (HKDF-style):

```
linkSecret (32 bytes)
    │
    ├── linkId (16 bytes)
    │   └─ BLAKE2b(linkSecret, context="mosaic:link:id:v1", outlen=16)
    │   └─ Sent to server for lookup
    │
    └── wrappingKey (32 bytes)
        └─ BLAKE2b(linkSecret, context="mosaic:link:wrap:v1", outlen=32)
        └─ Never leaves client, used to wrap tier keys
```

**Domain separation** ensures that even with the same `linkSecret`, the derived keys are cryptographically independent. An attacker who obtains `linkId` cannot reverse-engineer `linkSecret` or derive `wrappingKey`.

### URL Structure

Share links use URL fragments to keep secrets out of server logs:

```
https://app/s/{base64url(linkId)}#k={base64url(linkSecret)}
         │                        │
         └─ Sent to server        └─ NEVER sent to server
```

- **Path component**: Contains only the derived `linkId`
- **Fragment (`#k=...`)**: Contains the full `linkSecret`
- Browsers do not transmit fragments to servers (RFC 3986)
- Server only ever sees the `linkId`, never the `linkSecret`

### Tier Key Wrapping

Album epoch keys are organized into three access tiers:

| Tier | Access Level | Keys Wrapped |
|------|--------------|--------------|
| 1 | Thumbnail only | thumbKey |
| 2 | Preview | thumbKey + previewKey |
| 3 | Full resolution | thumbKey + previewKey + originalKey |

When creating a share link:

1. Owner determines which tier keys to include based on `accessTier`
2. Each tier key is encrypted with `wrappingKey` using XChaCha20-Poly1305
3. Wrapped keys are stored on server alongside the `linkId`

```typescript
// Owner wraps tier keys for the share link
const wrappedThumbKey = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
  thumbKey,
  null, // no AAD
  freshNonce,
  wrappingKey
);
```

Only someone with the original `linkSecret` can derive `wrappingKey` and unwrap the tier keys.

### Owner Secret Storage

To support epoch rotation, owners must be able to recover `linkSecret` for active links:

```
ownerEncryptedSecret = XChaCha20-Poly1305(accountKey, linkSecret)
```

- Stored on server alongside the share link
- Encrypted with owner's L2 account key
- Only the album owner can decrypt it
- Used during epoch rotation to re-wrap new epoch keys

### Epoch Rotation for Share Links

When an album's epoch rotates (e.g., member removal), share links must be updated:

```
Owner                                    Server
  │                                        │
  │  1. Fetch active share links           │
  │◀───────────────────────────────────────│
  │                                        │
  │  2. For each link:                     │
  │     a. Decrypt ownerEncryptedSecret    │
  │        with accountKey                 │
  │     b. Derive wrappingKey from secret  │
  │     c. Wrap NEW epoch tier keys        │
  │                                        │
  │  3. Upload new wrapped keys            │
  │───────────────────────────────────────▶│
```

This ensures:
- Share links continue to work after epoch rotation
- New epoch keys are protected with the same `wrappingKey`
- Anonymous users experience no disruption

### Link Revocation

Share links can be revoked by the album owner:

- **Server-side enforcement**: `isRevoked` flag set on the link record
- **Immediate effect**: Server rejects all requests for revoked links
- **No key distribution**: Wrapped keys remain stored but inaccessible
- **Audit trail**: Revocation timestamp preserved for compliance

```typescript
// Server rejects access to revoked links
if (shareLink.isRevoked) {
  return Forbid("Share link has been revoked");
}
```

### Access Controls

Multiple server-enforced controls limit share link access:

| Control | Enforcement | Description |
|---------|-------------|-------------|
| `maxUses` | Server counter | Rejects after N successful accesses |
| `expiresAt` | Server timestamp | Rejects after expiry date/time |
| `accessTier` | Cryptographic | Only tier-appropriate keys are wrapped |
| `isRevoked` | Server flag | Immediate access termination |

**Cryptographic enforcement of `accessTier`**: The owner only wraps keys up to the specified tier. Even if an attacker bypassed server checks, they couldn't decrypt higher-tier content because those keys were never wrapped.

### Security Properties

| Property | Guarantee |
|----------|-----------|
| **Zero-knowledge** | Server never sees `linkSecret` or plaintext tier keys |
| **Forward secrecy per link** | Each link has unique `wrappingKey`; compromise of one link doesn't affect others |
| **Revocation** | Server-side enforcement; no need to contact or revoke keys from anonymous users |
| **Tier isolation** | Access tier cryptographically enforced; higher-tier keys not available at lower tiers |
| **Epoch independence** | Links survive epoch rotation via owner re-wrapping |

### Threat Analysis

| Threat | Mitigation |
|--------|------------|
| Server database breach | Attacker gets `linkId` and wrapped keys; cannot derive `wrappingKey` without `linkSecret` |
| Link URL leaked | Revoke link immediately; server blocks further access |
| Brute force `linkId` | 16 bytes = 2^128 possibilities; infeasible |
| Man-in-the-middle | HTTPS required; fragment never transmitted |
| Replay attack | `maxUses` counter prevents reuse beyond limit |

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
