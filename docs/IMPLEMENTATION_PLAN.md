# Mosaic Implementation Plan

**Version:** 1.0  
**Date:** December 27, 2025  
**Target Scale:** ≤50 users  
**Philosophy:** Correctness > Security > Simplicity > Performance

---

## Table of Contents

1. [Project Scope](#project-scope-confirmed)
2. [Pre-Implementation Research](#phase-0-pre-implementation-research)
3. [Crypto Core](#phase-1-crypto-core)
4. [Backend](#phase-2-backend)
5. [Database Schema](#phase-3-database-schema)
6. [Frontend](#phase-4-frontend)
7. [Infrastructure](#phase-5-infrastructure)
8. [Timeline](#implementation-timeline)
9. [Security Documentation](#security-documentation)
10. [Design Decisions](#design-decisions-preserved)

---

## Project Scope (Confirmed)

| Decision | Value | Implication |
|----------|-------|-------------|
| Photos per gallery | ≤10k | Supercluster on-demand, no pre-computation |
| Galleries per user | Unlimited | Each gallery = separate album with own epoch keys |
| Platform | Web only | No React Native, native crypto considerations |
| Album sharing | v1 feature | Epoch key distribution required from start |

---

## Phase 0: Pre-Implementation Research

**Duration:** 2-3 days

| Topic | Question | Approach |
|-------|----------|----------|
| Argon2id Tuning | What parameters work on target devices? | Build test page, benchmark **32MB mobile / 64MB desktop**, target 500-1000ms. Mobile uses more iterations to compensate for lower memory. |

### Browser Support (Modern Only)

- Chrome/Edge 102+
- Firefox 111+
- Safari 16.4+

No fallbacks. Unsupported browsers get a clear error message.

---

## Phase 1: Crypto Core

**Location:** `libs/crypto/`  
**Duration:** ~1 week

### 1.1 Module Structure

```
libs/crypto/
├── index.ts           # Public API exports
├── keychain.ts        # Argon2id + HKDF key derivation
├── keybox.ts          # XChaCha20-Poly1305 encrypt/decrypt
├── envelope.ts        # Sharded envelope format (64B header)
├── epochs.ts          # Epoch key management + wrapping
├── signer.ts          # Ed25519 signing/verification
└── types.ts           # Shared type definitions
```

### 1.2 Key Hierarchy Implementation

```typescript
// L0: Master Key (never stored)
// Adaptive parameters: mobile (32MB, 4 iterations) vs desktop (64MB, 3 iterations)
L0 = Argon2id(password, salt, getArgon2Params())

// L1: Root Key (never stored) - ADD per-account salt
L1 = HKDF_SHA256(L0, salt: account_salt, info: "SafeGallery_Root_v1")

// L2: Account Key (stored wrapped by L1)
L2 = random(32 bytes)
L2_wrapped = XChaCha20Poly1305(L1, L2)

// L3: Epoch Keys (stored in epoch_keys table)
ReadKey = random(32 bytes)   // XChaCha20 encryption
SignKey = Ed25519.generateKeypair()

// Identity Keys (per-user, derived from wrapped seed)
// Store: 32-byte seed, wrapped by Account Key (L2)
// Derive on unlock: Ed25519 keypair (signing) + X25519 keypair (encryption)
IdentitySeed = random(32 bytes)
IdentitySeed_wrapped = XChaCha20Poly1305(L2, IdentitySeed)
IdentitySignKey = Ed25519.fromSeed(IdentitySeed)       // For signing
IdentityKxKey = X25519.fromEd25519(IdentitySignKey)    // For encryption (derived)
```

### 1.2.1 Identity Key Storage Strategy

**Critical:** Recipients must be able to decrypt sealed boxes, which requires their X25519 **secret** key. The storage strategy:

1. Generate a 32-byte **identity seed** once per account
2. Wrap seed with Account Key (L2) and store in local DB
3. On session unlock, derive both keypairs deterministically:

```typescript
// On account creation
const identitySeed = sodium.randombytes_buf(32);
const wrappedSeed = crypto.wrapKey(identitySeed, accountKey);
storeLocally('identity_seed_wrapped', wrappedSeed);

// On session unlock
const identitySeed = crypto.unwrapKey(wrappedSeed, accountKey);
const ed25519Keypair = sodium.crypto_sign_seed_keypair(identitySeed);
const x25519Secret = sodium.crypto_sign_ed25519_sk_to_curve25519(ed25519Keypair.privateKey);
const x25519Public = sodium.crypto_sign_ed25519_pk_to_curve25519(ed25519Keypair.publicKey);
```

**Never store only the public key** — decryption requires the secret.

### 1.2.2 Cryptographic Foundation: Ed25519 ↔ X25519

**Why this conversion is safe:**

Ed25519 (Twisted Edwards) and X25519 (Montgomery) are **birationally equivalent** representations of the same underlying curve over $\mathbb{F}_p$ where $p = 2^{255} - 19$. The mapping is:

$$u = \frac{1 + y}{1 - y} \pmod p$$

**Key properties:**

1. **2-to-1 Mapping (Benign):** Points $P = (x, y)$ and $-P = (-x, y)$ map to the same $u$-coordinate. This is harmless—X25519 operates in a quotient group where $P \equiv -P$. The private scalar entropy is unaffected.

2. **Joint Security Proven:** Academic research confirms Ed25519 signatures + X25519 key exchange are jointly secure under the Gap-DH assumption. The hash in EdDSA ($H(R, A, M)$) acts as a domain separator preventing cross-protocol attacks.

3. **Industry Precedent:** This pattern is used by:
   - **age** (file encryption tool by Filippo Valsorda) for SSH key recipients
   - **libsodium** explicitly supports this via conversion functions
   - **gnunet** and other privacy-focused systems

**Clamping (Critical for Secret Key Conversion):**

`crypto_sign_ed25519_sk_to_curve25519()` applies **clamping** to the derived scalar:
- Clears bits 0, 1, 2 (makes scalar multiple of cofactor 8)
- Clears bit 255, sets bit 254 (prevents timing attacks)

This protects against small-subgroup attacks. **Never implement the conversion manually**—use libsodium.

**Error Handling:**

```typescript
// ALWAYS check return values
const result = sodium.crypto_sign_ed25519_pk_to_curve25519(recipientEd25519Pub);
if (result === null) {
  throw new Error('Invalid Ed25519 public key - cannot convert');
}
```

Conversion fails for invalid keys (wrong length, point at infinity, not on curve).

### 1.2.3 Epoch Key Bundle Sharing (Authenticated)

`crypto_box_seal()` is **anonymous** — anyone with the recipient's public key can encrypt to them. To prove the bundle came from the album owner, we add an **owner signature**.

**Owner encrypts and signs:**

```typescript
// 1. Serialize key bundle with context (prevents replay/mixups)
const bundlePayload = msgpack.encode({
  version: 1,
  album_id: albumId,
  epoch_id: epochId,
  recipient_pubkey: recipientEd25519Pub,  // Fingerprint binding
  read_key: readKey,
  sign_keypair: signKeypair,
});

// 2. Seal to recipient (confidentiality + integrity)
const recipientX25519Pub = sodium.crypto_sign_ed25519_pk_to_curve25519(recipientEd25519Pub);
const sealed = sodium.crypto_box_seal(bundlePayload, recipientX25519Pub);

// 3. Sign the sealed ciphertext (authenticity — proves owner created it)
const signContext = new TextEncoder().encode('Mosaic_EpochBundle_v1');
const toSign = concat(signContext, sealed);
const ownerSignature = sodium.crypto_sign_detached(toSign, ownerIdentitySecretKey);

// 4. Store: sealed + signature + owner pubkey
```

**Recipient opens and verifies:**

```typescript
// 1. Verify owner signature FIRST (reject forgeries before decryption)
const signContext = new TextEncoder().encode('Mosaic_EpochBundle_v1');
const toVerify = concat(signContext, sealed);
if (!sodium.crypto_sign_verify_detached(ownerSignature, toVerify, ownerIdentityPubKey)) {
  throw new Error('Invalid bundle signature — not from album owner');
}

// 2. Convert identity keys to X25519
const myX25519Secret = sodium.crypto_sign_ed25519_sk_to_curve25519(myEd25519Secret);
const myX25519Public = sodium.crypto_sign_ed25519_pk_to_curve25519(myEd25519Public);

// 3. Open sealed box
const bundlePayload = sodium.crypto_box_seal_open(sealed, myX25519Public, myX25519Secret);
const bundle = msgpack.decode(bundlePayload);

// 4. Validate context matches expectations
assert(bundle.album_id === expectedAlbumId);
assert(bundle.epoch_id >= currentEpochId);
assert(bytesEqual(bundle.recipient_pubkey, myEd25519Public));
```

**Why this matters:**
- Without signature: malicious server could inject fake epoch bundles
- Context binding: prevents replaying bundles across albums/epochs
- Verify-before-decrypt: fail fast on forgeries

### 1.3 Envelope Format

```
Header (64 bytes):
┌────────────┬─────────┬──────────┬──────────┬───────────────┬──────────┐
│ Magic (4B) │ Ver (1) │ Epoch(4) │ Shard(4) │ Nonce (24B)   │ Rsv (27) │
│ "SGzk"     │ 0x03    │ LE u32   │ LE u32   │ Random        │ Zero     │
└────────────┴─────────┴──────────┴──────────┴───────────────┴──────────┘

Encryption:
- Algorithm: XChaCha20-Poly1305
- Nonce: Header bytes [13:37] (24 bytes, MUST be unique per encryption)
- AAD: Entire 64-byte header
- Payload: 6MB chunk (or remainder)
```

### 1.3.1 Shard Integrity Verification

To prevent shard substitution attacks (server returning different valid ciphertext), the **signed manifest must include ciphertext hashes**:

```typescript
// Inside encrypted_meta (part of signed payload)
{
  asset_id: "uuid",           // Stable logical photo ID
  shards: [
    { index: 0, id: "shard-uuid-1", sha256: "base64..." },
    { index: 1, id: "shard-uuid-2", sha256: "base64..." }
  ],
  // ... other metadata
}
```

Client verification flow:
1. Download shard by ID
2. Compute SHA256 of received ciphertext
3. Compare against hash in (decrypted, verified) manifest
4. Reject if mismatch—indicates server tampering or corruption

### 1.4 Critical Requirements

| Requirement | Implementation |
|-------------|----------------|
| **Nonce uniqueness** | Generate fresh 24 random bytes per shard. NEVER reuse with same ReadKey. |
| **Reserved validation** | On decrypt, verify `header[37:63] == 0`, reject otherwise |
| **Signing context** | `Sign(key, "SG_Shard_v1" \|\| header \|\| ciphertext)` |
| **Key wiping** | Use `sodium.memzero()` after use |
| **Shard binding** | Manifest signature covers shard SHA256 hashes—verify after download |

### 1.5 Public API

```typescript
// libs/crypto/keychain.ts
export function getArgon2Params(): Argon2Params {
  const isMobile = /Android|iPhone|iPad/.test(navigator.userAgent);
  return {
    memory: isMobile ? 32 * 1024 : 64 * 1024, // KiB
    iterations: isMobile ? 4 : 3,              // Compensate for lower memory
    parallelism: 1
  };
}
```

```typescript
// libs/crypto/index.ts
export interface CryptoLib {
  // Key derivation
  deriveKeys(password: string, salt: Uint8Array): Promise<DerivedKeys>;
  
  // Envelope operations
  encryptShard(data: Uint8Array, epochKey: EpochKey, shardIndex: number): Promise<EncryptedShard>;
  decryptShard(envelope: Uint8Array, epochKey: EpochKey): Promise<Uint8Array>;
  verifyShard(ciphertext: Uint8Array, expectedSha256: string): boolean;
  
  // Signing
  signManifest(manifest: Uint8Array, signKey: Uint8Array): Uint8Array;
  verifyManifest(manifest: Uint8Array, signature: Uint8Array, pubKey: Uint8Array): boolean;
  
  // Key management
  wrapKey(key: Uint8Array, wrapper: Uint8Array): Uint8Array;
  unwrapKey(wrapped: Uint8Array, wrapper: Uint8Array): Uint8Array;
  
  // Key bundle encryption (authenticated sealed box)
  // Uses Ed25519 → X25519 conversion + owner signature
  sealAndSignBundle(
    bundle: EpochKeyBundle,
    recipientEd25519Pub: Uint8Array,
    ownerIdentityKeypair: KeyPair
  ): { sealed: Uint8Array; signature: Uint8Array };
  
  verifyAndOpenBundle(
    sealed: Uint8Array,
    signature: Uint8Array,
    ownerEd25519Pub: Uint8Array,
    myIdentityKeypair: KeyPair,
    expectedContext: { albumId: string; epochId: number }
  ): EpochKeyBundle;
}

interface EncryptedShard {
  ciphertext: Uint8Array;
  sha256: string;  // For inclusion in manifest
}
```

---

## Phase 2: Backend

**Location:** `apps/backend/`  
**Runtime:** .NET 10 (ASP.NET Core)  
**Duration:** ~2 weeks

### 2.1 Project Structure

```
apps/backend/
├── Program.cs
├── appsettings.json
├── Middleware/
│   ├── TrustedProxyMiddleware.cs
│   └── RequestLoggingMiddleware.cs
├── Controllers/
│   ├── HealthController.cs
│   ├── SyncController.cs
│   ├── ManifestController.cs
│   └── EpochKeyController.cs
├── Services/
│   ├── TusStorageService.cs
│   └── GarbageCollectionService.cs
├── Data/
│   ├── MosaicDbContext.cs
│   ├── Entities/
│   └── Migrations/
└── Mosaic.Backend.csproj
```

### 2.2 Authentication Middleware

```csharp
// TrustedProxyMiddleware.cs
public class TrustedProxyMiddleware
{
    private readonly HashSet<string> _trustedCidrs;
    
    public async Task InvokeAsync(HttpContext context, RequestDelegate next)
    {
        var remoteIp = context.Connection.RemoteIpAddress;
        
        // Only accept Remote-User from trusted proxies
        if (!IsTrustedProxy(remoteIp))
        {
            context.Request.Headers.Remove("Remote-User");
            context.Response.StatusCode = 401;
            return;
        }
        
        var remoteUser = context.Request.Headers["Remote-User"].FirstOrDefault();
        if (string.IsNullOrEmpty(remoteUser))
        {
            context.Response.StatusCode = 401;
            return;
        }
        
        // Validate format (prevent injection)
        if (!Regex.IsMatch(remoteUser, @"^[a-zA-Z0-9_\-@.]+$"))
        {
            context.Response.StatusCode = 400;
            return;
        }
        
        context.Items["UserId"] = remoteUser;
        await next(context);
    }
}
```

### 2.3 Manifest Creation (Atomic Transaction)

```csharp
// POST /api/manifests
public async Task<IActionResult> CreateManifest(CreateManifestRequest request)
{
    var userId = GetCurrentUserId();
    
    await using var tx = await _db.Database.BeginTransactionAsync();
    try
    {
        // 1. Lock album row
        var album = await _db.Albums
            .FromSqlRaw("SELECT * FROM albums WHERE id = {0} FOR UPDATE", request.AlbumId)
            .FirstOrDefaultAsync();
            
        if (album == null || album.OwnerId != userId)
            return NotFound();
        
        // 2. Validate shards: exist, owned by user, PENDING status
        var shards = await _db.Shards
            .Where(s => request.ShardIds.Contains(s.Id))
            .ToListAsync();
            
        if (shards.Count != request.ShardIds.Count)
            return BadRequest("Some shards not found");
            
        if (shards.Any(s => s.UploaderId != userId))
            return Forbid("Shard ownership mismatch");
            
        if (shards.Any(s => s.Status != ShardStatus.PENDING))
            return BadRequest("Shards already linked");
        
        // 3. Increment version and create manifest
        album.CurrentVersion++;
        album.UpdatedAt = DateTime.UtcNow;
        
        var manifest = new Manifest
        {
            Id = Guid.NewGuid(),
            AlbumId = album.Id,
            VersionCreated = album.CurrentVersion,
            EncryptedMeta = request.EncryptedMeta,
            Signature = request.Signature,
            SignerPubkey = request.SignerPubkey,
            CreatedAt = DateTime.UtcNow
        };
        _db.Manifests.Add(manifest);
        
        // 4. Mark shards as ACTIVE and link
        foreach (var (shard, index) in shards.Select((s, i) => (s, i)))
        {
            shard.Status = ShardStatus.ACTIVE;
            shard.StatusUpdatedAt = DateTime.UtcNow;
            
            _db.ManifestShards.Add(new ManifestShard
            {
                ManifestId = manifest.Id,
                ShardId = shard.Id,
                ChunkIndex = index
            });
        }
        
        await _db.SaveChangesAsync();
        await tx.CommitAsync();
        
        return Ok(new { manifest.Id, Version = album.CurrentVersion });
    }
    catch
    {
        await tx.RollbackAsync();
        throw;
    }
}
```

### 2.4 Sync Endpoint

```csharp
// GET /api/albums/{albumId}/sync?since=105
public async Task<IActionResult> SyncDelta(Guid albumId, long since)
{
    var userId = GetCurrentUserId();
    
    // Verify access via epoch_keys
    var hasAccess = await _db.EpochKeys
        .AnyAsync(ek => ek.AlbumId == albumId && ek.RecipientId == userId);
        
    if (!hasAccess) return Forbid();
    
    var manifests = await _db.Manifests
        .Where(m => m.AlbumId == albumId && m.VersionCreated > since)
        .OrderBy(m => m.VersionCreated)
        .Take(100)  // Simple pagination
        .Select(m => new {
            m.Id,
            m.VersionCreated,
            m.IsDeleted,
            m.EncryptedMeta,
            m.Signature,
            m.SignerPubkey,
            ShardIds = m.ManifestShards.OrderBy(ms => ms.ChunkIndex).Select(ms => ms.ShardId)
        })
        .ToListAsync();
    
    var album = await _db.Albums.FindAsync(albumId);
    
    return Ok(new {
        Manifests = manifests,
        AlbumVersion = album.CurrentVersion,
        HasMore = manifests.Count == 100
    });
}
```

### 2.5 Tus Upload Configuration

```csharp
// Program.cs
builder.Services.AddTus(options =>
{
    options.StoragePath = builder.Configuration["Storage:Path"];
    options.MaxSize = 6 * 1024 * 1024; // 6MB max per shard
    
    options.OnBeforeCreate = async ctx =>
    {
        // Check user quota before allowing upload
        var userId = ctx.HttpContext.Items["UserId"] as string;
        var fileSize = ctx.UploadLength;
        
        await using var scope = ctx.HttpContext.RequestServices.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        
        var quota = await db.UserQuotas.FindAsync(Guid.Parse(userId));
        if (quota == null || quota.UsedStorageBytes + fileSize > quota.MaxStorageBytes)
        {
            ctx.FailRequest("Storage quota exceeded");
            return;
        }
    };
    
    options.OnUploadComplete = async ctx =>
    {
        var userId = ctx.HttpContext.Items["UserId"] as string;
        var fileId = ctx.FileId;
        var fileSize = ctx.UploadLength;
        
        await using var scope = ctx.HttpContext.RequestServices.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        
        await using var tx = await db.Database.BeginTransactionAsync();
        
        // Create PENDING shard record
        db.Shards.Add(new Shard
        {
            Id = Guid.Parse(fileId),
            UploaderId = userId,
            StorageKey = $"blobs/{fileId}",
            SizeBytes = fileSize,
            Status = ShardStatus.PENDING,
            PendingExpiresAt = DateTime.UtcNow.AddHours(24)
        });
        
        // Update quota usage
        await db.Database.ExecuteSqlRawAsync(
            "UPDATE user_quotas SET used_storage_bytes = used_storage_bytes + {0}, updated_at = NOW() WHERE user_id = {1}",
            fileSize, Guid.Parse(userId));
        
        await db.SaveChangesAsync();
        await tx.CommitAsync();
    };
});
```

### 2.6 Garbage Collection Service

```csharp
// Background service to clean orphaned uploads
public class GarbageCollectionService : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await CleanExpiredPendingShards();
            await CleanTrashedShards();
            await Task.Delay(TimeSpan.FromHours(1), stoppingToken);
        }
    }
    
    private async Task CleanExpiredPendingShards()
    {
        // Mark expired PENDING as TRASHED
        await _db.Database.ExecuteSqlRawAsync(@"
            UPDATE shards 
            SET status = 'TRASHED', status_updated_at = NOW() 
            WHERE status = 'PENDING' AND pending_expires_at < NOW()");
    }
    
    private async Task CleanTrashedShards()
    {
        // Delete TRASHED older than 7 days (and their files)
        var toDelete = await _db.Shards
            .Where(s => s.Status == ShardStatus.TRASHED 
                     && s.StatusUpdatedAt < DateTime.UtcNow.AddDays(-7))
            .ToListAsync();
            
        foreach (var shard in toDelete)
        {
            File.Delete(Path.Combine(_storagePath, shard.StorageKey));
            _db.Shards.Remove(shard);
        }
        await _db.SaveChangesAsync();
    }
}
```

---

## Phase 3: Database Schema

**Duration:** Parallel with Phase 2

### 3.1 Initial Migration

```sql
-- migrations/V1__initial_schema.sql

-- UUIDv7 provides time-ordered IDs for better B-tree locality and insert performance
-- Native in PostgreSQL 17+
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";  -- For uuid_generate_v7()

-- Users
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    auth_sub VARCHAR(255) UNIQUE NOT NULL,
    identity_pubkey TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Albums
CREATE TABLE albums (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
    current_version BIGINT DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Album Members (explicit membership with roles)
CREATE TABLE album_members (
    album_id UUID REFERENCES albums(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL DEFAULT 'viewer',  -- 'owner', 'editor', 'viewer'
    invited_by UUID REFERENCES users(id),
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    PRIMARY KEY (album_id, user_id)
);

-- Epoch Keys (with owner authentication)
CREATE TABLE epoch_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    album_id UUID REFERENCES albums(id) ON DELETE CASCADE,
    recipient_id UUID REFERENCES users(id) ON DELETE CASCADE,
    epoch_id INT NOT NULL,
    encrypted_key_bundle BYTEA NOT NULL,  -- Sealed box ciphertext
    owner_signature BYTEA NOT NULL,        -- Ed25519 signature over (context || sealed)
    sharer_pubkey BYTEA NOT NULL,          -- Ed25519 pubkey of who shared (for verification)
    sign_pubkey BYTEA NOT NULL,            -- Epoch sign pubkey (plaintext for server authz)
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(album_id, recipient_id, epoch_id)
);

-- Manifests
CREATE TABLE manifests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    album_id UUID REFERENCES albums(id) ON DELETE CASCADE,
    version_created BIGINT NOT NULL,
    is_deleted BOOLEAN DEFAULT FALSE,
    encrypted_meta BYTEA NOT NULL,
    signature TEXT NOT NULL,
    signer_pubkey TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Shards
CREATE TABLE shards (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    uploader_id UUID REFERENCES users(id),
    storage_key TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    status VARCHAR(20) DEFAULT 'PENDING',
    status_updated_at TIMESTAMPTZ DEFAULT NOW(),
    pending_expires_at TIMESTAMPTZ
);

-- Manifest-Shard Link
CREATE TABLE manifest_shards (
    manifest_id UUID REFERENCES manifests(id) ON DELETE CASCADE,
    shard_id UUID REFERENCES shards(id) ON DELETE RESTRICT,
    chunk_index INT NOT NULL,
    PRIMARY KEY (manifest_id, shard_id)
);

-- User Storage Quotas (abuse prevention)
CREATE TABLE user_quotas (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    max_storage_bytes BIGINT NOT NULL DEFAULT 10737418240,  -- 10GB default
    used_storage_bytes BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_manifests_album_version ON manifests(album_id, version_created);
CREATE INDEX idx_epoch_keys_recipient ON epoch_keys(recipient_id, album_id);
CREATE INDEX idx_shards_pending ON shards(pending_expires_at) WHERE status = 'PENDING';
CREATE INDEX idx_manifest_shards_shard ON manifest_shards(shard_id);
CREATE INDEX idx_albums_owner ON albums(owner_id);
CREATE INDEX idx_album_members_user ON album_members(user_id);
CREATE INDEX idx_album_members_active ON album_members(album_id) WHERE revoked_at IS NULL;
```

---

## Phase 4: Frontend

**Location:** `apps/admin/`  
**Runtime:** React 19 + Vite  
**Duration:** ~3 weeks

### 4.1 Project Structure

```
apps/admin/
├── index.html
├── vite.config.ts
├── tsconfig.json
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── workers/
│   │   ├── db.worker.ts        # SharedWorker - SQLite + FTS
│   │   ├── crypto.worker.ts    # Worker - libsodium ops
│   │   ├── geo.worker.ts       # Worker - Supercluster indexing
│   │   └── worker-types.ts
│   ├── lib/
│   │   ├── db-client.ts        # Comlink wrapper for DbWorker
│   │   ├── crypto-client.ts    # Comlink wrapper for CryptoWorker
│   │   ├── upload-queue.ts     # Upload orchestration
│   │   ├── sync-engine.ts      # Sync with server
│   │   └── session.ts          # Login/logout + idle timeout
│   ├── components/
│   │   ├── Gallery.tsx
│   │   ├── PhotoGrid.tsx
│   │   ├── MapView.tsx
│   │   ├── UploadButton.tsx
│   │   └── LoginForm.tsx
│   ├── hooks/
│   │   ├── usePhotos.ts
│   │   ├── useSync.ts
│   │   └── useUpload.ts
│   └── styles/
└── public/
```

### 4.2 Worker Architecture

```typescript
// workers/db.worker.ts (SharedWorker)
import * as Comlink from 'comlink';
import initSqlJs, { Database } from 'sql.js';

class DbWorker {
  private db: Database | null = null;
  private sessionKey: Uint8Array | null = null;
  
  async init(sessionKey: Uint8Array) {
    this.sessionKey = sessionKey;
    const SQL = await initSqlJs();
    
    // Load encrypted DB blob from OPFS if exists
    const encryptedBlob = await this.loadFromOPFS();
    if (encryptedBlob) {
      const decrypted = await this.decryptDbBlob(encryptedBlob, sessionKey);
      this.db = new SQL.Database(decrypted);
    } else {
      this.db = new SQL.Database();
    }
    await this.runMigrations();
  }
  
  // SQLite encryption approach: encrypt entire DB blob at rest
  // On save: serialize DB → encrypt with sessionKey → write to OPFS
  // On load: read from OPFS → decrypt with sessionKey → deserialize
  private async saveToOPFS() {
    const data = this.db!.export();
    const encrypted = sodium.crypto_secretbox_easy(
      data, 
      this.generateNonce(), 
      this.sessionKey!
    );
    await this.writeOPFS('mosaic.db.enc', encrypted);
  }
  
  async search(query: string): Promise<PhotoMeta[]> {
    return this.db!.exec(`
      SELECT * FROM photos 
      WHERE id IN (SELECT rowid FROM photos_fts WHERE photos_fts MATCH ?)
    `, [query]);
  }
  
  async insertManifest(manifest: DecryptedManifest) {
    // Insert into local tables
  }
  
  async getPhotosForMap(bounds: Bounds): Promise<GeoPoint[]> {
    return this.db!.exec(`
      SELECT id, lat, lng FROM photos 
      WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
    `, [bounds.south, bounds.north, bounds.west, bounds.east]);
  }
}

Comlink.expose(new DbWorker());
```

```typescript
// workers/crypto.worker.ts (Dedicated Worker)
import * as Comlink from 'comlink';
import sodium from 'libsodium-wrappers';

class CryptoWorker {
  private sessionKey: Uint8Array | null = null;
  
  async init(password: string, salt: Uint8Array) {
    await sodium.ready;
    // Derive session key from password
    this.sessionKey = sodium.crypto_pwhash(
      32, password, salt,
      sodium.crypto_pwhash_OPSLIMIT_MODERATE,
      sodium.crypto_pwhash_MEMLIMIT_MODERATE,
      sodium.crypto_pwhash_ALG_ARGON2ID13
    );
  }
  
  async encryptShard(
    data: Uint8Array, 
    readKey: Uint8Array, 
    epochId: number, 
    shardId: number
  ): Promise<Uint8Array> {
    // Build header, encrypt with AAD
  }
  
  async decryptShard(envelope: Uint8Array, readKey: Uint8Array): Promise<Uint8Array> {
    // Parse header, validate reserved bytes, decrypt
  }
  
  clear() {
    if (this.sessionKey) {
      sodium.memzero(this.sessionKey);
      this.sessionKey = null;
    }
  }
}

Comlink.expose(new CryptoWorker());
```

```typescript
// workers/geo.worker.ts (Dedicated Worker)
import Supercluster from 'supercluster';
import * as Comlink from 'comlink';

class GeoWorker {
  private index: Supercluster | null = null;
  
  load(points: GeoJSON.Feature[]) {
    this.index = new Supercluster({ radius: 60, maxZoom: 16 });
    this.index.load(points);
  }
  
  getClusters(bbox: [number, number, number, number], zoom: number) {
    return this.index?.getClusters(bbox, zoom) ?? [];
  }
  
  getLeaves(clusterId: number, limit: number, offset: number) {
    return this.index?.getLeaves(clusterId, limit, offset) ?? [];
  }
}

Comlink.expose(new GeoWorker());
```

### 4.3 Upload Queue

```typescript
// lib/upload-queue.ts
import { cryptoClient } from './crypto-client';
import { tusUpload } from './tus';
import { openDB, IDBPDatabase } from 'idb';

interface PersistedTask {
  id: string;
  albumId: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  completedShards: { index: number; shardId: string }[];
  epochId: number;
  status: 'queued' | 'uploading' | 'complete' | 'error';
}

export class UploadQueue {
  private queue: UploadTask[] = [];
  private processing = false;
  private maxConcurrent = 2;
  private activeCount = 0;
  private db: IDBPDatabase | null = null;
  
  onProgress?: (task: UploadTask) => void;
  onComplete?: (task: UploadTask) => void;
  onError?: (task: UploadTask, error: Error) => void;
  
  async init() {
    this.db = await openDB('upload-queue', 1, {
      upgrade(db) {
        db.createObjectStore('tasks', { keyPath: 'id' });
      }
    });
    await this.recoverIncompleteTasks();
  }
  
  // Recover tasks that were interrupted by browser crash/close
  private async recoverIncompleteTasks() {
    const persisted = await this.db!.getAll('tasks');
    for (const task of persisted) {
      if (task.status === 'uploading' || task.status === 'queued') {
        // Re-queue incomplete tasks - will resume from last completed shard
        console.log(`Recovering upload task ${task.id}, ${task.completedShards.length}/${task.totalChunks} shards complete`);
        // Note: File handle is lost on crash - user must re-select file
        // Mark as needing user action
        task.status = 'error';
        await this.db!.put('tasks', task);
      }
    }
  }
  
  async add(file: File, albumId: string, epochKey: EpochKey): Promise<string> {
    const taskId = crypto.randomUUID();
    const totalChunks = Math.ceil(file.size / (6 * 1024 * 1024));
    
    // Persist task state BEFORE starting
    const persisted: PersistedTask = {
      id: taskId,
      albumId,
      fileName: file.name,
      fileSize: file.size,
      totalChunks,
      completedShards: [],
      epochId: epochKey.epochId,
      status: 'queued'
    };
    await this.db!.put('tasks', persisted);
    
    const task: UploadTask = {
      id: taskId,
      file,
      albumId,
      epochKey,
      status: 'queued',
      progress: 0,
      shardIds: []
    };
    
    this.queue.push(task);
    this.processQueue();
    return taskId;
  }
  
  private async processQueue() {
    if (this.processing) return;
    this.processing = true;
    
    while (this.queue.length > 0 && this.activeCount < this.maxConcurrent) {
      const task = this.queue.shift()!;
      this.activeCount++;
      this.processTask(task).finally(() => this.activeCount--);
    }
    
    this.processing = false;
  }
  
  private async processTask(task: UploadTask) {
    try {
      task.status = 'uploading';
      await this.db!.put('tasks', { ...await this.db!.get('tasks', task.id), status: 'uploading' });
      
      const CHUNK_SIZE = 6 * 1024 * 1024;
      const totalChunks = Math.ceil(task.file.size / CHUNK_SIZE);
      
      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, task.file.size);
        const chunk = await task.file.slice(start, end).arrayBuffer();
        
        // Encrypt in worker (uses Transferable)
        // Fresh nonce generated per shard - if upload fails, we re-encrypt with new nonce
        const encrypted = await cryptoClient.encryptShard(
          new Uint8Array(chunk),
          task.epochKey.readKey,
          task.epochKey.epochId,
          i
        );
        
        // Upload via Tus
        const shardId = await tusUpload(encrypted);
        task.shardIds.push(shardId);
        
        // Persist completed shard ID immediately
        const persisted = await this.db!.get('tasks', task.id);
        persisted.completedShards.push({ index: i, shardId });
        await this.db!.put('tasks', persisted);
        
        task.progress = (i + 1) / totalChunks;
        this.onProgress?.(task);
      }
      
      task.status = 'complete';
      await this.db!.put('tasks', { ...await this.db!.get('tasks', task.id), status: 'complete' });
      this.onComplete?.(task);
    } catch (error) {
      task.status = 'error';
      await this.db!.put('tasks', { ...await this.db!.get('tasks', task.id), status: 'error' });
      this.onError?.(task, error as Error);
    }
  }
  
  // Clean up completed tasks older than 24 hours
  async pruneCompletedTasks() {
    const tasks = await this.db!.getAll('tasks');
    for (const task of tasks) {
      if (task.status === 'complete') {
        await this.db!.delete('tasks', task.id);
      }
    }
  }
}
```

### 4.4 Sync Engine with Lazy Hydration

```typescript
// lib/sync-engine.ts
import { dbClient } from './db-client';
import { api } from './api';

export class SyncEngine extends EventTarget {
  private syncing = false;
  
  async initialSync(albumId: string): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    
    try {
      // Phase 1: Fetch most recent items for immediate UI display
      const album = await api.getAlbum(albumId);
      const recentManifests = await api.syncDelta(albumId, album.currentVersion - 100);
      
      await dbClient.insertManifests(recentManifests.manifests);
      this.dispatchEvent(new CustomEvent('ready', { 
        detail: { count: recentManifests.manifests.length, albumVersion: album.currentVersion } 
      }));
      
      // Phase 2: Background hydration of older items
      let since = 0;
      let totalSynced = recentManifests.manifests.length;
      
      while (true) {
        const batch = await api.syncDelta(albumId, since);
        if (batch.manifests.length === 0) break;
        
        // Filter out items we already have from Phase 1
        const newManifests = batch.manifests.filter(
          m => m.versionCreated <= album.currentVersion - 100
        );
        
        if (newManifests.length > 0) {
          await dbClient.insertManifests(newManifests);
          totalSynced += newManifests.length;
          
          this.dispatchEvent(new CustomEvent('progress', { 
            detail: { synced: totalSynced, albumVersion: album.currentVersion } 
          }));
        }
        
        since = batch.manifests[batch.manifests.length - 1].versionCreated;
        if (!batch.hasMore) break;
        
        // Yield to prevent blocking - allow UI updates
        await new Promise(r => setTimeout(r, 10));
      }
      
      this.dispatchEvent(new CustomEvent('complete', { detail: { total: totalSynced } }));
    } finally {
      this.syncing = false;
    }
  }
  
  // Incremental sync for already-hydrated albums
  async incrementalSync(albumId: string): Promise<void> {
    const localVersion = await dbClient.getAlbumVersion(albumId);
    const delta = await api.syncDelta(albumId, localVersion);
    
    if (delta.manifests.length > 0) {
      await dbClient.insertManifests(delta.manifests);
      this.dispatchEvent(new CustomEvent('updated', { 
        detail: { count: delta.manifests.length } 
      }));
    }
  }
}

export const syncEngine = new SyncEngine();
```

### 4.5 Session Management

```typescript
// lib/session.ts
const IDLE_TIMEOUT = 30 * 60 * 1000; // 30 minutes

class SessionManager {
  private idleTimer: number | null = null;
  private cryptoWorker: Worker;
  private dbWorker: SharedWorker;
  
  async login(password: string) {
    // Request persistent storage
    if (navigator.storage?.persist) {
      await navigator.storage.persist();
    }
    
    // Initialize workers
    this.cryptoWorker = new Worker(
      new URL('./workers/crypto.worker.ts', import.meta.url),
      { type: 'module' }
    );
    this.dbWorker = new SharedWorker(
      new URL('./workers/db.worker.ts', import.meta.url),
      { type: 'module' }
    );
    
    // Derive keys and initialize
    await cryptoClient.init(password, userSalt);
    await dbClient.init(await cryptoClient.getSessionKey());
    
    this.resetIdleTimer();
    this.attachIdleListeners();
  }
  
  logout() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    
    cryptoClient.clear();
    this.cryptoWorker.terminate();
    this.dbWorker.port.close();
    
    sessionStorage.clear();
    window.location.href = '/login';
  }
  
  private resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => this.logout(), IDLE_TIMEOUT);
  }
  
  private attachIdleListeners() {
    const events = ['mousedown', 'keydown', 'touchstart', 'scroll'];
    events.forEach(event => {
      document.addEventListener(event, () => this.resetIdleTimer(), { passive: true });
    });
  }
}

export const session = new SessionManager();
```

### 4.6 Photo Grid (Virtualized)

```tsx
// components/PhotoGrid.tsx
import { useVirtualizer } from '@tanstack/react-virtual';
import { usePhotos } from '../hooks/usePhotos';

export function PhotoGrid() {
  const parentRef = useRef<HTMLDivElement>(null);
  const { photos, loadMore } = usePhotos();
  
  const COLUMNS = 4;
  const rowCount = Math.ceil(photos.length / COLUMNS);
  
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 200,
    overscan: 5
  });
  
  return (
    <div ref={parentRef} className="h-full overflow-auto">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map(virtualRow => (
          <div
            key={virtualRow.key}
            style={{
              position: 'absolute',
              top: virtualRow.start,
              height: virtualRow.size,
              width: '100%',
              display: 'grid',
              gridTemplateColumns: `repeat(${COLUMNS}, 1fr)`,
              gap: '4px'
            }}
          >
            {Array.from({ length: COLUMNS }).map((_, colIndex) => {
              const photo = photos[virtualRow.index * COLUMNS + colIndex];
              return photo ? <PhotoThumbnail key={photo.id} photo={photo} /> : null;
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
```

---

## Phase 5: Infrastructure

**Duration:** ~3 days

### 5.1 Docker Compose

```yaml
# docker-compose.yml
services:
  traefik:
    image: traefik:v3.0
    command:
      - "--providers.docker=true"
      - "--providers.docker.exposedbydefault=false"
      - "--entrypoints.websecure.address=:443"
      - "--certificatesresolvers.le.acme.tlschallenge=true"
      - "--certificatesresolvers.le.acme.email=${ACME_EMAIL}"
      - "--certificatesresolvers.le.acme.storage=/letsencrypt/acme.json"
    ports:
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - letsencrypt:/letsencrypt
    networks:
      - web

  backend:
    build: ./apps/backend
    environment:
      - ASPNETCORE_ENVIRONMENT=Production
      - ConnectionStrings__Default=Host=postgres;Database=mosaic;Username=mosaic;Password=${DB_PASSWORD}
      - Auth__TrustedProxies=172.16.0.0/12
      - Storage__Path=/data/blobs
    volumes:
      - blob_data:/data/blobs
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.api.rule=Host(`${DOMAIN}`) && PathPrefix(`/api`)"
      - "traefik.http.routers.api.entrypoints=websecure"
      - "traefik.http.routers.api.tls.certresolver=le"
    networks:
      - web
      - internal
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:5000/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: mosaic
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: mosaic
    volumes:
      - db_data:/var/lib/postgresql/data
    networks:
      - internal
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U mosaic"]
      interval: 10s
      timeout: 5s
      retries: 5

  frontend:
    build: ./apps/admin
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.frontend.rule=Host(`${DOMAIN}`)"
      - "traefik.http.routers.frontend.entrypoints=websecure"
      - "traefik.http.routers.frontend.tls.certresolver=le"
      # Required for SharedArrayBuffer and multi-threaded WASM (Argon2id parallelism)
      - "traefik.http.middlewares.coop-coep.headers.customresponseheaders.Cross-Origin-Opener-Policy=same-origin"
      - "traefik.http.middlewares.coop-coep.headers.customresponseheaders.Cross-Origin-Embedder-Policy=require-corp"
      - "traefik.http.routers.frontend.middlewares=coop-coep"
    networks:
      - web

networks:
  web:
    driver: bridge
  internal:
    driver: bridge

volumes:
  db_data:
  blob_data:
  letsencrypt:
```

### 5.2 Environment Configuration

```bash
# .env (gitignored)
DOMAIN=photos.example.com
ACME_EMAIL=admin@example.com
DB_PASSWORD=<generate with: openssl rand -base64 32>
```

### 5.3 Backup Script

```bash
#!/bin/bash
# scripts/backup.sh
set -e

BACKUP_DIR="/backups"
DATE=$(date +%Y%m%d_%H%M%S)

# Database backup
docker exec mosaic-postgres pg_dump -U mosaic mosaic | gzip > "$BACKUP_DIR/db_$DATE.sql.gz"

# Keep last 7 days
find "$BACKUP_DIR" -name "db_*.sql.gz" -mtime +7 -delete

# Sync blobs to offsite (configure rclone separately)
# rclone sync /data/blobs remote:mosaic-backups/blobs
```

### 5.4 Health Check Endpoint

```csharp
// Controllers/HealthController.cs
[ApiController]
[Route("health")]
public class HealthController : ControllerBase
{
    private readonly MosaicDbContext _db;
    
    [HttpGet]
    public async Task<IActionResult> Get()
    {
        try
        {
            await _db.Database.ExecuteSqlRawAsync("SELECT 1");
            return Ok(new { status = "healthy", timestamp = DateTime.UtcNow });
        }
        catch
        {
            return StatusCode(503, new { status = "unhealthy" });
        }
    }
}
```

---

## Implementation Timeline

| Phase | Duration | Dependencies | Deliverables |
|-------|----------|--------------|--------------|
| **0: Research** | 2-3 days | None | Argon2id params, browser test results |
| **1: Crypto Core** | 1 week | Phase 0 | `libs/crypto` package, unit tests |
| **2: Backend** | 2 weeks | Phase 1 | API endpoints, Tus integration |
| **3: Database** | // with P2 | None | Migrations, seed scripts |
| **4: Frontend** | 3 weeks | Phase 1, 2 | React app, workers, UI |
| **5: Infrastructure** | 3 days | Phase 2, 4 | Docker, TLS, backups |
| **Integration** | 1 week | All | E2E tests, bug fixes |

**Total: 7-8 weeks**

---

## Security Documentation

Create `docs/SECURITY.md` with:

1. **Trust Model**
   - Server stores encrypted blobs only
   - Compromise of server does not expose plaintext
   - Client handles all cryptographic operations
   - Server CAN verify manifest signatures using plaintext `sign_pubkey` in `epoch_keys`

2. **Epoch Key Limitations**
   - Provides backward secrecy (future keys don't expose past)
   - Does NOT provide forward secrecy (current key compromise exposes history)
   - Acceptable tradeoff for simplicity at small scale

3. **Identity Key / Invite Forward Secrecy Trade-off**
   
   Epoch bundles are encrypted with static identity keys (`crypto_box_seal`). This means:
   
   - **Risk:** If identity key is compromised, attacker can decrypt all historical invites (if ciphertext was captured)
   - **Mitigation:** Epoch keys rotate on member eviction. Compromised invite reveals only that epoch's keys.
   - **Acceptable because:**
     - Invites contain symmetric keys, not content directly
     - Epoch rotation limits blast radius
     - This matches industry standards (PGP, age, standard email encryption)
     - True forward secrecy (X3DH) requires stateful prekey servers—over-engineered for this use case
   
   If Mosaic evolves to real-time chat, migrate to X3DH.

4. **Critical Invariants**
   - Nonce: Generate 24 fresh random bytes per encryption. NEVER reuse.
   - Reserved bytes: Always validate `header[37:63] == 0` on decrypt
   - Session keys: Wiped from memory on logout via `sodium.memzero()`
   - Shard integrity: Verify SHA256 of downloaded ciphertext against signed manifest

4. **Conflict Resolution (Multi-Device)**
   - Each photo has a stable `asset_id` (UUID, generated on first upload)
   - Edits include `updated_at` timestamp and `device_id`
   - Merge rule: **Last-Writer-Wins** by `updated_at`, `device_id` as tiebreaker
   - Conflicts are resolved client-side; server accepts all valid manifests

5. **Epoch Key Eviction Protocol**
   
   When removing a user from an album, the following steps MUST be performed:
   
   ```
   1. Generate completely NEW random epoch key:
      - ReadKey = crypto.getRandomValues(32 bytes)  // NEVER derive from previous
      - SignKey = Ed25519.generateKeypair()         // Fresh keypair
   
   2. Increment epoch ID:
      - new_epoch_id = current_epoch_id + 1
   
   3. Distribute to remaining members ONLY:
      - For each remaining member:
        - Encrypt new key bundle with member's identity public key
        - Insert into epoch_keys table
      - Evicted user receives NO new epoch_keys row
   
   4. Evicted user's historical access:
      - Their existing epoch_keys rows remain (for epochs they had access to)
      - They can still decrypt photos from epochs 1 to N (when they were a member)
      - They CANNOT decrypt photos from epoch N+1 onward (backward secrecy)
   ```
   
   **Why fresh randomness is critical:**
   - If new epoch key were derived from previous key, an attacker who obtains
     ANY future key could potentially derive backward to keys they shouldn't have
   - Fresh randomness ensures each epoch is cryptographically independent
   - The only link between epochs is the explicit wrapping stored in epoch_keys

---

## Design Decisions Preserved

These elements from the original design remain unchanged:

| Element | Rationale |
|---------|-----------|
| 6MB shard size | Good memory/upload balance |
| XChaCha20-Poly1305 | Industry standard, libsodium native |
| Ed25519 signing | Fast, small signatures |
| Ed25519 → X25519 conversion | Birational equivalence proven safe; joint security validated; single keypair simplicity |
| `crypto_box_seal` for invites | Anonymous sender + ephemeral DH; signature inside payload provides authentication |
| Tus protocol | Resumability worth the complexity |
| SQLite-WASM + OPFS | Best option for offline-capable thick client |
| SharedWorker + Worker split | Clean DB/crypto separation |
| PostgreSQL | Right tool for the job |
| Single version scalar per album | Sufficient at small scale |
| Last-Writer-Wins conflict resolution | Simple, predictable, sufficient at small scale |
