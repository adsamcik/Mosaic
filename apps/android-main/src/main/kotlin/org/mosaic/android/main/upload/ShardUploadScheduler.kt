package org.mosaic.android.main.upload

import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkContinuation
import androidx.work.Data
import java.util.concurrent.TimeUnit
import org.mosaic.android.main.crypto.ShardEncryptionScheduler

object ShardUploadScheduler {
  fun buildRequest(
    jobId: String,
    shardId: String,
    tusEndpoint: String,
    metadataSignature: String? = null,
  ): OneTimeWorkRequest =
    OneTimeWorkRequestBuilder<ShardUploadWorker>()
      .setInputData(inputData(shardId, tusEndpoint, metadataSignature))
      .setConstraints(
        Constraints.Builder()
          .setRequiredNetworkType(NetworkType.CONNECTED)
          .build(),
      )
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, INITIAL_BACKOFF_SECONDS, TimeUnit.SECONDS)
      .addTag(ShardEncryptionScheduler.uploadJobTag(jobId))
      .addTag(SHARD_UPLOAD_TAG)
      .build()

  fun thenUpload(encryptionContinuation: WorkContinuation, uploadRequest: OneTimeWorkRequest): WorkContinuation =
    encryptionContinuation.then(uploadRequest)

  const val SHARD_UPLOAD_TAG: String = "shard-upload"
  const val MIN_BACKOFF_SECONDS: Long = 30L
  const val MAX_BACKOFF_MINUTES: Long = 30L

  private const val INITIAL_BACKOFF_SECONDS: Long = MIN_BACKOFF_SECONDS

  private fun inputData(shardId: String, tusEndpoint: String, metadataSignature: String?): Data {
    val builder = Data.Builder()
      .putString(ShardUploadWorker.KEY_SHARD_ID, shardId)
      .putString(ShardUploadWorker.KEY_TUS_ENDPOINT, tusEndpoint)
    if (metadataSignature != null) {
      builder.putString(ShardUploadWorker.KEY_METADATA_SIGNATURE, metadataSignature)
    }
    return builder.build()
  }
}
