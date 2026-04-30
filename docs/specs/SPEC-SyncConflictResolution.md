# SPEC: Sync & Conflict Resolution for Block-Based Content

> **Status:** Implemented (Lane B). Deterministic LWW conflict resolution for
> album content landed in `3d66b67` (`feat(web/sync): add deterministic
> conflict resolution for album content`). The CRDT/Yjs path remains a
> deferred enhancement and is not part of v1.
> **Author:** GitHub Copilot  
> **Date:** 2026-01-29  
> **Scope:** Sync protocol design, conflict resolution strategies, implementation recommendations

---

## TL;DR

**Recommendation:** Use **Last-Writer-Wins (LWW) with Block-Level Granularity** for Mosaic's block-based content. This provides the best balance of simplicity, correctness, and user experience for personal photo galleries with ≤50 users.

For future enhancement, consider **Secsync + Yjs** integration if real-time collaboration becomes a requirement.

---

## Executive Summary

This specification analyzes sync architecture and conflict resolution strategies for Mosaic's block-based content system. Key findings:

1. **Current sync model is compatible** - Extend existing version-based sync with block support
2. **LWW is sufficient** for Mosaic's use case (personal galleries, low concurrency)
3. **CRDT integration is possible** with Yjs/Secsync for encrypted documents
4. **Block-level granularity** significantly reduces conflict surface area
5. **Offline-first design** requires queue-based sync with optimistic updates

---

## Table of Contents

1. [Current Sync Model Compatibility](#1-current-sync-model-compatibility)
2. [Conflict Scenarios Analysis](#2-conflict-scenarios-analysis)
3. [Conflict Resolution Strategies](#3-conflict-resolution-strategies)
4. [CRDT Deep Dive](#4-crdt-deep-dive)
5. [User Experience for Conflicts](#5-user-experience-for-conflicts)
6. [Sync Protocol Design](#6-sync-protocol-design)
7. [Testing Strategy](#7-testing-strategy)
8. [Implementation Recommendations](#8-implementation-recommendations)

---

## 1. Current Sync Model Compatibility

### 1.1 How Photo Manifest Sync Currently Works

Mosaic uses a **version-based delta sync** model for photo manifests:

```
┌─────────────────┐                    ┌─────────────────┐
│     Client      │                    │     Server      │
│                 │                    │                 │
│  localVersion=5 │──GET /sync?since=5─│  albumVersion=8 │
│                 │                    │                 │
│                 │◄──manifests 6,7,8──│                 │
│  localVersion=8 │                    │                 │
└─────────────────┘                    └─────────────────┘
```

**Key Components:**

| Component | Location | Purpose |
|-----------|----------|---------|
| `Album.CurrentVersion` | Backend | Monotonic counter, increments on any change |
| `Manifest.VersionCreated` | Backend | Album version when manifest was created |
| `SyncEngine` | Frontend | Fetches delta, decrypts, stores locally |
| `SyncCoordinator` | Frontend | Single listener, dispatches updates to store |

### 1.2 Current Sync Flow (from [sync-engine.ts](../../apps/web/src/lib/sync-engine.ts))

```typescript
// Simplified sync flow
async sync(albumId: string): Promise<void> {
  const localVersion = await db.getAlbumVersion(albumId);
  const response = await api.syncAlbum(albumId, localVersion);
  
  for (const manifest of response.manifests) {
    // Verify signature
    const isValid = await crypto.verifyManifest(encryptedMeta, signature, signerPubkey);
    if (!isValid) continue;
    
    // Decrypt manifest
    const meta = await crypto.decryptManifest(encryptedMeta, epochKey);
    
    // Store in local DB
    await db.insertManifest(decrypted);
  }
  
  await db.setAlbumVersion(albumId, response.albumVersion);
  this.dispatchEvent('sync-complete', { albumId });
}
```

### 1.3 How Album Content Fits Into Sync Bundles

**Proposed Extension:**

```typescript
interface SyncResponse {
  // Existing photo sync
  manifests: ManifestRecord[];
  
  // NEW: Block content sync
  content?: EncryptedAlbumContent;
  contentVersion?: number;
  
  // NEW: Per-block sync (for future optimization)
  blocks?: BlockRecord[];
  deletedBlockIds?: string[];
  
  // Existing metadata
  currentEpochId: number;
  albumVersion: number;
  hasMore: boolean;
}
```

**Integration Approach:**

| Sync Mode | When To Use | Payload |
|-----------|-------------|---------|
| **Full Document** | MVP, small albums | Single encrypted blob |
| **Per-Block Delta** | Future, large albums | Changed blocks only |
| **Hybrid** | Transition | Document + per-block hints |

---

## 2. Conflict Scenarios Analysis

### 2.1 Scenario: User A and B Add Blocks Simultaneously

```
Time    User A (Mobile)              Server              User B (Desktop)
─────────────────────────────────────────────────────────────────────────
T1      Add TextBlock "Hello"        version=5          Add HeadingBlock "Trip"
        position="a1"                                    position="a1"
        
T2      [offline]                    ─────              Save to server
                                     version=6          ✓ saved
                                     
T3      Reconnect, sync              ─────              ─────
        ??? CONFLICT ???
```

**Analysis:**
- Both blocks have the same position `"a1"`
- Server has User B's version (version=6)
- User A's local changes are uncommitted

**Resolution Options:**

| Strategy | Outcome | Data Loss? |
|----------|---------|-----------|
| LWW (server wins) | User A's block replaced | Yes - User A loses block |
| LWW (timestamp) | Newest timestamp wins | Partial - older block lost |
| Block-level merge | Both blocks preserved | No - but order undefined |
| CRDT | Automatic merge | No |

### 2.2 Scenario: User A Reorders While User B Adds Content

```
Time    User A                       User B
─────────────────────────────────────────────
T1      Blocks: [A, B, C]            Blocks: [A, B, C]
        positions: a0, a1, a2        positions: a0, a1, a2
        
T2      Move C before A              Add D between B and C
        C.position = "Zz"            D.position = "a1V"
        
T3      result: [C, A, B]            result: [A, B, D, C]
        
T4      ── SYNC ──
        Final: ??? 
```

**Expected Merged Result:** `[C, A, B, D]`
- C moved to front (position "Zz" sorts before "a0")
- D inserted between B and C (position "a1V" sorts between "a1" and "a2")
- Both operations can coexist

**This scenario is SAFE with fractional indexing** - no conflict if positions are distinct.

### 2.3 Scenario: Offline Edits Reconnecting

```
Timeline:
─────────────────────────────────────────────────────────────
| Online    | Offline (3 hours)            | Reconnect      |
|-----------|------------------------------|----------------|
| sync v10  | Add 5 blocks                 | sync v15       |
|           | Edit 3 blocks                | (5 new server) |
|           | Delete 1 block               |                |
|           | Reorder 4 blocks             |                |
─────────────────────────────────────────────────────────────
```

**Conflict Surface:**
- Server has 5 new manifests (photos) at versions 11-15
- Client has 13 local block operations (5 add, 3 edit, 1 delete, 4 reorder)
- Some client operations may touch blocks that changed on server

**Resolution Strategy:**

```typescript
async function reconcileOfflineEdits(
  localOps: BlockOperation[],
  serverChanges: SyncResponse
): Promise<ReconciliationResult> {
  // 1. Apply server changes to local state (they're authoritative for photos)
  await applyServerManifests(serverChanges.manifests);
  
  // 2. For blocks, merge based on strategy
  if (serverChanges.content) {
    // Document-level: LWW based on contentVersion
    if (serverChanges.contentVersion > localVersion) {
      // Server wins for whole document
      return { strategy: 'server-wins', lostOps: localOps };
    } else {
      // Push local changes
      return { strategy: 'client-wins', toUpload: localOps };
    }
  }
}
```

### 2.4 Scenario: Edit During Key Rotation

```
Timeline:
─────────────────────────────────────────────────────────────
| User A (Owner)       | User B (Editor)                    |
|----------------------|------------------------------------|
| Rotate epoch         | Editing blocks with old key        |
| epoch_id: 7 → 8      | blocks encrypted with epoch 7      |
| Re-encrypt content   | Save... FAIL! epoch mismatch       |
─────────────────────────────────────────────────────────────
```

**Resolution:**

1. **Detect epoch mismatch** on failed save attempt
2. **Fetch new epoch keys** for User B
3. **Re-encrypt local content** with new epoch key
4. **Retry save** with correct epoch

```typescript
async function saveWithEpochRecovery(
  content: AlbumContent,
  epochKey: EpochKey
): Promise<void> {
  try {
    await api.updateContent(albumId, encryptedContent);
  } catch (err) {
    if (err.code === 'EPOCH_MISMATCH') {
      // Fetch new epoch keys
      const newEpochKey = await fetchNewEpochKey(albumId);
      // Re-encrypt with new key
      const reencrypted = await encryptContent(content, newEpochKey);
      // Retry
      await api.updateContent(albumId, reencrypted);
    }
  }
}
```

---

## 3. Conflict Resolution Strategies

### 3.1 Strategy Comparison Matrix

| Strategy | Complexity | Data Loss | Real-Time | Offline | Best For |
|----------|------------|-----------|-----------|---------|----------|
| **Last-Writer-Wins** | Low | Yes | No | Partial | Single-user, simple |
| **Block-Level Merge** | Medium | Minimal | No | Good | Multi-user, low concurrency |
| **Three-Way Merge** | High | No | No | Good | Git-like workflows |
| **CRDT (Yjs)** | High | No | Yes | Excellent | Real-time collaboration |

### 3.2 Last-Writer-Wins (LWW)

**Implementation:**

```typescript
interface VersionedContent {
  content: AlbumContent;
  version: number;        // Server-assigned, monotonic
  updatedAt: string;      // ISO timestamp
  updatedBy: string;      // User ID
}

async function resolveConflict(
  local: VersionedContent,
  server: VersionedContent
): Promise<VersionedContent> {
  // Simple: highest version wins
  return server.version > local.version ? server : local;
}
```

**Pros:**
- Simple to implement
- No merge logic required
- Predictable behavior

**Cons:**
- Loses data on conflict
- Poor UX for concurrent editing
- No offline conflict detection

### 3.3 Block-Level Merge

**Key Insight:** Conflicts only occur when both users edit the *same block*. Different blocks can be merged without conflict.

```typescript
interface BlockMergeResult {
  merged: Record<string, Block>;
  conflicts: BlockConflict[];
}

interface BlockConflict {
  blockId: string;
  localVersion: Block;
  serverVersion: Block;
  resolution: 'local' | 'server' | 'manual';
}

function mergeBlocks(
  localBlocks: Record<string, Block>,
  serverBlocks: Record<string, Block>,
  baseBlocks: Record<string, Block>  // Last synced version
): BlockMergeResult {
  const merged: Record<string, Block> = {};
  const conflicts: BlockConflict[] = [];
  
  const allIds = new Set([
    ...Object.keys(localBlocks),
    ...Object.keys(serverBlocks),
    ...Object.keys(baseBlocks),
  ]);
  
  for (const id of allIds) {
    const local = localBlocks[id];
    const server = serverBlocks[id];
    const base = baseBlocks[id];
    
    // Case 1: Only on server (new from another user)
    if (server && !local) {
      merged[id] = server;
      continue;
    }
    
    // Case 2: Only local (new local block)
    if (local && !server) {
      merged[id] = local;
      continue;
    }
    
    // Case 3: Same content (no change)
    if (deepEqual(local, server)) {
      merged[id] = local;
      continue;
    }
    
    // Case 4: Local changed, server unchanged
    if (deepEqual(server, base) && !deepEqual(local, base)) {
      merged[id] = local;
      continue;
    }
    
    // Case 5: Server changed, local unchanged
    if (deepEqual(local, base) && !deepEqual(server, base)) {
      merged[id] = server;
      continue;
    }
    
    // Case 6: Both changed - CONFLICT
    conflicts.push({
      blockId: id,
      localVersion: local,
      serverVersion: server,
      resolution: 'manual', // Or auto-resolve with LWW
    });
    
    // Default: server wins
    merged[id] = server;
  }
  
  return { merged, conflicts };
}
```

**Pros:**
- Minimizes data loss
- Only conflicts on same-block edits
- Intuitive for users

**Cons:**
- Requires base version for comparison
- More complex than pure LWW
- Still loses data on block-level conflicts

### 3.4 Three-Way Merge at Block Level

Extends block-level merge with granular property merging:

```typescript
function threeWayMergeBlock(
  local: Block,
  server: Block,
  base: Block
): { merged: Block; conflicts: string[] } {
  const conflicts: string[] = [];
  const merged = { ...base };
  
  // Merge each property independently
  for (const key of ['content', 'position', 'parentId'] as const) {
    const localChanged = !deepEqual(local[key], base[key]);
    const serverChanged = !deepEqual(server[key], base[key]);
    
    if (localChanged && !serverChanged) {
      merged[key] = local[key];
    } else if (serverChanged && !localChanged) {
      merged[key] = server[key];
    } else if (localChanged && serverChanged) {
      if (!deepEqual(local[key], server[key])) {
        conflicts.push(key);
        merged[key] = server[key]; // LWW fallback
      } else {
        merged[key] = local[key]; // Same change
      }
    }
  }
  
  return { merged, conflicts };
}
```

**Pros:**
- Preserves most changes
- Property-level granularity
- Git-like semantics

**Cons:**
- Requires storing base version
- Complex rich text merging
- May produce invalid states

---

## 4. CRDT Deep Dive

### 4.1 Can CRDTs Work with Encrypted Content?

**Yes, with the right architecture.** The key insight is that CRDT operations can be encrypted individually.

**Secsync Architecture (from nikgraf/secsync):**

```
┌─────────────────────────────────────────────────────────────┐
│                       SECSYNC MODEL                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Document = Snapshot + Updates                               │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Snapshot 1                                           │    │
│  │ ┌─────────────────────────────────────────────────┐ │    │
│  │ │ Encrypted(CRDT State at time T1)                │ │    │
│  │ │ Signature, PublicKey, AAD                       │ │    │
│  │ └─────────────────────────────────────────────────┘ │    │
│  │                       │                              │    │
│  │   ┌───────────────────┼───────────────────┐         │    │
│  │   ▼                   ▼                   ▼         │    │
│  │ Update 1           Update 2            Update 3     │    │
│  │ (Encrypted Op)     (Encrypted Op)      (Encrypted)  │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  Each Update = XChaCha20-Poly1305(CRDT operation)           │
│  Server never sees plaintext operations                      │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Operation-Based vs State-Based CRDTs

| Type | How It Works | Bandwidth | Encryption Fit |
|------|--------------|-----------|----------------|
| **Operation-Based** | Send each operation | Low | ✅ Encrypt ops individually |
| **State-Based** | Send full state | High | ⚠️ Re-encrypt entire doc |

**Yjs is operation-based** - ideal for encrypted sync:

```typescript
// Yjs update = binary diff of operations
const update = Y.encodeStateAsUpdateV2(yDoc);

// Encrypt the update
const encryptedUpdate = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
  update,
  null, // AAD
  null,
  nonce,
  documentKey
);

// Send to server (server sees only ciphertext)
await api.sendUpdate(documentId, encryptedUpdate);
```

### 4.3 Yjs Integration with Encrypted Documents

**Using Secsync library:**

```typescript
import { useYjsSync } from 'secsync-react-yjs';
import * as Y from 'yjs';

function BlockEditor({ albumId, documentKey, signKeyPair }) {
  const yDocRef = useRef(new Y.Doc());
  
  const [state, send] = useYjsSync({
    yDoc: yDocRef.current,
    documentId: albumId,
    signatureKeyPair: signKeyPair,
    websocketEndpoint: 'wss://mosaic.example/sync',
    
    // Document key for encryption
    getSnapshotKey: async () => documentKey,
    
    // Create new snapshot (for key rotation)
    getNewSnapshotData: async ({ id }) => ({
      data: Y.encodeStateAsUpdateV2(yDocRef.current),
      key: documentKey,
      publicData: { albumId },
    }),
    
    // Validate author (check epoch signing key)
    isValidClient: async (signingPublicKey) => {
      return verifyEpochMember(albumId, signingPublicKey);
    },
    
    sodium, // libsodium-wrappers-sumo
  });
  
  return <YjsBlockRenderer yDoc={yDocRef.current} />;
}
```

### 4.4 CRDT Data Model for Blocks

```typescript
// Yjs document structure for blocks
interface YjsAlbumContent {
  // Y.Map for block lookup
  blocks: Y.Map<YjsBlock>;
  
  // Y.Array for root ordering
  rootBlockIds: Y.Array<string>;
  
  // Metadata
  meta: Y.Map<any>;
}

interface YjsBlock {
  id: string;
  type: BlockType;
  parentId: string | null;
  
  // Y.Text for rich text (CRDT-aware)
  content: Y.Text;
  
  // Y.Array for child IDs (sections)
  childIds?: Y.Array<string>;
  
  // Fractional index for ordering
  position: string;
}
```

### 4.5 Performance and Complexity Tradeoffs

| Aspect | LWW | Block Merge | Yjs CRDT |
|--------|-----|-------------|----------|
| **Implementation Time** | 1 week | 2-3 weeks | 4-6 weeks |
| **Bundle Size** | +0 KB | +2 KB | +80 KB (Yjs) |
| **CPU (per edit)** | O(1) | O(n blocks) | O(log n) |
| **Memory** | Document only | Doc + base | Doc + history |
| **Real-time Support** | ❌ | ❌ | ✅ |
| **Offline Support** | ⚠️ | ✅ | ✅ |
| **Data Loss Risk** | High | Low | None |

**Recommendation:** Start with Block-Level Merge, plan migration path to Yjs.

---

## 5. User Experience for Conflicts

### 5.1 Silent Merge When Possible

**95% of conflicts can be merged silently:**

```typescript
enum ConflictType {
  NONE = 'none',
  AUTO_RESOLVED = 'auto_resolved',
  NEEDS_ATTENTION = 'needs_attention',
}

interface SyncResult {
  type: ConflictType;
  autoResolved?: AutoResolvedInfo[];
  conflicts?: ConflictInfo[];
}

// Example auto-resolutions
const autoResolutions = [
  { type: 'added-by-both', action: 'keep-both' },
  { type: 'different-blocks', action: 'merge' },
  { type: 'same-edit', action: 'dedupe' },
];
```

### 5.2 Conflict Notification UI

When conflicts cannot be auto-resolved:

```tsx
function ConflictNotification({ conflict }: { conflict: ConflictInfo }) {
  return (
    <Toast variant="warning">
      <ToastTitle>Changes from {conflict.otherUser}</ToastTitle>
      <ToastDescription>
        {conflict.affectedBlocks} blocks were edited by both you and 
        {conflict.otherUser}. Your version was kept.
      </ToastDescription>
      <ToastAction onClick={() => showConflictDetails(conflict)}>
        View Details
      </ToastAction>
      <ToastAction onClick={() => undoMyChanges(conflict)}>
        Use Their Version
      </ToastAction>
    </Toast>
  );
}
```

### 5.3 Manual Resolution Interface

**Side-by-side diff view for complex conflicts:**

```tsx
function ConflictResolver({ conflict }: { conflict: BlockConflict }) {
  return (
    <Dialog>
      <DialogHeader>
        <DialogTitle>Resolve Conflict: {conflict.blockId}</DialogTitle>
      </DialogHeader>
      
      <DialogContent className="grid grid-cols-2 gap-4">
        <div>
          <h3>Your Version</h3>
          <BlockPreview block={conflict.localVersion} />
          <Button onClick={() => resolve('local')}>Keep Mine</Button>
        </div>
        
        <div>
          <h3>Their Version</h3>
          <BlockPreview block={conflict.serverVersion} />
          <Button onClick={() => resolve('server')}>Keep Theirs</Button>
        </div>
      </DialogContent>
      
      <DialogFooter>
        <Button variant="outline" onClick={() => resolve('both')}>
          Keep Both (Duplicate Block)
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
```

### 5.4 Version History / Time Travel

**Store snapshots for recovery:**

```typescript
interface ContentSnapshot {
  id: string;
  albumId: string;
  content: AlbumContent;
  createdAt: string;
  createdBy: string;
  reason: 'manual' | 'auto' | 'conflict_resolution';
}

// Auto-snapshot before destructive operations
async function createSnapshot(
  albumId: string,
  reason: 'manual' | 'auto' | 'conflict_resolution'
): Promise<string> {
  const content = await getAlbumContent(albumId);
  const encrypted = await encryptContent(content, epochKey);
  
  return api.createSnapshot(albumId, {
    encryptedContent: encrypted,
    reason,
  });
}

// Recovery UI
function VersionHistory({ albumId }: { albumId: string }) {
  const snapshots = useSnapshots(albumId);
  
  return (
    <Timeline>
      {snapshots.map(s => (
        <TimelineItem key={s.id}>
          <TimelineDate>{formatDate(s.createdAt)}</TimelineDate>
          <TimelineContent>
            <span>{s.reason === 'conflict_resolution' ? '⚠️' : '📸'}</span>
            <span>Snapshot by {s.createdBy}</span>
            <Button size="sm" onClick={() => previewSnapshot(s.id)}>
              Preview
            </Button>
            <Button size="sm" onClick={() => restoreSnapshot(s.id)}>
              Restore
            </Button>
          </TimelineContent>
        </TimelineItem>
      ))}
    </Timeline>
  );
}
```

---

## 6. Sync Protocol Design

### 6.1 API Endpoints for Content Sync

```yaml
# OpenAPI additions for block content

paths:
  /albums/{albumId}/content:
    get:
      summary: Get album content (blocks)
      parameters:
        - name: version
          in: query
          description: Last known version (for delta sync)
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ContentSyncResponse'
    
    put:
      summary: Update album content
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ContentUpdateRequest'
      responses:
        '200':
          description: Content updated
        '409':
          description: Version conflict
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ContentConflictResponse'

components:
  schemas:
    ContentSyncResponse:
      type: object
      properties:
        encryptedContent:
          type: string
          format: byte
          description: XChaCha20-Poly1305 encrypted AlbumContent
        signature:
          type: string
        signerPubkey:
          type: string
        contentVersion:
          type: integer
        lastModifiedBy:
          type: string
        lastModifiedAt:
          type: string
          format: date-time
    
    ContentUpdateRequest:
      type: object
      required:
        - encryptedContent
        - signature
        - signerPubkey
        - baseVersion
      properties:
        encryptedContent:
          type: string
          format: byte
        signature:
          type: string
        signerPubkey:
          type: string
        baseVersion:
          type: integer
          description: Version this update is based on (optimistic locking)
    
    ContentConflictResponse:
      type: object
      properties:
        currentVersion:
          type: integer
        currentContent:
          $ref: '#/components/schemas/ContentSyncResponse'
        message:
          type: string
```

### 6.2 Optimistic Updates

```typescript
class ContentSyncManager {
  private pendingUpdates: Map<string, PendingUpdate> = new Map();
  
  /**
   * Apply change optimistically, queue for sync
   */
  async applyOptimistic(albumId: string, change: ContentChange): Promise<void> {
    // 1. Apply to local store immediately
    const localContent = await getLocalContent(albumId);
    const updated = applyChange(localContent, change);
    await setLocalContent(albumId, updated);
    
    // 2. Queue for server sync
    this.pendingUpdates.set(change.id, {
      albumId,
      change,
      status: 'pending',
      retries: 0,
    });
    
    // 3. Trigger background sync
    this.schedulePush(albumId);
  }
  
  /**
   * Push pending changes to server
   */
  private async pushChanges(albumId: string): Promise<void> {
    const pending = this.getPendingForAlbum(albumId);
    if (pending.length === 0) return;
    
    const content = await getLocalContent(albumId);
    const encrypted = await encryptContent(content, await getEpochKey(albumId));
    
    try {
      const result = await api.updateContent(albumId, {
        encryptedContent: encrypted.content,
        signature: encrypted.signature,
        signerPubkey: encrypted.signerPubkey,
        baseVersion: content.version,
      });
      
      // Success - clear pending
      this.clearPending(albumId);
      await setLocalVersion(albumId, result.newVersion);
      
    } catch (err) {
      if (err.status === 409) {
        // Version conflict - needs merge
        await this.handleConflict(albumId, err.data);
      } else {
        // Retry later
        this.scheduleRetry(albumId);
      }
    }
  }
  
  private async handleConflict(
    albumId: string, 
    serverResponse: ContentConflictResponse
  ): Promise<void> {
    // 1. Decrypt server version
    const serverContent = await decryptContent(
      serverResponse.currentContent,
      await getEpochKey(albumId)
    );
    
    // 2. Get local version and base
    const localContent = await getLocalContent(albumId);
    const baseContent = await getBaseContent(albumId);
    
    // 3. Attempt merge
    const mergeResult = mergeBlocks(
      localContent.blocks,
      serverContent.blocks,
      baseContent.blocks
    );
    
    // 4. Handle unresolved conflicts
    if (mergeResult.conflicts.length > 0) {
      emit('conflict-detected', mergeResult.conflicts);
    }
    
    // 5. Save merged content
    await setLocalContent(albumId, {
      ...serverContent,
      blocks: mergeResult.merged,
    });
    
    // 6. Push merged version
    await this.pushChanges(albumId);
  }
}
```

### 6.3 Retry and Failure Handling

```typescript
interface RetryPolicy {
  maxRetries: 5;
  baseDelay: 1000;       // 1 second
  maxDelay: 60000;       // 1 minute
  backoffMultiplier: 2;
}

class SyncRetryManager {
  private retryQueues: Map<string, RetryQueue> = new Map();
  
  async scheduleRetry(albumId: string): Promise<void> {
    const queue = this.getOrCreateQueue(albumId);
    
    if (queue.retries >= this.policy.maxRetries) {
      // Give up - notify user
      emit('sync-failed', { albumId, reason: 'max-retries' });
      return;
    }
    
    const delay = Math.min(
      this.policy.baseDelay * Math.pow(this.policy.backoffMultiplier, queue.retries),
      this.policy.maxDelay
    );
    
    queue.retries++;
    queue.nextRetry = Date.now() + delay;
    
    setTimeout(() => this.retrySync(albumId), delay);
  }
  
  async retrySync(albumId: string): Promise<void> {
    if (!navigator.onLine) {
      // Wait for online
      window.addEventListener('online', () => this.retrySync(albumId), { once: true });
      return;
    }
    
    try {
      await this.syncManager.pushChanges(albumId);
      this.clearQueue(albumId);
    } catch (err) {
      this.scheduleRetry(albumId);
    }
  }
}
```

### 6.4 Connection State Management

```typescript
type ConnectionState = 
  | 'connected'
  | 'connecting'
  | 'disconnected'
  | 'error';

interface SyncState {
  connection: ConnectionState;
  pendingChanges: number;
  lastSyncAt: Date | null;
  error: Error | null;
}

// Zustand store for sync state
const useSyncState = create<SyncState>((set) => ({
  connection: 'disconnected',
  pendingChanges: 0,
  lastSyncAt: null,
  error: null,
}));

// Connection status indicator
function SyncStatusIndicator() {
  const { connection, pendingChanges } = useSyncState();
  
  return (
    <div className="flex items-center gap-2">
      <StatusDot status={connection} />
      {pendingChanges > 0 && (
        <span className="text-sm text-muted-foreground">
          {pendingChanges} pending
        </span>
      )}
    </div>
  );
}
```

---

## 7. Testing Strategy

### 7.1 Testing Concurrent Edits

**Unit Test Pattern:**

```typescript
describe('ContentMerge', () => {
  describe('concurrent block additions', () => {
    it('should preserve both blocks when added at same position', async () => {
      // Setup base state
      const base = createContent([
        { id: 'a', position: 'a0' },
        { id: 'b', position: 'a1' },
      ]);
      
      // Client A adds block
      const clientA = createContent([
        { id: 'a', position: 'a0' },
        { id: 'new-a', position: 'a0V' }, // Between a and b
        { id: 'b', position: 'a1' },
      ]);
      
      // Client B adds block at same position
      const clientB = createContent([
        { id: 'a', position: 'a0' },
        { id: 'new-b', position: 'a0V' }, // Same position!
        { id: 'b', position: 'a1' },
      ]);
      
      // Merge
      const result = mergeBlocks(clientA.blocks, clientB.blocks, base.blocks);
      
      // Both blocks should exist
      expect(result.merged['new-a']).toBeDefined();
      expect(result.merged['new-b']).toBeDefined();
      
      // Conflict should be recorded (same position)
      expect(result.conflicts).toHaveLength(0); // No content conflict
    });
  });
  
  describe('concurrent edits to same block', () => {
    it('should detect conflict when both edit same block', async () => {
      const base = createContent([
        { id: 'text-1', type: 'text', content: { text: 'Hello' } },
      ]);
      
      const clientA = createContent([
        { id: 'text-1', type: 'text', content: { text: 'Hello World' } },
      ]);
      
      const clientB = createContent([
        { id: 'text-1', type: 'text', content: { text: 'Hello There' } },
      ]);
      
      const result = mergeBlocks(clientA.blocks, clientB.blocks, base.blocks);
      
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].blockId).toBe('text-1');
    });
  });
});
```

### 7.2 Offline Simulation

```typescript
describe('OfflineSync', () => {
  it('should queue changes while offline and sync on reconnect', async () => {
    // Go offline
    await page.setOfflineMode(true);
    
    // Make changes
    await editor.addBlock('text', 'Offline edit');
    await editor.addBlock('heading', 'Offline heading');
    
    // Verify queued
    const pending = await page.evaluate(() => 
      window.syncManager.getPendingCount()
    );
    expect(pending).toBe(2);
    
    // Go online
    await page.setOfflineMode(false);
    
    // Wait for sync
    await expect(async () => {
      const synced = await page.evaluate(() => 
        window.syncManager.getPendingCount()
      );
      expect(synced).toBe(0);
    }).toPass({ timeout: 10000 });
    
    // Verify on server
    const serverContent = await api.getContent(albumId);
    expect(serverContent.blocks).toHaveLength(2);
  });
  
  it('should handle offline conflict on reconnect', async () => {
    // Client goes offline
    await page.setOfflineMode(true);
    
    // Client edits locally
    await editor.editBlock('block-1', 'Offline version');
    
    // Server receives edit from another user
    await api.updateContent(albumId, {
      blocks: [{ id: 'block-1', content: { text: 'Server version' } }],
    });
    
    // Client reconnects
    await page.setOfflineMode(false);
    
    // Should show conflict notification
    await expect(page.getByText('Conflict detected')).toBeVisible();
  });
});
```

### 7.3 Race Condition Detection

```typescript
describe('RaceConditions', () => {
  it('should not lose updates during rapid concurrent saves', async () => {
    const results: string[] = [];
    
    // Simulate 10 rapid edits
    const editPromises = Array.from({ length: 10 }, (_, i) => 
      editor.addBlock('text', `Edit ${i}`)
    );
    
    await Promise.all(editPromises);
    
    // Wait for all syncs
    await waitForSync();
    
    // Verify all edits present
    const content = await api.getContent(albumId);
    const texts = content.blocks
      .filter(b => b.type === 'text')
      .map(b => b.content.text);
    
    for (let i = 0; i < 10; i++) {
      expect(texts).toContain(`Edit ${i}`);
    }
  });
  
  it('should serialize concurrent sync requests', async () => {
    const syncOrder: number[] = [];
    
    // Intercept sync calls
    await page.route('**/api/albums/*/content', async (route, request) => {
      const body = await request.postDataJSON();
      syncOrder.push(body.baseVersion);
      await route.continue();
    });
    
    // Trigger multiple syncs
    await Promise.all([
      syncManager.sync(),
      syncManager.sync(),
      syncManager.sync(),
    ]);
    
    // Should be sequential, not parallel
    expect(syncOrder).toEqual([1, 2, 3]); // Or deduplicated to single call
  });
});
```

### 7.4 Test Fixtures for Conflict Scenarios

```typescript
// tests/fixtures/conflict-scenarios.ts

export const conflictScenarios = {
  simultaneousAdd: {
    base: { blocks: { a: block('a', 'a0') } },
    clientA: { blocks: { a: block('a', 'a0'), x: block('x', 'a0V') } },
    clientB: { blocks: { a: block('a', 'a0'), y: block('y', 'a0V') } },
    expected: {
      mergedBlockCount: 3,
      conflictCount: 0, // Different IDs
    },
  },
  
  simultaneousEdit: {
    base: { blocks: { a: textBlock('a', 'Hello') } },
    clientA: { blocks: { a: textBlock('a', 'Hello World') } },
    clientB: { blocks: { a: textBlock('a', 'Hello There') } },
    expected: {
      conflictCount: 1,
      conflictBlockId: 'a',
    },
  },
  
  editAndDelete: {
    base: { blocks: { a: block('a'), b: block('b') } },
    clientA: { blocks: { a: block('a') } }, // Deleted b
    clientB: { blocks: { a: block('a'), b: editedBlock('b') } }, // Edited b
    expected: {
      // Depends on policy: delete wins or edit wins?
      conflictCount: 1,
    },
  },
  
  reorderConflict: {
    base: { 
      blocks: { a: block('a', 'a0'), b: block('b', 'a1'), c: block('c', 'a2') },
      rootBlockIds: ['a', 'b', 'c'],
    },
    clientA: { 
      blocks: { a: block('a', 'a0'), b: block('b', 'a2'), c: block('c', 'a1') },
      rootBlockIds: ['a', 'c', 'b'], // Swapped b and c
    },
    clientB: { 
      blocks: { a: block('a', 'a0'), b: block('b', 'a1'), c: block('c', 'Zz') },
      rootBlockIds: ['c', 'a', 'b'], // Moved c to front
    },
    expected: {
      // Fractional indexing should handle this
      finalOrder: ['c', 'a', 'b'], // c has "Zz", a has "a0", b disputed
      conflictCount: 1, // b's position conflicts
    },
  },
};
```

---

## 8. Implementation Recommendations

### 8.1 Recommended Approach: Block-Level Merge with LWW Fallback

**Phase 1: MVP (Weeks 1-3)**

```
┌─────────────────────────────────────────────────────────────┐
│                   PHASE 1: MVP                               │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Storage: Single encrypted document                         │
│  Sync: Version-based, whole-document                        │
│  Conflict: LWW (server wins)                                 │
│  Offline: Queue changes, push on reconnect                  │
│                                                              │
│  Backend:                                                    │
│  - Add encryptedContent to Album entity                     │
│  - Add PUT /albums/{id}/content endpoint                    │
│  - Version check with 409 on conflict                       │
│                                                              │
│  Frontend:                                                   │
│  - ContentSyncManager with optimistic updates               │
│  - Simple conflict toast notification                       │
│  - Queue-based offline support                              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

**Phase 2: Enhanced Merge (Weeks 4-6)**

```
┌─────────────────────────────────────────────────────────────┐
│                   PHASE 2: BLOCK MERGE                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Storage: Single document + base version cache              │
│  Sync: Version-based with three-way merge                   │
│  Conflict: Block-level merge, LWW fallback                  │
│  Offline: Full offline editing with merge                   │
│                                                              │
│  Additions:                                                  │
│  - Store base version in IndexedDB                          │
│  - mergeBlocks() implementation                             │
│  - Conflict resolution UI                                    │
│  - Version history snapshots                                │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

**Phase 3: CRDT (Future, if needed)**

```
┌─────────────────────────────────────────────────────────────┐
│                   PHASE 3: CRDT                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Library: Yjs + Secsync                                     │
│  Storage: Snapshots + Updates                               │
│  Sync: Real-time WebSocket                                  │
│  Conflict: Automatic CRDT merge                             │
│                                                              │
│  When to implement:                                          │
│  - User demand for real-time collaboration                  │
│  - Frequent conflict complaints                             │
│  - >10 concurrent editors per album                         │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 8.2 Key Design Decisions

| Decision | Recommended Choice | Rationale |
|----------|-------------------|-----------|
| **Initial Sync Model** | Version-based delta | Matches existing photo sync |
| **Conflict Strategy** | Block-level merge + LWW | Balance of correctness and simplicity |
| **Block Ordering** | Fractional indexing | Efficient reordering, conflict-resistant |
| **Key Derivation** | HKDF with "Mosaic_Block_v1" | Crypto separation from photos |
| **Offline Queue** | IndexedDB + Zustand | Persistent, reactive |
| **Conflict UI** | Toast + optional dialog | Non-intrusive with escape hatch |

### 8.3 Code Example: Complete Sync Flow

```typescript
// apps/web/src/lib/content-sync.ts

import { useContentStore } from '../stores/content-store';
import { encryptContent, decryptContent } from './crypto-client';
import { getApi } from './api';
import { createLogger } from './logger';

const log = createLogger('ContentSync');

export class ContentSyncManager {
  private syncInProgress = false;
  private pendingQueue: ContentChange[] = [];
  private baseVersionCache: Map<string, AlbumContent> = new Map();
  
  /**
   * Save content changes with optimistic update
   */
  async saveContent(
    albumId: string,
    content: AlbumContent,
    epochKey: EpochKey
  ): Promise<SaveResult> {
    const store = useContentStore.getState();
    const api = getApi();
    
    // 1. Optimistic local update
    store.setContent(albumId, content);
    
    // 2. Encrypt
    const encrypted = await encryptContent(content, epochKey);
    
    // 3. Push to server
    try {
      const result = await api.updateContent(albumId, {
        encryptedContent: encrypted.content,
        signature: encrypted.signature,
        signerPubkey: encrypted.signerPubkey,
        baseVersion: content.version,
      });
      
      // Success - update version
      store.setVersion(albumId, result.newVersion);
      this.baseVersionCache.set(albumId, content);
      
      return { success: true, version: result.newVersion };
      
    } catch (err: any) {
      if (err.status === 409) {
        // Version conflict - attempt merge
        return this.handleConflict(albumId, content, err.data, epochKey);
      }
      
      // Other error - queue for retry
      this.queueForRetry(albumId, content);
      throw err;
    }
  }
  
  /**
   * Handle version conflict with three-way merge
   */
  private async handleConflict(
    albumId: string,
    localContent: AlbumContent,
    serverResponse: ContentConflictResponse,
    epochKey: EpochKey
  ): Promise<SaveResult> {
    log.info('Handling conflict', { albumId });
    
    // 1. Decrypt server version
    const serverContent = await decryptContent(
      serverResponse.currentContent,
      epochKey
    );
    
    // 2. Get base version
    const baseContent = this.baseVersionCache.get(albumId);
    if (!baseContent) {
      // No base - fall back to LWW (server wins)
      log.warn('No base version, using server content');
      const store = useContentStore.getState();
      store.setContent(albumId, serverContent);
      return { 
        success: true, 
        version: serverResponse.currentVersion,
        conflicts: [{ type: 'no-base', resolution: 'server-wins' }],
      };
    }
    
    // 3. Three-way merge
    const mergeResult = this.mergeContents(localContent, serverContent, baseContent);
    
    // 4. Apply merged content locally
    const store = useContentStore.getState();
    store.setContent(albumId, mergeResult.content);
    
    // 5. If conflicts remain, notify user
    if (mergeResult.conflicts.length > 0) {
      this.notifyConflicts(mergeResult.conflicts);
    }
    
    // 6. Push merged version
    return this.saveContent(albumId, mergeResult.content, epochKey);
  }
  
  /**
   * Three-way merge of album content
   */
  private mergeContents(
    local: AlbumContent,
    server: AlbumContent,
    base: AlbumContent
  ): MergeResult {
    const merged: AlbumContent = {
      version: server.version, // Use server version
      albumId: local.albumId,
      rootBlockIds: [], // Will compute
      blocks: {},
      updatedAt: new Date().toISOString(),
    };
    
    const conflicts: BlockConflict[] = [];
    
    // Merge blocks
    const allBlockIds = new Set([
      ...Object.keys(local.blocks),
      ...Object.keys(server.blocks),
      ...Object.keys(base.blocks),
    ]);
    
    for (const id of allBlockIds) {
      const localBlock = local.blocks[id];
      const serverBlock = server.blocks[id];
      const baseBlock = base.blocks[id];
      
      const result = this.mergeBlock(localBlock, serverBlock, baseBlock);
      
      if (result.conflict) {
        conflicts.push(result.conflict);
      }
      
      if (result.block) {
        merged.blocks[id] = result.block;
      }
    }
    
    // Merge root block order
    merged.rootBlockIds = this.mergeBlockOrder(
      local.rootBlockIds,
      server.rootBlockIds,
      base.rootBlockIds,
      merged.blocks
    );
    
    return { content: merged, conflicts };
  }
  
  private mergeBlock(
    local?: Block,
    server?: Block,
    base?: Block
  ): { block?: Block; conflict?: BlockConflict } {
    // Deleted on both
    if (!local && !server) {
      return {};
    }
    
    // Added on server only
    if (!local && server) {
      return { block: server };
    }
    
    // Added on local only (or deleted on server)
    if (local && !server) {
      if (base) {
        // Deleted on server - delete wins
        return {};
      }
      // New local block
      return { block: local };
    }
    
    // Both have the block
    const localChanged = !deepEqual(local, base);
    const serverChanged = !deepEqual(server, base);
    
    if (!localChanged) {
      return { block: server };
    }
    
    if (!serverChanged) {
      return { block: local };
    }
    
    // Both changed - conflict
    if (!deepEqual(local, server)) {
      return {
        block: server, // LWW fallback
        conflict: {
          blockId: local!.id,
          localVersion: local!,
          serverVersion: server!,
          resolution: 'server-wins',
        },
      };
    }
    
    // Same changes
    return { block: local };
  }
  
  private mergeBlockOrder(
    local: string[],
    server: string[],
    base: string[],
    blocks: Record<string, Block>
  ): string[] {
    // Use positions from blocks (fractional indexing)
    const ids = Object.keys(blocks);
    return ids.sort((a, b) => {
      const posA = blocks[a]?.position ?? '';
      const posB = blocks[b]?.position ?? '';
      return posA.localeCompare(posB);
    });
  }
  
  private notifyConflicts(conflicts: BlockConflict[]): void {
    // Emit to UI
    window.dispatchEvent(new CustomEvent('content-conflicts', {
      detail: { conflicts },
    }));
  }
}

export const contentSyncManager = new ContentSyncManager();
```

---

## Summary

### Confidence Ratings

| Finding | Confidence | Notes |
|---------|------------|-------|
| LWW sufficient for MVP | **High** | Personal galleries have low concurrency |
| Block-level merge reduces conflicts | **High** | Well-established pattern (Figma, Notion) |
| Yjs works with encryption | **High** | Secsync proves this architecture |
| Fractional indexing for order | **High** | Battle-tested at Figma scale |
| Three-way merge is complex | **Medium** | Rich text merging is challenging |
| CRDT bundle size acceptable | **Medium** | 80KB may impact mobile perf |

### Decision Tree

```
Should you use CRDTs (Yjs)?
│
├─ Is real-time collaboration needed? ─── Yes ──► Use Yjs + Secsync
│
├─ Are there frequent conflicts? ───────── Yes ──► Consider Yjs
│
├─ Is bundle size critical? ────────────── Yes ──► Use Block Merge
│
└─ Is it an MVP? ───────────────────────── Yes ──► Use LWW + Block Merge
```

### Next Steps

1. **Implement Phase 1** (LWW + Single Document)
2. **Monitor conflict frequency** in production
3. **Add block-level merge** when needed (Phase 2)
4. **Evaluate Yjs migration** based on user feedback

---

## Sources

1. Secsync - Architecture for E2E Encrypted CRDTs: https://github.com/nikgraf/secsync
2. Yjs - CRDT Framework: https://yjs.dev/
3. Figma - Real-time Editing with Fractional Indexing: https://www.figma.com/blog/realtime-editing-of-ordered-sequences/
4. Steve Ruiz - Fractional Indexing: https://www.steveruiz.me/posts/reordering-fractional-indices
5. RxDB CRDT Plugin: https://rxdb.info/crdt.html
6. Ditto - Building Offline-First Apps with CRDTs: https://www.ditto.com/blog/how-to-build-robust-offline-first-apps

---

**End of Specification**
