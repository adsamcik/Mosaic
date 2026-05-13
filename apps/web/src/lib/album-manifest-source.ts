/**
 * Current Album Manifest Source
 *
 * Builds a {@link CurrentAlbumManifest} from the local SQLite (`db.worker`)
 * snapshot for an album. This is the "freshly decrypted current view of the
 * album" that {@link DownloadResumePrompt} diffs against a persisted
 * download plan when the user resumes a stale download job.
 *
 * Why this lives here (not in the coordinator worker):
 *   The coordinator needs to compare what a resumable download job *thought*
 *   the album was vs. what the album *now* looks like — added, removed,
 *   rekeyed, and shardChanged photos. The "now" view is owned by the main
 *   thread because the encrypted manifest has already been decrypted, parsed,
 *   and persisted into the local DB by `sync-engine`. We just project the DB
 *   rows back into the minimal shape `computeAlbumDiff` consumes.
 *
 * Tier-3 shard fallback:
 *   Newer uploads populate {@link PhotoMeta.originalShardIds} (the canonical
 *   per-tier field). Older entries — written before the tier-specific schema —
 *   only have the deprecated {@link PhotoMeta.shardIds} flat list. We prefer
 *   the new field and fall back to the legacy one so resume diffs stay
 *   correct across the migration boundary.
 */

import { getDbClient } from './db-client';
import { loadAllAlbumPhotos } from './photo-query-pagination';
import type {
  CurrentAlbumManifest,
  DbWorkerApi,
  PhotoMeta,
} from '../workers/types';

/**
 * Extract the tier-3 (full-resolution) shard IDs for a single photo.
 *
 * Prefer the per-tier `originalShardIds` field; if a legacy row still uses
 * the deprecated flat `shardIds`, fall back to it so the diff is not silently
 * wrong for un-migrated albums. Both arrays are normalised to a shallow copy
 * to guarantee the returned manifest is independent of DB query buffers.
 */
function tier3ShardIdsFor(photo: PhotoMeta): string[] {
  if (photo.originalShardIds && photo.originalShardIds.length > 0) {
    return [...photo.originalShardIds];
  }
  if (photo.shardIds && photo.shardIds.length > 0) {
    return [...photo.shardIds];
  }
  return [];
}

/**
 * Build a {@link CurrentAlbumManifest} from the local DB for `albumId`.
 *
 * Reads the album's photos via the DB worker and projects them into the
 * minimal shape required by `coordinator.computeAlbumDiff`. This function
 * is side-effect-free apart from the DB read it triggers.
 *
 * @param albumId - The album whose current local view is being captured.
 * @param db - Optional DB worker handle, primarily for testing. Defaults to
 *             the shared singleton from {@link getDbClient}.
 */
export async function getCurrentAlbumManifest(
  albumId: string,
  db?: Pick<DbWorkerApi, 'getPhotos'>,
): Promise<CurrentAlbumManifest> {
  const dbClient = db ?? (await getDbClient());
  const photos = await loadAllAlbumPhotos(dbClient, albumId);

  return {
    albumId,
    photos: photos.map((photo) => ({
      photoId: photo.id,
      epochId: photo.epochId,
      tier3ShardIds: tier3ShardIdsFor(photo),
    })),
  };
}
