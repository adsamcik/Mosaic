package org.mosaic.android.main.video

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
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
  fun extractAppliesContainerOrientationBeforeEncodingTiers() {
    val frame = Bitmap.createBitmap(10, 20, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.GREEN) }
    val decoder = object : VideoFrameDecoder {
      override fun decode(sourceUri: Uri): DecodedVideoFrame = DecodedVideoFrame(frame, orientationDegrees = 90)
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

  private fun testLayoutProvider(): TierLayoutProvider = object : TierLayoutProvider {
    override fun canonicalLayout(): CanonicalTierLayout = CanonicalTierLayout(
      thumbnail = TierDimensions(1, 64, 64),
      preview = TierDimensions(2, 128, 128),
      original = TierDimensions(3, 256, 256),
    )
  }
}
