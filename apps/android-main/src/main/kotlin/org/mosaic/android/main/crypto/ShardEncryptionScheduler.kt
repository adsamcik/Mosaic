package org.mosaic.android.main.crypto

import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.workDataOf
import java.util.concurrent.TimeUnit

object ShardEncryptionScheduler {
  fun buildRequest(
    jobId: String,
    stagingUri: String,
    epochHandleId: Long,
    tier: Int,
    shardIndex: Int,
  ): OneTimeWorkRequest =
    OneTimeWorkRequestBuilder<ShardEncryptionWorker>()
      .setInputData(
        workDataOf(
          ShardEncryptionWorker.KEY_STAGING_URI to stagingUri,
          ShardEncryptionWorker.KEY_EPOCH_HANDLE_ID to epochHandleId,
          ShardEncryptionWorker.KEY_TIER to tier,
          ShardEncryptionWorker.KEY_SHARD_INDEX to shardIndex,
        ),
      )
      .setConstraints(
        Constraints.Builder()
          .setRequiredNetworkType(NetworkType.NOT_REQUIRED)
          .build(),
      )
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, INITIAL_BACKOFF_SECONDS, TimeUnit.SECONDS)
      .addTag(uploadJobTag(jobId))
      .addTag(SHARD_ENCRYPT_TAG)
      .build()

  fun uploadJobTag(jobId: String): String = "upload-job-$jobId"

  const val SHARD_ENCRYPT_TAG: String = "shard-encrypt"

  private const val INITIAL_BACKOFF_SECONDS: Long = 30L
}
