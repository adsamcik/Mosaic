package org.mosaic.android.main.sync

import android.content.Context
import androidx.room.withTransaction
import androidx.work.Logger
import androidx.work.WorkManager
import androidx.work.await
import org.mosaic.android.main.crypto.ShardEncryptionScheduler
import org.mosaic.android.main.db.UploadQueueDatabase
import org.mosaic.android.main.net.dto.AlbumId

class AlbumPurger(
  private val database: UploadQueueDatabase,
  private val workManager: WorkManager? = null,
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
      Logger.get().info(TAG, "Purged local album state after remote deletion")
      PurgeOutcome(
        jobIds = jobIds,
        result = PurgeResult(
          uploadJobs = deletedQueueRows,
          uploadJobSnapshots = deletedSnapshots,
          syncSnapshots = deletedSyncRows,
          contentHashes = deletedContentHashes,
        ),
      )
    }

    workManager?.let { manager ->
      purge.jobIds
        .map(ShardEncryptionScheduler::uploadJobTag)
        .forEach { tag -> manager.cancelAllWorkByTag(tag).await() }
    }
    return purge.result
  }

  companion object {
    private const val TAG = "AlbumPurger"

    /**
     * Production factory wiring an [AlbumPurger] against the process-wide
     * [WorkManager] singleton. Unit tests should instantiate
     * [AlbumPurger] directly so they can inject a test [WorkManager] (or
     * none at all).
     */
    fun production(context: Context, database: UploadQueueDatabase): AlbumPurger =
      AlbumPurger(database, WorkManager.getInstance(context))
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
)