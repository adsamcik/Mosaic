package org.mosaic.android.main.sync

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.mosaic.android.main.db.AlbumContentHashRecord
import org.mosaic.android.main.db.RustSnapshotVersions
import org.mosaic.android.main.db.UploadJobSnapshotRow
import org.mosaic.android.main.db.UploadQueueDatabase
import org.mosaic.android.main.db.UploadQueueRecord
import org.mosaic.android.main.net.dto.AlbumId
import org.mosaic.android.main.upload.RoomContentHashDedup
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * v1.0.x s47-B2 / s49-y2: verifies that [AlbumPurger.purgeRemotePhotoDeletion]
 * removes the dedup record AND that a re-upload of identical plaintext for the
 * same photoId no longer collides with the orphaned hash.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AlbumPurgerPhotoDeletionTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()
  private val db = UploadQueueDatabase.createInMemoryForTests(context)

  @After
  fun closeDb() {
    db.close()
  }

  @Test
  fun purgesPerPhotoDedupSnapshotAndQueueRowInSingleTransaction() = runTest(UnconfinedTestDispatcher()) {
    val albumId = "018f9f8d-99df-7b42-8f0d-555555555555"
    val otherAlbum = "018f9f8d-99df-7b42-8f0d-666666666666"
    val photoId = "photo-target"
    val survivor = "photo-survivor"
    val contentHash = "a".repeat(64)
    val survivorHash = "b".repeat(64)

    db.uploadQueueDao().insert(uploadQueueRecord(jobId = photoId, albumId = albumId))
    db.uploadQueueDao().insert(uploadQueueRecord(jobId = survivor, albumId = albumId))
    db.uploadJobSnapshotDao().upsert(uploadJobSnapshot(photoId))
    db.uploadJobSnapshotDao().upsert(uploadJobSnapshot(survivor))
    db.albumContentHashDao().upsert(contentHash(albumId, contentHash, photoId))
    db.albumContentHashDao().upsert(contentHash(albumId, survivorHash, survivor))
    // dedup row for a different album with the same hash MUST survive.
    db.albumContentHashDao().upsert(contentHash(otherAlbum, contentHash, photoId))

    val result = AlbumPurger(db).purgeRemotePhotoDeletion(AlbumId(albumId), photoId)

    assertEquals(
      PhotoPurgeResult(contentHashes = 1, uploadJobs = 1, uploadJobSnapshots = 1),
      result,
    )
    assertNull(db.albumContentHashDao().lookup(albumId, contentHash))
    assertNull(db.uploadQueueDao().get(photoId))
    assertNull(db.uploadJobSnapshotDao().get(photoId))
    // Sibling photo in the same album survives.
    assertNotNull(db.uploadQueueDao().get(survivor))
    assertNotNull(db.uploadJobSnapshotDao().get(survivor))
    assertNotNull(db.albumContentHashDao().lookup(albumId, survivorHash))
    // Cross-album dedup row with same content hash survives.
    assertNotNull(db.albumContentHashDao().lookup(otherAlbum, contentHash))
  }

  @Test
  fun reuploadOfDeletedPhotoContentSucceedsAfterPurge() = runTest(UnconfinedTestDispatcher()) {
    val albumId = "018f9f8d-99df-7b42-8f0d-777777777777"
    val photoId = "photo-reupload"
    val newPhotoId = "photo-reupload-v2"
    val contentHash = "c".repeat(64)
    val dedup = RoomContentHashDedup(db.albumContentHashDao(), clock = { 1_700_000_000_000L })

    dedup.record(albumId = albumId, contentHash = contentHash, photoId = photoId)
    assertEquals(photoId, dedup.lookup(albumId, contentHash)?.photoId)

    AlbumPurger(db).purgeRemotePhotoDeletion(AlbumId(albumId), photoId)
    assertNull(dedup.lookup(albumId, contentHash))

    // Re-upload of the same plaintext must succeed (no orphaned dedup row blocking it).
    dedup.record(albumId = albumId, contentHash = contentHash, photoId = newPhotoId)
    assertEquals(newPhotoId, dedup.lookup(albumId, contentHash)?.photoId)
  }

  @Test
  fun returnsZeroCountsWhenPhotoHasNoLocalState() = runTest(UnconfinedTestDispatcher()) {
    val albumId = "018f9f8d-99df-7b42-8f0d-888888888888"
    val result = AlbumPurger(db).purgeRemotePhotoDeletion(AlbumId(albumId), "photo-unknown")

    assertEquals(PhotoPurgeResult(contentHashes = 0, uploadJobs = 0, uploadJobSnapshots = 0), result)
  }

  private fun uploadQueueRecord(jobId: String, albumId: String): UploadQueueRecord = UploadQueueRecord(
    jobId = jobId,
    albumId = albumId,
    schemaVersion = RustSnapshotVersions.CURRENT,
    phase = "AwaitingPreparedMedia",
    createdAtMs = 1_700_000_000_000L,
    updatedAtMs = 1_700_000_000_000L,
    retryCount = 0,
    maxRetryCount = 3,
    nextRetryNotBeforeMs = null,
    idempotencyKey = "idempotency-$jobId",
    tieredShardCount = 0,
    shardSetHashHex = null,
    snapshotRevision = 0L,
    lastEffectId = null,
    lastAcknowledgedEffectId = null,
    lastAppliedEventId = null,
    failureCode = null,
  )

  private fun uploadJobSnapshot(jobId: String): UploadJobSnapshotRow = UploadJobSnapshotRow(
    jobId = jobId,
    schemaVersion = RustSnapshotVersions.CURRENT,
    canonicalCborBytes = byteArrayOf(0xA0.toByte()),
    updatedAtMs = 1_700_000_000_000L,
    snapshotRevision = 1L,
  )

  private fun contentHash(albumId: String, hash: String, photoId: String): AlbumContentHashRecord =
    AlbumContentHashRecord(
      albumId = albumId,
      contentHash = hash,
      photoId = photoId,
      dateAdded = 1_700_000_000_000L,
    )
}
