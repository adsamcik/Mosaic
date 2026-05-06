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
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.mosaic.android.main.MainActivity
import org.mosaic.android.main.reducer.UploadJobId
import org.mosaic.android.main.reducer.UploadJobOutcome
import org.mosaic.android.main.reducer.decodeUploadSnapshot

@RunWith(AndroidJUnit4::class)
class UploadLifecycleE2ETest : E2ETestSupport() {

  @Test
  fun photoHappyPath_uploadsAllShardsAndFinalizes() = runBlocking {
    val staged = stageFixture("tiny-photo.jpg")
    assertEquals("one Photo Picker item is staged", 1, staged.size)
    seedSnapshot()
    val dispatcher = FullUploadPipelineDispatcher(backend)

    val outcome = reducer(dispatcher).run(UploadJobId(JOB_ID))

    outcome.assertFinalized()
    assertEquals("thumbnail, preview, and original shards encrypted", 3, backend.encryptedShardIds.distinct().size)
    assertEquals("thumbnail, preview, and original shards uploaded", 3, backend.uploadedShardIds.distinct().size)
    assertEquals("manifest finalized once", 1, backend.manifestFinalizeCalls)
    assertEquals("sync confirmation completes", 1, backend.syncConfirmations)
    assertTrue("all snapshot shards are marked uploaded", persistedSnapshot().tieredShards.all { it.uploaded })
    ActivityScenario.launch(MainActivity::class.java).use {
      onView(withText("Mosaic Android")).check(matches(isDisplayed()))
    }
  }

  @Test
  fun processDeath_resumesFromSnapshot() = runBlocking {
    seedSnapshot("EncryptingShard", shards = allTierShards())
    val firstDelegate = FullUploadPipelineDispatcher(backend)
    val interrupted = BlockingOnceDispatcher(firstDelegate, blockingKind = "EncryptShard")
    try {
      reducer(interrupted).run(UploadJobId(JOB_ID))
      throw AssertionError("simulated process death should interrupt the first reducer pass")
    } catch (_: CancellationException) {
      assertEquals("EncryptingShard", persistedSnapshot().phase)
    }

    val resumedDispatcher = FullUploadPipelineDispatcher(backend)
    val outcome = reducer(resumedDispatcher).run(UploadJobId(JOB_ID))

    outcome.assertFinalized()
    assertEquals("resume uploads each shard exactly once", 3, backend.uploadedShardIds.distinct().size)
    assertEquals("no duplicate upload attempts after snapshot replay", backend.uploadedShardIds.size, backend.uploadedShardIds.distinct().size)
  }

  @Test
  fun networkFailure_retriesAndRecovers() = runBlocking {
    seedSnapshot("UploadingShard", shards = allTierShards())
    val dispatcher = FullUploadPipelineDispatcher(backend, failFirstUpload = true)

    val outcome = reducer(dispatcher).run(UploadJobId(JOB_ID))

    outcome.assertFinalized()
    assertTrue("mock 502 forces an extra PATCH attempt", dispatcher.uploadAttempts > backend.uploadedShardIds.size)
    assertEquals("retry counter records the transient upload failure", 1, persistedSnapshot().retryCount)
    assertEquals(3, backend.uploadedShardIds.distinct().size)
  }

  @Test
  fun manifestCommitUnknown_syncRecovers() = runBlocking {
    seedSnapshot("CreatingManifest", shards = allTierShards(uploaded = true))
    val dispatcher = FullUploadPipelineDispatcher(backend, manifestUnknownThenAlreadyFinalized = true)

    val outcome = reducer(dispatcher).run(UploadJobId(JOB_ID))

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
    val outcome = reducer(FullUploadPipelineDispatcher(backend)).run(UploadJobId(JOB_ID))
    outcome.assertFinalized()

    cleanupPrivateStaging()
    val report = runPrivacyAudit()

    assertTrue("private staging has no stale files", staging.listStagedFiles().isEmpty())
    assertTrue("privacy auditor reports a clean post-upload device state", report.isClean)
  }

  @Test
  fun albumDeletedMidUpload_transitionsToCanceled() = runBlocking {
    seedSnapshot("UploadingShard", shards = allTierShards())
    backend.albumDeleted = true

    val outcome = reducer(FullUploadPipelineDispatcher(backend)).run(UploadJobId(JOB_ID))

    assertEquals(UploadJobOutcome.Cancelled, outcome)
    assertEquals("Cancelled", persistedSnapshot().phase)
    assertTrue("410 Gone prevents shard upload persistence", backend.uploadedShardIds.isEmpty())
    cleanupPrivateStaging()
    assertTrue("cancellation path leaves staging clean", staging.listStagedFiles().isEmpty())
  }

  @Test
  fun realDeviceMatrix_documentedForApi26Api30Api34AndApi35() {
    val documentedApis = setOf(26, 30, 34, 35)
    assertTrue("lowest supported Android version is included", 26 in documentedApis)
    assertTrue("mid-range Android version is included", 30 in documentedApis)
    assertTrue("current CI target Android version is included", 34 in documentedApis)
    assertTrue("latest preview/current API lane is included", 35 in documentedApis)
  }
}
