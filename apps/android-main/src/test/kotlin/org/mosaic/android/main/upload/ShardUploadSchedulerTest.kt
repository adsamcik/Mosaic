package org.mosaic.android.main.upload

import androidx.work.NetworkType
import androidx.work.OutOfQuotaPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Unit tests for [ShardUploadScheduler] (v1.0.2 network-type-unmetered).
 *
 * The scheduler's responsibility is the WorkRequest constraints — particularly
 * the network-type policy that decides whether new shard uploads are allowed
 * to run over a metered (cellular) connection. The default must be UNMETERED
 * so the app never silently burns a user's cellular data quota on potentially
 * multi-gigabyte photo uploads.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ShardUploadSchedulerTest {
  @Test
  fun buildRequestRequiresUnmeteredNetwork() {
    val request = ShardUploadScheduler.buildRequest(
      jobId = "job-1",
      shardId = "shard-1",
      tusEndpoint = "https://example.invalid/files",
    )

    assertEquals(NetworkType.UNMETERED, request.workSpec.constraints.requiredNetworkType)
  }

  @Test
  fun buildRequestWithInitialDelayKeepsUnmeteredConstraint() {
    val request = ShardUploadScheduler.buildRequest(
      jobId = "job-2",
      shardId = "shard-2",
      tusEndpoint = "https://example.invalid/files",
      initialDelayMs = 60_000L,
    )

    assertEquals(NetworkType.UNMETERED, request.workSpec.constraints.requiredNetworkType)
    assertEquals(60_000L, request.workSpec.initialDelay)
  }

  @Test
  fun buildRequestTagsAreApplied() {
    val request = ShardUploadScheduler.buildRequest(
      jobId = "job-3",
      shardId = "shard-3",
      tusEndpoint = "https://example.invalid/files",
    )

    assertTrue(request.tags.contains(ShardUploadScheduler.SHARD_UPLOAD_TAG))
  }

  @Test
  fun buildRequestZeroDelaySetsExpedited() {
    val request = ShardUploadScheduler.buildRequest(
      jobId = "job-4",
      shardId = "shard-4",
      tusEndpoint = "https://example.invalid/files",
      initialDelayMs = 0L,
    )

    // Expedited jobs use RUN_AS_NON_EXPEDITED_WORK_REQUEST out-of-quota policy
    assertEquals(
      OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST,
      request.workSpec.outOfQuotaPolicy,
    )
  }
}
