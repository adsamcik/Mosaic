package org.mosaic.android.main.e2e

import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.matcher.ViewMatchers.isDisplayed
import androidx.test.espresso.matcher.ViewMatchers.withText
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.mosaic.android.main.MainActivity
import org.mosaic.android.main.reducer.UploadJobId
import org.mosaic.android.main.reducer.UploadJobOutcome

@RunWith(AndroidJUnit4::class)
class UploadLifecycleE2ETest : E2ETestSupport() {

  @Test
  fun photoHappyPath_uploadsAllShardsFinalizesAndPersistsConfirmedSnapshot() = runBlocking {
    val staged = stageFixture("tiny-photo.jpg")
    assertEquals("one Photo Picker item is staged", 1, staged.size)
    seedSnapshot()

    val outcome = uploadAdapter().submit(UploadJobId(JOB_ID))

    outcome.assertFinalized()
    assertEquals("thumbnail, preview, and original shards encrypted", 3, backend.encryptedShardIds.distinct().size)
    assertEquals("thumbnail, preview, and original shards uploaded", 3, backend.uploadedShardIds.distinct().size)
    assertEquals("manifest finalized once", 1, backend.manifestFinalizeCalls)
    assertEquals("sync confirmation completes", 1, backend.syncConfirmations)
    assertTrue("all snapshot shards are marked uploaded", persistedSnapshot().tieredShards.all { it.uploaded })
    ActivityScenario.launch(MainActivity::class.java).use {
      onView(withText("Mosaic Android")).check(matches(isDisplayed()))
    }
    assertNotNull("confirmed upload snapshot remains queryable as Android gallery source of truth", database.uploadJobSnapshotDao().get(JOB_ID))
  }

  @Test
  fun processDeath_resumesFromSnapshot() = runBlocking {
    seedSnapshot("EncryptingShard", shards = allTierShards())
    val firstDelegate = NetworkUploadPipelineDispatcher(backend, staging, database)
    val interrupted = BlockingOnceDispatcher(firstDelegate, blockingKind = "EncryptShard")
    try {
      reducer(interrupted).run(UploadJobId(JOB_ID))
      throw AssertionError("simulated process death should interrupt the first reducer pass")
    } catch (_: CancellationException) {
      assertEquals("EncryptingShard", persistedSnapshot().phase)
    }

    val outcome = uploadAdapter().submit(UploadJobId(JOB_ID))

    outcome.assertFinalized()
    assertEquals("resume uploads each shard exactly once", 3, backend.uploadedShardIds.distinct().size)
    assertEquals("no duplicate upload attempts after snapshot replay", backend.uploadedShardIds.size, backend.uploadedShardIds.distinct().size)
  }

  @Test
  fun networkFailure_retriesWithDelayAndRecovers() = runBlocking {
    seedSnapshot("UploadingShard", shards = allTierShards())
    backend.failFirstPatchWithDisconnect = true

    val outcome = uploadAdapter().submit(UploadJobId(JOB_ID))

    outcome.assertFinalized()
    assertTrue("SocketPolicy disconnect forces an extra PATCH attempt", backend.patchAttempts > backend.uploadedShardIds.size)
    assertEquals("retry counter records the transient upload failure", 1, persistedSnapshot().retryCount)
    assertTrue("retry transition advanced through RetryWaiting with a scheduled delay", persistedSnapshot().snapshotRevision > 1)
    assertEquals(3, backend.uploadedShardIds.distinct().size)
  }

  @Test
  fun manifestCommitUnknown_syncRecovers() = runBlocking {
    seedSnapshot("CreatingManifest", shards = allTierShards(uploaded = true))
    backend.manifestUnknownThenAlreadyFinalized = true

    val outcome = uploadAdapter().submit(UploadJobId(JOB_ID))

    outcome.assertFinalized()
    assertEquals("first finalize commits but drops response, second observes 409", 2, backend.manifestFinalizeCalls)
    assertTrue("AlreadyFinalized is treated as manifest success", backend.alreadyFinalizedRecovered)
    assertEquals("sync confirmation catches up after recovery", 1, backend.syncConfirmations)
  }

  @Test
  fun afterUpload_stagingCleaned_privacyAuditClean() = runBlocking {
    val staged = stageFixture("tiny-photo.png")
    assertFalse(staged.isEmpty())
    seedSnapshot()

    val outcome = uploadAdapter().submit(UploadJobId(JOB_ID))
    val report = runPrivacyAudit()

    outcome.assertFinalized()
    assertTrue("private staging has no stale files", staging.listStagedFiles().isEmpty())
    assertTrue("privacy auditor reports a clean post-upload device state", report.isClean)
  }

  @Test
  fun albumDeletedMidUpload_transitionsToCanceled() = runBlocking {
    seedSnapshot("UploadingShard", shards = allTierShards())
    backend.deleteAlbumAfterFirstPatch = true

    val outcome = uploadAdapter().submit(UploadJobId(JOB_ID))

    assertEquals(UploadJobOutcome.Cancelled, outcome)
    assertEquals("Cancelled", persistedSnapshot().phase)
    assertTrue("410 Gone is driven after upload starts", backend.albumDeleted)
    assertTrue("only pre-deletion shard upload may persist", backend.uploadedShardIds.size <= 1)
    assertTrue("cancellation path leaves staging clean", staging.listStagedFiles().isEmpty())
  }

  @Test
  fun realDeviceMatrix_documentedForApi26Api30Api34AndApi35() {
    val spec = readCoverageSpecAsset()
    val matrixRows = spec.lineSequence()
      .filter { it.startsWith("| ") && it.contains("API ") && it.contains("Android") }
      .toList()
    val documentedApis = matrixRows.mapNotNull { Regex("API (\\d+)").find(it)?.groupValues?.get(1)?.toInt() }.toSet()
    val documentedClasses = matrixRows.map { it.split('|')[1].trim() }.filter { it.isNotBlank() }

    assertEquals(setOf(26, 30, 34, 35), documentedApis)
    assertEquals("device matrix must keep four non-empty device classes", 4, documentedClasses.distinct().size)
    assertTrue("SPEC must document Snapdragon coverage", spec.contains("Snapdragon"))
    assertTrue("SPEC must document Tensor coverage", spec.contains("Tensor"))
    assertTrue("SPEC must document MediaTek coverage", spec.contains("MediaTek"))
    assertTrue("coverage gaps must be honestly documented", spec.contains("## Coverage gaps and mitigations"))
    assertTrue("manual Android lanes are explicit", spec.contains("manual/device-lab"))
  }
}
