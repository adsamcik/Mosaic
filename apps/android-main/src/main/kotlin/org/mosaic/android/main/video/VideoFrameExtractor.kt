package org.mosaic.android.main.video

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import org.mosaic.android.main.media.BitmapTierEncoder
import org.mosaic.android.main.media.EncodedMediaTiers

class VideoFrameExtractor(
  private val context: Context,
  private val encoder: BitmapTierEncoder = BitmapTierEncoder(),
  private val frameDecoder: VideoFrameDecoder = MediaMetadataRetrieverFrameDecoder(context),
) {
  fun extract(sourceUri: Uri): VideoFrameExtractionResult {
    val frame = frameDecoder.decode(sourceUri)
    val rotated = encoder.rotate(frame.bitmap, frame.orientationDegrees)
    return VideoFrameExtractionResult(
      tiers = encoder.encode(rotated),
      orientationDegrees = frame.orientationDegrees,
    )
  }
}

interface VideoFrameDecoder {
  fun decode(sourceUri: Uri): DecodedVideoFrame
}

class MediaMetadataRetrieverFrameDecoder(private val context: Context) : VideoFrameDecoder {
  override fun decode(sourceUri: Uri): DecodedVideoFrame {
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(context, sourceUri)
      val bitmap = retriever.getFrameAtTime(0L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
      requireNotNull(bitmap) { "Unable to decode first video frame" }
      val orientation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)
        ?.toIntOrNull()
        ?: 0
      return DecodedVideoFrame(bitmap = bitmap, orientationDegrees = orientation)
    } finally {
      retriever.release()
    }
  }
}

data class DecodedVideoFrame(
  val bitmap: Bitmap,
  val orientationDegrees: Int,
)

data class VideoFrameExtractionResult(
  val tiers: EncodedMediaTiers,
  val orientationDegrees: Int,
)
