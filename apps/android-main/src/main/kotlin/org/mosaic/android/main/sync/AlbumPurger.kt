package org.mosaic.android.main.sync

import android.content.Context
import androidx.room.withTransaction
import androidx.work.Logger
import androidx.work.WorkManager
import androidx.work.await
import org.mosaic.android.main.crypto.ShardEncryptionScheduler
import org.mosaic.android.main.crypto.ShardEnvelopeStore
import org.mosaic.android.main.db.UploadQueueDatabase
import org.mosaic.android.main.net.dto.AlbumId

class AlbumPurger internal constructor(
  private val database: UploadQueueDatabase,
  private val workManager: WorkManager? = null,
  private val shardEnvelopeStore: ShardEnvelopeStore? = null,
) {
  /**
   * Whether this purger will broadcast work-cancellation through
   * [androidx.work.WorkManager]. Production wiring sets this; in-memory
   * unit tests that mock the WorkManager separately may set this to
   * `false` to stay off the global singleton.
   */
  val hasWorkManager: Boolean
    get() = workManager != null

  suspend fun purgeRemoteAlbumDeletion(albumId: AlbumId): PurgeResult {
    val purge = database.withTransaction {
      val jobIds = database.uploadQueueDao().jobIdsForAlbum(albumId.value)
      val deletedSnapshots = if (jobIds.isEmpty()) 0 else database.uploadJobSnapshotDao().deleteForJobIds(jobIds)
      val deletedQueueRows = database.uploadQueueDao().deleteForAlbum(albumId.value)
      val deletedSyncRows = database.albumSyncSnapshotDao().clear(albumId.value)
      val deletedContentHashes = database.albumContentHashDao().clear(albumId.value)
      // v1.0.1 s34: drop wrapped epoch seeds for the deleted album. Without
      // this, logout/multi-account would expose stale L3 epoch material.
      val deletedEpochKeys = database.albumEpochKeyDao().clear(albumId.value)
      Logger.get().info(TAG, "Purged local album state after remote deletion")
      PurgeOutcome(
        jobIds = jobIds,
        result = PurgeResult(
          uploadJobs = deletedQueueRows,
          uploadJobSnapshots = deletedSnapshots,
          syncSnapshots = deletedSyncRows,
          contentHashes = deletedContentHashes,
          epochKeys = deletedEpochKeys,
          envelopeFiles = 0,
        ),
      )
    }

    workManager?.let { manager ->
      purge.jobIds
        .map(ShardEncryptionScheduler::uploadJobTag)
        .forEach { tag -> manager.cancelAllWorkByTag(tag).await() }
    }
    // v1.0.1 s34: drop on-disk envelopes for the deleted album. File I/O is
    // not part of the Room transaction so we run it AFTER the commit; even if
    // this fails the Room state is already consistent with "album removed."
    val envelopeFiles = shardEnvelopeStore?.deleteForAlbum(albumId) ?: 0
    return purge.result.copy(envelopeFiles = envelopeFiles)
  }

  /**
   * Per-photo counterpart to [purgeRemoteAlbumDeletion]. v1.0.x s47-B2/s49-y2:
   * when a remote sync confirms a manifest with `isDeleted = true`, the local
   * dedup record for that photo must be removed in the same Room transaction
   * as the manifest/shard cleanup. Without this the
   * [org.mosaic.android.main.db.AlbumContentHashRecord] is orphaned and a
   * future re-upload of the identical plaintext is blocked by the duplicate
   * lookup in [org.mosaic.android.main.crypto.ShardEncryptionWorker].
   *
   * The Android upload pipeline uses `jobId == photoId` (see
   * [org.mosaic.android.main.reducer.UploadJobReducer]) so the photoId also
   * keys the upload-queue and snapshot rows. WorkManager cancellation is
   * performed outside the Room transaction, matching
   * [purgeRemoteAlbumDeletion] semantics.
   */
  suspend fun purgeRemotePhotoDeletion(albumId: AlbumId, photoId: String): PhotoPurgeResult {
    require(photoId.isNotBlank()) { "photoId must not be blank" }
    val purge = database.withTransaction {
      val deletedContentHashes = database.albumContentHashDao().deleteByPhotoId(albumId.value, photoId)
      val deletedSnapshots = database.uploadJobSnapshotDao().deleteForJobIds(listOf(photoId))
      val deletedQueueRows = database.uploadQueueDao().deleteForJobId(photoId)
      Logger.get().info(TAG, "Purged local photo state after remote deletion")
      PhotoPurgeResult(
        contentHashes = deletedContentHashes,
        uploadJobs = deletedQueueRows,
        uploadJobSnapshots = deletedSnapshots,
      )
    }

    workManager?.cancelAllWorkByTag(ShardEncryptionScheduler.uploadJobTag(photoId))?.await()
    return purge
  }

  companion object {
    private const val TAG = "AlbumPurger"

    /**
     * Production factory wiring an [AlbumPurger] against the process-wide
     * [WorkManager] singleton and a [ShardEnvelopeStore] rooted at the app
     * `filesDir`. Unit tests should instantiate [AlbumPurger] directly so
     * they can inject a test [WorkManager] (or none at all) and a test
     * envelope store.
     */
    fun production(context: Context, database: UploadQueueDatabase): AlbumPurger =
      AlbumPurger(
        database = database,
        workManager = WorkManager.getInstance(context),
        shardEnvelopeStore = ShardEnvelopeStore(context),
      )
  }
}

private data class PurgeOutcome(
  val jobIds: List<String>,
  val result: PurgeResult,
)

data class PurgeResult(
  val uploadJobs: Int,
  val uploadJobSnapshots: Int,
  val syncSnapshots: Int,
  val contentHashes: Int,
  val epochKeys: Int,
  val envelopeFiles: Int,
)

data class PhotoPurgeResult(
  val contentHashes: Int,
  val uploadJobs: Int,
  val uploadJobSnapshots: Int,
)