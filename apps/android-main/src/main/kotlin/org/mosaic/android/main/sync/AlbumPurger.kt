package org.mosaic.android.main.sync

import androidx.room.withTransaction
import androidx.work.Logger
import org.mosaic.android.main.db.UploadQueueDatabase
import org.mosaic.android.main.net.dto.AlbumId

class AlbumPurger(
  private val database: UploadQueueDatabase,
) {
  suspend fun purgeRemoteAlbumDeletion(albumId: AlbumId): PurgeResult = database.withTransaction {
    val jobIds = database.uploadQueueDao().jobIdsForAlbum(albumId.value)
    val deletedSnapshots = if (jobIds.isEmpty()) 0 else database.uploadJobSnapshotDao().deleteForJobIds(jobIds)
    val deletedQueueRows = database.uploadQueueDao().deleteForAlbum(albumId.value)
    val deletedSyncRows = database.albumSyncSnapshotDao().clear(albumId.value)
    val deletedContentHashes = database.albumContentHashDao().clear(albumId.value)
    Logger.get().info(TAG, "Purged local album state after remote deletion")
    PurgeResult(
      uploadJobs = deletedQueueRows,
      uploadJobSnapshots = deletedSnapshots,
      syncSnapshots = deletedSyncRows,
      contentHashes = deletedContentHashes,
    )
  }

  private companion object {
    const val TAG = "AlbumPurger"
  }
}

data class PurgeResult(
  val uploadJobs: Int,
  val uploadJobSnapshots: Int,
  val syncSnapshots: Int,
  val contentHashes: Int,
)
