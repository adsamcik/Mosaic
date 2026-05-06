package org.mosaic.android.main.privacy

import android.content.Context
import android.net.Uri
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import kotlin.system.measureTimeMillis
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.mosaic.android.main.db.RustSnapshotVersions
import org.mosaic.android.main.db.StagedPickerBlob
import org.mosaic.android.main.db.UploadQueueDatabase
import org.mosaic.android.main.db.UploadQueueRecord
import org.mosaic.android.main.staging.AppPrivateStagingManager
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PrivacyAuditorTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()
  private var nowMs = BASE_INSTANT.toEpochMilli()
  private val staging = AppPrivateStagingManager(context) { nowMs }
  private val database = UploadQueueDatabase.createInMemoryForTests(context)
  private val logTail = InMemoryLogTailReader()

  @After
  fun tearDown() {
    database.close()
    File(context.filesDir, "staging").deleteRecursively()
    context.getSharedPreferences("mosaic_staging_privacy", Context.MODE_PRIVATE).edit().clear().commit()
  }

  @Test
  fun cleanStateHasNoFindings() = runBlocking {
    staging.cleanup(maxAgeMs = Duration.ofDays(1).toMillis())

    val report = auditor().runAudit()

    assertTrue(report.isClean)
    assertTrue(report.staleStaging.isEmpty())
    assertTrue(report.plaintextInDb.isEmpty())
    assertTrue(report.plaintextInLogs.isEmpty())
    assertTrue(report.cleanupRecency.recentEnough)
  }

  @Test
  fun staleStagingFileOlderThanMaxAgeIsReported() = runBlocking {
    val staged = stageFile("stale-source.txt", "encrypted-source-bytes")
    nowMs += Duration.ofDays(2).toMillis()
    staging.cleanup(maxAgeMs = Duration.ofDays(7).toMillis())

    val report = auditor(maxStagingAge = Duration.ofDays(1)).runAudit()

    assertEquals(listOf(staged.id), report.staleStaging.map { it.id })
    assertFalse(report.isClean)
  }

  @Test
  fun plaintextEmailInDatabaseIsDetected() = runBlocking {
    val unsafeDb = unsafeDatabaseWithoutPrivacyTriggers()
    try {
      unsafeDb.uploadQueueDao().insertValidated(validRecord().copy(phase = "owner=test@example.com"))
      staging.cleanup(maxAgeMs = Duration.ofDays(1).toMillis())

      val report = auditor(database = unsafeDb).runAudit()

      assertEquals(1, report.plaintextInDb.size)
      assertEquals("email", report.plaintextInDb.single().patternName)
      assertTrue(report.plaintextInDb.single().location.contains("upload_queue_records.phase"))
    } finally {
      unsafeDb.close()
    }
  }

  @Test
  fun plaintextCryptoKeyInLogsIsDetected() = runBlocking {
    logTail.append("debug key=${"a".repeat(64)}")
    staging.cleanup(maxAgeMs = Duration.ofDays(1).toMillis())

    val report = auditor().runAudit()

    assertEquals(1, report.plaintextInLogs.size)
    assertEquals("crypto-key-hex-32-byte", report.plaintextInLogs.single().patternName)
    assertFalse(report.isClean)
  }

  @Test
  fun cleanupNotRunForMoreThanSevenDaysIsReported() = runBlocking {
    staging.cleanup(maxAgeMs = Duration.ofDays(1).toMillis())
    nowMs += Duration.ofDays(8).toMillis()

    val report = auditor().runAudit()

    assertFalse(report.cleanupRecency.recentEnough)
    assertFalse(report.isClean)
  }

  @Test
  fun auditRunsUnderFiveHundredMillisecondsOnRepresentativeDataset() = runBlocking {
    repeat(20) { index ->
      database.uploadQueueDao().insert(validRecord(jobId = "job-$index", albumId = "album-$index"))
      stageFile("source-$index.txt", "encrypted-source-bytes-$index")
    }
    staging.cleanup(maxAgeMs = Duration.ofDays(1).toMillis())

    val elapsedMs = measureTimeMillis {
      auditor().runAudit()
    }

    assertTrue("audit took ${elapsedMs}ms", elapsedMs < 500)
  }

  @Test
  fun concurrentAuditsReturnStableFindingsWithoutDoubleFlagging() = runBlocking {
    logTail.append("debug key=${"b".repeat(64)}")
    staging.cleanup(maxAgeMs = Duration.ofDays(1).toMillis())
    val auditor = auditor()

    val reports = coroutineScope {
      List(4) { async { auditor.runAudit() } }.awaitAll()
    }

    assertTrue(reports.all { report -> report.plaintextInLogs.size == 1 })
    assertEquals(setOf(reports.first().plaintextInLogs.single()), reports.flatMap { it.plaintextInLogs }.toSet())
  }

  @Test
  fun auditDuringActiveUploadDoesNotReportReferencedStagingFile() = runBlocking {
    val staged = stageFile("active-source.txt", "active-upload-bytes")
    database.uploadQueueDao().insert(validRecord())
    database.stagedPickerBlobDao().insert(
      StagedPickerBlob(
        blobId = staged.id,
        jobId = "job-1",
        mimeType = "image/jpeg",
        sizeBytes = staged.sizeBytes,
        createdAtMs = staged.createdAtMs,
      ),
    )
    nowMs += Duration.ofDays(2).toMillis()
    staging.cleanup(maxAgeMs = Duration.ofDays(7).toMillis())

    val report = auditor(maxStagingAge = Duration.ofDays(1)).runAudit()

    assertTrue(report.staleStaging.isEmpty())
    assertTrue(staged.file.exists())
  }

  @Test
  fun additionalPiiPatternsDetectGpsFilenameAndPhoneShapes() = runBlocking {
    logTail.append("EXIF lat=50.0874512 file=IMG_20240131_123456.jpg phone=+420123456789")
    staging.cleanup(maxAgeMs = Duration.ofDays(1).toMillis())

    val report = auditor().runAudit()

    assertEquals(
      setOf("exif-gps-coordinate", "android-camera-filename", "e164-phone-number"),
      report.plaintextInLogs.map { it.patternName }.toSet(),
    )
  }

  private fun auditor(
    database: UploadQueueDatabase = this.database,
    maxStagingAge: Duration = Duration.ofDays(1),
  ) = PrivacyAuditor(
    staging = staging,
    database = database,
    logTail = logTail,
    clock = Clock.fixed(Instant.ofEpochMilli(nowMs), ZoneOffset.UTC),
    maxStagingAge = maxStagingAge,
    cleanupPolicyInterval = Duration.ofDays(7),
  )

  private fun stageFile(name: String, contents: String): org.mosaic.android.main.staging.StagedFile {
    val source = File(context.filesDir, name).apply { writeText(contents) }
    return staging.stage(Uri.fromFile(source))
  }

  private fun unsafeDatabaseWithoutPrivacyTriggers(): UploadQueueDatabase =
    Room.inMemoryDatabaseBuilder(context, UploadQueueDatabase::class.java)
      .allowMainThreadQueries()
      .build()

  private fun validRecord(
    jobId: String = "job-1",
    albumId: String = "album-1",
  ): UploadQueueRecord = UploadQueueRecord(
    jobId = jobId,
    albumId = albumId,
    schemaVersion = RustSnapshotVersions.CURRENT,
    phase = "AwaitingPreparedMedia",
    createdAtMs = nowMs,
    updatedAtMs = nowMs,
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

  private class InMemoryLogTailReader : LogTailReader {
    private val lines = mutableListOf<String>()

    fun append(line: String) {
      lines += line
    }

    override suspend fun readLastLines(maxLines: Int): List<String> = lines.takeLast(maxLines)
  }

  private companion object {
    val BASE_INSTANT: Instant = Instant.parse("2024-01-01T00:00:00Z")
  }
}
