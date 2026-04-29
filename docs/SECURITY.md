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
