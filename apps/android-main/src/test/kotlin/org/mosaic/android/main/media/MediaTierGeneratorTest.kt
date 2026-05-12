package org.mosaic.android.main.media

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import androidx.exifinterface.media.ExifInterface
import androidx.test.core.app.ApplicationProvider
import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MediaTierGeneratorTest {
  private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

  @After
  fun tearDown() {
    context.filesDir.listFiles { file -> file.name.startsWith("fixture") }?.forEach { it.delete() }
  }

  @Test
  fun generateDecodesImageUriAndProducesAllTiers() {
    val fixture = File(context.filesDir, "fixture.jpg")
    Bitmap.createBitmap(80, 40, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.MAGENTA) }
      .compress(Bitmap.CompressFormat.JPEG, 95, fixture.outputStream())
    val generator = MediaTierGenerator(context, BitmapTierEncoder(testLayoutProvider()))

    val tiers = generator.generate(Uri.fromFile(fixture))

    assertNotNull(BitmapFactory.decodeByteArray(tiers.thumbnail, 0, tiers.thumbnail.size))
    assertNotNull(BitmapFactory.decodeByteArray(tiers.preview, 0, tiers.preview.size))
    assertNotNull(BitmapFactory.decodeByteArray(tiers.original, 0, tiers.original.size))
    assertTrue(tiers.thumbhash.startsWith("thv1:"))
  }

  @Test
  fun respectsExifOrientation6_producesRotatedTiers() {
    val tiers = generateWithExifOrientation("fixture-orientation-6.jpg", ExifInterface.ORIENTATION_ROTATE_90)

    val original = BitmapFactory.decodeByteArray(tiers.original, 0, tiers.original.size)
    assertEquals(200, original.width)
    assertEquals(100, original.height)
  }

  @Test
  fun respectsExifOrientation3_producesRotatedTiers() {
    val tiers = generateWithExifOrientation("fixture-orientation-3.jpg", ExifInterface.ORIENTATION_ROTATE_180)
    val unrotated = generateWithExifOrientation("fixture-orientation-normal.jpg", ExifInterface.ORIENTATION_NORMAL)

    val original = BitmapFactory.decodeByteArray(tiers.original, 0, tiers.original.size)
    assertEquals(100, original.width)
    assertEquals(200, original.height)
    assertFalse(tiers.original.contentEquals(unrotated.original))
  }

  @Test
  fun respectsExifOrientation8_producesRotatedTiers() {
    val tiers = generateWithExifOrientation("fixture-orientation-8.jpg", ExifInterface.ORIENTATION_ROTATE_270)

    val original = BitmapFactory.decodeByteArray(tiers.original, 0, tiers.original.size)
    assertEquals(200, original.width)
    assertEquals(100, original.height)
  }

  private fun generateWithExifOrientation(fileName: String, orientation: Int): EncodedMediaTiers {
    val fixture = File(context.filesDir, fileName)
    val bitmap = Bitmap.createBitmap(100, 200, Bitmap.Config.ARGB_8888)
    for (y in 0 until bitmap.height) {
      val color = if (y < bitmap.height / 2) Color.RED else Color.BLUE
      for (x in 0 until bitmap.width) {
        bitmap.setPixel(x, y, color)
      }
    }
    fixture.outputStream().use { output ->
      bitmap.compress(Bitmap.CompressFormat.JPEG, 95, output)
    }
    bitmap.recycle()
    ExifInterface(fixture.absolutePath).run {
      setAttribute(ExifInterface.TAG_ORIENTATION, orientation.toString())
      saveAttributes()
    }
    val generator = MediaTierGenerator(context, BitmapTierEncoder(testLayoutProvider()))

    return generator.generate(Uri.fromFile(fixture))
  }

  private fun testLayoutProvider(): TierLayoutProvider = object : TierLayoutProvider {
    override fun canonicalLayout(): CanonicalTierLayout = CanonicalTierLayout(
      thumbnail = TierDimensions(1, 32, 32),
      preview = TierDimensions(2, 64, 64),
      original = TierDimensions(3, 256, 256),
    )
  }
}
