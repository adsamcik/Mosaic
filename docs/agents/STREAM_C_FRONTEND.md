# Stream C: Frontend Implementation

**Duration:** 3 weeks  
**Depends On:** Phase 0 (interfaces + mocks)  
**Parallel With:** Stream A (Crypto), Stream B (Backend)  
**Deliverable:** `apps/web/` - React 19 + Vite application

> **Parent:** `.github/copilot-instructions.md`

---

## 🚨 Non-Interactive Commands (CRITICAL)

**ALL terminal commands MUST be non-interactive.** Commands that wait for user input will hang indefinitely.

| Task | ❌ NEVER USE | ✅ ALWAYS USE |
|------|--------------|---------------|
| Create project | `npm create vite@latest` (prompts) | `npm create vite@latest apps/web -- --template react-ts` |
| Run tests | `npm test` (may watch) | `npm run test:run` |
| Dev server | `npm run dev` (foreground) | `npm run dev` with `isBackground=true` |
| Build | — | `npm run build` |
| Lint | — | `npm run lint` |
| Type check | — | `npx tsc --noEmit` |

### Full Command Examples

```powershell
# ✅ Create project (non-interactive with template flag)
npm create vite@latest apps/web -- --template react-ts

# ✅ Install dependencies
cd apps/web ; npm install

# ✅ Run tests (non-interactive)
npm run test:run

# ✅ Build (non-interactive)
npm run build
```

### Output Capture Pattern

```powershell
# ✅ CORRECT - Capture output to file first
npm run test:run 2>&1 | Out-File -FilePath "vitest-output.txt" -Encoding utf8
Get-Content "vitest-output.txt" | Select-String -Pattern "PASS|FAIL"
```

---

## Context

You are implementing the "thick client" frontend for Mosaic. The browser:
- Handles ALL encryption/decryption (server never sees plaintext)
- Maintains a local SQLite database (encrypted at rest)
- Uses Web Workers for crypto and database operations
- Communicates with workers via Comlink

**During parallel development:** Use mock implementations from Phase 0 for crypto and API. Real implementations will be integrated later.

---

## Technology Stack

- React 19 + Vite
- TypeScript (strict mode)
- Comlink (worker communication)
- sql.js (SQLite in WASM)
- libsodium-wrappers
- @tanstack/react-virtual (virtualization)
- Supercluster (map clustering)
- idb (IndexedDB wrapper for upload queue)

---

## Project Structure

```
apps/web/
├── index.html
├── vite.config.ts
├── tsconfig.json
├── package.json
├── public/
│   └── sql-wasm.wasm
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── vite-env.d.ts
│   ├── workers/
│   │   ├── db.worker.ts          # SharedWorker - SQLite
│   │   ├── crypto.worker.ts      # Worker - libsodium
│   │   ├── geo.worker.ts         # Worker - Supercluster
│   │   └── types.ts              # Shared worker types
│   ├── lib/
│   │   ├── db-client.ts          # Comlink wrapper
│   │   ├── crypto-client.ts      # Comlink wrapper
│   │   ├── geo-client.ts         # Comlink wrapper
│   │   ├── api.ts                # Backend API client
│   │   ├── api-mock.ts           # Mock API (Phase 0)
│   │   ├── upload-queue.ts       # Upload orchestration
│   │   ├── sync-engine.ts        # Sync with server
│   │   ├── session.ts            # Session management
│   │   └── utils.ts              # Helpers
│   ├── components/
│   │   ├── App/
│   │   │   ├── AppShell.tsx
│   │   │   └── AppRoutes.tsx
│   │   ├── Auth/
│   │   │   ├── LoginForm.tsx
│   │   │   └── LogoutButton.tsx
│   │   ├── Gallery/
│   │   │   ├── Gallery.tsx
│   │   │   ├── PhotoGrid.tsx
│   │   │   ├── PhotoThumbnail.tsx
│   │   │   └── PhotoViewer.tsx
│   │   ├── Map/
│   │   │   ├── MapView.tsx
│   │   │   └── ClusterMarker.tsx
│   │   ├── Upload/
│   │   │   ├── UploadButton.tsx
│   │   │   ├── UploadProgress.tsx
│   │   │   └── DropZone.tsx
│   │   ├── Albums/
│   │   │   ├── AlbumList.tsx
│   │   │   ├── AlbumCard.tsx
│   │   │   └── CreateAlbumDialog.tsx
│   │   └── Sharing/
│   │       ├── ShareDialog.tsx
│   │       └── MemberList.tsx
│   ├── hooks/
│   │   ├── usePhotos.ts
│   │   ├── useAlbums.ts
│   │   ├── useSync.ts
│   │   ├── useUpload.ts
│   │   └── useSession.ts
│   ├── stores/
│   │   └── session-store.ts      # Zustand or context
│   └── styles/
│       └── globals.css
└── tests/
    └── ...
```

---

## Task 1: Project Setup

### Create Project

```bash
npm create vite@latest apps/web -- --template react-ts
cd apps/web
npm install
npm install comlink sql.js libsodium-wrappers supercluster @tanstack/react-virtual idb
npm install -D @types/libsodium-wrappers
```

### File: `vite.config.ts`

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  
  // Required for SharedWorker
  worker: {
    format: 'es',
  },
  
  // Required headers for SharedArrayBuffer (Argon2id parallelism)
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  
  // Optimize large dependencies
  optimizeDeps: {
    exclude: ['sql.js'],
  },
  
  build: {
    target: 'esnext',
  },
});
```

### File: `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "lib": ["ESNext", "DOM", "DOM.Iterable", "WebWorker"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

---

## Task 2: Worker Types

### File: `src/workers/types.ts`

```typescript
// Shared types for worker communication

export interface PhotoMeta {
  id: string;
  assetId: string;
  albumId: string;
  filename: string;
  mimeType: string;
  width: number;
  height: number;
  takenAt?: string;
  lat?: number;
  lng?: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ManifestRecord {
  id: string;
  albumId: string;
  versionCreated: number;
  isDeleted: boolean;
  encryptedMeta: Uint8Array;
  signature: string;
  signerPubkey: string;
  shardIds: string[];
}

export interface DecryptedManifest {
  id: string;
  albumId: string;
  versionCreated: number;
  isDeleted: boolean;
  meta: PhotoMeta;
  shardIds: string[];
}

export interface GeoPoint {
  id: string;
  lat: number;
  lng: number;
}

export interface Bounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface DbWorkerApi {
  init(sessionKey: Uint8Array): Promise<void>;
  close(): Promise<void>;
  
  // Album state
  getAlbumVersion(albumId: string): Promise<number>;
  setAlbumVersion(albumId: string, version: number): Promise<void>;
  
  // Manifests
  insertManifests(manifests: DecryptedManifest[]): Promise<void>;
  deleteManifest(id: string): Promise<void>;
  
  // Photos
  getPhotos(albumId: string, limit: number, offset: number): Promise<PhotoMeta[]>;
  searchPhotos(albumId: string, query: string): Promise<PhotoMeta[]>;
  getPhotosForMap(albumId: string, bounds: Bounds): Promise<GeoPoint[]>;
  getPhotoById(id: string): Promise<PhotoMeta | null>;
}

export interface CryptoWorkerApi {
  init(password: string, userSalt: Uint8Array, accountSalt: Uint8Array): Promise<void>;
  clear(): Promise<void>;
  
  getSessionKey(): Promise<Uint8Array>;
  
  encryptShard(
    data: Uint8Array,
    readKey: Uint8Array,
    epochId: number,
    shardIndex: number
  ): Promise<{ ciphertext: Uint8Array; sha256: string }>;
  
  decryptShard(envelope: Uint8Array, readKey: Uint8Array): Promise<Uint8Array>;
  
  decryptManifest(
    encryptedMeta: Uint8Array,
    readKey: Uint8Array
  ): Promise<PhotoMeta>;
  
  verifyManifest(
    manifest: Uint8Array,
    signature: Uint8Array,
    pubKey: Uint8Array
  ): Promise<boolean>;
}

export interface GeoWorkerApi {
  load(points: GeoJSON.Feature[]): void;
  getClusters(bbox: [number, number, number, number], zoom: number): GeoJSON.Feature[];
  getLeaves(clusterId: number, limit: number, offset: number): GeoJSON.Feature[];
}
```

---

## Task 3: Database Worker

### File: `src/workers/db.worker.ts`

```typescript
/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import type { DbWorkerApi, PhotoMeta, DecryptedManifest, Bounds, GeoPoint } from './types';

class DbWorker implements DbWorkerApi {
  private sql: SqlJsStatic | null = null;
  private db: Database | null = null;
  private sessionKey: Uint8Array | null = null;
  
  async init(sessionKey: Uint8Array): Promise<void> {
    this.sessionKey = sessionKey;
    
    // Initialize SQL.js
    this.sql = await initSqlJs({
      locateFile: (file: string) => `/sql-wasm.wasm`
    });
    
    // Try to load existing DB from OPFS
    const existingData = await this.loadFromOPFS();
    if (existingData) {
      // Decrypt and load
      const decrypted = await this.decryptBlob(existingData);
      this.db = new this.sql.Database(decrypted);
    } else {
      this.db = new this.sql.Database();
    }
    
    await this.runMigrations();
  }
  
  async close(): Promise<void> {
    if (this.db) {
      await this.saveToOPFS();
      this.db.close();
      this.db = null;
    }
    if (this.sessionKey) {
      this.sessionKey.fill(0);
      this.sessionKey = null;
    }
  }
  
  private async runMigrations(): Promise<void> {
    this.db!.run(`
      CREATE TABLE IF NOT EXISTS albums (
        id TEXT PRIMARY KEY,
        current_version INTEGER DEFAULT 0
      );
      
      CREATE TABLE IF NOT EXISTS photos (
        id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL,
        album_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        taken_at TEXT,
        lat REAL,
        lng REAL,
        tags TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      
      CREATE INDEX IF NOT EXISTS idx_photos_album ON photos(album_id);
      CREATE INDEX IF NOT EXISTS idx_photos_taken ON photos(taken_at);
      
      -- FTS5 for search
      CREATE VIRTUAL TABLE IF NOT EXISTS photos_fts USING fts5(
        filename, tags,
        content='photos',
        content_rowid='rowid'
      );
      
      -- Trigger to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS photos_ai AFTER INSERT ON photos BEGIN
        INSERT INTO photos_fts(rowid, filename, tags)
        VALUES (NEW.rowid, NEW.filename, NEW.tags);
      END;
      
      CREATE TRIGGER IF NOT EXISTS photos_ad AFTER DELETE ON photos BEGIN
        INSERT INTO photos_fts(photos_fts, rowid, filename, tags)
        VALUES ('delete', OLD.rowid, OLD.filename, OLD.tags);
      END;
      
      CREATE TRIGGER IF NOT EXISTS photos_au AFTER UPDATE ON photos BEGIN
        INSERT INTO photos_fts(photos_fts, rowid, filename, tags)
        VALUES ('delete', OLD.rowid, OLD.filename, OLD.tags);
        INSERT INTO photos_fts(rowid, filename, tags)
        VALUES (NEW.rowid, NEW.filename, NEW.tags);
      END;
    `);
  }
  
  async getAlbumVersion(albumId: string): Promise<number> {
    const result = this.db!.exec(
      'SELECT current_version FROM albums WHERE id = ?',
      [albumId]
    );
    return result[0]?.values[0]?.[0] as number ?? 0;
  }
  
  async setAlbumVersion(albumId: string, version: number): Promise<void> {
    this.db!.run(`
      INSERT INTO albums (id, current_version) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET current_version = ?
    `, [albumId, version, version]);
    await this.saveToOPFS();
  }
  
  async insertManifests(manifests: DecryptedManifest[]): Promise<void> {
    const stmt = this.db!.prepare(`
      INSERT OR REPLACE INTO photos 
      (id, asset_id, album_id, filename, mime_type, width, height, taken_at, lat, lng, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    for (const m of manifests) {
      if (m.isDeleted) {
        this.db!.run('DELETE FROM photos WHERE id = ?', [m.id]);
      } else {
        stmt.run([
          m.id,
          m.meta.assetId,
          m.albumId,
          m.meta.filename,
          m.meta.mimeType,
          m.meta.width,
          m.meta.height,
          m.meta.takenAt ?? null,
          m.meta.lat ?? null,
          m.meta.lng ?? null,
          JSON.stringify(m.meta.tags),
          m.meta.createdAt,
          m.meta.updatedAt
        ]);
      }
    }
    
    stmt.free();
    await this.saveToOPFS();
  }
  
  async deleteManifest(id: string): Promise<void> {
    this.db!.run('DELETE FROM photos WHERE id = ?', [id]);
    await this.saveToOPFS();
  }
  
  async getPhotos(albumId: string, limit: number, offset: number): Promise<PhotoMeta[]> {
    const result = this.db!.exec(`
      SELECT * FROM photos WHERE album_id = ?
      ORDER BY taken_at DESC, created_at DESC
      LIMIT ? OFFSET ?
    `, [albumId, limit, offset]);
    
    return this.rowsToPhotos(result);
  }
  
  async searchPhotos(albumId: string, query: string): Promise<PhotoMeta[]> {
    const result = this.db!.exec(`
      SELECT p.* FROM photos p
      INNER JOIN photos_fts fts ON p.rowid = fts.rowid
      WHERE p.album_id = ? AND photos_fts MATCH ?
      ORDER BY rank
      LIMIT 100
    `, [albumId, query]);
    
    return this.rowsToPhotos(result);
  }
  
  async getPhotosForMap(albumId: string, bounds: Bounds): Promise<GeoPoint[]> {
    const result = this.db!.exec(`
      SELECT id, lat, lng FROM photos
      WHERE album_id = ?
        AND lat IS NOT NULL AND lng IS NOT NULL
        AND lat BETWEEN ? AND ?
        AND lng BETWEEN ? AND ?
    `, [albumId, bounds.south, bounds.north, bounds.west, bounds.east]);
    
    if (!result[0]) return [];
    
    return result[0].values.map(row => ({
      id: row[0] as string,
      lat: row[1] as number,
      lng: row[2] as number
    }));
  }
  
  async getPhotoById(id: string): Promise<PhotoMeta | null> {
    const result = this.db!.exec('SELECT * FROM photos WHERE id = ?', [id]);
    const photos = this.rowsToPhotos(result);
    return photos[0] ?? null;
  }
  
  private rowsToPhotos(result: any[]): PhotoMeta[] {
    if (!result[0]) return [];
    
    const columns = result[0].columns as string[];
    return result[0].values.map((row: any[]) => {
      const obj: any = {};
      columns.forEach((col, i) => {
        obj[this.snakeToCamel(col)] = row[i];
      });
      obj.tags = JSON.parse(obj.tags || '[]');
      return obj as PhotoMeta;
    });
  }
  
  private snakeToCamel(str: string): string {
    return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  }
  
  // OPFS persistence (encrypted)
  private async loadFromOPFS(): Promise<Uint8Array | null> {
    try {
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle('mosaic.db.enc');
      const file = await fileHandle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
  }
  
  private async saveToOPFS(): Promise<void> {
    const data = this.db!.export();
    const encrypted = await this.encryptBlob(data);
    
    const root = await navigator.storage.getDirectory();
    const fileHandle = await root.getFileHandle('mosaic.db.enc', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(encrypted);
    await writable.close();
  }
  
  private async encryptBlob(data: Uint8Array): Promise<Uint8Array> {
    // Simple XChaCha20-Poly1305 encryption
    // In real impl, use libsodium via crypto worker
    // For now, store plaintext (to be fixed in integration)
    return data;
  }
  
  private async decryptBlob(data: Uint8Array): Promise<Uint8Array> {
    return data;
  }
}

// SharedWorker entry point
const worker = new DbWorker();
Comlink.expose(worker);

// Handle SharedWorker connections
declare const self: SharedWorkerGlobalScope;
self.onconnect = (event: MessageEvent) => {
  const port = event.ports[0];
  Comlink.expose(worker, port);
};
```

---

## Task 4: Crypto Worker

### File: `src/workers/crypto.worker.ts`

```typescript
/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import type { CryptoWorkerApi, PhotoMeta } from './types';

// For parallel development, use mock implementation
// Will be replaced with real crypto from libs/crypto

class CryptoWorker implements CryptoWorkerApi {
  private sessionKey: Uint8Array | null = null;
  private initialized = false;
  
  async init(
    password: string,
    userSalt: Uint8Array,
    accountSalt: Uint8Array
  ): Promise<void> {
    // Mock: Just hash the password for session key
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    this.sessionKey = new Uint8Array(hashBuffer);
    this.initialized = true;
  }
  
  async clear(): Promise<void> {
    if (this.sessionKey) {
      this.sessionKey.fill(0);
      this.sessionKey = null;
    }
    this.initialized = false;
  }
  
  async getSessionKey(): Promise<Uint8Array> {
    if (!this.sessionKey) throw new Error('Not initialized');
    return this.sessionKey;
  }
  
  async encryptShard(
    data: Uint8Array,
    readKey: Uint8Array,
    epochId: number,
    shardIndex: number
  ): Promise<{ ciphertext: Uint8Array; sha256: string }> {
    // Mock: Return data with fake header
    const header = new Uint8Array(64);
    header.set([0x53, 0x47, 0x7a, 0x6b, 0x03]); // SGzk + version
    
    const ciphertext = new Uint8Array(64 + data.length);
    ciphertext.set(header);
    ciphertext.set(data, 64);
    
    const hashBuffer = await crypto.subtle.digest('SHA-256', ciphertext);
    const sha256 = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
    
    return { ciphertext, sha256 };
  }
  
  async decryptShard(envelope: Uint8Array, readKey: Uint8Array): Promise<Uint8Array> {
    // Mock: Strip 64-byte header
    return envelope.slice(64);
  }
  
  async decryptManifest(
    encryptedMeta: Uint8Array,
    readKey: Uint8Array
  ): Promise<PhotoMeta> {
    // Mock: Parse as JSON directly
    const decoder = new TextDecoder();
    return JSON.parse(decoder.decode(encryptedMeta));
  }
  
  async verifyManifest(
    manifest: Uint8Array,
    signature: Uint8Array,
    pubKey: Uint8Array
  ): Promise<boolean> {
    // Mock: Always valid
    return true;
  }
}

const worker = new CryptoWorker();
Comlink.expose(worker);
```

---

## Task 5: Worker Clients

### File: `src/lib/db-client.ts`

```typescript
import * as Comlink from 'comlink';
import type { DbWorkerApi } from '../workers/types';

let worker: SharedWorker | null = null;
let api: Comlink.Remote<DbWorkerApi> | null = null;

export async function getDbClient(): Promise<Comlink.Remote<DbWorkerApi>> {
  if (api) return api;
  
  worker = new SharedWorker(
    new URL('../workers/db.worker.ts', import.meta.url),
    { type: 'module', name: 'db-worker' }
  );
  
  api = Comlink.wrap<DbWorkerApi>(worker.port);
  return api;
}

export async function closeDbClient(): Promise<void> {
  if (api) {
    await api.close();
    api = null;
  }
  if (worker) {
    worker.port.close();
    worker = null;
  }
}
```

### File: `src/lib/crypto-client.ts`

```typescript
import * as Comlink from 'comlink';
import type { CryptoWorkerApi } from '../workers/types';

let worker: Worker | null = null;
let api: Comlink.Remote<CryptoWorkerApi> | null = null;

export async function getCryptoClient(): Promise<Comlink.Remote<CryptoWorkerApi>> {
  if (api) return api;
  
  worker = new Worker(
    new URL('../workers/crypto.worker.ts', import.meta.url),
    { type: 'module', name: 'crypto-worker' }
  );
  
  api = Comlink.wrap<CryptoWorkerApi>(worker);
  return api;
}

export async function closeCryptoClient(): Promise<void> {
  if (api) {
    await api.clear();
    api = null;
  }
  if (worker) {
    worker.terminate();
    worker = null;
  }
}
```

---

## Task 6: Session Management

### File: `src/lib/session.ts`

```typescript
import { getDbClient, closeDbClient } from './db-client';
import { getCryptoClient, closeCryptoClient } from './crypto-client';

const IDLE_TIMEOUT = 30 * 60 * 1000; // 30 minutes

class SessionManager {
  private idleTimer: number | null = null;
  private _isLoggedIn = false;
  private listeners: Set<() => void> = new Set();
  
  get isLoggedIn() {
    return this._isLoggedIn;
  }
  
  subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  
  private notify() {
    this.listeners.forEach(cb => cb());
  }
  
  async login(password: string): Promise<void> {
    // Request persistent storage
    if (navigator.storage?.persist) {
      const granted = await navigator.storage.persist();
      if (!granted) {
        console.warn('Persistent storage not granted');
      }
    }
    
    // Initialize crypto worker
    const crypto = await getCryptoClient();
    const userSalt = new Uint8Array(16); // TODO: Fetch from server
    const accountSalt = new Uint8Array(16);
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
  
  async logout(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    
    await closeDbClient();
    await closeCryptoClient();
    
    sessionStorage.clear();
    this._isLoggedIn = false;
    this.notify();
  }
  
  private resetIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = window.setTimeout(() => {
      this.logout();
    }, IDLE_TIMEOUT);
  }
  
  private attachIdleListeners() {
    const events = ['mousedown', 'keydown', 'touchstart', 'scroll'];
    events.forEach(event => {
      document.addEventListener(
        event,
        () => this.resetIdleTimer(),
        { passive: true }
      );
    });
  }
}

export const session = new SessionManager();
```

---

## Task 7: Upload Queue

### File: `src/lib/upload-queue.ts`

```typescript
import { openDB, IDBPDatabase } from 'idb';
import { getCryptoClient } from './crypto-client';

const CHUNK_SIZE = 6 * 1024 * 1024; // 6MB

interface UploadTask {
  id: string;
  file: File;
  albumId: string;
  epochId: number;
  readKey: Uint8Array;
  status: 'queued' | 'uploading' | 'complete' | 'error';
  progress: number;
  completedShards: { index: number; shardId: string }[];
  error?: string;
}

interface PersistedTask {
  id: string;
  albumId: string;
  fileName: string;
  fileSize: number;
  epochId: number;
  totalChunks: number;
  completedShards: { index: number; shardId: string }[];
  status: string;
}

type ProgressCallback = (task: UploadTask) => void;
type CompleteCallback = (task: UploadTask, shardIds: string[]) => void;
type ErrorCallback = (task: UploadTask, error: Error) => void;

class UploadQueue {
  private queue: UploadTask[] = [];
  private processing = false;
  private maxConcurrent = 2;
  private activeCount = 0;
  private db: IDBPDatabase | null = null;
  
  onProgress?: ProgressCallback;
  onComplete?: CompleteCallback;
  onError?: ErrorCallback;
  
  async init() {
    this.db = await openDB('upload-queue', 1, {
      upgrade(db) {
        db.createObjectStore('tasks', { keyPath: 'id' });
      }
    });
  }
  
  async add(
    file: File,
    albumId: string,
    epochId: number,
    readKey: Uint8Array
  ): Promise<string> {
    const taskId = crypto.randomUUID();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    
    // Persist task state
    const persisted: PersistedTask = {
      id: taskId,
      albumId,
      fileName: file.name,
      fileSize: file.size,
      epochId,
      totalChunks,
      completedShards: [],
      status: 'queued'
    };
    await this.db!.put('tasks', persisted);
    
    const task: UploadTask = {
      id: taskId,
      file,
      albumId,
      epochId,
      readKey,
      status: 'queued',
      progress: 0,
      completedShards: []
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
      this.processTask(task).finally(() => {
        this.activeCount--;
        this.processQueue();
      });
    }
    
    this.processing = false;
  }
  
  private async processTask(task: UploadTask) {
    const crypto = await getCryptoClient();
    
    try {
      task.status = 'uploading';
      await this.updatePersistedTask(task.id, { status: 'uploading' });
      
      const totalChunks = Math.ceil(task.file.size / CHUNK_SIZE);
      const shardIds: string[] = [];
      
      for (let i = 0; i < totalChunks; i++) {
        // Check if already uploaded (resume support)
        const existing = task.completedShards.find(s => s.index === i);
        if (existing) {
          shardIds[i] = existing.shardId;
          continue;
        }
        
        // Read chunk
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, task.file.size);
        const chunk = await task.file.slice(start, end).arrayBuffer();
        
        // Encrypt
        const encrypted = await crypto.encryptShard(
          new Uint8Array(chunk),
          task.readKey,
          task.epochId,
          i
        );
        
        // Upload via Tus (mock for now)
        const shardId = await this.tusUpload(encrypted.ciphertext);
        shardIds[i] = shardId;
        
        // Persist progress
        task.completedShards.push({ index: i, shardId });
        await this.updatePersistedTask(task.id, {
          completedShards: task.completedShards
        });
        
        task.progress = (i + 1) / totalChunks;
        this.onProgress?.(task);
      }
      
      task.status = 'complete';
      await this.updatePersistedTask(task.id, { status: 'complete' });
      this.onComplete?.(task, shardIds);
      
    } catch (error) {
      task.status = 'error';
      task.error = (error as Error).message;
      await this.updatePersistedTask(task.id, { status: 'error' });
      this.onError?.(task, error as Error);
    }
  }
  
  private async updatePersistedTask(id: string, updates: Partial<PersistedTask>) {
    const task = await this.db!.get('tasks', id);
    if (task) {
      Object.assign(task, updates);
      await this.db!.put('tasks', task);
    }
  }
  
  private async tusUpload(data: Uint8Array): Promise<string> {
    // Mock: Return random shard ID
    // TODO: Integrate with tus-js-client
    await new Promise(r => setTimeout(r, 100)); // Simulate network
    return crypto.randomUUID();
  }
}

export const uploadQueue = new UploadQueue();
```

---

## Task 8: React Components

### File: `src/App.tsx`

```tsx
import { useEffect, useState } from 'react';
import { session } from './lib/session';
import { LoginForm } from './components/Auth/LoginForm';
import { AppShell } from './components/App/AppShell';

export function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(session.isLoggedIn);
  
  useEffect(() => {
    return session.subscribe(() => {
      setIsLoggedIn(session.isLoggedIn);
    });
  }, []);
  
  if (!isLoggedIn) {
    return <LoginForm />;
  }
  
  return <AppShell />;
}
```

### File: `src/components/Auth/LoginForm.tsx`

```tsx
import { useState } from 'react';
import { session } from '../../lib/session';

export function LoginForm() {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    
    try {
      await session.login(password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };
  
  return (
    <div className="login-container">
      <h1>Mosaic</h1>
      <form onSubmit={handleSubmit}>
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="Enter password"
          disabled={loading}
        />
        <button type="submit" disabled={loading}>
          {loading ? 'Unlocking...' : 'Unlock'}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  );
}
```

### File: `src/components/Gallery/PhotoGrid.tsx`

```tsx
import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { usePhotos } from '../../hooks/usePhotos';
import { PhotoThumbnail } from './PhotoThumbnail';

interface PhotoGridProps {
  albumId: string;
}

export function PhotoGrid({ albumId }: PhotoGridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const { photos, isLoading } = usePhotos(albumId);
  
  const COLUMNS = 4;
  const rowCount = Math.ceil(photos.length / COLUMNS);
  
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 200,
    overscan: 5
  });
  
  if (isLoading) {
    return <div className="loading">Loading photos...</div>;
  }
  
  return (
    <div ref={parentRef} className="photo-grid-container">
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: 'relative'
        }}
      >
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
              return photo ? (
                <PhotoThumbnail key={photo.id} photo={photo} />
              ) : null;
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
```

### File: `src/hooks/usePhotos.ts`

```tsx
import { useState, useEffect } from 'react';
import { getDbClient } from '../lib/db-client';
import type { PhotoMeta } from '../workers/types';

export function usePhotos(albumId: string) {
  const [photos, setPhotos] = useState<PhotoMeta[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  
  useEffect(() => {
    let cancelled = false;
    
    async function loadPhotos() {
      try {
        setIsLoading(true);
        const db = await getDbClient();
        const result = await db.getPhotos(albumId, 1000, 0);
        if (!cancelled) {
          setPhotos(result);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err as Error);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }
    
    loadPhotos();
    
    return () => {
      cancelled = true;
    };
  }, [albumId]);
  
  return { photos, isLoading, error };
}
```

---

## Task 9: Sync Engine

### File: `src/lib/sync-engine.ts`

```typescript
import { getDbClient } from './db-client';
import { getCryptoClient } from './crypto-client';
import type { ManifestRecord, DecryptedManifest } from '../workers/types';

// Mock API for parallel development
const api = {
  async getAlbum(id: string) {
    return { id, currentVersion: 100 };
  },
  async syncDelta(albumId: string, since: number): Promise<{
    manifests: ManifestRecord[];
    albumVersion: number;
    hasMore: boolean;
  }> {
    // Return mock data
    return { manifests: [], albumVersion: 100, hasMore: false };
  }
};

class SyncEngine extends EventTarget {
  private syncing = false;
  
  async sync(albumId: string, readKey: Uint8Array): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    
    try {
      const db = await getDbClient();
      const crypto = await getCryptoClient();
      
      const localVersion = await db.getAlbumVersion(albumId);
      const response = await api.syncDelta(albumId, localVersion);
      
      // Decrypt manifests
      const decrypted: DecryptedManifest[] = [];
      for (const m of response.manifests) {
        const meta = await crypto.decryptManifest(m.encryptedMeta, readKey);
        decrypted.push({
          id: m.id,
          albumId: m.albumId,
          versionCreated: m.versionCreated,
          isDeleted: m.isDeleted,
          meta,
          shardIds: m.shardIds
        });
      }
      
      // Store in local DB
      if (decrypted.length > 0) {
        await db.insertManifests(decrypted);
        await db.setAlbumVersion(albumId, response.albumVersion);
        
        this.dispatchEvent(new CustomEvent('synced', {
          detail: { count: decrypted.length }
        }));
      }
      
      // Continue if more data
      if (response.hasMore) {
        await this.sync(albumId, readKey);
      }
    } finally {
      this.syncing = false;
    }
  }
}

export const syncEngine = new SyncEngine();
```

---

## Exit Criteria

- [ ] Project builds without errors
- [ ] Workers initialize and communicate via Comlink
- [ ] Mock crypto/API allows UI development
- [ ] Photo grid renders with virtualization
- [ ] Session management works (login/logout/idle timeout)
- [ ] Upload queue persists state to IndexedDB
- [ ] Sync engine structure in place
- [ ] Basic routing between albums/gallery views
- [ ] Responsive layout for desktop (mobile deferred)

---

## Integration Points

When Stream A (Crypto) completes:
1. Replace `crypto.worker.ts` mock with real implementation
2. Add libsodium-wrappers initialization
3. Wire up DB encryption in `db.worker.ts`

When Stream B (Backend) completes:
1. Replace mock API with real `api.ts`
2. Integrate tus-js-client for uploads
3. Wire up actual sync flow
