package org.mosaic.android.main.upload

import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
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
    initialDelayMs: Long = 0L,
  ): OneTimeWorkRequest {
    val coercedDelayMs = initialDelayMs.coerceIn(0L, MAX_BACKOFF_MS)
    val builder = OneTimeWorkRequestBuilder<ShardUploadWorker>()
      .setInputData(inputData(jobId, shardId, tusEndpoint, metadataSignature))
      .setConstraints(
        Constraints.Builder()
          .setRequiredNetworkType(NetworkType.CONNECTED)
          .build(),
      )
      .setInitialDelay(coercedDelayMs, TimeUnit.MILLISECONDS)
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, INITIAL_BACKOFF_SECONDS, TimeUnit.SECONDS)
      .addTag(ShardEncryptionScheduler.uploadJobTag(jobId))
      .addTag(SHARD_UPLOAD_TAG)
    // setExpedited is incompatible with setInitialDelay (WorkRequest.Builder
    // throws "Expedited jobs cannot be delayed"). The expedited path matters
    // for first-attempt uploads that must bypass Doze maintenance windows; a
    // caller-supplied retry delay already means the job is intentionally
    // deferred, so non-expedited scheduling is the correct behavior there.
    if (coercedDelayMs == 0L) {
      builder.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
    }
    return builder.build()
  }

  fun thenUpload(encryptionContinuation: WorkContinuation, uploadRequest: OneTimeWorkRequest): WorkContinuation =
    encryptionContinuation.then(uploadRequest)

  const val SHARD_UPLOAD_TAG: String = "shard-upload"
  const val MIN_BACKOFF_SECONDS: Long = 30L
  const val MAX_BACKOFF_MINUTES: Long = 30L
  const val MAX_BACKOFF_MS: Long = MAX_BACKOFF_MINUTES * 60_000L

  private const val INITIAL_BACKOFF_SECONDS: Long = MIN_BACKOFF_SECONDS

  private fun inputData(jobId: String, shardId: String, tusEndpoint: String, metadataSignature: String?): Data {
    val builder = Data.Builder()
      .putString(ShardUploadWorker.KEY_UPLOAD_JOB_ID, jobId)
      .putString(ShardUploadWorker.KEY_SHARD_ID, shardId)
      .putString(ShardUploadWorker.KEY_TUS_ENDPOINT, tusEndpoint)
    if (metadataSignature != null) {
      builder.putString(ShardUploadWorker.KEY_METADATA_SIGNATURE, metadataSignature)
    }
    return builder.build()
  }
}
