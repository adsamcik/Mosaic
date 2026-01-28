# Mosaic Security Audit Documentation

## Overview

Mosaic is a zero-knowledge encrypted photo gallery. This document describes the security model, known threats, and audit procedures.

## Zero-Knowledge Architecture

### Core Principle

The server **never** sees plaintext photos or metadata. All encryption and decryption happens client-side using libsodium (via `@mosaic/crypto`).

### Encryption Algorithms

| Algorithm | Use Case |
| --------- | -------- |
| XChaCha20-Poly1305 | Symmetric encryption for photos, manifests, keys |
| Ed25519 | Digital signatures for verifying content integrity |
| X25519 | Asymmetric key exchange for sharing epoch keys |
| Argon2id | Password-based key derivation (L0 master key) |
| HKDF-SHA256 | Deriving sub-keys from master key |
| BLAKE2b | Hashing for thumbhashes, key derivation contexts |

### Key Hierarchy

```
L0 (Master)   = Argon2id(password, account_salt)     # Never stored, derived from password
L1 (Root)     = HKDF(L0, "root-key")                 # Never stored, used to wrap L2
L2 (Account)  = random(32), encrypted by L1          # Stored on server (wrapped)
L3 (Epoch)    = ReadKey + SignKeypair per album      # Encrypted to each member's identity
```

### Zero-Knowledge Invariants

1. **Server stores only encrypted blobs** - All photo data, manifest metadata, and epoch keys are encrypted before leaving the client.

2. **Keys never leave the client in plaintext** - Epoch keys are wrapped (encrypted) to recipients' identity public keys before transmission.

3. **Server cannot decrypt content** - Without access to L0 (password), L2 (account key), or L3 (epoch keys), the server cannot read any content.

4. **Verification is client-side** - Ed25519 signatures on manifests are verified by clients to detect tampering.

## Threat Model

### In Scope

| Threat | Mitigation |
| ------ | ---------- |
| Server compromise | Zero-knowledge encryption - server has only ciphertext |
| Network interception | TLS + client-side encryption |
| Database breach | All sensitive data encrypted, keys never stored plaintext |
| Malicious admin | Cannot decrypt content without user's password |
| Session hijacking | Session tokens hashed before storage, idle timeout |

### Out of Scope (Assumed Secure)

- Client device compromise
- Malicious client-side code (trusted frontend)
- Side-channel attacks on the browser
- Phishing for user passwords

## Data Flow Security

### Photo Upload

1. Client encrypts photo shards with tier-specific keys derived from epoch seed
2. Client computes SHA256 of encrypted shard
3. Encrypted shards uploaded via TUS protocol (resumable)
4. Server computes SHA256 of received data (transport integrity)
5. Server stores SHA256 hash for download verification
6. Client creates signed manifest containing shard references
7. Manifest metadata encrypted with thumbKey before upload

### Photo Download

1. Client requests shard from server
2. Server returns shard with `X-Content-SHA256` header
3. Client verifies SHA256 matches expected hash
4. Client verifies manifest signature
5. Client decrypts shard with appropriate tier key

### Key Sharing

1. Album owner generates epoch keys (readKey + signKeypair)
2. Keys wrapped (encrypted) to each member's identity public key
3. Wrapped keys stored on server per-recipient
4. Recipients unwrap keys using their identity private key
5. Wrapped keys include owner signature for authenticity

## Implementation Security

### Memory Safety

- All sensitive key material is zeroed after use (`sodium.memzero()`)
- Keys stored in memory only as long as needed
- Session key cache cleared on logout

### Error Handling

- Crypto errors are caught explicitly (never swallowed)
- Error messages sanitized to avoid leaking sensitive info
- Failed decryption attempts logged without key material

### Transport Security

- All API calls require authentication
- Session tokens are SHA256 hashed before database storage
- Idle timeout invalidates sessions automatically
- CORS configured for same-origin only

## Database Security

### Unique Constraints

- `(AlbumId, RecipientId, EpochId)` on EpochKeys - prevents duplicate distribution
- `AuthSub` on Users - prevents duplicate accounts

### Concurrency Handling

- `DbUpdateConcurrencyException` handled globally via `DatabaseExceptionHandler`
- Unique constraint violations return 409 Conflict (not 500 error)
- Row-level locking (FOR UPDATE) on album operations (PostgreSQL)

### Soft Deletion

- Manifests use `IsDeleted` flag for soft deletion
- Shards transition PENDING → ACTIVE → TRASHED
- Garbage collection removes expired pending shards

## Authentication Modes

### LocalAuth (Session-based)

- Username/password with Argon2id verification
- Session tokens issued on successful login
- Tokens hashed before database storage

### ProxyAuth (Trusted Reverse Proxy)

- Trusts `Remote-User` header from configured proxies
- IP-based proxy validation with CIDR matching
- Auto-creates user records on first access

### Both Modes Can Be Enabled Simultaneously

- `Auth:LocalAuthEnabled=true` and `Auth:ProxyAuthEnabled=true`
- Request tries both mechanisms in order

## Audit Procedures

### Code Review Checklist

- [ ] No plaintext keys logged or serialized
- [ ] `sodium.memzero()` called on sensitive buffers
- [ ] Nonces are 24 bytes and never reused
- [ ] Signatures verified before trusting content
- [ ] Error messages don't leak internal details

### Penetration Testing Scope

1. **Authentication bypass** - Attempt access without valid session
2. **Authorization escalation** - Access albums without membership
3. **Injection attacks** - SQL injection, XSS in user inputs
4. **Cryptographic attacks** - Nonce reuse, padding oracle
5. **Information disclosure** - Error messages, timing attacks

### Automated Security Checks

- Static analysis for crypto usage patterns
- Dependency vulnerability scanning
- SAST for SQL injection, XSS patterns

## Known Limitations

1. **No forward secrecy** - Compromised L2 key reveals all past content
2. **Trust-on-first-use** - No PKI for identity key verification
3. **Single device limit** - Account key tied to device storage
4. **No key rotation** - Epoch keys not automatically rotated

## Incident Response

### Suspected Compromise

1. Invalidate all sessions for affected users
2. Force password reset
3. Rotate epoch keys (create new epoch, re-wrap to members)
4. Audit access logs for anomalies

### Data Breach Notification

- If encrypted data accessed: Low severity (ciphertext only)
- If decryption possible: Critical (notify affected users immediately)

## Version History

| Version | Date | Changes |
| ------- | ---- | ------- |
| 1.0 | 2025-01-XX | Initial security documentation |

---

**Last Updated:** January 2025
**Document Owner:** Security Team
