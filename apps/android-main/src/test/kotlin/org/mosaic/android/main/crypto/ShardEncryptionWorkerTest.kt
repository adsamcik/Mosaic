package org.mosaic.android.main.crypto

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.work.Data
import androidx.work.ListenableWorker
import androidx.work.NetworkType
import androidx.work.WorkerFactory
import androidx.work.WorkerParameters
import androidx.work.testing.TestListenableWorkerBuilder
import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.mosaic.android.main.upload.ContentHashDedup
import org.mosaic.android.main.upload.DuplicateContent
import org.mosaic.android.main.upload.NoOpContentHashDedup

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ShardEncryptionWorkerTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()
  private val envelopeDir = File(context.filesDir, "encrypted-shards")

  @After
  fun tearDown() {
    File(context.filesDir, "shard-worker-test").deleteRecursively()
    envelopeDir.deleteRecursively()
  }

  @Test
  fun happyPathEncryptsSmallShardAndReturnsEnvelopeUriAndSha256() = runBlocking {
    val staging = stageBytes("small-shard".toByteArray())
    val crypto = RecordingCryptoEngine()
    val worker = workerFor(staging, crypto = crypto)

    val result = worker.doWork()

    assertTrue(result is ListenableWorker.Result.Success)
    val output = (result as ListenableWorker.Result.Success).outputData
    val envelopeUri = output.getString(ShardEncryptionWorker.KEY_ENVELOPE_URI)!!
    val envelope = File(requireNotNull(android.net.Uri.parse(envelopeUri).path)).readBytes()
    assertArrayEquals(crypto.smallEnvelope, envelope)
    assertEquals(sha256Hex(envelope), output.getString(ShardEncryptionWorker.KEY_SHA256_HEX))
    assertEquals(sha256Hex("small-shard".toByteArray()), output.getString(ShardEncryptionWorker.KEY_CONTENT_HASH_HEX))
    assertEquals(1, crypto.smallCalls)
    assertEquals(0, crypto.streamingCalls)
  }

  @Test
  fun duplicateContentReturnsFailureBeforeEncryption() = runBlocking {
    val plaintext = "duplicate-shard".toByteArray()
    val staging = stageBytes(plaintext)
    val crypto = RecordingCryptoEngine()
    val dedup = RecordingContentHashDedup(
      duplicate = DuplicateContent(photoId = "photo-existing", dateAdded = 1_700_000_000_000L),
    )
    val worker = workerFor(
      staging,
      albumId = "album-1",
      photoId = "photo-new",
      crypto = crypto,
      contentHashDedup = dedup,
    )

    val result = worker.doWork()

    assertTrue(result is ListenableWorker.Result.Failure)
    val output = (result as ListenableWorker.Result.Failure).outputData
    assertEquals(ShardEncryptionWorker.FAILURE_DUPLICATE, output.getString(ShardEncryptionWorker.KEY_FAILURE_REASON))
    assertEquals("photo-existing", output.getString(ShardEncryptionWorker.KEY_DUPLICATE_PHOTO_ID))
    assertEquals(sha256Hex(plaintext), output.getString(ShardEncryptionWorker.KEY_CONTENT_HASH_HEX))
    assertEquals(0, crypto.smallCalls + crypto.streamingCalls)
    assertEquals(0, dedup.recorded.size)
  }

  @Test
  fun recordsContentHashAfterSuccessfulEncryptionWhenAlbumAndPhotoAreProvided() = runBlocking {
    val plaintext = "record-me".toByteArray()
    val staging = stageBytes(plaintext)
    val dedup = RecordingContentHashDedup()
    val worker = workerFor(
      staging,
      albumId = "album-1",
      photoId = "photo-new",
      contentHashDedup = dedup,
    )

    val result = worker.doWork()

    assertTrue(result is ListenableWorker.Result.Success)
    assertEquals(listOf(Triple("album-1", sha256Hex(plaintext), "photo-new")), dedup.recorded)
  }

  @Test
  fun largeShardUsesStreamingPath() = runBlocking {
    val plaintext = ByteArray(ShardEncryptionWorker.STREAMING_THRESHOLD_BYTES + 1) { (it % 251).toByte() }
    val staging = stageBytes(plaintext)
    val crypto = RecordingCryptoEngine()
    val worker = workerFor(staging, crypto = crypto)

    val result = worker.doWork()

    assertTrue(result is ListenableWorker.Result.Success)
    val output = (result as ListenableWorker.Result.Success).outputData
    assertEquals(0, crypto.smallCalls)
    assertEquals(1, crypto.streamingCalls)
    assertEquals(plaintext.size.toLong(), crypto.lastStreamingLength)
    assertArrayEquals(plaintext, crypto.lastStreamingPlaintext)
    assertEquals(sha256Hex(plaintext), output.getString(ShardEncryptionWorker.KEY_CONTENT_HASH_HEX))
  }

  @Test
  fun invalidEpochHandleFailsWithoutRetry() = runBlocking {
    val staging = stageBytes("invalid".toByteArray())
    val crypto = RecordingCryptoEngine()
    val worker = workerFor(staging, epochHandleId = 0L, crypto = crypto)

    val result = worker.doWork()

    assertTrue(result is ListenableWorker.Result.Failure)
    assertEquals(0, crypto.smallCalls + crypto.streamingCalls)
  }

  @Test
  fun cryptoExceptionRetriesBeforeMaxRetries() = runBlocking {
    val staging = stageBytes("retry".toByteArray())
    val worker = workerFor(staging, runAttemptCount = ShardEncryptionWorker.MAX_RETRIES - 1, crypto = ThrowingCryptoEngine)

    val result = worker.doWork()

    assertTrue(result is ListenableWorker.Result.Retry)
  }

  @Test
  fun cryptoExceptionFailsAtMaxRetries() = runBlocking {
    val staging = stageBytes("fail".toByteArray())
    val worker = workerFor(staging, runAttemptCount = ShardEncryptionWorker.MAX_RETRIES, crypto = ThrowingCryptoEngine)

    val result = worker.doWork()

    assertTrue(result is ListenableWorker.Result.Failure)
  }

  @Test
  fun sameInputsReturnByteIdenticalEnvelopeAcrossRuns() = runBlocking {
    val staging = stageBytes("idempotent".toByteArray())
    val crypto = RecordingCryptoEngine()
    val first = workerFor(staging, crypto = crypto).doWork() as ListenableWorker.Result.Success
    val firstEnvelope = File(requireNotNull(android.net.Uri.parse(first.outputData.getString(ShardEncryptionWorker.KEY_ENVELOPE_URI)).path)).readBytes()

    crypto.smallEnvelope = "different-if-reencrypted".toByteArray()
    val second = workerFor(staging, crypto = crypto).doWork() as ListenableWorker.Result.Success
    val secondEnvelope = File(requireNotNull(android.net.Uri.parse(second.outputData.getString(ShardEncryptionWorker.KEY_ENVELOPE_URI)).path)).readBytes()

    assertArrayEquals(firstEnvelope, secondEnvelope)
    assertEquals("second run must reuse the persisted deterministic output", 1, crypto.smallCalls)
  }

  @Test
  fun schedulerBuildsLocalEncryptionWorkWithUploadJobTags() {
    val request = ShardEncryptionScheduler.buildRequest(
      jobId = "job-123",
      stagingUri = "file:///staged.bin",
      epochHandleId = 42L,
      tier = 2,
      shardIndex = 9,
    )

    assertTrue(request.tags.contains("upload-job-job-123"))
    assertTrue(request.tags.contains(ShardEncryptionScheduler.SHARD_ENCRYPT_TAG))
    assertEquals(NetworkType.NOT_REQUIRED, request.workSpec.constraints.requiredNetworkType)
    assertEquals("file:///staged.bin", request.workSpec.input.getString(ShardEncryptionWorker.KEY_STAGING_URI))
    assertEquals(42L, request.workSpec.input.getLong(ShardEncryptionWorker.KEY_EPOCH_HANDLE_ID, 0L))
    assertEquals(2, request.workSpec.input.getInt(ShardEncryptionWorker.KEY_TIER, 0))
    assertEquals(9, request.workSpec.input.getInt(ShardEncryptionWorker.KEY_SHARD_INDEX, -1))
  }

  private fun workerFor(
    staging: File,
    epochHandleId: Long = 42L,
    tier: Int = 1,
    shardIndex: Int = 7,
    albumId: String? = null,
    photoId: String? = null,
    runAttemptCount: Int = 0,
    crypto: ShardCryptoEngine = RecordingCryptoEngine(),
    contentHashDedup: ContentHashDedup = NoOpContentHashDedup,
  ): ShardEncryptionWorker {
    val inputBuilder = Data.Builder()
      .putString(ShardEncryptionWorker.KEY_STAGING_URI, staging.toURI().toString())
      .putLong(ShardEncryptionWorker.KEY_EPOCH_HANDLE_ID, epochHandleId)
      .putInt(ShardEncryptionWorker.KEY_TIER, tier)
      .putInt(ShardEncryptionWorker.KEY_SHARD_INDEX, shardIndex)
    if (albumId != null) inputBuilder.putString(ShardEncryptionWorker.KEY_ALBUM_ID, albumId)
    if (photoId != null) inputBuilder.putString(ShardEncryptionWorker.KEY_PHOTO_ID, photoId)
    val input = inputBuilder.build()
    return TestListenableWorkerBuilder<ShardEncryptionWorker>(context)
      .setInputData(input)
      .setRunAttemptCount(runAttemptCount)
      .setWorkerFactory(object : WorkerFactory() {
        override fun createWorker(
          appContext: Context,
          workerClassName: String,
          workerParameters: WorkerParameters,
        ): ListenableWorker = ShardEncryptionWorker(
          appContext,
          workerParameters,
          crypto,
          ShardEnvelopeStore(appContext),
          contentHashDedup,
        )
      })
      .build()
  }

  private fun stageBytes(bytes: ByteArray): File {
    val dir = File(context.filesDir, "shard-worker-test").also { it.mkdirs() }
    return File(dir, "staged-${System.nanoTime()}.bin").apply { writeBytes(bytes) }
  }

  private fun sha256Hex(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

  private class RecordingCryptoEngine : ShardCryptoEngine {
    var smallEnvelope: ByteArray = "small-envelope".toByteArray()
    var streamingEnvelope: ByteArray = "streaming-envelope".toByteArray()
    var smallCalls: Int = 0
    var streamingCalls: Int = 0

    override fun encryptShardWithEpochHandle(
      epochHandleId: Long,
      plaintext: ByteArray,
      tier: Int,
      shardIndex: Int,
    ): ByteArray {
      smallCalls++
      return smallEnvelope.copyOf()
    }

    override fun encryptStreamingShard(
      epochHandleId: Long,
      plaintext: InputStream,
      plaintextLength: Long,
      tier: Int,
      shardIndex: Int,
    ): ByteArray {
      streamingCalls++
      lastStreamingLength = plaintextLength
      lastStreamingPlaintext = plaintext.readBytes()
      return streamingEnvelope.copyOf()
    }

    var lastStreamingLength: Long = -1
    var lastStreamingPlaintext: ByteArray = ByteArray(0)
  }

  private object ThrowingCryptoEngine : ShardCryptoEngine {
    override fun encryptShardWithEpochHandle(epochHandleId: Long, plaintext: ByteArray, tier: Int, shardIndex: Int): ByteArray {
      error("boom")
    }

    override fun encryptStreamingShard(
      epochHandleId: Long,
      plaintext: InputStream,
      plaintextLength: Long,
      tier: Int,
      shardIndex: Int,
    ): ByteArray {
      error("boom")
    }
  }

  private class RecordingContentHashDedup(
    private val duplicate: DuplicateContent? = null,
  ) : ContentHashDedup {
    val recorded = mutableListOf<Triple<String, String, String>>()

    override fun lookup(albumId: String, contentHash: String): DuplicateContent? = duplicate

    override fun record(albumId: String, contentHash: String, photoId: String) {
      recorded += Triple(albumId, contentHash, photoId)
    }

    override fun clear(albumId: String): Int = 0
  }
}
