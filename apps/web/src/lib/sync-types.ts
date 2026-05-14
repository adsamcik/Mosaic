/** Sync event types emitted by the sync engine. */
export type SyncEventType =
  | 'sync-start'
  | 'sync-progress'
  | 'sync-complete'
  | 'sync-error'
  | 'sync-warning'
  | 'sync-server-regression'
  | 'content-conflict';

export interface SyncEventDetail {
  albumId: string;
  count?: number;
  error?: Error;
  /**
   * For `sync-warning`: opaque manifest IDs the engine could not safely
   * apply to the local DB on this run (signature failed, decrypt failed,
   * JSON parse failed, transcript mismatch, signer-pubkey mismatch, etc.).
   * The cursor was held back so they will be retried on the next sync.
   * Carries IDs only — never plaintext metadata.
   */
  skippedManifestIds?: readonly string[];
  /** For `sync-warning`: classification of the skip count by reason. */
  skipReasonCounts?: Readonly<Record<string, number>>;
  /**
   * For `sync-server-regression`: the cursor value the client held vs the
   * smaller value the server returned. Surfaced so a parent UI can demand
   * a hard re-auth / full re-sync rather than silently rewinding.
   */
  serverRegression?: {
    clientHeld: number;
    serverReported: number;
  };
}

/**
 * Event detail for `content-conflict` events. Dispatched whenever an
 * album-content save (story blocks document) hits a 409 from the server
 * and the resolver picked a winner per
 * `docs/specs/SPEC-SyncConflictResolution.md`. The payload is plaintext
 * but only carries opaque block ids and resolution categories — never
 * keys, never raw block content — so listening UI can show a generic
 * "conflict resolved" toast without breaking zero-knowledge invariants.
 */
export interface ContentConflictEventDetail {
  /** Album whose content document collided with a server update. */
  albumId: string;
  /** How the merge was resolved (LWW vs three-way block merge). */
  strategy: 'lww-server-wins' | 'three-way-block-merge';
  /** Number of blocks where merge surfaced a manual conflict. */
  manualConflictCount: number;
  /** Total number of merge decisions reported. */
  totalDecisionCount: number;
  /** Block ids of manually-resolved conflicts (opaque, server-known ids). */
  manualConflictBlockIds: readonly string[];
}

/**
 * Listener invoked once per album-content `content-conflict` event from
 * the sync engine. Listeners receive a sanitized payload (no plaintext
 * block content, no key material) and may freely subscribe/unsubscribe
 * via the returned disposer.
 */
export type ContentConflictListener = (
  detail: ContentConflictEventDetail,
) => void;

export interface SyncCoordinatorPurge {
  cancelPendingSync?: (albumId: string, assetId: string) => void;
}

const noopSyncCoordinatorPurge: SyncCoordinatorPurge = {};
let registeredSyncCoordinatorPurge: SyncCoordinatorPurge =
  noopSyncCoordinatorPurge;

export function registerSyncCoordinatorPurge(
  syncCoordinator: SyncCoordinatorPurge,
): void {
  registeredSyncCoordinatorPurge = syncCoordinator;
}

export function getRegisteredSyncCoordinatorPurge(): SyncCoordinatorPurge {
  return registeredSyncCoordinatorPurge;
}
