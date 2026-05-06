package org.mosaic.android.main.upload

import android.content.Context
import androidx.work.ExistingWorkPolicy
import androidx.work.WorkContinuation
import androidx.work.WorkManager
import org.mosaic.android.main.crypto.ShardEncryptionScheduler

object UploadPipelineBuilder {
  fun buildShardPlan(
    jobId: String,
    stagingUri: String,
    epochHandleId: Long,
    tier: Int,
    shardIndex: Int,
    shardId: String,
    tusEndpoint: String,
    metadataSignature: String? = null,
  ): UploadShardPlan {
    val encryptionRequest = ShardEncryptionScheduler.buildRequest(
      jobId = jobId,
      stagingUri = stagingUri,
      epochHandleId = epochHandleId,
      tier = tier,
      shardIndex = shardIndex,
    )
    val uploadRequest = ShardUploadScheduler.buildRequest(
      jobId = jobId,
      shardId = shardId,
      tusEndpoint = tusEndpoint,
      metadataSignature = metadataSignature,
    )
    return UploadShardPlan(
      uniqueWorkName = uniqueShardWorkName(jobId, shardId),
      encryptionRequest = encryptionRequest,
      uploadRequest = uploadRequest,
      cancellationTags = setOf(
        ShardEncryptionScheduler.uploadJobTag(jobId),
        ShardEncryptionScheduler.SHARD_ENCRYPT_TAG,
        ShardUploadScheduler.SHARD_UPLOAD_TAG,
      ),
    )
  }

  fun enqueueShard(
    context: Context,
    plan: UploadShardPlan,
  ): WorkContinuation =
    WorkManager.getInstance(context.applicationContext)
      .beginUniqueWork(plan.uniqueWorkName, ExistingWorkPolicy.KEEP, plan.encryptionRequest)
      .then(plan.uploadRequest)

  fun uniqueShardWorkName(jobId: String, shardId: String): String = "upload-job-$jobId-shard-$shardId"
}

data class UploadShardPlan(
  val uniqueWorkName: String,
  val encryptionRequest: androidx.work.OneTimeWorkRequest,
  val uploadRequest: androidx.work.OneTimeWorkRequest,
  val cancellationTags: Set<String>,
)
