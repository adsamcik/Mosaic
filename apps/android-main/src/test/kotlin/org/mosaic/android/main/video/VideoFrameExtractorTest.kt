package org.mosaic.android.main.video

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.mosaic.android.main.media.BitmapTierEncoder
import org.mosaic.android.main.media.CanonicalTierLayout
import org.mosaic.android.main.media.TierDimensions
import org.mosaic.android.main.media.TierLayoutProvider
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class VideoFrameExtractorTest {
  private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

  @Test
  fun extractAppliesContainerOrientationBeforeEncodingTiers() = runTest {
    val frame = Bitmap.createBitmap(10, 20, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.GREEN) }
    val decoder = object : VideoFrameDecoder {
      override suspend fun decode(sourceUri: Uri): DecodedVideoFrame = DecodedVideoFrame(frame, orientationDegrees = 90)
    }
    val extractor = VideoFrameExtractor(
      context = context,
      encoder = BitmapTierEncoder(testLayoutProvider()),
      frameDecoder = decoder,
    )

    val result = extractor.extract(Uri.parse("file:///video-90.mp4"))

    assertEquals(90, result.orientationDegrees)
    val thumbnail = BitmapFactory.decodeByteArray(result.tiers.thumbnail, 0, result.tiers.thumbnail.size)
    assertEquals(20, thumbnail.width)
    assertEquals(10, thumbnail.height)
    assertTrue(result.tiers.thumbhash.startsWith("thv1:"))
  }

  @Test
  fun mediaMetadataRetrieverFrameDecoderHappyPathUsesTimeoutWrapper() = runBlocking {
    val retriever = StubFrameRetriever(
      frame = Bitmap.createBitmap(12, 24, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.CYAN) },
      orientation = "90",
    )
    val decoder = MediaMetadataRetrieverFrameDecoder(
      context = context,
      timeoutMillis = 1_000L,
      retrieverFactory = { retriever },
    )

    val decoded = decoder.decode(Uri.parse("file:///happy.mp4"))

    assertEquals(90, decoded.orientationDegrees)
    assertEquals(12, decoded.bitmap.width)
    assertTrue(retriever.releaseCalled)
    decoded.bitmap.recycle()
  }

  @Test
  fun timeoutOnHungVideo() = runTest {
    val retriever = StubFrameRetriever(
      frame = Bitmap.createBitmap(10, 10, Bitmap.Config.ARGB_8888),
      orientation = "0",
      sleepMillis = 60_000L,
    )
    val decoder = MediaMetadataRetrieverFrameDecoder(
      context = context,
      timeoutMillis = 1_000L,
      retrieverFactory = { retriever },
    )

    var thrown: Throwable? = null
    try {
      decoder.decode(Uri.parse("file:///hung.mp4"))
    } catch (error: VideoFrameExtractionTimeoutException) {
      thrown = error
    }
    assertTrue("expected VideoFrameExtractionTimeoutException", thrown is VideoFrameExtractionTimeoutException)
    assertTrue(retriever.releaseCalled)
    retriever.frame.recycle()
  }

  private class StubFrameRetriever(
    val frame: Bitmap,
    private val orientation: String?,
    private val sleepMillis: Long = 0L,
  ) : FrameRetriever {
    var releaseCalled = false

    override fun setDataSource(context: android.content.Context, sourceUri: Uri) = Unit

    override fun getFrameAtTime(timeUs: Long, option: Int): Bitmap? {
      if (sleepMillis > 0L) {
        Thread.sleep(sleepMillis)
      }
      return frame
    }

    override fun extractMetadata(keyCode: Int): String? = orientation

    override fun release() {
      releaseCalled = true
    }
  }

  private fun testLayoutProvider(): TierLayoutProvider = object : TierLayoutProvider {
    override fun canonicalLayout(): CanonicalTierLayout = CanonicalTierLayout(
      thumbnail = TierDimensions(1, 64, 64),
      preview = TierDimensions(2, 128, 128),
      original = TierDimensions(3, 256, 256),
    )
  }
}
