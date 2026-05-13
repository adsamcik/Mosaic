package org.mosaic.android.main.upload

import org.mosaic.android.main.db.AlbumContentHashDao
import org.mosaic.android.main.db.AlbumContentHashRecord

interface ContentHashDedup {
  fun lookup(albumId: String, contentHash: String): DuplicateContent?
  fun record(albumId: String, contentHash: String, photoId: String)
  fun deleteByContentHash(albumId: String, contentHash: String): Int
  fun deleteByPhotoId(albumId: String, photoId: String): Int
  fun clear(albumId: String): Int
}

data class DuplicateContent(
  val photoId: String,
  val dateAdded: Long,
)

class RoomContentHashDedup(
  private val dao: AlbumContentHashDao,
  private val clock: () -> Long = { System.currentTimeMillis() },
) : ContentHashDedup {
  override fun lookup(albumId: String, contentHash: String): DuplicateContent? =
    dao.lookup(albumId, contentHash)?.let { DuplicateContent(it.photoId, it.dateAdded) }

  override fun record(albumId: String, contentHash: String, photoId: String) {
    dao.upsert(
      AlbumContentHashRecord(
        albumId = albumId,
        contentHash = contentHash,
        photoId = photoId,
        dateAdded = clock(),
      ),
    )
  }

  override fun clear(albumId: String): Int = dao.clear(albumId)

  override fun deleteByContentHash(albumId: String, contentHash: String): Int =
    dao.deleteByContentHash(albumId, contentHash)

  override fun deleteByPhotoId(albumId: String, photoId: String): Int =
    dao.deleteByPhotoId(albumId, photoId)
}

object NoOpContentHashDedup : ContentHashDedup {
  override fun lookup(albumId: String, contentHash: String): DuplicateContent? = null
  override fun record(albumId: String, contentHash: String, photoId: String) = Unit
  override fun deleteByContentHash(albumId: String, contentHash: String): Int = 0
  override fun deleteByPhotoId(albumId: String, photoId: String): Int = 0
  override fun clear(albumId: String): Int = 0
}
