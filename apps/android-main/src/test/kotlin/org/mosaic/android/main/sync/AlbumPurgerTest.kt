package org.mosaic.android.main.sync

import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.mosaic.android.main.db.AlbumContentHashRecord
import org.mosaic.android.main.db.AlbumSyncSnapshotRow
import org.mosaic.android.main.db.RustSnapshotVersions
import org.mosaic.android.main.db.UploadJobSnapshotRow
import org.mosaic.android.main.db.UploadQueueDatabase
import org.mosaic.android.main.db.UploadQueueRecord
import org.mosaic.android.main.net.dto.AlbumId
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AlbumPurgerTest {
  private val db = UploadQueueDatabase.createInMemoryForTests(ApplicationProvider.getApplicationContext())

  @After
  fun closeDb() {
    db.close()
  }

  @Test
  fun purgesAlbumOnGone() = runBlocking {
    val targetAlbum = "018f9f8d-99df-7b42-8f0d-111111111111"
    val otherAlbum = "018f9f8d-99df-7b42-8f0d-222222222222"
    db.uploadQueueDao().insert(uploadQueueRecord("job-target", targetAlbum))
    db.uploadQueueDao().insert(uploadQueueRecord("job-other", otherAlbum))
    db.uploadJobSnapshotDao().upsert(uploadJobSnapshot("job-target"))
    db.uploadJobSnapshotDao().upsert(uploadJobSnapshot("job-other"))
    db.albumSyncSnapshotDao().upsert(albumSyncSnapshot(targetAlbum))
    db.albumSyncSnapshotDao().upsert(albumSyncSnapshot(otherAlbum))
    db.albumContentHashDao().upsert(contentHash(targetAlbum, "a".repeat(64)))
    db.albumContentHashDao().upsert(contentHash(otherAlbum, "b".repeat(64)))

    val result = AlbumPurger(db).purgeRemoteAlbumDeletion(AlbumId(targetAlbum))

    assertEquals(PurgeResult(uploadJobs = 1, uploadJobSnapshots = 1, syncSnapshots = 1, contentHashes = 1), result)
    assertEquals(null, db.uploadQueueDao().get("job-target"))
    assertEquals(null, db.uploadJobSnapshotDao().get("job-target"))
    assertEquals(null, db.albumSyncSnapshotDao().get(targetAlbum))
    assertEquals(null, db.albumContentHashDao().lookup(targetAlbum, "a".repeat(64)))
    assertEquals("job-other", db.uploadQueueDao().get("job-other")?.jobId)
    assertEquals("job-other", db.uploadJobSnapshotDao().get("job-other")?.jobId)
    assertEquals(otherAlbum, db.albumSyncSnapshotDao().get(otherAlbum)?.albumId)
    assertEquals("photo-b", db.albumContentHashDao().lookup(otherAlbum, "b".repeat(64))?.photoId)
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

  private fun albumSyncSnapshot(albumId: String): AlbumSyncSnapshotRow = AlbumSyncSnapshotRow(
    albumId = albumId,
    schemaVersion = RustSnapshotVersions.CURRENT,
    canonicalCborBytes = byteArrayOf(0xA0.toByte()),
    updatedAtMs = 1_700_000_000_000L,
    snapshotRevision = 1L,
  )

  private fun contentHash(albumId: String, hash: String): AlbumContentHashRecord = AlbumContentHashRecord(
    albumId = albumId,
    contentHash = hash,
    photoId = if (hash.startsWith("a")) "photo-a" else "photo-b",
    dateAdded = 1_700_000_000_000L,
  )
}
