package org.mosaic.android.main.upload

import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.mosaic.android.main.db.AlbumContentHashRecord
import org.mosaic.android.main.db.UploadQueueDatabase
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ContentHashDedupDeleteTest {
  private val db = UploadQueueDatabase.createInMemoryForTests(ApplicationProvider.getApplicationContext())
  private val dao = db.albumContentHashDao()

  @After
  fun closeDb() {
    db.close()
  }

  @Test
  fun daoDeletesContentHashRowsByAlbumAndPhotoId() {
    dao.upsert(contentHash(albumId = "album-a", contentHash = "a".repeat(64), photoId = "photo-a"))
    dao.upsert(contentHash(albumId = "album-a", contentHash = "b".repeat(64), photoId = "photo-b"))
    dao.upsert(contentHash(albumId = "album-b", contentHash = "a".repeat(64), photoId = "photo-a"))

    assertEquals(1, dao.deleteByPhotoId(albumId = "album-a", photoId = "photo-a"))

    assertNull(dao.lookup(albumId = "album-a", contentHash = "a".repeat(64)))
    assertEquals("photo-b", dao.lookup(albumId = "album-a", contentHash = "b".repeat(64))?.photoId)
    assertEquals("photo-a", dao.lookup(albumId = "album-b", contentHash = "a".repeat(64))?.photoId)
  }

  @Test
  fun roomContentHashDedupDeletesByContentHashAndPhotoId() {
    val dedup = RoomContentHashDedup(dao, clock = { 1_700_000_000_000L })
    dedup.record(albumId = "album-a", contentHash = "a".repeat(64), photoId = "photo-a")
    dedup.record(albumId = "album-a", contentHash = "b".repeat(64), photoId = "photo-b")

    assertEquals(1, dedup.deleteByContentHash(albumId = "album-a", contentHash = "a".repeat(64)))
    assertNull(dedup.lookup(albumId = "album-a", contentHash = "a".repeat(64)))

    assertEquals(1, dedup.deleteByPhotoId(albumId = "album-a", photoId = "photo-b"))
    assertNull(dedup.lookup(albumId = "album-a", contentHash = "b".repeat(64)))
  }

  private fun contentHash(
    albumId: String,
    contentHash: String,
    photoId: String,
  ): AlbumContentHashRecord =
    AlbumContentHashRecord(
      albumId = albumId,
      contentHash = contentHash,
      photoId = photoId,
      dateAdded = 1_700_000_000_000L,
    )
}
