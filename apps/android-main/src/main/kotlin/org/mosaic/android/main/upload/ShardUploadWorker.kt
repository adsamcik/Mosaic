package org.mosaic.android.main.upload

import android.content.Context
import android.net.Uri
import androidx.work.CoroutineWorker
import androidx.work.Logger
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import java.io.File
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException
import org.mosaic.android.main.crypto.ShardEncryptionWorker
import org.mosaic.android.main.net.dto.ShardId
import org.mosaic.android.main.net.dto.UploadJobId
import org.mosaic.android.main.staging.AppPrivateStagingManager
import org.mosaic.android.main.staging.StagedFile
import org.mosaic.android.main.tus.ShardManifestEntry
import org.mosaic.android.main.tus.TusClientFactory
import org.mosaic.android.main.tus.TusUploadException
import org.mosaic.android.main.tus.TusUploadSession

class ShardUploadWorker internal constructor(
  appContext: Context,
  workerParams: WorkerParameters,
  private val tusSessionFactory: ShardTusSessionFactory,
  private val stagingCleaner: ShardStagingCleaner,
  private val manifestStore: ShardUploadManifestStore,
  private val warningSink: (String) -> Unit,
) : CoroutineWorker(appContext, workerParams) {
  constructor(
    appContext: Context,
    workerParams: WorkerParameters,
  ) : this(
    appContext,
    workerParams,
    DefaultShardTusSessionFactory(appContext),
    AppPrivateShardStagingCleaner(AppPrivateStagingManager(appContext)),
    FileShardUploadManifestStore(appContext),
    { message -> Logger.get().warning(LOG_TAG, message) },
  )

  override suspend fun doWork(): Result {
    val envelopeUri = inputData.getString(KEY_ENVELOPE_URI) ?: return failure(FAILURE_MISSING_INPUT)
    val expectedSha256 = inputData.getString(KEY_SHA256) ?: return failure(FAILURE_MISSING_INPUT)
    val uploadJobId = inputData.getString(KEY_UPLOAD_JOB_ID) ?: return failure(FAILURE_MISSING_INPUT)
    val shardId = inputData.getString(KEY_SHARD_ID) ?: return failure(FAILURE_MISSING_INPUT)
    val tusEndpoint = inputData.getString(KEY_TUS_ENDPOINT) ?: return failure(FAILURE_MISSING_INPUT)
    val metadataSignature = inputData.getString(KEY_METADATA_SIGNATURE)

    return try {
      val stagedEnvelope = envelopeUri.toStagedFile(shardId)
      val localSha256 = stagedEnvelope.file.sha256Hex()
      if (!localSha256.equals(expectedSha256, ignoreCase = true)) {
        return failure(FAILURE_SHA256_MISMATCH)
      }

      val session = tusSessionFactory.create(tusEndpoint)
      val uploadResult = withContext(Dispatchers.IO) {
        session.upload(
          stagedEnvelope,
          buildMetadata(shardId, expectedSha256, metadataSignature),
          UploadJobId(uploadJobId),
          ShardId(shardId),
        )
      }
      if (!uploadResult.sha256.equals(expectedSha256, ignoreCase = true)) {
        return failure(FAILURE_SHA256_MISMATCH)
      }

      val manifestEntry = ShardUploadManifestEntry(
        shardId = shardId,
        tusLocation = uploadResult.uploadUrl,
        sha256 = uploadResult.sha256,
        sizeBytes = uploadResult.sizeBytes,
        uploadedBytes = uploadResult.uploadedBytes,
      )
      manifestStore.persist(manifestEntry)
      cleanStaging(stagedEnvelope)

      Result.success(
        workDataOf(
          KEY_SHARD_ID to shardId,
          KEY_TUS_LOCATION to uploadResult.uploadUrl,
          KEY_FINAL_SHA256 to uploadResult.sha256,
        ),
      )
    } catch (e: TusUploadException.OffsetMismatch) {
      failure(FAILURE_NON_RETRYABLE_UPLOAD)
    } catch (e: TusUploadException.MissingUploadOffset) {
      failure(FAILURE_NON_RETRYABLE_UPLOAD)
    } catch (e: TusUploadException.HeadFailed) {
      retryForHttpStatus(e.statusCode)
    } catch (e: TusUploadException.PatchFailed) {
      retryForHttpStatus(e.statusCode)
    } catch (e: SerializationException) {
      failure(FAILURE_NON_RETRYABLE_UPLOAD)
    } catch (e: Exception) {
      retryOrExhausted()
    }
  }

  private fun buildMetadata(
    shardId: String,
    expectedSha256: String,
    metadataSignature: String?,
  ): Map<String, String> = buildMap {
    put("shardId", shardId)
    put("expectedSha256", expectedSha256)
    put("content-sha256", expectedSha256.lowercase(Locale.ROOT))
    if (!metadataSignature.isNullOrBlank()) {
      put("metadataSignature", metadataSignature)
    }
  }

  private fun cleanStaging(stagedEnvelope: StagedFile) {
    try {
      stagingCleaner.unstage(stagedEnvelope)
    } catch (e: Exception) {
      warningSink("Shard upload succeeded but staging cleanup failed for ${stagedEnvelope.id}: ${e.message}")
    }
  }

  private fun failure(reason: String): Result = Result.failure(workDataOf(KEY_FAILURE_REASON to reason))

  private fun retryForHttpStatus(statusCode: Int): Result = when (statusCode) {
    408, 429 -> retryOrExhausted()
    in 400..499 -> failure(FAILURE_NON_RETRYABLE_UPLOAD)
    else -> retryOrExhausted()
  }

  private fun retryOrExhausted(): Result = if (runAttemptCount < MAX_RETRIES) {
    Result.retry()
  } else {
    failure(FAILURE_RETRY_EXHAUSTED)
  }

  private fun String.toStagedFile(shardId: String): StagedFile {
    val uri = Uri.parse(this)
    val file = when (uri.scheme) {
      null, "" -> File(this)
      "file" -> File(requireNotNull(uri.path) { "file envelope uri must include a path" })
      else -> error("unsupported envelope uri scheme: ${uri.scheme}")
    }
    require(file.exists()) { "envelope file does not exist" }
    val now = System.currentTimeMillis()
    return StagedFile(
      id = uploadStateId(shardId),
      uri = uri,
      file = file,
      displayName = file.name,
      sizeBytes = file.length(),
      createdAtMs = now,
      lastAccessMs = now,
    )
  }

  companion object {
    const val KEY_ENVELOPE_URI: String = ShardEncryptionWorker.KEY_ENVELOPE_URI
    const val KEY_SHA256: String = ShardEncryptionWorker.KEY_SHA256_HEX
    const val KEY_UPLOAD_JOB_ID: String = "upload_job_id"
    const val KEY_SHARD_ID: String = "shard_id"
    const val KEY_TUS_ENDPOINT: String = "tus_endpoint"
    const val KEY_METADATA_SIGNATURE: String = "metadata_signature"
    const val KEY_TUS_LOCATION: String = "tus_location"
    const val KEY_FINAL_SHA256: String = "final_sha256"
    const val KEY_FAILURE_REASON: String = "failure_reason"

    const val FAILURE_MISSING_INPUT: String = "missing-input"
    const val FAILURE_RETRY_EXHAUSTED: String = "retry-exhausted"
    const val FAILURE_SHA256_MISMATCH: String = "sha256-mismatch"
    const val FAILURE_NON_RETRYABLE_UPLOAD: String = "non-retryable-upload"
    const val MAX_RETRIES: Int = 5

    private const val LOG_TAG = "ShardUploadWorker"
  }
}

fun interface ShardTusSession {
  fun upload(
    staged: StagedFile,
    metadata: Map<String, String>,
    uploadJobId: UploadJobId,
    shardId: ShardId,
  ): ShardManifestEntry
}

interface ShardTusSessionFactory {
  fun create(endpointUrl: String): ShardTusSession
}

internal class DefaultShardTusSessionFactory(
  private val context: Context,
) : ShardTusSessionFactory {
  override fun create(endpointUrl: String): ShardTusSession {
    val client = TusClientFactory.create(endpointUrl, context)
    val session = TusUploadSession(client, AppPrivateStagingManager(context))
    return ShardTusSession { staged, metadata, uploadJobId, shardId ->
      session.upload(staged, metadata, uploadJobId, shardId)
    }
  }
}

interface ShardStagingCleaner {
  fun unstage(staged: StagedFile)
}

internal class AppPrivateShardStagingCleaner(
  private val stagingManager: AppPrivateStagingManager,
) : ShardStagingCleaner {
  override fun unstage(staged: StagedFile) {
    stagingManager.unstage(staged)
  }
}

interface ShardUploadManifestStore {
  fun persist(entry: ShardUploadManifestEntry)
}

internal class FileShardUploadManifestStore(
  context: Context,
) : ShardUploadManifestStore {
  private val manifestDir = File(context.filesDir, "upload-manifests")

  override fun persist(entry: ShardUploadManifestEntry) {
    manifestDir.mkdirs()
    val file = File(manifestDir, "${entry.shardId}.properties")
    file.writeText(
      listOf(
        "shardId=${entry.shardId}",
        "tusLocation=${entry.tusLocation}",
        "sha256=${entry.sha256}",
        "sizeBytes=${entry.sizeBytes}",
        "uploadedBytes=${entry.uploadedBytes}",
      ).joinToString(separator = "\n"),
    )
  }
}

data class ShardUploadManifestEntry(
  val shardId: String,
  val tusLocation: String,
  val sha256: String,
  val sizeBytes: Long,
  val uploadedBytes: Long,
)

private fun uploadStateId(shardId: String): String =
  "upload-${RustContentHasher.sha256Hex(shardId.toByteArray(Charsets.UTF_8))}"

private fun File.sha256Hex(): String = RustContentHasher.sha256Hex(this)
