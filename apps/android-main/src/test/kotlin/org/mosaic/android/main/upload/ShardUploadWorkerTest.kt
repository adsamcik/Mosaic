package org.mosaic.android.main.upload

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.work.Data
import androidx.work.ListenableWorker
import androidx.work.NetworkType
import androidx.work.WorkerFactory
import androidx.work.WorkerParameters
import androidx.work.testing.TestListenableWorkerBuilder
import java.io.File
import java.security.MessageDigest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.mosaic.android.main.staging.AppPrivateStagingManager
import org.mosaic.android.main.staging.StagedFile
import org.mosaic.android.main.tus.ShardManifestEntry
import org.mosaic.android.main.tus.TusClientFactory
import org.mosaic.android.main.tus.TusUploadSession
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ShardUploadWorkerTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()
  private val stagingManager = AppPrivateStagingManager(context)
  private val server = MockWebServer()

  @After
  fun tearDown() {
    server.shutdown()
    File(context.filesDir, "encrypted-shards").deleteRecursively()
    File(context.filesDir, "staging").deleteRecursively()
    File(context.filesDir, "upload-manifests").deleteRecursively()
  }

  @Test
  fun happyPathUploadsEnvelopeCleansStagingAndReturnsManifestEntry() {
    server.enqueue(MockResponse().setResponseCode(201).setHeader("Location", "/uploads/shard-1"))
    server.enqueue(MockResponse().setResponseCode(204).setHeader("Upload-Offset", "14"))
    server.start()
    val envelope = envelopeFile("encrypted-body")
    val sha256 = sha256Hex(envelope.readBytes())
    val worker = workerFor(envelope, sha256, shardId = "shard-1", tusEndpoint = server.url("/files").toString())

    val result = worker.doWorkBlocking()

    assertTrue(result is ListenableWorker.Result.Success)
    val output = (result as ListenableWorker.Result.Success).outputData
    assertEquals("shard-1", output.getString(ShardUploadWorker.KEY_SHARD_ID))
    assertEquals(server.url("/uploads/shard-1").toString(), output.getString(ShardUploadWorker.KEY_TUS_LOCATION))
    assertEquals(sha256, output.getString(ShardUploadWorker.KEY_FINAL_SHA256))
    assertFalse(envelope.exists())
    assertManifestPersisted("shard-1", sha256, server.url("/uploads/shard-1").toString())

    val post = server.takeRequest()
    assertEquals("POST", post.method)
    val metadata = requireNotNull(post.getHeader("Upload-Metadata"))
    assertTrue(metadata.contains("shardId "))
    assertTrue(metadata.contains("expectedSha256 "))
    assertTrue(metadata.contains("metadataSignature "))
    val patch = server.takeRequest()
    assertEquals("PATCH", patch.method)
    assertEquals("encrypted-body", patch.body.readUtf8())
  }

  @Test
  fun transientNetworkErrorRetriesBeforeMaxRetries() {
    server.enqueue(MockResponse().setResponseCode(503))
    server.start()
    val envelope = envelopeFile("retry")
    val worker = workerFor(
      envelope = envelope,
      expectedSha256 = sha256Hex(envelope.readBytes()),
      shardId = "retry-shard",
      tusEndpoint = server.url("/files").toString(),
      runAttemptCount = ShardUploadWorker.MAX_RETRIES - 1,
    )

    val result = worker.doWorkBlocking()

    assertTrue(result is ListenableWorker.Result.Retry)
    assertTrue(envelope.exists())
  }

  @Test
  fun maxRetriesExhaustedFailsWithReason() {
    server.enqueue(MockResponse().setResponseCode(503))
    server.start()
    val envelope = envelopeFile("give-up")
    val worker = workerFor(
      envelope = envelope,
      expectedSha256 = sha256Hex(envelope.readBytes()),
      shardId = "failed-shard",
      tusEndpoint = server.url("/files").toString(),
      runAttemptCount = ShardUploadWorker.MAX_RETRIES,
    )

    val result = worker.doWorkBlocking()

    assertTrue(result is ListenableWorker.Result.Failure)
    val output = (result as ListenableWorker.Result.Failure).outputData
    assertEquals(ShardUploadWorker.FAILURE_RETRY_EXHAUSTED, output.getString(ShardUploadWorker.KEY_FAILURE_REASON))
    assertTrue(envelope.exists())
  }

  @Test
  fun sha256MismatchFailsWithoutRetry() {
    val envelope = envelopeFile("mismatch")
    val expectedSha256 = sha256Hex(envelope.readBytes())
    val worker = workerFor(
      envelope = envelope,
      expectedSha256 = expectedSha256,
      shardId = "mismatch-shard",
      tusEndpoint = "https://uploads.invalid/files",
      tusSessionFactory = FixedTusSessionFactory(
        ShardManifestEntry(
          uploadUrl = "https://uploads.invalid/uploads/mismatch-shard",
          sizeBytes = envelope.length(),
          uploadedBytes = envelope.length(),
          sha256 = "1".repeat(64),
        ),
      ),
    )

    val result = worker.doWorkBlocking()

    assertTrue(result is ListenableWorker.Result.Failure)
    val output = (result as ListenableWorker.Result.Failure).outputData
    assertEquals(ShardUploadWorker.FAILURE_SHA256_MISMATCH, output.getString(ShardUploadWorker.KEY_FAILURE_REASON))
    assertTrue(envelope.exists())
  }

  @Test
  fun stagingCleanupFailureLogsWarningButSucceeds() {
    val envelope = envelopeFile("cleanup-warning")
    val sha256 = sha256Hex(envelope.readBytes())
    val warnings = mutableListOf<String>()
    val worker = workerFor(
      envelope = envelope,
      expectedSha256 = sha256,
      shardId = "cleanup-shard",
      tusEndpoint = "https://uploads.invalid/files",
      tusSessionFactory = FixedTusSessionFactory(
        ShardManifestEntry(
          uploadUrl = "https://uploads.invalid/uploads/cleanup-shard",
          sizeBytes = envelope.length(),
          uploadedBytes = envelope.length(),
          sha256 = sha256,
        ),
      ),
      stagingCleaner = ThrowingStagingCleaner,
      warningSink = warnings::add,
    )

    val result = worker.doWorkBlocking()

    assertTrue(result is ListenableWorker.Result.Success)
    assertEquals(1, warnings.size)
    assertTrue(envelope.exists())
    assertManifestPersisted("cleanup-shard", sha256, "https://uploads.invalid/uploads/cleanup-shard")
  }

  @Test
  fun schedulerBuildsConnectedShardUploadRequestWithBackoffAndTags() {
    val request = ShardUploadScheduler.buildRequest(
      jobId = "job-123",
      shardId = "shard-9",
      tusEndpoint = "https://uploads.example.test/files",
      metadataSignature = "signature-abc",
    )

    assertTrue(request.tags.contains("upload-job-job-123"))
    assertTrue(request.tags.contains(ShardUploadScheduler.SHARD_UPLOAD_TAG))
    assertEquals(NetworkType.CONNECTED, request.workSpec.constraints.requiredNetworkType)
    assertEquals("shard-9", request.workSpec.input.getString(ShardUploadWorker.KEY_SHARD_ID))
    assertEquals("https://uploads.example.test/files", request.workSpec.input.getString(ShardUploadWorker.KEY_TUS_ENDPOINT))
    assertEquals("signature-abc", request.workSpec.input.getString(ShardUploadWorker.KEY_METADATA_SIGNATURE))
    assertEquals(30_000L, request.workSpec.backoffDelayDuration)
  }

  @Test
  fun uploadPipelineBuilderComposesEncryptionThenUploadWithCancellationTags() {
    val plan = UploadPipelineBuilder.buildShardPlan(
      jobId = "job-456",
      stagingUri = "mosaic-staged://original",
      epochHandleId = 42L,
      tier = 2,
      shardIndex = 3,
      shardId = "shard-3",
      tusEndpoint = "https://uploads.example.test/files",
    )

    assertEquals("upload-job-job-456-shard-shard-3", plan.uniqueWorkName)
    assertTrue(plan.encryptionRequest.tags.contains("upload-job-job-456"))
    assertTrue(plan.uploadRequest.tags.contains("upload-job-job-456"))
    assertTrue(plan.cancellationTags.contains("upload-job-job-456"))
    assertTrue(plan.cancellationTags.contains(ShardUploadScheduler.SHARD_UPLOAD_TAG))
  }

  private fun workerFor(
    envelope: File,
    expectedSha256: String,
    shardId: String,
    tusEndpoint: String,
    runAttemptCount: Int = 0,
    metadataSignature: String = "signed-metadata",
    tusSessionFactory: ShardTusSessionFactory = RealTestTusSessionFactory(stagingManager),
    stagingCleaner: ShardStagingCleaner = AppPrivateShardStagingCleaner(stagingManager),
    warningSink: (String) -> Unit = {},
  ): ShardUploadWorker {
    val input = Data.Builder()
      .putString(ShardUploadWorker.KEY_ENVELOPE_URI, envelope.toURI().toString())
      .putString(ShardUploadWorker.KEY_SHA256, expectedSha256)
      .putString(ShardUploadWorker.KEY_SHARD_ID, shardId)
      .putString(ShardUploadWorker.KEY_TUS_ENDPOINT, tusEndpoint)
      .putString(ShardUploadWorker.KEY_METADATA_SIGNATURE, metadataSignature)
      .build()
    return TestListenableWorkerBuilder<ShardUploadWorker>(context)
      .setInputData(input)
      .setRunAttemptCount(runAttemptCount)
      .setWorkerFactory(object : WorkerFactory() {
        override fun createWorker(
          appContext: Context,
          workerClassName: String,
          workerParameters: WorkerParameters,
        ): ListenableWorker = ShardUploadWorker(
          appContext,
          workerParameters,
          tusSessionFactory,
          stagingCleaner,
          FileShardUploadManifestStore(appContext),
          warningSink,
        )
      })
      .build()
  }

  private fun ListenableWorker.doWorkBlocking(): ListenableWorker.Result =
    kotlinx.coroutines.runBlocking { (this@doWorkBlocking as ShardUploadWorker).doWork() }

  private fun envelopeFile(value: String): File {
    val dir = File(context.filesDir, "encrypted-shards").also { it.mkdirs() }
    return File(dir, "envelope-${System.nanoTime()}.bin").apply { writeText(value) }
  }

  private fun assertManifestPersisted(shardId: String, sha256: String, tusLocation: String) {
    val file = File(context.filesDir, "upload-manifests/$shardId.properties")
    assertTrue(file.exists())
    val text = file.readText()
    assertTrue(text.contains("shardId=$shardId"))
    assertTrue(text.contains("sha256=$sha256"))
    assertTrue(text.contains("tusLocation=$tusLocation"))
  }

  private fun sha256Hex(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

  private class RealTestTusSessionFactory(
    private val stagingManager: AppPrivateStagingManager,
  ) : ShardTusSessionFactory {
    override fun create(endpointUrl: String): ShardTusSession {
      val session = TusUploadSession(TusClientFactory.create(serverUrl(endpointUrl), OkHttpClient()), stagingManager, chunkSizeBytes = 64)
      return ShardTusSession { staged, metadata -> session.upload(staged, metadata) }
    }

    private fun serverUrl(endpointUrl: String): java.net.URL = java.net.URL(endpointUrl)
  }

  private class FixedTusSessionFactory(
    private val manifestEntry: ShardManifestEntry,
  ) : ShardTusSessionFactory {
    override fun create(endpointUrl: String): ShardTusSession = ShardTusSession { _, _ -> manifestEntry }
  }

  private object ThrowingStagingCleaner : ShardStagingCleaner {
    override fun unstage(staged: StagedFile) {
      error("cleanup failed")
    }
  }
}
