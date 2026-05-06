package org.mosaic.android.main.media

import android.content.Context
import android.net.Uri
import android.graphics.BitmapFactory

class MediaTierGenerator(
  private val context: Context,
  private val encoder: BitmapTierEncoder = BitmapTierEncoder(),
) {
  fun generate(sourceUri: Uri): EncodedMediaTiers {
    val bitmap = context.contentResolver.openInputStream(sourceUri).use { input ->
      requireNotNull(input) { "Unable to open media URI" }
      BitmapFactory.decodeStream(input)
    }
    requireNotNull(bitmap) { "Unable to decode image" }
    return encoder.encode(bitmap)
  }
}
