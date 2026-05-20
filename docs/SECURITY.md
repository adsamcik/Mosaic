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
│   └─ Argon2id(password, salt, server-pinned per-account KDF profile)
│   └─ NEVER stored, derived on login
│   └─ KDF profile is selected only at registration, persisted by the server,
│      and returned during auth bootstrap to prevent cross-device drift
│
└── L1 (Root Key)
    │   └─ HKDF-SHA256(L0, account_salt, "mosaic:root-key:v1")
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
37      1     ShardTier (1=thumb, 2=preview, 3=full)
38      26    Reserved (MUST be zero)
```

- **AAD:** Entire 64-byte header
- **Encryption:** XChaCha20-Poly1305
- **Payload:** Up to 100MB chunk + 16B auth tag

## Image Processing Constraints

Due to the zero-knowledge architecture, the **server cannot perform any image processing**:

| Processing | Server-Side | Client-Side | Reason |
|------------|-------------|-------------|--------|
| Resize images | ❌ Impossible | ✅ Required | Content is encrypted |
| Convert to WebP | ❌ Impossible | ✅ Required | Server sees only ciphertext |
| Generate thumbnails | ❌ Impossible | ✅ Required | No access to plaintext |
| Strip EXIF metadata | ❌ Impossible | ✅ Required | Privacy-preserving |

### Recommended Client-Side Processing

Before encryption and upload, the frontend should:

1. **Resize large images** - Use Canvas API or `browser-image-compression` to limit dimensions (e.g., max 4096px)
2. **Convert to WebP** - Use Canvas API with `toBlob('image/webp', quality)` for better compression
3. **Strip EXIF metadata** - Remove GPS coordinates and other sensitive metadata
4. **Generate thumbnails** - Create 200px and 800px variants for fast gallery loading

This ensures optimal storage usage while maintaining end-to-end encryption.

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

### Production WASM Build Floor

**CRITICAL:** The `weak-kdf` Cargo feature on `mosaic-crypto` / `mosaic-wasm`
relaxes Argon2id to a test-only profile (8 MiB / 1 iter) so KDF-bound test
runs stay tractable. Bytes built with `weak-kdf` MUST NEVER land at the
canonical production WASM path `apps/web/src/generated/mosaic-wasm/` —
otherwise a production bundle could silently inherit the relaxed KDF floor
(see `security-review-2026-05-20-02`).

Defense in depth (all four must pass):

1. **Script-level guard** — `scripts/build-rust-wasm.{sh,ps1}` and the
   Docker wrappers reject builds where `MOSAIC_WASM_CARGO_FEATURES`
   contains `weak-kdf` unless `MOSAIC_WASM_OUT_DIR` is set to the dedicated
   `apps/web/src/generated/mosaic-wasm-test-weak/` path. Exit code 64.
2. **CI workflow pinning** — every weak-kdf build step in
   `.github/workflows/{tests,publish}.yml` sets
   `MOSAIC_WASM_OUT_DIR=apps/web/src/generated/mosaic-wasm-test-weak`
   alongside the feature flag.
3. **Prebuild verifier** — `apps/web` `prebuild` invokes
   `scripts/verify-production-wasm-no-weak-kdf.mjs`, which fails the build
   if the canonical WASM is byte-identical to the test-weak artifact
   (smoking-gun evidence of contamination).
4. **Vite production guard** — `apps/web/vite.config.ts` refuses to start
   a production build when `VITE_E2E_WEAK_KEYS=true` or when the canonical
   and test-weak WASM bytes match.

## Forward Secrecy Limitations

### Epoch Keys

- **Does NOT provide:** Forward secrecy: an attacker who compromises L0 (the password-derived master) at time T can decrypt all photos uploaded BEFORE T given access to historical ciphertext. The system is intentionally password-derived, not session-key-based.
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

## Right-to-Erasure (GDPR Article 17)

Mosaic provides a full self-service account-deletion flow that satisfies the
right-to-erasure under GDPR Article 17. Any logged-in user can permanently
delete their own account, all owned content, and all derived state from the
**Settings → Security → Delete Account** entry; no operator intervention is
required.

### Endpoint

`DELETE /api/v1/users/me`

The endpoint is protected by both the standard session cookie and an
in-request defence-in-depth confirmation layer:

1. **Confirmation text.** The request body's `confirmationText` MUST equal the
   caller's username (case-sensitive). The web UI keeps the destructive button
   disabled until the typed text matches.
2. **Fresh authentication (LocalAuth mode only).** In LocalAuth deployments
   the body MUST also include `challengeId` + `confirmationSignature` +
   `timestamp` — a fresh Ed25519 attestation over a server-issued challenge,
   produced via the same `signAuthChallenge` flow used at login. This proves
   the caller still controls the password-derived auth key (and not just a
   stolen session cookie). In ProxyAuth deployments the upstream trusted
   proxy already gates every request, so this layer is skipped.

### What is deleted

| Category | Mechanism |
| -------- | --------- |
| User row, identity, wrapped account key | DB cascade from `users` |
| Owned albums, manifests, manifest_shards, share_links, album_memberships, album_content | DB cascade |
| Shards uploaded by the user (rows + encrypted blobs) | Explicit collect → orphan-row delete → post-commit blob delete |
| `auth_challenges` keyed by the user's username | DB delete (no FK) |
| Tus upload sessions started by the user | Post-commit cleanup |
| Active session cookie | Cleared in the response |
| Client-side state (OPFS, IDB, CacheStorage, localStorage, sessionStorage, crypto worker key cache) | Wiped client-side on 204 via `clearAllLocalState` |

### What is retained (anonymised, legitimate interest)

Audit log entries are **not** deleted. Instead, every row authored by the
erased account is anonymised in the same transaction:

- `audit_log_entries.actor_user_id = NULL`
- `audit_log_entries.actor_was_erased = TRUE`

The actor identifier is gone, so no PII remains; the
`actor_was_erased` flag distinguishes anonymised-because-erased from
NULL-because-system-event. Audit retention is justified under the **legitimate
interest** legal basis (security incident investigation, abuse detection,
quota fraud forensics) per GDPR Art.6(1)(f).

### Three-phase server flow

`UserErasureService` orchestrates deletion in three explicit phases:

1. **Collect** — gather every shard the user owns (both `uploader_id = me`
   and shards reachable through manifests in albums the user owns), every
   blob storage key, and every active Tus upload session ID. This snapshot is
   taken **before** the destructive transaction so post-commit cleanup has
   a stable reference list.
2. **Transactional DB delete** — cascade-delete the `users` row (drops
   `albums`, `album_memberships`, `manifests`, `manifest_shards`,
   `share_links`, etc.), then delete `auth_challenges` by username (no FK),
   then explicitly delete the orphan `shards` rows whose `Uploader` FK is
   `SetNull`, then anonymise audit entries with `ExecuteUpdateAsync`. The
   entire DB mutation is one transaction — either the user is fully gone, or
   nothing changes.
3. **Post-commit cleanup** — best-effort delete of encrypted shard blobs
   from the storage backend and abandoned Tus upload sessions. Failures
   here are **logged but not rolled back** — the storage garbage collector
   sweeps orphans on its next cycle, and rolling back the DB transaction
   over a transient S3/filesystem error would leave the user re-able to log
   in, which is worse.

### Threat model and defences

| Threat | Defence |
| ------ | ------- |
| Accidental click | Type-username confirmation |
| Stolen session cookie | LocalAuth fresh-auth signature verification |
| Replay of an old erasure request | Per-request `challengeId` consumed exactly once on the server |
| Server-side bug leaves shard blobs behind | Post-commit collect + GC sweep |
| Audit trail tampering by the erased user | Audit anonymisation is `ExecuteUpdateAsync` inside the same transaction; no row is deleted |
| Cross-user data exposure during a partial failure | Single DB transaction — all-or-nothing |

### Operator runbook (legacy users, manual DB deletion)

For users created before this feature shipped, or for forced deletion of an
inactive account, an operator can reproduce the same effect manually:

```sql
BEGIN;

-- Collect the storage keys you'll need to delete from the blob backend AFTER commit
SELECT s.id, s.storage_key
FROM   shards s
LEFT   JOIN album_memberships am ON am.user_id = s.uploader_id
WHERE  s.uploader_id = '<uuid>'
   OR  EXISTS (
         SELECT 1 FROM manifest_shards ms
         JOIN   manifests m ON m.id = ms.manifest_id
         JOIN   albums a    ON a.id = m.album_id
         WHERE  ms.shard_id = s.id AND a.owner_id = '<uuid>');

-- Cascade-delete the user; drops albums, manifests, manifest_shards,
-- share_links, album_memberships, album_content
DELETE FROM users WHERE id = '<uuid>';

-- Auth challenges live by username with no FK
DELETE FROM auth_challenges WHERE username = '<the-username>';

-- Orphan shards (uploader_id set to NULL by the cascade)
DELETE FROM shards WHERE id IN (<list collected above>);

-- Anonymise audit log entries
UPDATE audit_log_entries
SET    actor_user_id   = NULL,
       actor_was_erased = TRUE
WHERE  actor_user_id   = '<uuid>';

COMMIT;
```

After commit:

1. Delete the corresponding blobs from the storage backend (filesystem or S3)
   using the `storage_key` values collected before the transaction.
2. Delete any active Tus upload sessions for that user.

If the operator deletion is requested for a user who never logged in (e.g.
account provisioned by an admin but never claimed), step-3 cleanup is a no-op.

### Tests

- Backend: [`UserErasureIntegrationTests.cs`](../apps/backend/Mosaic.Backend.Tests/Integration/UserErasureIntegrationTests.cs) — 7 Postgres-backed tests covering the happy path, the confirmation-text guard, LocalAuth fresh-auth verification (challenge consumption, signature verification, expired-timestamp rejection), audit-log anonymisation, shard cleanup, and idempotence.
- Frontend: [`delete-account-dialog.test.tsx`](../apps/web/tests/delete-account-dialog.test.tsx) — 5 unit tests covering the disabled-until-match guard, the ProxyAuth body shape, the LocalAuth fresh-auth signing path, the signing-failure abort, and the generic API-failure rendering.

## Right to Portability (GDPR Article 20)

Mosaic also satisfies the right to data portability under GDPR Article 20.
Any logged-in user can download a zip archive of their entire data footprint
from **Settings → Data → Download Export** without operator intervention.

### Endpoint

`GET /api/v1/export`

Returns `application/zip` with `Content-Disposition: attachment;
filename="mosaic-export-<user-id>-<timestamp>.zip"`. The archive is
streamed directly to the response body via `ZipArchive` in
`ZipArchiveMode.Create` mode with response buffering disabled — neither
the server nor the client materialises the full archive in memory.

### What the export contains

| Top-level entry | Contents |
| --------------- | -------- |
| `metadata.json` | User id, export timestamp, format version (`1.0`) |
| `account-key-wrapped.bin` | The wrapped L2 account key (already returned by `GET /me`); only the holder of the password-derived L1 can unwrap it |
| `identity-seed-wrapped.bin` | The wrapped Ed25519 identity seed, when set |
| `salt.bin`, `account-salt.bin` | KDF salts so the user can replay Argon2id + HKDF offline |
| `kdf-params.json` | `SaltVersion`, Argon2 cost parameters, algorithm version |
| `albums/<album-id>/album.json` | Album row metadata (encrypted name / description fields included verbatim) |
| `albums/<album-id>/members.json` | Roster with roles, invite source, join / revoke timestamps |
| `albums/<album-id>/share-links.json` | Share-link rows (link id, access tier, owner-encrypted secret, expiry, revocation) |
| `albums/<album-id>/epoch-keys.json` | Per-recipient wrapped epoch key bundles, owner signatures, signing pubkeys |
| `albums/<album-id>/manifests/<id>.json` | Manifest row + per-shard chunk / tier / sha256 / content-length |
| `albums/<album-id>/manifests/<id>.encrypted-meta.bin` | Encrypted manifest metadata blob |
| `albums/<album-id>/manifests/<id>.encrypted-meta-sidecar.bin` | Encrypted sidecar (where present) |
| `albums/<album-id>/shards/<shard-id>.bin` | The raw XChaCha20-Poly1305 ciphertext shard blob, streamed from storage |

Albums where the caller is merely a member (not the owner) are deliberately
excluded — exporting them would leak another user's content. Members can
ask each owner for an export of those albums separately.

### Zero-knowledge invariants

The archive contains **only ciphertext + wrapped keys + already-public
metadata**. The server never decrypts anything during export. Specifically:

- Shard blobs are streamed byte-for-byte from storage without inspection.
- The wrapped account key is the same bytes the server already returns
  from `GET /api/v1/users/me` — including it in the export does not
  weaken any existing posture.
- KDF salts are non-secret per the threat model: they are plaintext at
  rest in the database.
- Per-shard blobs are stored with `CompressionLevel.NoCompression` —
  ciphertext is already high-entropy, and deflate-on-ciphertext is both a
  CPU waste and a well-known size-inflation anti-pattern.

The user decrypts the archive offline by replaying their normal key
derivation (Argon2id over `salt.bin` → HKDF over `account-salt.bin` →
unwrap `account-key-wrapped.bin`). See [`EXPORT_FORMAT.md`](EXPORT_FORMAT.md)
for the detailed archive layout and decryption guide.

### Audit log

Every successful export writes a `user.data.exported` row to the audit log
with the album / manifest / shard / byte counts and the format version.
The row retains the same retention posture as every other audit entry
(retained until the user's account is erased, then anonymised in place
under the same Article 17 cascade).

### Missing-blob handling

If a shard row references a blob that has been garbage-collected, the
export writes an empty `<shard-id>.bin.missing` marker rather than aborting
the whole archive. A single corrupted reference would otherwise deny the
user their entire export.

### Tests

- Backend: [`DataExportIntegrationTests.cs`](../apps/backend/Mosaic.Backend.Tests/Integration/DataExportIntegrationTests.cs) — 5 Postgres-backed tests covering valid zip-archive parsing, owned-vs-member album scoping, account-key + salt inclusion, the empty-account minimal archive, and cancellation-token propagation.
- Frontend: [`DataExport.test.tsx`](../apps/web/src/components/Settings/__tests__/DataExport.test.tsx) — 3 unit tests covering render, anchor download target, and the in-flight disabled state.

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
| **Key isolation per link** | Each link has unique `wrappingKey`; compromise of one link's wrapping does not directly expose the album's tier_key (the underlying tier_key is, however, shared across links to the same album/tier) |
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

## Web hardening static guards

Two deterministic guards enforce the "Web client" slice of
[`SPEC-CrossPlatformHardening.md`](specs/SPEC-CrossPlatformHardening.md).
Both are non-interactive, run in CI on every push, and are intended to
be invoked manually during Band 8 release readiness. They are
**parallel-safe** with the Rust and Android boundary guards
(`tests/architecture/rust-boundaries.{ps1,sh}`,
`tests/architecture/kotlin-raw-input-ffi.{ps1,sh}`) and follow the same
file-pair convention.

### `web-no-direct-console.{ps1,sh}` — direct-console redaction guard

**Purpose.** Implements the redaction rule from
`SPEC-CrossPlatformHardening.md` lines 111-113: *"Web production code
uses the centralized logger only; no `console.*` calls in high-risk
crypto/storage/upload boundaries."*

**What it scans.** TypeScript / TSX sources directly under the
following high-risk roots — boundaries where a `console.*` regression
would bypass the centralized logger's redaction guarantees and risk
leaking secrets, PII, raw URIs, or plaintext metadata:

| Root | Scope |
|------|-------|
| `apps/web/src/workers/` | All `.ts` / `.tsx` (recursive) |
| `apps/web/src/lib/*-service.ts` | Service modules (album-download, album-cover, photo-edit, photo, manifest, settings, shard, epoch-key, epoch-rotation, album-metadata) |
| `apps/web/src/lib/sync-engine.ts`, `sync-coordinator.{ts,tsx}` | Sync pipeline |
| `apps/web/src/lib/shared-album-download.ts` | Shared-album content boundary |
| `apps/web/src/lib/local-purge.ts` | Local-storage purge path |
| `apps/web/src/lib/api.ts` | Server API client |
| `apps/web/src/lib/key-cache.ts`, `epoch-key-store.ts`, `epoch-key-service.ts`, `epoch-rotation-service.ts` | Key storage / epoch rotation |
| `apps/web/src/contexts/SyncContext.tsx`, `AlbumContentContext.tsx` | Sync / album contexts |

**What it allows.** The guard exempts the following paths so tests,
helper scripts, and the centralized logger itself can use `console.*`
freely:

- `*/__tests__/*`, `*.test.ts`, `*.test.tsx` — test sources
- `*/scripts/*` — dev / build scripts
- `apps/web/src/lib/logger.ts` — the centralized logger (the *only*
  sanctioned `console.*` callsite)

**What counts as a violation.** Any executable line containing
`console.log`, `console.warn`, `console.error`, `console.info`,
`console.debug`, or `console.trace` in a non-allowlisted file. Comment
lines (starting with `//`, `*`, `/*`) are skipped so JSDoc snippets
that *describe* `console.*` (e.g. as a "do-not-do-this" example) do
not trip the guard.

**Failure mode.** Exit code `1` with a `file:line` summary of every
violation. Exit code `0` when the boundary is clean.

**How to invoke.**

```powershell
# Windows / PowerShell 7+
pwsh tests\architecture\web-no-direct-console.ps1
```

```bash
# Linux / macOS
bash tests/architecture/web-no-direct-console.sh
```

**Where it sits in the build.** The guard is intentionally not part of
the existing `scripts/rust-check.ps1` pipeline (it is not a Rust
check). It is meant to be run on every Band 7/8 release readiness
pass alongside `rust-boundaries.{ps1,sh}` and
`kotlin-raw-input-ffi.{ps1,sh}`. A reference comment in
`scripts/rust-check.ps1` reminds future Band 8 readiness work to invoke
it.

### `db-worker-no-raw-secrets.test.ts` — persistence-safe-snapshot guard

Companion vitest in `apps/web/tests/db-worker-no-raw-secrets.test.ts`
locks down the OPFS/SQLite persistence rule from the same SPEC (lines
136-138): *"OPFS/SQLite persistence contains encrypted data and
persistence-safe snapshots only; no raw handles, raw picker URIs,
plaintext media, plaintext metadata, or key material."*

The test runs the DB worker against a real `sql.js` database and a
passthrough crypto bridge, then substring-checks the bytes that go
into `bridge.wrap` (i.e. the snapshot plaintext) for known raw-secret
field names: `epochSeed`, `signSecret`, `signSeed`, `linkSecret`,
`accountKey`, `identitySeed`, `sessionKey`, `authSecret`, `password`,
`passphrase`, plus their snake-case column variants and any raw
`nonce` / `iv` token outside an envelope. It also verifies the on-disk
shape carries the `SNAPSHOT_VERSION` envelope and source-checks that
no schema column declaration uses any forbidden field name.

Run it with:

```powershell
cd apps\web
npm run test:run -- tests/db-worker-no-raw-secrets.test.ts
```

### Known web logger exceptions

None at the time of writing. Lane D1 (Band 7 prep, 2026-04) audited
every high-risk root listed above and found zero direct `console.*`
calls in production code. Any future justified exception must be
gated by a single-line `// eslint-disable-next-line no-console -- <reason
ref to spec>` comment AND added to this subsection with a citation.

## Dependabot triage 2026-04

**Scope.** GitHub Dependabot raised 27 open alerts attributed to `settings.gradle.kts`
across 12 unique Maven packages (Lane E, 2026-04). All 27 are dismissed with reason
`tolerable_risk`; this section documents the per-package rationale and the
verification each decision rests on.

### How the alerts arose

The only Gradle module in this repository is `:apps:android-main`. Its declared
runtime/test dependencies are intentionally minimal (`gradle/libs.versions.toml`):
AndroidX `activity-ktx` / `appcompat` / `core-ktx`, `net.java.dev.jna:jna:5.14.0`
(both `@aar` for Android and the desktop JAR for JVM unit tests), JUnit 4, and
AndroidX Test (`junit` + `espresso-core`). None of the alerted packages is one of
those direct dependencies.

The alerted packages enter the build through two indirect paths, both of which
are properties of Android Gradle Plugin (AGP) 8.7.3 itself:

1. **AGP buildscript classpath** — the `com.android.tools.build:gradle:8.7.3`
   plugin pulls in `bouncycastle` (APK signing), `jose4j` (JWT parsing during
   signing), `jdom2` (Maven POM and AndroidManifest XML parsing), and
   `commons-compress` (AAR/APK packaging). These run on the Gradle daemon at
   build time only; they are not packaged into the APK, are not loaded by
   Android at runtime, and are not on any test classpath of our module.

2. **AGP UTP (Unified Test Platform) configurations** — when AGP wires up the
   instrumented-test infrastructure it creates several `_internal-unified-test-
   platform-*` configurations to resolve emulator-control plugins. Those plugins
   speak gRPC (HTTP/2 over plaintext localhost) to the emulator and pull in
   `protobuf-java`, `commons-io`, and the `netty-*` family transitively via
   `io.grpc:grpc-netty:1.57.0`. These configurations exist on the Gradle daemon
   only — they are *not* the APK runtime, *not* the unit-test JVM classpath, and
   *not* the instrumented-test app classpath. They are AGP-internal and prefixed
   with an underscore for that reason.

### Verification

For every alerted package, the following four `:apps:android-main` configurations
were inspected with `gradlew :apps:android-main:dependencies --configuration <CFG>
--no-daemon --console=plain` (full reports archived under `artifacts/lane-e/`):

| Configuration | Purpose | Result |
|---------------|---------|--------|
| `debugRuntimeClasspath` | What ships in the debug APK | All 12 packages absent |
| `releaseRuntimeClasspath` | What ships in the release APK | All 12 packages absent |
| `debugUnitTestRuntimeClasspath` | JVM unit tests (`testDebugUnitTest`) | All 12 packages absent |
| `debugAndroidTestRuntimeClasspath` | Instrumented test app classpath | All 12 packages absent |

The buildscript classpath was inspected with `gradlew :apps:android-main:buildEnvironment`,
which confirmed the alerted versions are pinned by AGP 8.7.3 itself and cannot be
overridden by a `dependencies { constraints { } }` block in `apps/android-main/build.gradle.kts`
(constraints apply to module configurations, not to the buildscript classpath, and
the UTP `_internal-*` configurations are private to AGP).

### Per-package decisions

| Alert # | Package | Severity | Patched in | Where it lives | Decision |
|--------:|---------|----------|------------|----------------|----------|
| 26 | `io.netty:netty-handler` | medium | 4.1.94.Final | AGP UTP gRPC handler (localhost) | dismissed (`tolerable_risk`) |
| 27 | `io.netty:netty-codec-http2` | high | 4.1.100.Final | AGP UTP gRPC HTTP/2 (not exposed) | dismissed (`tolerable_risk`) |
| 28 | `org.apache.commons:commons-compress` | medium | 1.26.0 | AGP buildscript (own outputs) | dismissed (`tolerable_risk`) |
| 29 | `org.apache.commons:commons-compress` | medium | 1.26.0 | AGP buildscript (own outputs) | dismissed (`tolerable_risk`) |
| 30 | `io.netty:netty-codec-http` | medium | 4.1.108.Final | AGP UTP gRPC transport | dismissed (`tolerable_risk`) |
| 31 | `org.bouncycastle:bcprov-jdk18on` | medium | 1.78 | AGP buildscript (APK signing) | dismissed (`tolerable_risk`) |
| 32 | `org.bouncycastle:bcprov-jdk18on` | medium | 1.78 | AGP buildscript (APK signing) | dismissed (`tolerable_risk`) |
| 33 | `org.bouncycastle:bcprov-jdk18on` | medium | 1.78 | AGP buildscript (APK signing) | dismissed (`tolerable_risk`) |
| 34 | `com.google.protobuf:protobuf-java` | high | 3.25.5 | AGP UTP emulator-control gRPC | dismissed (`tolerable_risk`) |
| 35 | `commons-io:commons-io` | high | 2.14.0 | AGP UTP test-plugin host | dismissed (`tolerable_risk`) |
| 36 | `org.bouncycastle:bcprov-jdk18on` | medium | 1.78 | AGP buildscript (APK signing) | dismissed (`tolerable_risk`) |
| 37 | `io.netty:netty-handler` | high | 4.1.118.Final | AGP UTP gRPC (plaintext localhost) | dismissed (`tolerable_risk`) |
| 38 | `io.netty:netty-common` | medium | 4.1.115.Final | AGP UTP gRPC common | dismissed (`tolerable_risk`) |
| 39 | `io.netty:netty-common` | medium | 4.1.118.Final | AGP UTP gRPC common | dismissed (`tolerable_risk`) |
| 40 | `org.bouncycastle:bcprov-jdk18on` | medium | 1.78 | AGP buildscript (APK signing) | dismissed (`tolerable_risk`) |
| 41 | `io.netty:netty-codec-http2` | high | 4.1.124.Final | AGP UTP gRPC HTTP/2 | dismissed (`tolerable_risk`) |
| 42 | `io.netty:netty-codec` | medium | 4.1.125.Final | AGP UTP gRPC codec | dismissed (`tolerable_risk`) |
| 43 | `io.netty:netty-codec-http` | low | 4.1.125.Final | AGP UTP gRPC transport | dismissed (`tolerable_risk`) |
| 44 | `org.jdom:jdom2` | high | 2.0.6.1 | AGP buildscript (trusted XML) | dismissed (`tolerable_risk`) |
| 45 | `org.bouncycastle:bcpkix-jdk18on` | medium | 1.79 | AGP buildscript (cert path) | dismissed (`tolerable_risk`) |
| 46 | `io.netty:netty-codec-http` | medium | 4.1.129.Final | AGP UTP gRPC transport | dismissed (`tolerable_risk`) |
| 47 | `org.bitbucket.b_c:jose4j` | high | 0.9.6 | AGP buildscript (JWT) | dismissed (`tolerable_risk`) |
| 48 | `io.netty:netty-codec-http` | high | 4.1.132.Final | AGP UTP gRPC transport | dismissed (`tolerable_risk`) |
| 49 | `io.netty:netty-codec-http2` | high | 4.1.132.Final | AGP UTP gRPC HTTP/2 | dismissed (`tolerable_risk`) |
| 50 | `org.bouncycastle:bcpkix-jdk18on` | medium | 1.84 | AGP buildscript (cert path) | dismissed (`tolerable_risk`) |
| 51 | `org.bouncycastle:bcprov-jdk18on` | medium | 1.84 | AGP buildscript (APK signing) | dismissed (`tolerable_risk`) |
| 52 | `org.bouncycastle:bcprov-jdk18on` | high | 1.84 | AGP buildscript (APK signing) | dismissed (`tolerable_risk`) |

### Why `tolerable_risk` and not a bump

- **No constraint can fix the buildscript classpath.** A `dependencies { constraints { } }`
  block in `apps/android-main/build.gradle.kts` only governs module configurations.
  The buildscript classpath is owned by AGP and would have to be overridden in a
  root `buildscript { dependencies { constraints { } } }` block, which is risky
  because AGP 8.7.3's plugin code may rely on specific BouncyCastle / jose4j /
  protobuf APIs that newer versions remove.
- **The UTP `_internal-*` configurations are AGP-private.** They are recreated
  by AGP on every configuration phase and not user-modifiable.
- **None of the vulnerable code paths is reachable from our build.** The CVEs
  cover (a) parsing attacker-controlled inputs (XXE in jdom2, ZIP slip in
  commons-compress, malformed certs in BouncyCastle), (b) running an exposed
  network service (Netty HTTP/2 server CVEs), or (c) attacker-controlled UNC
  paths (netty-common). At build time we are processing trusted Maven
  artifacts and our own source on a developer or CI machine, and the gRPC
  channels UTP uses are plaintext localhost loopbacks to a developer-controlled
  emulator.
- **The fix path is to bump AGP itself.** When the next AGP upgrade lands in
  `gradle/libs.versions.toml` (`agp = "8.7.3"`), the buildscript and UTP
  transitive versions will move forward automatically and Dependabot will
  re-evaluate. Until then the alerts are accepted risk on build-time tooling.

### Reproducing the verification

```powershell
# from the repository root
.\gradlew.bat :apps:android-main:dependencies --configuration debugRuntimeClasspath --no-daemon --console=plain
.\gradlew.bat :apps:android-main:dependencies --configuration releaseRuntimeClasspath --no-daemon --console=plain
.\gradlew.bat :apps:android-main:dependencies --configuration debugUnitTestRuntimeClasspath --no-daemon --console=plain
.\gradlew.bat :apps:android-main:dependencies --configuration debugAndroidTestRuntimeClasspath --no-daemon --console=plain
.\gradlew.bat :apps:android-main:buildEnvironment --no-daemon --console=plain
```

Searching the output for any of `protobuf-java`, `commons-io`, `netty-*`,
`jose4j`, `bcprov-jdk18on`, `bcpkix-jdk18on`, `jdom2`, or `commons-compress`
will return zero matches in the four runtime/test classpath reports and matches
only inside the buildscript / UTP listings.
