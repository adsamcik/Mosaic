# Phase 0: Research + Interface Design

**Duration:** 3-5 days  
**Blocks:** All other phases  
**Parallelizable:** No (foundation phase)

> **Parent:** `.github/copilot-instructions.md`

---

## 🚨 Non-Interactive Commands (CRITICAL)

**ALL terminal commands MUST be non-interactive.** Commands that wait for user input will hang indefinitely.

| Task | ✅ Correct Command | Notes |
|------|-------------------|-------|
| Install dependencies | `npm install` | Runs and exits |
| Run crypto tests | `cd libs/crypto ; npm test` | Configured to run and exit |
| Build crypto | `cd libs/crypto ; npm run build` | Compiles TypeScript |
| Type check | `npx tsc --noEmit` | No output emitted |

### Output Capture Pattern

```powershell
# ✅ CORRECT - Capture output to file first
npm test 2>&1 | Out-File -FilePath "test-output.txt" -Encoding utf8
Get-Content "test-output.txt" | Select-String -Pattern "PASS|FAIL"
```

---

## Objectives

1. Benchmark Argon2id parameters across target devices
2. Define TypeScript interfaces for crypto library
3. Define OpenAPI specification for backend
4. Finalize database schema
5. Create mock implementations for parallel development

---

## Task 1: Argon2id Benchmarking

### Goal
Determine optimal parameters that achieve 500-1000ms derivation time across device types.

### Test Matrix

| Device Type | Target | Test Configs |
|-------------|--------|--------------|
| Desktop (modern) | 800ms | 64MB/3, 128MB/3, 64MB/4 |
| Laptop (mid-range) | 800ms | 64MB/3, 32MB/4 |
| Mobile (modern) | 1000ms | 32MB/4, 32MB/5, 16MB/6 |

### Deliverable: `libs/crypto/src/argon2-params.ts`

```typescript
export interface Argon2Params {
  memory: number;      // KiB
  iterations: number;
  parallelism: number;
}

export function getArgon2Params(): Argon2Params {
  // Implement device detection and return appropriate params
  const isMobile = /Android|iPhone|iPad/.test(navigator.userAgent);
  return isMobile 
    ? { memory: 32 * 1024, iterations: 4, parallelism: 1 }
    : { memory: 64 * 1024, iterations: 3, parallelism: 1 };
}
```

### Test Page
Create `apps/admin/benchmark.html` that:
1. Loads libsodium-wrappers
2. Runs Argon2id with each config 3 times
3. Reports median time
4. Outputs JSON results for documentation

---

## Task 2: Crypto Library Interface

### Deliverable: `libs/crypto/src/types.ts`

```typescript
// Key Types
export interface DerivedKeys {
  masterKey: Uint8Array;      // L0 - never persisted
  rootKey: Uint8Array;        // L1 - never persisted
  accountKey: Uint8Array;     // L2 - wrapped and stored
  accountKeyWrapped: Uint8Array;
}

export interface EpochKey {
  epochId: number;
  readKey: Uint8Array;        // 32 bytes - XChaCha20 encryption
  signKeypair: {
    publicKey: Uint8Array;    // 32 bytes
    secretKey: Uint8Array;    // 64 bytes
  };
}

export interface IdentityKeypair {
  ed25519: {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  };
  x25519: {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  };
}

export interface EpochKeyBundle {
  version: number;
  albumId: string;
  epochId: number;
  recipientPubkey: Uint8Array;
  readKey: Uint8Array;
  signKeypair: {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  };
}

export interface EncryptedShard {
  ciphertext: Uint8Array;
  sha256: string;
}

export interface SealedBundle {
  sealed: Uint8Array;
  signature: Uint8Array;
  sharerPubkey: Uint8Array;
}

// Envelope Header
export interface ShardHeader {
  magic: string;          // "SGzk"
  version: number;        // 0x03
  epochId: number;
  shardId: number;
  nonce: Uint8Array;      // 24 bytes
  reserved: Uint8Array;   // 27 bytes, must be zero
}
```

### Deliverable: `libs/crypto/src/index.ts` (Interface Only)

```typescript
import type { 
  DerivedKeys, EpochKey, IdentityKeypair, 
  EncryptedShard, EpochKeyBundle, SealedBundle 
} from './types';

export interface CryptoLib {
  // Initialization
  init(): Promise<void>;
  
  // Key Derivation
  deriveKeys(password: string, salt: Uint8Array): Promise<DerivedKeys>;
  deriveIdentityKeypair(seed: Uint8Array): IdentityKeypair;
  
  // Key Wrapping
  wrapKey(key: Uint8Array, wrapper: Uint8Array): Uint8Array;
  unwrapKey(wrapped: Uint8Array, wrapper: Uint8Array): Uint8Array;
  
  // Envelope Operations
  encryptShard(
    data: Uint8Array, 
    readKey: Uint8Array, 
    epochId: number, 
    shardIndex: number
  ): Promise<EncryptedShard>;
  
  decryptShard(
    envelope: Uint8Array, 
    readKey: Uint8Array
  ): Promise<Uint8Array>;
  
  verifyShard(ciphertext: Uint8Array, expectedSha256: string): boolean;
  
  // Manifest Signing
  signManifest(manifest: Uint8Array, signKey: Uint8Array): Uint8Array;
  verifyManifest(
    manifest: Uint8Array, 
    signature: Uint8Array, 
    pubKey: Uint8Array
  ): boolean;
  
  // Epoch Key Sharing (Authenticated Sealed Box)
  sealAndSignBundle(
    bundle: EpochKeyBundle,
    recipientEd25519Pub: Uint8Array,
    ownerIdentityKeypair: IdentityKeypair
  ): SealedBundle;
  
  verifyAndOpenBundle(
    sealed: Uint8Array,
    signature: Uint8Array,
    ownerEd25519Pub: Uint8Array,
    myIdentityKeypair: IdentityKeypair,
    expectedContext: { albumId: string; minEpochId: number }
  ): EpochKeyBundle;
  
  // Secure Memory
  memzero(buffer: Uint8Array): void;
  
  // Random
  randomBytes(length: number): Uint8Array;
}
```

---

## Task 3: OpenAPI Specification

### Deliverable: `docs/api/openapi.yaml`

```yaml
openapi: 3.1.0
info:
  title: Mosaic API
  version: 1.0.0
  description: Zero-knowledge photo gallery API

servers:
  - url: /api

paths:
  /health:
    get:
      operationId: getHealth
      responses:
        '200':
          description: Service healthy
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/HealthResponse'

  /users/me:
    get:
      operationId: getCurrentUser
      security: [RemoteUser: []]
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/User'

  /albums:
    get:
      operationId: listAlbums
      security: [RemoteUser: []]
      responses:
        '200':
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Album'
    post:
      operationId: createAlbum
      security: [RemoteUser: []]
      responses:
        '201':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Album'

  /albums/{albumId}:
    get:
      operationId: getAlbum
      parameters:
        - $ref: '#/components/parameters/AlbumId'
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Album'

  /albums/{albumId}/sync:
    get:
      operationId: syncAlbum
      parameters:
        - $ref: '#/components/parameters/AlbumId'
        - name: since
          in: query
          required: true
          schema:
            type: integer
            format: int64
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/SyncResponse'

  /albums/{albumId}/members:
    get:
      operationId: listAlbumMembers
      parameters:
        - $ref: '#/components/parameters/AlbumId'
      responses:
        '200':
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/AlbumMember'
    post:
      operationId: inviteToAlbum
      parameters:
        - $ref: '#/components/parameters/AlbumId'
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/InviteRequest'
      responses:
        '201':
          description: Invite created

  /albums/{albumId}/epoch-keys:
    get:
      operationId: getEpochKeys
      parameters:
        - $ref: '#/components/parameters/AlbumId'
      responses:
        '200':
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/EpochKeyRecord'
    post:
      operationId: createEpochKey
      parameters:
        - $ref: '#/components/parameters/AlbumId'
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateEpochKeyRequest'
      responses:
        '201':
          description: Epoch key created

  /manifests:
    post:
      operationId: createManifest
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateManifestRequest'
      responses:
        '201':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ManifestCreated'

  /shards/{shardId}:
    get:
      operationId: downloadShard
      parameters:
        - name: shardId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        '200':
          content:
            application/octet-stream:
              schema:
                type: string
                format: binary

components:
  securitySchemes:
    RemoteUser:
      type: apiKey
      in: header
      name: Remote-User

  parameters:
    AlbumId:
      name: albumId
      in: path
      required: true
      schema:
        type: string
        format: uuid

  schemas:
    HealthResponse:
      type: object
      properties:
        status:
          type: string
          enum: [healthy, unhealthy]
        timestamp:
          type: string
          format: date-time

    User:
      type: object
      properties:
        id:
          type: string
          format: uuid
        authSub:
          type: string
        identityPubkey:
          type: string
          description: Base64-encoded Ed25519 public key
        createdAt:
          type: string
          format: date-time

    Album:
      type: object
      properties:
        id:
          type: string
          format: uuid
        ownerId:
          type: string
          format: uuid
        currentVersion:
          type: integer
          format: int64
        createdAt:
          type: string
          format: date-time

    AlbumMember:
      type: object
      properties:
        userId:
          type: string
          format: uuid
        role:
          type: string
          enum: [owner, editor, viewer]
        joinedAt:
          type: string
          format: date-time

    SyncResponse:
      type: object
      properties:
        manifests:
          type: array
          items:
            $ref: '#/components/schemas/ManifestRecord'
        albumVersion:
          type: integer
          format: int64
        hasMore:
          type: boolean

    ManifestRecord:
      type: object
      properties:
        id:
          type: string
          format: uuid
        versionCreated:
          type: integer
          format: int64
        isDeleted:
          type: boolean
        encryptedMeta:
          type: string
          format: byte
        signature:
          type: string
        signerPubkey:
          type: string
        shardIds:
          type: array
          items:
            type: string
            format: uuid

    EpochKeyRecord:
      type: object
      properties:
        id:
          type: string
          format: uuid
        epochId:
          type: integer
        encryptedKeyBundle:
          type: string
          format: byte
        ownerSignature:
          type: string
          format: byte
        sharerPubkey:
          type: string
          format: byte
        signPubkey:
          type: string
          format: byte

    CreateManifestRequest:
      type: object
      required:
        - albumId
        - encryptedMeta
        - signature
        - signerPubkey
        - shardIds
      properties:
        albumId:
          type: string
          format: uuid
        encryptedMeta:
          type: string
          format: byte
        signature:
          type: string
        signerPubkey:
          type: string
        shardIds:
          type: array
          items:
            type: string
            format: uuid

    ManifestCreated:
      type: object
      properties:
        id:
          type: string
          format: uuid
        version:
          type: integer
          format: int64

    CreateEpochKeyRequest:
      type: object
      required:
        - recipientId
        - epochId
        - encryptedKeyBundle
        - ownerSignature
        - sharerPubkey
        - signPubkey
      properties:
        recipientId:
          type: string
          format: uuid
        epochId:
          type: integer
        encryptedKeyBundle:
          type: string
          format: byte
        ownerSignature:
          type: string
          format: byte
        sharerPubkey:
          type: string
          format: byte
        signPubkey:
          type: string
          format: byte

    InviteRequest:
      type: object
      required:
        - recipientPubkey
        - role
        - epochKeys
      properties:
        recipientPubkey:
          type: string
          description: Base64 Ed25519 public key
        role:
          type: string
          enum: [editor, viewer]
        epochKeys:
          type: array
          items:
            $ref: '#/components/schemas/CreateEpochKeyRequest'
```

---

## Task 4: Database Schema (Final Review)

Review and finalize `docs/IMPLEMENTATION_PLAN.md` Phase 3 schema. Ensure:

1. All foreign keys have correct CASCADE/RESTRICT behavior
2. All necessary indexes are defined
3. UUIDv7 is used for time-ordered inserts
4. Quota table exists for abuse prevention

### Deliverable
Confirm schema is ready or document required changes.

---

## Task 5: Mock Implementations

Create mock implementations so other streams can work in parallel.

### Deliverable: `libs/crypto/src/mock.ts`

```typescript
import type { CryptoLib } from './index';

export const mockCrypto: CryptoLib = {
  async init() {},
  
  async deriveKeys(password, salt) {
    // Return deterministic fake keys for testing
    return {
      masterKey: new Uint8Array(32).fill(1),
      rootKey: new Uint8Array(32).fill(2),
      accountKey: new Uint8Array(32).fill(3),
      accountKeyWrapped: new Uint8Array(48).fill(4),
    };
  },
  
  async encryptShard(data, readKey, epochId, shardIndex) {
    // Return data with fake header prepended
    const header = new Uint8Array(64);
    header.set([0x53, 0x47, 0x7a, 0x6b, 0x03]); // SGzk + version
    return {
      ciphertext: new Uint8Array([...header, ...data]),
      sha256: 'mock-sha256-' + shardIndex,
    };
  },
  
  async decryptShard(envelope, readKey) {
    // Strip 64-byte header, return rest
    return envelope.slice(64);
  },
  
  // ... implement remaining methods with mock behavior
};
```

### Deliverable: `apps/admin/src/lib/api-mock.ts`

```typescript
import type { Album, SyncResponse, ManifestRecord } from './api-types';

export const mockApi = {
  async getAlbum(id: string): Promise<Album> {
    return {
      id,
      ownerId: 'mock-owner',
      currentVersion: 100,
      createdAt: new Date().toISOString(),
    };
  },
  
  async syncDelta(albumId: string, since: number): Promise<SyncResponse> {
    // Return mock manifests for UI development
    const manifests: ManifestRecord[] = Array.from({ length: 20 }, (_, i) => ({
      id: `manifest-${since + i}`,
      versionCreated: since + i + 1,
      isDeleted: false,
      encryptedMeta: new Uint8Array(100),
      signature: 'mock-sig',
      signerPubkey: 'mock-pubkey',
      shardIds: [`shard-${i}-0`, `shard-${i}-1`],
    }));
    
    return {
      manifests,
      albumVersion: 100,
      hasMore: since < 80,
    };
  },
  
  // ... implement remaining endpoints
};
```

---

## Exit Criteria

- [ ] Argon2id params documented with benchmark results
- [ ] `libs/crypto/src/types.ts` complete and reviewed
- [ ] `libs/crypto/src/index.ts` interface complete
- [ ] `docs/api/openapi.yaml` complete and validated
- [ ] Database schema finalized
- [ ] Mock crypto implementation ready
- [ ] Mock API implementation ready
- [ ] All interfaces committed to repo

---

## Handoff

Once complete, the following streams can begin in parallel:

- **Stream A (Crypto):** Implement `libs/crypto` against the interface
- **Stream B (Backend):** Implement API against OpenAPI spec
- **Stream C (Frontend):** Build UI using mock implementations
