package org.mosaic.android.main.media

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.Base64
import org.mosaic.android.main.bridge.AndroidRustCoreLibraryLoader
import uniffi.mosaic_uniffi.canonicalTierLayout as rustCanonicalTierLayout

class BitmapTierEncoder(
  private val layoutProvider: TierLayoutProvider = RustCanonicalTierLayoutProvider,
  private val thumbHashCalculator: ThumbHashCalculator = ThumbHashCalculator(),
) {
  fun encode(bitmap: Bitmap): EncodedMediaTiers {
    require(bitmap.width > 0 && bitmap.height > 0) { "bitmap dimensions must be positive" }
    val layout = layoutProvider.canonicalLayout()
    val srgbBitmap = bitmap.toSrgbCopy()
    val thumbnailBitmap = srgbBitmap.scaleToFit(layout.thumbnail.width, layout.thumbnail.height)
    val previewBitmap = srgbBitmap.scaleToFit(layout.preview.width, layout.preview.height)
    val originalBitmap = srgbBitmap.scaleToFit(layout.original.width, layout.original.height)

    return EncodedMediaTiers(
      thumbnail = thumbnailBitmap.encodeJpegWithoutMetadata(),
      preview = previewBitmap.encodeJpegWithoutMetadata(),
      original = originalBitmap.encodeJpegWithoutMetadata(),
      thumbhash = thumbHashCalculator.calculate(thumbnailBitmap),
    )
  }

  fun rotate(bitmap: Bitmap, degrees: Int): Bitmap {
    val normalized = ((degrees % 360) + 360) % 360
    if (normalized == 0) return bitmap
    val matrix = Matrix().apply { postRotate(normalized.toFloat()) }
    return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
  }

  private fun Bitmap.toSrgbCopy(): Bitmap {
    val output = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    Canvas(output).drawBitmap(this, 0f, 0f, null)
    return output
  }

  private fun Bitmap.scaleToFit(maxWidth: Int, maxHeight: Int): Bitmap {
    require(maxWidth > 0 && maxHeight > 0) { "tier dimensions must be positive" }
    val scale = minOf(maxWidth.toFloat() / width.toFloat(), maxHeight.toFloat() / height.toFloat(), 1f)
    val targetWidth = maxOf(1, (width * scale).toInt())
    val targetHeight = maxOf(1, (height * scale).toInt())
    if (targetWidth == width && targetHeight == height) return this
    return Bitmap.createScaledBitmap(this, targetWidth, targetHeight, true)
  }

  private fun Bitmap.encodeJpegWithoutMetadata(): ByteArray {
    val output = ByteArrayOutputStream()
    check(compress(Bitmap.CompressFormat.JPEG, 90, output)) { "JPEG encoding failed" }
    return output.toByteArray()
  }
}

interface TierLayoutProvider {
  fun canonicalLayout(): CanonicalTierLayout
}

object RustCanonicalTierLayoutProvider : TierLayoutProvider {
  override fun canonicalLayout(): CanonicalTierLayout {
    AndroidRustCoreLibraryLoader.warmUp()
    val layout = rustCanonicalTierLayout()
    require(layout.code.toInt() == 0) { "Rust canonical tier layout failed with code ${layout.code}" }
    return CanonicalTierLayout(
      thumbnail = TierDimensions(1, layout.thumbnail.width.toInt(), layout.thumbnail.height.toInt()),
      preview = TierDimensions(2, layout.preview.width.toInt(), layout.preview.height.toInt()),
      original = TierDimensions(3, layout.original.width.toInt(), layout.original.height.toInt()),
    )
  }
}

class ThumbHashCalculator {
  fun calculate(bitmap: Bitmap): String {
    val sampled = Bitmap.createScaledBitmap(bitmap, 16, 16, true)
    val features = ByteArrayOutputStream()
    for (y in 0 until sampled.height) {
      for (x in 0 until sampled.width) {
        val pixel = sampled.getPixel(x, y)
        val red = Color.red(pixel)
        val green = Color.green(pixel)
        val blue = Color.blue(pixel)
        val luma = ((red * 77) + (green * 150) + (blue * 29)) ushr 8
        val warm = ((red - blue) + 255) / 2
        features.write(luma)
        features.write(warm)
      }
    }
    val digest = MessageDigest.getInstance("SHA-256").digest(features.toByteArray()).copyOf(24)
    return "thv1:${Base64.getUrlEncoder().withoutPadding().encodeToString(digest)}"
  }
}

data class CanonicalTierLayout(
  val thumbnail: TierDimensions,
  val preview: TierDimensions,
  val original: TierDimensions,
)

data class TierDimensions(
  val tier: Int,
  val width: Int,
  val height: Int,
)

data class EncodedMediaTiers(
  val thumbnail: ByteArray,
  val preview: ByteArray,
  val original: ByteArray,
  val thumbhash: String,
) {
  override fun equals(other: Any?): Boolean {
    if (this === other) return true
    if (other !is EncodedMediaTiers) return false
    return thumbnail.contentEquals(other.thumbnail) &&
      preview.contentEquals(other.preview) &&
      original.contentEquals(other.original) &&
      thumbhash == other.thumbhash
  }

  override fun hashCode(): Int {
    var result = thumbnail.contentHashCode()
    result = 31 * result + preview.contentHashCode()
    result = 31 * result + original.contentHashCode()
    result = 31 * result + thumbhash.hashCode()
    return result
  }
}
