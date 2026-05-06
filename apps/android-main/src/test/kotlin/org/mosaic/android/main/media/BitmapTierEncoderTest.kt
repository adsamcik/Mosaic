package org.mosaic.android.main.media

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class BitmapTierEncoderTest {
  private val layoutProvider = object : TierLayoutProvider {
    override fun canonicalLayout(): CanonicalTierLayout = CanonicalTierLayout(
      thumbnail = TierDimensions(1, 64, 64),
      preview = TierDimensions(2, 128, 128),
      original = TierDimensions(3, 512, 512),
    )
  }

  @Test
  fun encodeRescalesTiersStripsMetadataAndComputesThumbhash() {
    val bitmap = gradientBitmap(width = 300, height = 150)
    val tiers = BitmapTierEncoder(layoutProvider).encode(bitmap)

    val thumbnail = BitmapFactory.decodeByteArray(tiers.thumbnail, 0, tiers.thumbnail.size)
    val preview = BitmapFactory.decodeByteArray(tiers.preview, 0, tiers.preview.size)
    val original = BitmapFactory.decodeByteArray(tiers.original, 0, tiers.original.size)

    assertTrue(thumbnail.width <= 64)
    assertTrue(thumbnail.height <= 64)
    assertTrue(preview.width <= 128)
    assertTrue(preview.height <= 128)
    assertTrue(original.width <= 300)
    assertTrue(original.height <= 150)
    assertTrue(tiers.thumbhash.startsWith("thv1:"))
    assertFalse(tiers.thumbnail.containsAscii("ICC_PROFILE"))
    assertFalse(tiers.preview.containsAscii("ICC_PROFILE"))
    assertFalse(tiers.original.containsAscii("ICC_PROFILE"))
  }

  @Test
  fun thumbhashChangesWhenPixelsChange() {
    val encoder = BitmapTierEncoder(layoutProvider)
    val red = Bitmap.createBitmap(32, 32, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.RED) }
    val blue = Bitmap.createBitmap(32, 32, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.BLUE) }

    assertTrue(encoder.encode(red).thumbhash != encoder.encode(blue).thumbhash)
  }

  private fun gradientBitmap(width: Int, height: Int): Bitmap {
    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    for (y in 0 until height) {
      for (x in 0 until width) {
        bitmap.setPixel(x, y, Color.rgb(x % 256, y % 256, (x + y) % 256))
      }
    }
    return bitmap
  }

  private fun ByteArray.containsAscii(value: String): Boolean = toString(Charsets.ISO_8859_1).contains(value)
}

