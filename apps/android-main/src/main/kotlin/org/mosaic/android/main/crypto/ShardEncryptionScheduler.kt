package org.mosaic.android.main.crypto

import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import java.util.concurrent.TimeUnit

object ShardEncryptionScheduler {
  fun buildRequest(
    jobId: String,
    stagingUri: String,
    albumId: String,
    epochId: Int,
    tier: Int,
    shardIndex: Int,
    albumContentHashHex: String,
    photoId: String? = null,
  ): OneTimeWorkRequest =
    OneTimeWorkRequestBuilder<ShardEncryptionWorker>()
      .setInputData(
        Data.Builder()
          .putString(ShardEncryptionWorker.KEY_STAGING_URI, stagingUri)
          .putString(ShardEncryptionWorker.KEY_ALBUM_ID, albumId)
          .putInt(ShardEncryptionWorker.KEY_EPOCH_ID, epochId)
          .putInt(ShardEncryptionWorker.KEY_TIER, tier)
          .putInt(ShardEncryptionWorker.KEY_SHARD_INDEX, shardIndex)
          .putString(ShardEncryptionWorker.KEY_ALBUM_CONTENT_HASH_HEX, albumContentHashHex)
          .apply {
            if (photoId != null) putString(ShardEncryptionWorker.KEY_PHOTO_ID, photoId)
          }
          .build(),
      )
      .setConstraints(
        Constraints.Builder()
          .setRequiredNetworkType(NetworkType.NOT_REQUIRED)
          .build(),
      )
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, INITIAL_BACKOFF_SECONDS, TimeUnit.SECONDS)
      .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
      .addTag(uploadJobTag(jobId))
      .addTag(SHARD_ENCRYPT_TAG)
      .build()

  fun uploadJobTag(jobId: String): String = "upload-job-$jobId"

  const val SHARD_ENCRYPT_TAG: String = "shard-encrypt"

  private const val INITIAL_BACKOFF_SECONDS: Long = 30L
}
