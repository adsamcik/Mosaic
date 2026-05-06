package org.mosaic.android.main.media

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import java.io.File
import org.junit.After
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
    File(context.filesDir, "fixture.jpg").delete()
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

  private fun testLayoutProvider(): TierLayoutProvider = object : TierLayoutProvider {
    override fun canonicalLayout(): CanonicalTierLayout = CanonicalTierLayout(
      thumbnail = TierDimensions(1, 32, 32),
      preview = TierDimensions(2, 64, 64),
      original = TierDimensions(3, 128, 128),
    )
  }
}

