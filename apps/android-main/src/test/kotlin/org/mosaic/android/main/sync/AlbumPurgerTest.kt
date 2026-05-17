package org.mosaic.android.main.sync

import android.content.Context
import android.util.Log
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.Constraints
import androidx.work.ListenableWorker
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.mosaic.android.main.crypto.ShardEncryptionScheduler
import org.mosaic.android.main.crypto.ShardEnvelopeStore
import org.mosaic.android.main.db.AlbumContentHashRecord
import org.mosaic.android.main.db.AlbumEpochKeyRecord
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
  private val context = ApplicationProvider.getApplicationContext<Context>()
  private val db = UploadQueueDatabase.createInMemoryForTests(context)
  private val envelopeRoot = java.io.File(context.filesDir, "encrypted-shards")

  @Before
  fun setUpWorkManager() {
    envelopeRoot.deleteRecursively()
    WorkManagerTestInitHelper.initializeTestWorkManager(
      context,
      Configuration.Builder()
        .setMinimumLoggingLevel(Log.DEBUG)
        .setExecutor(SynchronousExecutor())
        .build(),
    )
  }

  @After
  fun closeDb() {
    WorkManager.getInstance(context).cancelAllWork().result.get()
    WorkManager.getInstance(context).pruneWork().result.get()
    db.close()
    envelopeRoot.deleteRecursively()
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
    // v1.0.1 s34: wrapped epoch seeds + on-disk envelopes for both albums.
    db.albumEpochKeyDao().upsert(albumEpochKey(targetAlbum, epochId = 1))
    db.albumEpochKeyDao().upsert(albumEpochKey(targetAlbum, epochId = 2))
    db.albumEpochKeyDao().upsert(albumEpochKey(otherAlbum, epochId = 1))
    val envelopeStore = ShardEnvelopeStore(context)
    writeEnvelope(envelopeStore, targetAlbum, "target-shard-0", shardIndex = 0)
    writeEnvelope(envelopeStore, targetAlbum, "target-shard-1", shardIndex = 1)
    writeEnvelope(envelopeStore, otherAlbum, "other-shard-0", shardIndex = 0)

    val result = AlbumPurger(db, shardEnvelopeStore = envelopeStore)
      .purgeRemoteAlbumDeletion(AlbumId(targetAlbum))

    assertEquals(
      PurgeResult(
        uploadJobs = 1,
        uploadJobSnapshots = 1,
        syncSnapshots = 1,
        contentHashes = 1,
        epochKeys = 2,
        envelopeFiles = 2,
      ),
      result,
    )
    assertEquals(null, db.uploadQueueDao().get("job-target"))
    assertEquals(null, db.uploadJobSnapshotDao().get("job-target"))
    assertEquals(null, db.albumSyncSnapshotDao().get(targetAlbum))
    assertEquals(null, db.albumContentHashDao().lookup(targetAlbum, "a".repeat(64)))
    assertEquals(null, db.albumEpochKeyDao().get(targetAlbum, epochId = 1))
    assertEquals(null, db.albumEpochKeyDao().get(targetAlbum, epochId = 2))
    assertEquals("job-other", db.uploadQueueDao().get("job-other")?.jobId)
    assertEquals("job-other", db.uploadJobSnapshotDao().get("job-other")?.jobId)
    assertEquals(otherAlbum, db.albumSyncSnapshotDao().get(otherAlbum)?.albumId)
    assertEquals("photo-b", db.albumContentHashDao().lookup(otherAlbum, "b".repeat(64))?.photoId)
    assertEquals(otherAlbum, db.albumEpochKeyDao().get(otherAlbum, epochId = 1)?.albumId)
    assertTrue("other album's envelope dir survives", java.io.File(envelopeRoot, otherAlbum).exists())
  }

  @Test
  fun reportsZeroWhenEnvelopeDirAndEpochKeysAreEmpty() = runBlocking {
    val targetAlbum = "018f9f8d-99df-7b42-8f0d-333333333333"
    db.uploadQueueDao().insert(uploadQueueRecord("job-empty", targetAlbum))

    val result = AlbumPurger(db, shardEnvelopeStore = ShardEnvelopeStore(context))
      .purgeRemoteAlbumDeletion(AlbumId(targetAlbum))

    assertEquals(0, result.epochKeys)
    assertEquals(0, result.envelopeFiles)
    assertEquals(1, result.uploadJobs)
  }

  @Test
  fun purgeWithoutEnvelopeStoreLeavesEnvelopeFilesZero() = runBlocking {
    val targetAlbum = "018f9f8d-99df-7b42-8f0d-444444444444"
    db.uploadQueueDao().insert(uploadQueueRecord("job-nostore", targetAlbum))
    db.albumEpochKeyDao().upsert(albumEpochKey(targetAlbum, epochId = 7))

    val result = AlbumPurger(db).purgeRemoteAlbumDeletion(AlbumId(targetAlbum))

    assertEquals(1, result.epochKeys)
    assertEquals(0, result.envelopeFiles)
  }

  @Test
  fun cancelsUploadJobsForPurgedAlbum() = runBlocking {
    val albumA = "018f9f8d-99df-7b42-8f0d-aaaaaaaaaaaa"
    val albumB = "018f9f8d-99df-7b42-8f0d-bbbbbbbbbbbb"
    val workManager = WorkManager.getInstance(context)
    db.uploadQueueDao().insert(uploadQueueRecord("jobA1", albumA))
    db.uploadQueueDao().insert(uploadQueueRecord("jobA2", albumA))
    db.uploadQueueDao().insert(uploadQueueRecord("jobB1", albumB))
    workManager.enqueue(taggedWork("jobA1")).result.get()
    workManager.enqueue(taggedWork("jobA2")).result.get()
    workManager.enqueue(taggedWork("jobB1")).result.get()

    AlbumPurger(db, workManager).purgeRemoteAlbumDeletion(AlbumId(albumA))

    assertEquals(null, db.uploadQueueDao().get("jobA1"))
    assertEquals(null, db.uploadQueueDao().get("jobA2"))
    assertEquals("jobB1", db.uploadQueueDao().get("jobB1")?.jobId)
    assertEquals(WorkInfo.State.CANCELLED, workInfoForJob("jobA1").state)
    assertEquals(WorkInfo.State.CANCELLED, workInfoForJob("jobA2").state)
    assertEquals(WorkInfo.State.ENQUEUED, workInfoForJob("jobB1").state)
  }

  @Test
  fun productionFactoryWiresWorkManager() {
    val purger = AlbumPurger.production(context, db)

    assertTrue(purger.hasWorkManager)
  }

  private fun taggedWork(jobId: String) = OneTimeWorkRequestBuilder<NoOpWorker>()
    .setInitialDelay(1, TimeUnit.DAYS)
    .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
    .addTag(ShardEncryptionScheduler.uploadJobTag(jobId))
    .build()

  private fun workInfoForJob(jobId: String): WorkInfo =
    WorkManager.getInstance(context).getWorkInfosByTag(ShardEncryptionScheduler.uploadJobTag(jobId)).get().single()

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

  private fun albumEpochKey(albumId: String, epochId: Int): AlbumEpochKeyRecord = AlbumEpochKeyRecord(
    albumId = albumId,
    epochId = epochId,
    wrappedEpochSeed = ByteArray(48) { it.toByte() },
    updatedAtMs = 1_700_000_000_000L,
  )

  private fun writeEnvelope(store: ShardEnvelopeStore, albumId: String, stagingName: String, shardIndex: Int) {
    val stagingDir = java.io.File(context.filesDir, "purger-test-staging").also { it.mkdirs() }
    val stagingFile = java.io.File(stagingDir, "$stagingName.bin")
    if (!stagingFile.exists()) stagingFile.writeText(stagingName)
    val input = org.mosaic.android.main.crypto.ShardEnvelopeInput(
      stagingUri = android.net.Uri.fromFile(stagingFile).toString(),
      albumId = albumId,
      epochId = 1,
      tier = 3,
      shardIndex = shardIndex,
      plaintextSha256Hex = "0".repeat(64),
    )
    store.persistEnvelope(input, envelope = byteArrayOf(1, 2, 3))
  }

  class NoOpWorker(context: Context, params: WorkerParameters) : ListenableWorker(context, params) {
    override fun startWork() = com.google.common.util.concurrent.SettableFuture.create<Result>()
  }
}
