/**
 * Sync Conflict Resolution for Album Content (Block-Based Documents)
 *
 * Implements the strategy described in
 * `docs/specs/SPEC-SyncConflictResolution.md` for resolving concurrent edits
 * to block-based album content (story documents). The resolver combines:
 *
 * - Last-Writer-Wins (LWW) at the document level when no shared base is
 *   available, matching SPEC §8.1 Phase 1 (MVP).
 * - Three-way block-level merge with LWW fallback for same-block conflicts
 *   when a base version is available, matching SPEC §3.3 Phase 2.
 *
 * The resolver is a pure, deterministic function. It performs no I/O, no
 * crypto, and no logging. It must remain framework-agnostic so it can be
 * unit tested without a DOM or worker; the React `AlbumContentContext`
 * wires the result back into UI state, and the sync engine is the only
 * other allowed integration point.
 *
 * Zero-knowledge invariants:
 * - The resolver only operates on plaintext documents that are already
 *   inside the trusted client boundary; nothing here ever crosses the
 *   server seam.
 * - No key material is read, written, or referenced from this module.
 * - Inputs are read-only and never mutated. The merged output is a fresh
 *   document so callers can safely diff against `local` for change
 *   detection.
 */

import type {
  AlbumContentDocument,
  ContentBlock,
} from './content-blocks';

/**
 * Outcome categorisation for a single block conflict.
 *
 * `auto-server-wins`: server changed and local was unchanged → server picked.
 * `auto-local-wins`: local changed and server was unchanged → local picked.
 * `auto-both-deleted`: both sides deleted; the block is dropped.
 * `auto-server-delete-wins`: server deleted while local kept the original
 *   value; the deletion wins (deletes are not auto-resurrected).
 * `auto-local-add-kept`: local added a new block that the server does not yet
 *   know about; kept as part of the merge.
 * `auto-server-add-kept`: server added a block that the local document did
 *   not yet have; kept as part of the merge.
 * `manual-server-wins`: both sides edited the same block; LWW fallback picks
 *   the server version and surfaces the conflict for UI/notification.
 */
export type BlockMergeResolution =
  | 'auto-server-wins'
  | 'auto-local-wins'
  | 'auto-both-deleted'
  | 'auto-server-delete-wins'
  | 'auto-local-add-kept'
  | 'auto-server-add-kept'
  | 'manual-server-wins';

/**
 * Description of a single block-level merge decision. Reported for every
 * non-trivial outcome so the UI can either notify the user or, in the
 * common case, log auto-resolutions for diagnostics.
 */
export interface BlockMergeDecision {
  /** Block identifier; the same id keyspace is used by all three documents. */
  readonly blockId: string;
  /** What the resolver decided to do. */
  readonly resolution: BlockMergeResolution;
  /**
   * Reason category. `manual` indicates the change requires user attention
   * (both sides edited differently). `auto` indicates a deterministic merge
   * that does not need to interrupt the user.
   */
  readonly category: 'auto' | 'manual';
  /** Local version of the block, or null if it was deleted/never created. */
  readonly local: ContentBlock | null;
  /** Server version of the block, or null if it was deleted/never created. */
  readonly server: ContentBlock | null;
  /** Base version of the block, or null if no base or block did not exist. */
  readonly base: ContentBlock | null;
}

/**
 * Top-level merge strategy used. Reported so the UI/log can distinguish
 * between Phase 1 (no base, server wins entirely) and Phase 2 (true
 * three-way merge with block-level granularity).
 */
export type MergeStrategy = 'lww-server-wins' | 'three-way-block-merge';

/**
 * Result of merging an album content document. The `merged` document is
 * always returned (never null) so the caller can immediately try to push
 * it to the server with the latest known version.
 */
export interface AlbumContentMergeResult {
  /** The merged document, ready to encrypt and push. */
  readonly merged: AlbumContentDocument;
  /** Strategy used to produce `merged`. */
  readonly strategy: MergeStrategy;
  /**
   * All non-trivial decisions taken during the merge. For
   * `lww-server-wins` this is always empty (no per-block reasoning is
   * performed). For `three-way-block-merge` this contains one entry per
   * block whose state actually changed between base and either side.
   */
  readonly decisions: readonly BlockMergeDecision[];
  /**
   * Subset of `decisions` whose `category` is `manual`. These are the
   * conflicts the UI should surface to the user (toast or dialog per
   * SPEC §5).
   */
  readonly manualConflicts: readonly BlockMergeDecision[];
}

/**
 * Compare two block records for structural equality. Uses canonical JSON
 * with sorted keys so property ordering does not affect the result.
 *
 * The merge resolver only ever calls this with two values that share the
 * same block `id`, so we can rely on the discriminant (`type`) and the
 * remaining fields being structurally comparable.
 */
function blocksEqual(a: ContentBlock, b: ContentBlock): boolean {
  if (a === b) return true;
  if (a.type !== b.type) return false;
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * Canonical JSON serialisation with deterministic key ordering. This is
 * intentionally narrow: it covers only the shapes used by `ContentBlock`
 * (objects, arrays, primitives). It does not need to handle Date, Map,
 * Set, or BigInt because the schema does not allow those.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries
    .map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`)
    .join(',')}}`;
}

/**
 * Sort blocks by fractional-index `position` so the merged document has a
 * deterministic order regardless of which side was the source of each
 * block. Fractional indexing means we can sort lexically and end up with
 * the intended sequence (SPEC §2.2 / §8.2).
 *
 * Ties on position are broken by `id` so the ordering is total even if
 * two clients picked the same fractional index for different blocks.
 */
function sortBlocksDeterministically(blocks: ContentBlock[]): ContentBlock[] {
  return [...blocks].sort((a, b) => {
    if (a.position < b.position) return -1;
    if (a.position > b.position) return 1;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
}

/**
 * Build a Map<id, block> from a block array. The block list is normally
 * small (<200 blocks per album) so the allocation cost is negligible
 * compared to the gain in lookup readability.
 */
function indexBlocksById(
  blocks: readonly ContentBlock[],
): Map<string, ContentBlock> {
  const map = new Map<string, ContentBlock>();
  for (const block of blocks) {
    // Last-write-wins for duplicate ids inside one document; the schema
    // forbids duplicates but we are defensive against malformed input.
    map.set(block.id, block);
  }
  return map;
}

/**
 * Decide the outcome for a single block id given the three possible
 * versions. Returns `merged` (the block to keep, or null to drop) and an
 * optional `decision` that should be reported.
 */
function resolveBlock(
  local: ContentBlock | null,
  server: ContentBlock | null,
  base: ContentBlock | null,
): { merged: ContentBlock | null; decision: BlockMergeDecision | null } {
  // Case 1: Both sides agree the block does not exist. Nothing to do.
  if (!local && !server) {
    if (!base) {
      // Truly empty: not a real case (the caller would not enumerate this
      // id at all), but treat as no-op for safety.
      return { merged: null, decision: null };
    }
    // Both sides deleted a block that existed at base. Honour the
    // deletion silently — there is no conflict to surface.
    return {
      merged: null,
      decision: {
        blockId: base.id,
        resolution: 'auto-both-deleted',
        category: 'auto',
        local: null,
        server: null,
        base,
      },
    };
  }

  // Case 2: Server has the block, local does not.
  if (!local && server) {
    if (base) {
      // Local deleted, server unchanged → keep server (deletes do not
      // auto-resurrect, but neither do they auto-erase server-side
      // content the local user did not know about). The resolver picks
      // server here so concurrent local-delete + server-edit retains
      // data; the surfaced manual conflict is reported below.
      const localChangedFromBase = false; // local has no record
      const serverChangedFromBase = !blocksEqual(server, base);
      if (serverChangedFromBase) {
        return {
          merged: server,
          decision: {
            blockId: server.id,
            resolution: 'manual-server-wins',
            category: 'manual',
            local: null,
            server,
            base,
          },
        };
      }
      // Server unchanged, local deleted → respect local deletion.
      void localChangedFromBase;
      return {
        merged: null,
        decision: {
          blockId: server.id,
          resolution: 'auto-local-wins',
          category: 'auto',
          local: null,
          server,
          base,
        },
      };
    }
    // No base, server has block local does not: it was added on the
    // server side after our last sync.
    return {
      merged: server,
      decision: {
        blockId: server.id,
        resolution: 'auto-server-add-kept',
        category: 'auto',
        local: null,
        server,
        base: null,
      },
    };
  }

  // Case 3: Local has the block, server does not.
  if (local && !server) {
    if (base) {
      // Server deleted what was at base. Per SPEC §6.2 the deletion wins
      // unless the local side actively edited the block — in that case
      // the user should be told.
      const localChangedFromBase = !blocksEqual(local, base);
      if (localChangedFromBase) {
        // Local edited, server deleted → manual conflict. We honour the
        // server's delete (LWW) but report the loss.
        return {
          merged: null,
          decision: {
            blockId: local.id,
            resolution: 'manual-server-wins',
            category: 'manual',
            local,
            server: null,
            base,
          },
        };
      }
      // Local unchanged, server deleted → drop the block silently.
      return {
        merged: null,
        decision: {
          blockId: local.id,
          resolution: 'auto-server-delete-wins',
          category: 'auto',
          local,
          server: null,
          base,
        },
      };
    }
    // No base, local has block server does not: locally added after the
    // last shared snapshot. Keep it.
    return {
      merged: local,
      decision: {
        blockId: local.id,
        resolution: 'auto-local-add-kept',
        category: 'auto',
        local,
        server: null,
        base: null,
      },
    };
  }

  // Case 4: Both sides have the block. We must pick one (or merge later).
  // The block existence checks above guarantee both are non-null, so the
  // assertions are safe.
  const localBlock = local as ContentBlock;
  const serverBlock = server as ContentBlock;

  if (blocksEqual(localBlock, serverBlock)) {
    // Same content on both sides. Nothing changed worth reporting.
    return { merged: localBlock, decision: null };
  }

  // Both sides exist but differ. The base controls whether this is an
  // auto-merge (one side untouched) or a manual conflict.
  if (base) {
    const localChanged = !blocksEqual(localBlock, base);
    const serverChanged = !blocksEqual(serverBlock, base);

    if (localChanged && !serverChanged) {
      return {
        merged: localBlock,
        decision: {
          blockId: localBlock.id,
          resolution: 'auto-local-wins',
          category: 'auto',
          local: localBlock,
          server: serverBlock,
          base,
        },
      };
    }

    if (serverChanged && !localChanged) {
      return {
        merged: serverBlock,
        decision: {
          blockId: serverBlock.id,
          resolution: 'auto-server-wins',
          category: 'auto',
          local: localBlock,
          server: serverBlock,
          base,
        },
      };
    }

    // Both changed (or neither matches base while still differing). LWW
    // fallback: server wins, but the user must be informed.
    return {
      merged: serverBlock,
      decision: {
        blockId: serverBlock.id,
        resolution: 'manual-server-wins',
        category: 'manual',
        local: localBlock,
        server: serverBlock,
        base,
      },
    };
  }

  // No base: pure LWW. Server wins, surface as manual conflict so the
  // caller can decide whether to inform the user.
  return {
    merged: serverBlock,
    decision: {
      blockId: serverBlock.id,
      resolution: 'manual-server-wins',
      category: 'manual',
      local: localBlock,
      server: serverBlock,
      base: null,
    },
  };
}

/**
 * Three-way merge of two block lists with an optional shared base. The
 * function is exported separately so callers (such as future tooling or
 * unit tests for specific scenarios) can run it without constructing
 * full documents.
 */
export function mergeBlocks(
  local: readonly ContentBlock[],
  server: readonly ContentBlock[],
  base: readonly ContentBlock[] | null,
): { merged: ContentBlock[]; decisions: BlockMergeDecision[] } {
  const localIndex = indexBlocksById(local);
  const serverIndex = indexBlocksById(server);
  const baseIndex = base ? indexBlocksById(base) : null;

  const allIds = new Set<string>();
  for (const id of localIndex.keys()) allIds.add(id);
  for (const id of serverIndex.keys()) allIds.add(id);
  if (baseIndex) {
    for (const id of baseIndex.keys()) allIds.add(id);
  }

  // Sort the id iteration order so the decisions list and merged output
  // are deterministic across runs and platforms.
  const orderedIds = [...allIds].sort();

  const merged: ContentBlock[] = [];
  const decisions: BlockMergeDecision[] = [];

  for (const id of orderedIds) {
    const result = resolveBlock(
      localIndex.get(id) ?? null,
      serverIndex.get(id) ?? null,
      baseIndex?.get(id) ?? null,
    );
    if (result.merged) {
      merged.push(result.merged);
    }
    if (result.decision) {
      decisions.push(result.decision);
    }
  }

  return {
    merged: sortBlocksDeterministically(merged),
    decisions,
  };
}

/**
 * Merge two album content documents. When `base` is omitted (the client
 * has no record of the last shared version), the resolver falls back to
 * Phase 1 LWW: the server document wins entirely. Otherwise Phase 2
 * three-way block merge runs with LWW fallback for same-block conflicts.
 *
 * @param local - The document the local user just tried to save.
 * @param server - The current document from the server (post-conflict
 *   refetch).
 * @param base - The last document the local user successfully synced
 *   with the server, or null/undefined if no base is available.
 */
export function mergeAlbumContent(
  local: AlbumContentDocument,
  server: AlbumContentDocument,
  base?: AlbumContentDocument | null,
): AlbumContentMergeResult {
  if (!base) {
    // Phase 1: LWW. Server document is authoritative; we do not surface
    // per-block decisions because we have no way to know which side
    // changed what without a base. Manual conflicts list is empty so
    // the UI does not pop a dialog.
    const merged: AlbumContentDocument = {
      version: server.version,
      blocks: sortBlocksDeterministically([...server.blocks]),
      ...(server.settings ? { settings: { ...server.settings } } : {}),
    };

    return {
      merged,
      strategy: 'lww-server-wins',
      decisions: [],
      manualConflicts: [],
    };
  }

  const { merged: mergedBlocks, decisions } = mergeBlocks(
    local.blocks,
    server.blocks,
    base.blocks,
  );

  // Document-level settings: prefer server (LWW). The settings object is
  // small and the SPEC does not yet describe per-key merging.
  const mergedSettings = server.settings ?? local.settings;

  const merged: AlbumContentDocument = {
    version: server.version,
    blocks: mergedBlocks,
    ...(mergedSettings ? { settings: { ...mergedSettings } } : {}),
  };

  const manualConflicts = decisions.filter((d) => d.category === 'manual');

  return {
    merged,
    strategy: 'three-way-block-merge',
    decisions,
    manualConflicts,
  };
}

/**
 * Convenience predicate: did the merge produce any conflicts that the UI
 * should surface to the user? Auto-resolutions do not count.
 */
export function hasManualConflicts(result: AlbumContentMergeResult): boolean {
  return result.manualConflicts.length > 0;
}
