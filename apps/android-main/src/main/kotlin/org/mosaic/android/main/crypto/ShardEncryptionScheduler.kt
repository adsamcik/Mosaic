package org.mosaic.android.main.crypto

import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import java.util.concurrent.TimeUnit

object ShardEncryptionScheduler {
  /**
   * `epochHandleId` is the bit-pattern carrier for a Rust `u64` handle.
   * WorkManager `Data` cannot store `ULong`, so high-bit handles are
   * intentionally transported as negative `Long` values and reinterpreted
   * with `toULong()` by the crypto engine.
   */
  fun buildRequest(
    jobId: String,
    stagingUri: String,
    epochHandleId: Long,
    tier: Int,
    shardIndex: Int,
    albumContentHashHex: String,
    albumId: String? = null,
    photoId: String? = null,
  ): OneTimeWorkRequest =
    OneTimeWorkRequestBuilder<ShardEncryptionWorker>()
      .setInputData(
        Data.Builder()
          .putString(ShardEncryptionWorker.KEY_STAGING_URI, stagingUri)
          .putLong(ShardEncryptionWorker.KEY_EPOCH_HANDLE_ID, epochHandleId)
          .putInt(ShardEncryptionWorker.KEY_TIER, tier)
          .putInt(ShardEncryptionWorker.KEY_SHARD_INDEX, shardIndex)
          .putString(ShardEncryptionWorker.KEY_ALBUM_CONTENT_HASH_HEX, albumContentHashHex)
          .apply {
            if (albumId != null) putString(ShardEncryptionWorker.KEY_ALBUM_ID, albumId)
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
      .addTag(uploadJobTag(jobId))
      .addTag(SHARD_ENCRYPT_TAG)
      .build()

  fun uploadJobTag(jobId: String): String = "upload-job-$jobId"

  const val SHARD_ENCRYPT_TAG: String = "shard-encrypt"

  private const val INITIAL_BACKOFF_SECONDS: Long = 30L
}
