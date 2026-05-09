package org.mosaic.android.main.upload

import java.security.MessageDigest
import org.mosaic.android.main.db.AlbumContentHashDao
import org.mosaic.android.main.db.AlbumContentHashRecord

interface ContentHashDedup {
  fun lookup(albumId: String, contentHash: String): DuplicateContent?
  fun record(albumId: String, contentHash: String, photoId: String)
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
}

object NoOpContentHashDedup : ContentHashDedup {
  override fun lookup(albumId: String, contentHash: String): DuplicateContent? = null
  override fun record(albumId: String, contentHash: String, photoId: String) = Unit
  override fun clear(albumId: String): Int = 0
}

fun computePlaintextContentHash(bytes: ByteArray): String =
  MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { byte -> "%02x".format(byte) }
