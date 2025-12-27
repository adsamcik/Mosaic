# Phase: Integration

**Duration:** 1 week  
**Depends On:** Stream A (Crypto), Stream B (Backend), Stream C (Frontend)  
**Deliverable:** Fully integrated, working application

---

## Context

All three parallel streams are complete with mock/interface boundaries:
- **Stream A:** `libs/crypto/` - Real cryptographic operations
- **Stream B:** `apps/backend/` - .NET API with database
- **Stream C:** `apps/admin/` - React UI with mock crypto/API

This phase wires everything together and validates the full data flow.

---

## Task 1: Wire Real Crypto to Frontend

### 1.1: Bundle Crypto Library

```bash
cd libs/crypto
npm run build
cd ../..
npm install ./libs/crypto --save -w apps/admin
```

### 1.2: Update Crypto Worker

**File:** `apps/admin/src/workers/crypto.worker.ts`

Replace mock implementation with real crypto:

```typescript
/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import {
  initSodium,
  deriveKeychain,
  unwrapAccountKey,
  createEnvelope,
  openEnvelope,
  deriveSessionKey,
  clearKeychain,
  generateIdentityKeyPair,
  signManifest,
  verifyManifestSignature,
  createEpochKeyBundle,
  openEpochKeyBundle,
  type Keychain
} from '@mosaic/crypto';
import type { CryptoWorkerApi, PhotoMeta } from './types';

class CryptoWorker implements CryptoWorkerApi {
  private keychain: Keychain | null = null;
  
  async init(
    password: string,
    userSalt: Uint8Array,
    accountSalt: Uint8Array
  ): Promise<void> {
    await initSodium();
    this.keychain = await deriveKeychain(password, userSalt, accountSalt);
  }
  
  async clear(): Promise<void> {
    if (this.keychain) {
      clearKeychain(this.keychain);
      this.keychain = null;
    }
  }
  
  async getSessionKey(): Promise<Uint8Array> {
    if (!this.keychain) throw new Error('Not initialized');
    return deriveSessionKey(this.keychain);
  }
  
  async encryptShard(
    data: Uint8Array,
    readKey: Uint8Array,
    epochId: number,
    shardIndex: number
  ): Promise<{ ciphertext: Uint8Array; sha256: string }> {
    const envelope = createEnvelope(data, readKey, epochId, shardIndex);
    const hashBuffer = await crypto.subtle.digest('SHA-256', envelope);
    const sha256 = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
    return { ciphertext: envelope, sha256 };
  }
  
  async decryptShard(envelope: Uint8Array, readKey: Uint8Array): Promise<Uint8Array> {
    return openEnvelope(envelope, readKey);
  }
  
  async decryptManifest(
    encryptedMeta: Uint8Array,
    readKey: Uint8Array
  ): Promise<PhotoMeta> {
    const plaintext = openEnvelope(encryptedMeta, readKey);
    return JSON.parse(new TextDecoder().decode(plaintext));
  }
  
  async verifyManifest(
    manifest: Uint8Array,
    signature: Uint8Array,
    pubKey: Uint8Array
  ): Promise<boolean> {
    return verifyManifestSignature(manifest, signature, pubKey);
  }
  
  // Additional methods for key management
  async getIdentityKeyPair() {
    // Generate or retrieve from wrapped storage
    return generateIdentityKeyPair();
  }
  
  async createEpochKeyBundle(
    readKey: Uint8Array,
    signKey: Uint8Array,
    recipientIdentityPubKey: Uint8Array
  ): Promise<Uint8Array> {
    if (!this.keychain) throw new Error('Not initialized');
    return createEpochKeyBundle(
      readKey,
      signKey,
      recipientIdentityPubKey,
      this.keychain.identitySignKey
    );
  }
  
  async openEpochKeyBundle(
    bundle: Uint8Array,
    senderIdentityPubKey: Uint8Array
  ): Promise<{ readKey: Uint8Array; signKey: Uint8Array }> {
    if (!this.keychain) throw new Error('Not initialized');
    return openEpochKeyBundle(bundle, senderIdentityPubKey, this.keychain.identityEncKey);
  }
}

const worker = new CryptoWorker();
Comlink.expose(worker);
```

### 1.3: Add Database Encryption

**Update:** `apps/admin/src/workers/db.worker.ts`

Add encryption to OPFS persistence:

```typescript
import { secretbox, secretbox_open, randombytes_buf, NONCE_BYTES } from '@mosaic/crypto';

// In DbWorker class:

private async encryptBlob(data: Uint8Array): Promise<Uint8Array> {
  if (!this.sessionKey) throw new Error('No session key');
  
  const nonce = randombytes_buf(NONCE_BYTES);
  const ciphertext = secretbox(data, nonce, this.sessionKey);
  
  // nonce || ciphertext
  const result = new Uint8Array(nonce.length + ciphertext.length);
  result.set(nonce);
  result.set(ciphertext, nonce.length);
  return result;
}

private async decryptBlob(data: Uint8Array): Promise<Uint8Array> {
  if (!this.sessionKey) throw new Error('No session key');
  
  const nonce = data.slice(0, NONCE_BYTES);
  const ciphertext = data.slice(NONCE_BYTES);
  return secretbox_open(ciphertext, nonce, this.sessionKey);
}
```

---

## Task 2: Wire Real API to Frontend

### 2.1: Create API Client

**File:** `apps/admin/src/lib/api.ts`

```typescript
const API_BASE = '/api';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
}

async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, headers = {} } = options;
  
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(error || `HTTP ${response.status}`);
  }
  
  if (response.status === 204) {
    return undefined as T;
  }
  
  return response.json();
}

// Auth
export async function getMe() {
  return apiRequest<{ userId: string; username: string; identityPubKey: string }>('/me');
}

export async function createAccount(identityPubKey: string) {
  return apiRequest('/me', {
    method: 'POST',
    body: { identityPubKey }
  });
}

export async function storeUserSalt(salt: string) {
  return apiRequest('/me/salt', {
    method: 'PUT',
    body: { salt }
  });
}

// Albums
export interface AlbumDTO {
  id: string;
  ownerId: string;
  currentEpochId: number;
  currentVersion: number;
  createdAt: string;
}

export async function listAlbums(): Promise<AlbumDTO[]> {
  return apiRequest('/albums');
}

export async function getAlbum(id: string): Promise<AlbumDTO> {
  return apiRequest(`/albums/${id}`);
}

export async function createAlbum(): Promise<AlbumDTO> {
  return apiRequest('/albums', { method: 'POST' });
}

// Epoch Keys
export interface EpochKeyDTO {
  epochId: number;
  encryptedEpochKeyBundle: string;
  createdAt: string;
}

export async function getEpochKeys(albumId: string): Promise<EpochKeyDTO[]> {
  return apiRequest(`/albums/${albumId}/epoch-keys`);
}

export async function createEpochKey(albumId: string, bundle: string) {
  return apiRequest(`/albums/${albumId}/epoch-keys`, {
    method: 'POST',
    body: { encryptedEpochKeyBundle: bundle }
  });
}

// Manifests
export interface ManifestDTO {
  id: string;
  albumId: string;
  epochId: number;
  versionCreated: number;
  isDeleted: boolean;
  encryptedMeta: string; // Base64
  signature: string;
  signerPubKey: string;
  shards: { shardId: string; index: number; sha256: string }[];
}

export interface SyncDeltaResponse {
  manifests: ManifestDTO[];
  albumVersion: number;
  hasMore: boolean;
}

export async function syncDelta(albumId: string, since: number): Promise<SyncDeltaResponse> {
  return apiRequest(`/albums/${albumId}/manifests?since=${since}&limit=100`);
}

export async function createManifest(
  albumId: string,
  manifest: Omit<ManifestDTO, 'id' | 'versionCreated'>
): Promise<ManifestDTO> {
  return apiRequest(`/albums/${albumId}/manifests`, {
    method: 'POST',
    body: manifest
  });
}

export async function softDeleteManifest(albumId: string, manifestId: string) {
  return apiRequest(`/albums/${albumId}/manifests/${manifestId}`, {
    method: 'DELETE'
  });
}

// Shards
export function getShardUploadUrl(albumId: string): string {
  return `${API_BASE}/albums/${albumId}/shards`;
}

export async function downloadShard(
  albumId: string,
  shardId: string
): Promise<Uint8Array> {
  const response = await fetch(`${API_BASE}/albums/${albumId}/shards/${shardId}`);
  if (!response.ok) throw new Error(`Failed to download shard: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

// Sharing
export interface AlbumMemberDTO {
  userId: string;
  username: string;
  identityPubKey: string;
  role: 'owner' | 'editor' | 'viewer';
  joinedAt: string;
}

export async function getMembers(albumId: string): Promise<AlbumMemberDTO[]> {
  return apiRequest(`/albums/${albumId}/members`);
}

export async function inviteMember(
  albumId: string,
  userId: string,
  role: 'editor' | 'viewer',
  epochKeyBundle: string
) {
  return apiRequest(`/albums/${albumId}/members`, {
    method: 'POST',
    body: { userId, role, epochKeyBundle }
  });
}

export async function removeMember(albumId: string, userId: string) {
  return apiRequest(`/albums/${albumId}/members/${userId}`, {
    method: 'DELETE'
  });
}
```

### 2.2: Integrate Tus Client

**Install:**
```bash
cd apps/admin
npm install tus-js-client
```

**Update:** `apps/admin/src/lib/upload-queue.ts`

```typescript
import * as tus from 'tus-js-client';
import { getShardUploadUrl } from './api';

// Replace tusUpload method:

private async tusUpload(
  data: Uint8Array,
  albumId: string,
  metadata: { epochId: number; shardIndex: number; sha256: string }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const upload = new tus.Upload(new Blob([data]), {
      endpoint: getShardUploadUrl(albumId),
      retryDelays: [0, 1000, 3000, 5000],
      chunkSize: data.length, // Single request
      metadata: {
        epochId: String(metadata.epochId),
        shardIndex: String(metadata.shardIndex),
        sha256: metadata.sha256
      },
      onError: reject,
      onSuccess: () => {
        // Extract shard ID from URL
        const url = upload.url!;
        const shardId = url.substring(url.lastIndexOf('/') + 1);
        resolve(shardId);
      }
    });
    
    upload.start();
  });
}
```

---

## Task 3: Wire Sync Engine

**Update:** `apps/admin/src/lib/sync-engine.ts`

```typescript
import { getDbClient } from './db-client';
import { getCryptoClient } from './crypto-client';
import * as api from './api';
import type { DecryptedManifest } from '../workers/types';

class SyncEngine extends EventTarget {
  private syncing = false;
  private intervalId: number | null = null;
  
  // Epoch keys cache per album
  private epochKeys: Map<string, Map<number, Uint8Array>> = new Map();
  
  async loadEpochKeys(albumId: string): Promise<void> {
    const keys = await api.getEpochKeys(albumId);
    const crypto = await getCryptoClient();
    const album = await api.getAlbum(albumId);
    const members = await api.getMembers(albumId);
    
    // Find owner's public key
    const owner = members.find(m => m.role === 'owner');
    if (!owner) throw new Error('Album has no owner');
    
    const epochKeyMap = new Map<number, Uint8Array>();
    
    for (const key of keys) {
      const bundle = Uint8Array.from(atob(key.encryptedEpochKeyBundle), c => c.charCodeAt(0));
      const ownerPubKey = Uint8Array.from(atob(owner.identityPubKey), c => c.charCodeAt(0));
      
      const { readKey } = await crypto.openEpochKeyBundle(bundle, ownerPubKey);
      epochKeyMap.set(key.epochId, readKey);
    }
    
    this.epochKeys.set(albumId, epochKeyMap);
  }
  
  async sync(albumId: string): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    
    try {
      // Ensure epoch keys are loaded
      if (!this.epochKeys.has(albumId)) {
        await this.loadEpochKeys(albumId);
      }
      
      const db = await getDbClient();
      const crypto = await getCryptoClient();
      
      const localVersion = await db.getAlbumVersion(albumId);
      const response = await api.syncDelta(albumId, localVersion);
      
      // Decrypt manifests
      const decrypted: DecryptedManifest[] = [];
      
      for (const m of response.manifests) {
        const epochKey = this.epochKeys.get(albumId)?.get(m.epochId);
        if (!epochKey) {
          console.warn(`Missing epoch key ${m.epochId} for manifest ${m.id}`);
          continue;
        }
        
        // Verify signature first
        const encryptedMeta = Uint8Array.from(atob(m.encryptedMeta), c => c.charCodeAt(0));
        const signature = Uint8Array.from(atob(m.signature), c => c.charCodeAt(0));
        const signerPubKey = Uint8Array.from(atob(m.signerPubKey), c => c.charCodeAt(0));
        
        const valid = await crypto.verifyManifest(encryptedMeta, signature, signerPubKey);
        if (!valid) {
          console.warn(`Invalid signature for manifest ${m.id}`);
          continue;
        }
        
        const meta = await crypto.decryptManifest(encryptedMeta, epochKey);
        
        decrypted.push({
          id: m.id,
          albumId: m.albumId,
          versionCreated: m.versionCreated,
          isDeleted: m.isDeleted,
          meta,
          shardIds: m.shards.map(s => s.shardId)
        });
      }
      
      // Store in local DB
      if (decrypted.length > 0) {
        await db.insertManifests(decrypted);
        await db.setAlbumVersion(albumId, response.albumVersion);
        
        this.dispatchEvent(new CustomEvent('synced', {
          detail: { albumId, count: decrypted.length }
        }));
      }
      
      // Continue if more data
      if (response.hasMore) {
        await this.sync(albumId);
      }
    } finally {
      this.syncing = false;
    }
  }
  
  startPolling(albumId: string, intervalMs = 30000) {
    this.stopPolling();
    this.sync(albumId); // Initial sync
    this.intervalId = window.setInterval(() => {
      this.sync(albumId);
    }, intervalMs);
  }
  
  stopPolling() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

export const syncEngine = new SyncEngine();
```

---

## Task 4: Update Session Management

**Update:** `apps/admin/src/lib/session.ts`

```typescript
import * as api from './api';

class SessionManager {
  private user: { userId: string; username: string } | null = null;
  
  async login(password: string): Promise<void> {
    // Request persistent storage
    if (navigator.storage?.persist) {
      await navigator.storage.persist();
    }
    
    // Get user info from reverse proxy header
    const me = await api.getMe();
    this.user = { userId: me.userId, username: me.username };
    
    // Initialize crypto worker
    const crypto = await getCryptoClient();
    
    // Fetch user salt from server (or use derived if first login)
    let userSalt: Uint8Array;
    try {
      const saltResponse = await fetch('/api/me/salt');
      if (saltResponse.ok) {
        const { salt } = await saltResponse.json();
        userSalt = Uint8Array.from(atob(salt), c => c.charCodeAt(0));
      } else {
        // First login - generate and store salt
        userSalt = crypto.getRandomValues(new Uint8Array(16));
        await api.storeUserSalt(btoa(String.fromCharCode(...userSalt)));
      }
    } catch {
      userSalt = crypto.getRandomValues(new Uint8Array(16));
    }
    
    // Generate account salt (derived from user ID)
    const accountSalt = new TextEncoder().encode(me.userId).slice(0, 16);
    
    await crypto.init(password, userSalt, accountSalt);
    
    // Initialize database worker
    const db = await getDbClient();
    const sessionKey = await crypto.getSessionKey();
    await db.init(sessionKey);
    
    this._isLoggedIn = true;
    this.notify();
    
    this.resetIdleTimer();
    this.attachIdleListeners();
  }
  
  // ... rest of implementation
}
```

---

## Task 5: E2E Test Scenarios

### Scenario 1: First-Time Login

```
1. User accesses app (authenticated via reverse proxy)
2. App prompts for password (encryption key)
3. User enters password
4. Crypto worker derives keys with Argon2id
5. Local database initializes (empty)
6. App shows empty gallery
7. Close and reopen - data persists (OPFS)
```

### Scenario 2: Photo Upload

```
1. User selects photos via file picker
2. For each photo:
   a. Extract EXIF metadata (width, height, date, GPS)
   b. Generate thumbnails (done client-side)
   c. Split into 6MB chunks
   d. Encrypt each chunk with XChaCha20-Poly1305
   e. Upload via Tus protocol
   f. Create manifest with encrypted metadata
   g. Sign manifest with epoch sign key
   h. POST manifest to server
3. Sync engine picks up new manifest
4. Photo appears in grid
```

### Scenario 3: Photo View

```
1. User clicks photo in grid
2. Check if original is cached locally
3. If not:
   a. Fetch shard metadata from local DB
   b. Download each shard
   c. Verify SHA256 of each shard
   d. Decrypt each shard
   e. Concatenate to form original
4. Display in lightbox
```

### Scenario 4: Album Sharing

```
1. Owner clicks "Share" on album
2. Owner searches for user by username
3. Server returns user's identity public key
4. Crypto worker:
   a. Gets current epoch (readKey + signKey)
   b. Converts owner's Ed25519 sign key to X25519
   c. Converts recipient's Ed25519 pubkey to X25519
   d. Uses crypto_box_seal to encrypt epoch keys
   e. Signs the sealed box with owner's Ed25519 key
5. POST sealed box to server
6. Recipient:
   a. Verifies signature
   b. Opens sealed box with their X25519 secret key
   c. Now has readKey + signKey for epoch
   d. Can sync and decrypt photos
```

### Scenario 5: Member Removal + Epoch Ratchet

```
1. Owner removes a member
2. Server marks membership as removed
3. Owner's client:
   a. Generates new epoch (new readKey + signKey)
   b. Re-encrypts epoch keys for remaining members
   c. POSTs new epoch to server
4. New uploads use new epoch
5. Removed member:
   a. Can still decrypt old photos (has old epoch key)
   b. Cannot decrypt new photos (lacks new epoch key)
```

---

## Task 6: Integration Tests

### Test: Crypto Round-Trip

```typescript
import { initSodium, createEnvelope, openEnvelope, randombytes_buf } from '@mosaic/crypto';

test('envelope round-trip', async () => {
  await initSodium();
  
  const data = new TextEncoder().encode('Hello, World!');
  const readKey = randombytes_buf(32);
  const epochId = 1;
  const shardIndex = 0;
  
  const envelope = createEnvelope(data, readKey, epochId, shardIndex);
  const decrypted = openEnvelope(envelope, readKey);
  
  expect(new TextDecoder().decode(decrypted)).toBe('Hello, World!');
});
```

### Test: API Integration

```typescript
test('album CRUD', async () => {
  // Create album
  const album = await api.createAlbum();
  expect(album.id).toBeDefined();
  
  // List albums
  const albums = await api.listAlbums();
  expect(albums.some(a => a.id === album.id)).toBe(true);
  
  // Get album
  const fetched = await api.getAlbum(album.id);
  expect(fetched.id).toBe(album.id);
});
```

### Test: Full Upload Flow

```typescript
test('upload and sync', async () => {
  const albumId = 'test-album';
  const readKey = randombytes_buf(32);
  
  // Create test file
  const file = new File(['test content'], 'test.jpg', { type: 'image/jpeg' });
  
  // Upload
  await uploadQueue.add(file, albumId, 1, readKey);
  
  // Wait for completion
  await new Promise(resolve => {
    uploadQueue.onComplete = resolve;
  });
  
  // Sync
  await syncEngine.sync(albumId);
  
  // Check local DB
  const db = await getDbClient();
  const photos = await db.getPhotos(albumId, 10, 0);
  expect(photos.length).toBe(1);
  expect(photos[0].filename).toBe('test.jpg');
});
```

---

## Task 7: Docker Integration

### Update `docker-compose.yml`

```yaml
services:
  traefik:
    image: traefik:v3.0
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./traefik:/etc/traefik
      - letsencrypt:/letsencrypt
    command:
      - "--providers.docker=true"
      - "--providers.docker.exposedbydefault=false"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.websecure.address=:443"
      - "--certificatesresolvers.le.acme.tlschallenge=true"
      - "--certificatesresolvers.le.acme.email=${ACME_EMAIL}"
      - "--certificatesresolvers.le.acme.storage=/letsencrypt/acme.json"

  authelia:
    image: authelia/authelia:latest
    volumes:
      - ./authelia:/config
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.authelia.rule=Host(`auth.${DOMAIN}`)"
      - "traefik.http.routers.authelia.tls.certresolver=le"

  backend:
    build: ./apps/backend
    environment:
      - ConnectionStrings__Default=Host=db;Database=mosaic;Username=mosaic;Password=${DB_PASSWORD}
      - Storage__BasePath=/data/shards
    volumes:
      - shard_data:/data/shards
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.api.rule=Host(`${DOMAIN}`) && PathPrefix(`/api`)"
      - "traefik.http.routers.api.tls.certresolver=le"
      - "traefik.http.routers.api.middlewares=authelia@docker"

  frontend:
    build: ./apps/admin
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.frontend.rule=Host(`${DOMAIN}`)"
      - "traefik.http.routers.frontend.tls.certresolver=le"
      - "traefik.http.routers.frontend.middlewares=authelia@docker,headers@docker"
      # Required headers for SharedArrayBuffer
      - "traefik.http.middlewares.headers.headers.customresponseheaders.Cross-Origin-Opener-Policy=same-origin"
      - "traefik.http.middlewares.headers.headers.customresponseheaders.Cross-Origin-Embedder-Policy=require-corp"

  db:
    image: postgres:17-alpine
    environment:
      - POSTGRES_USER=mosaic
      - POSTGRES_PASSWORD=${DB_PASSWORD}
      - POSTGRES_DB=mosaic
    volumes:
      - pg_data:/var/lib/postgresql/data

volumes:
  pg_data:
  shard_data:
  letsencrypt:
```

### Frontend Dockerfile

**File:** `apps/admin/Dockerfile`

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

### Nginx Config

**File:** `apps/admin/nginx.conf`

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;

    # SPA routing
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Cache static assets
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|wasm)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Don't cache HTML
    location ~* \.html$ {
        expires -1;
        add_header Cache-Control "no-cache, no-store, must-revalidate";
    }
}
```

---

## Exit Criteria

- [ ] Frontend uses real crypto library (no mocks)
- [ ] Frontend communicates with real backend API
- [ ] Tus uploads work with shard integrity verification
- [ ] Sync engine decrypts and stores manifests
- [ ] Photo viewing downloads, verifies, and decrypts shards
- [ ] Album sharing encrypts epoch keys for recipients
- [ ] Docker compose brings up full stack
- [ ] COOP/COEP headers enable SharedArrayBuffer
- [ ] All E2E test scenarios pass manually
- [ ] No console errors in normal operation

---

## Known Integration Points to Verify

1. **Base64 Encoding:** Ensure frontend and backend agree on Base64 encoding (standard vs URL-safe)
2. **UUID Format:** Both use UUIDv7, verify format compatibility
3. **Timestamp Format:** ISO 8601 with timezone
4. **Error Format:** Consistent error response structure
5. **Tus Metadata:** Verify metadata key names match
6. **Header Names:** `Remote-User` header name matches Authelia config
