# SPEC: Logging Hygiene

## Web direct-console guard scope

`tests/architecture/web-no-direct-console.{ps1,sh}` scans a hardcoded inclusion list of high-risk `apps/web/src/` paths. This is an inclusion list, not an exclusion list, because the explicit risk surface is encrypt/key/sync/share-link plumbing; broad UI rendering code is outside this guard and can use future UI-specific logging policy.

| Included path | Rationale |
| --- | --- |
| `apps/web/src/workers` | Workers handle crypto, database, upload, and media transformations where raw bytes and keys may be in memory. |
| `apps/web/src/lib/*-service.ts` | Service modules cross storage/API boundaries and can touch encrypted blobs, metadata, and sync inputs. |
| `apps/web/src/lib/sync-engine.ts` | Sync state can include album membership, shard state, and conflict metadata. |
| `apps/web/src/lib/sync-coordinator.ts` | Sync orchestration coordinates storage and remote API state. |
| `apps/web/src/lib/sync-coordinator.tsx` | React-facing sync orchestration exposes the same sensitive sync state to UI code. |
| `apps/web/src/lib/shared-album-download.ts` | Shared album downloads handle share-link-derived access and decrypted download flow state. |
| `apps/web/src/lib/local-purge.ts` | Local purge code handles local encrypted storage and deletion decisions. |
| `apps/web/src/lib/api.ts` | API transport can carry auth context, opaque encrypted blobs, and request identifiers. |
| `apps/web/src/lib/key-cache.ts` | Key cache code holds sensitive handles and cache lifecycle state. |
| `apps/web/src/lib/epoch-key-store.ts` | Epoch key persistence code handles encrypted epoch-key material and identifiers. |
| `apps/web/src/lib/epoch-key-service.ts` | Epoch key service code coordinates key-handle access for album content. |
| `apps/web/src/lib/epoch-rotation-service.ts` | Epoch rotation code manages key transitions and membership-sensitive state. |
| `apps/web/src/contexts/SyncContext.tsx` | Sync context exposes high-risk sync lifecycle state to React consumers. |
| `apps/web/src/contexts/AlbumContentContext.tsx` | Album content context coordinates encrypted content state and render-facing data. |

Any new module under `apps/web/src/lib/` that touches keys, shards, or sync state must be added to this inclusion list before merge.
