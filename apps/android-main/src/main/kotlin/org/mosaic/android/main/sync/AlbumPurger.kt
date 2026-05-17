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