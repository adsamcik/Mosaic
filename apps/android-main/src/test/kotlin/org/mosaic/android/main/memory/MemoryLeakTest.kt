package org.mosaic.android.main.memory

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.work.Data
import androidx.work.ListenableWorker
import androidx.work.WorkerFactory
import androidx.work.WorkerParameters
import androidx.work.testing.TestListenableWorkerBuilder
import java.io.File
import java.io.InputStream
import java.lang.ref.WeakReference
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.mosaic.android.main.crypto.ShardCryptoEngine
import org.mosaic.android.main.crypto.ShardEncryptionWorker
import org.mosaic.android.main.crypto.ShardEnvelopeStore
import org.mosaic.android.main.crypto.EpochHandleResolver
import org.mosaic.android.main.crypto.OpenedEpochHandle
import org.mosaic.android.main.media.BitmapTierEncoder
import org.mosaic.android.main.media.CanonicalTierLayout
import org.mosaic.android.main.media.TierDimensions
import org.mosaic.android.main.media.TierLayoutProvider
import org.mosaic.android.main.video.DecodedVideoFrame
import org.mosaic.android.main.video.VideoFrameDecoder
import org.mosaic.android.main.video.VideoFrameExtractor
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MemoryLeakTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()
  private val envelopeDir = File(context.filesDir, "encrypted-shards")
  private val stagingDir = File(context.filesDir, "memory-leak-test")

  @After
  fun tearDown() {
    stagingDir.deleteRecursively()
    envelopeDir.deleteRecursively()
  }

  @Test
  fun repeatedVideoFrameExtractionRecyclesDecodedAndRotatedBitmaps() {
    val frameRefs = mutableListOf<WeakReference<Bitmap>>()
    val decoder = object : VideoFrameDecoder {
      override fun decode(sourceUri: Uri): DecodedVideoFrame {
        val bitmap = Bitmap.createBitmap(24, 12, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.CYAN) }
        frameRefs += WeakReference(bitmap)
        return DecodedVideoFrame(bitmap = bitmap, orientationDegrees = 90)
      }
    }
    val extractor = VideoFrameExtractor(
      context = context,
      encoder = BitmapTierEncoder(testLayoutProvider()),
      frameDecoder = decoder,
    )

    repeat(10) { iteration ->
      extractor.extract(Uri.parse("file:///video-$iteration.mp4"))
      assertTrue("decoded frame $iteration should be recycled", frameRefs.last().get()?.isRecycled == true)
    }

    System.gc()
    assertTrue(frameRefs.all { ref -> ref.get() == null || ref.get()?.isRecycled == true })
  }

  @Test
  fun repeatedShardEncryptionWorkerInvocationsDoNotAccumulateOpenStreamsOrBitmaps() = runBlocking {
    val crypto = CountingCryptoEngine()

    repeat(10) { iteration ->
      val staging = stageBytes("shard-$iteration".toByteArray())
      val result = workerFor(staging, crypto).doWork()
      assertTrue(result is ListenableWorker.Result.Success)
    }

    assertEquals(10, crypto.smallCalls)
    assertEquals(0, crypto.streamingCalls)
  }

  private fun workerFor(staging: File, crypto: ShardCryptoEngine): ShardEncryptionWorker {
    val input = Data.Builder()
      .putString(ShardEncryptionWorker.KEY_STAGING_URI, staging.toURI().toString())
      .putString(ShardEncryptionWorker.KEY_ALBUM_ID, "album-memory")
      .putInt(ShardEncryptionWorker.KEY_EPOCH_ID, 1)
      .putInt(ShardEncryptionWorker.KEY_TIER, 1)
      .putInt(ShardEncryptionWorker.KEY_SHARD_INDEX, 7)
      .putString(ShardEncryptionWorker.KEY_ALBUM_CONTENT_HASH_HEX, "0".repeat(64))
      .build()
    return TestListenableWorkerBuilder<ShardEncryptionWorker>(context)
      .setInputData(input)
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
          object : EpochHandleResolver {
            override fun openEpochHandle(albumId: String, epochId: Int): OpenedEpochHandle =
              OpenedEpochHandle(42L) {}
          },
        )
      })
      .build()
  }

  private fun stageBytes(bytes: ByteArray): File {
    stagingDir.mkdirs()
    return File(stagingDir, "staged-${System.nanoTime()}.bin").apply { writeBytes(bytes) }
  }

  private fun testLayoutProvider(): TierLayoutProvider = object : TierLayoutProvider {
    override fun canonicalLayout(): CanonicalTierLayout = CanonicalTierLayout(
      thumbnail = TierDimensions(1, 16, 16),
      preview = TierDimensions(2, 32, 32),
      original = TierDimensions(3, 64, 64),
    )
  }

  private class CountingCryptoEngine : ShardCryptoEngine {
    var smallCalls: Int = 0
    var streamingCalls: Int = 0

    override fun encryptShardWithEpochHandle(
      epochHandleId: Long,
      plaintext: ByteArray,
      tier: Int,
      shardIndex: Int,
    ): ByteArray {
      smallCalls++
      return "envelope-$smallCalls".toByteArray()
    }

    override fun encryptStreamingShard(
      epochHandleId: Long,
      plaintext: InputStream,
      plaintextLength: Long,
      tier: Int,
      shardIndex: Int,
    ): ByteArray {
      streamingCalls++
      plaintext.use { it.readBytes() }
      return "streaming-envelope-$streamingCalls".toByteArray()
    }
  }
}
