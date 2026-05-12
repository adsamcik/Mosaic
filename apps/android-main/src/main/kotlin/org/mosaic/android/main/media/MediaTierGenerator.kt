package org.mosaic.android.main.media

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import androidx.exifinterface.media.ExifInterface
import java.io.ByteArrayInputStream

class MediaTierGenerator(
  private val context: Context,
  private val encoder: BitmapTierEncoder = BitmapTierEncoder(),
) {
  fun generate(sourceUri: Uri): EncodedMediaTiers {
    val bytes = context.contentResolver.openInputStream(sourceUri).use { input ->
      requireNotNull(input) { "Unable to open media URI" }
      input.readBytes()
    }
    val orientation = ExifInterface(ByteArrayInputStream(bytes))
      .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
    val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    requireNotNull(bitmap) { "Unable to decode image" }
    val rotated = bitmap.applyExifOrientation(orientation)
    return try {
      encoder.encode(rotated)
    } finally {
      if (rotated !== bitmap && !rotated.isRecycled) rotated.recycle()
      if (!bitmap.isRecycled) bitmap.recycle()
    }
  }

  private fun Bitmap.applyExifOrientation(orientation: Int): Bitmap = when (orientation) {
    ExifInterface.ORIENTATION_ROTATE_90 -> encoder.rotate(this, 90)
    ExifInterface.ORIENTATION_ROTATE_180 -> encoder.rotate(this, 180)
    ExifInterface.ORIENTATION_ROTATE_270 -> encoder.rotate(this, 270)
    ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> transform { postScale(-1f, 1f) }
    ExifInterface.ORIENTATION_FLIP_VERTICAL -> transform { postScale(1f, -1f) }
    ExifInterface.ORIENTATION_TRANSPOSE -> transform {
      postRotate(90f)
      postScale(-1f, 1f)
    }
    ExifInterface.ORIENTATION_TRANSVERSE -> transform {
      postRotate(270f)
      postScale(-1f, 1f)
    }
    else -> this
  }

  private fun Bitmap.transform(configure: Matrix.() -> Unit): Bitmap {
    val matrix = Matrix().apply(configure)
    return Bitmap.createBitmap(this, 0, 0, width, height, matrix, true)
  }
}
