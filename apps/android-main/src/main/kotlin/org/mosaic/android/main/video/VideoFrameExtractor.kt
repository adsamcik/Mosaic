package org.mosaic.android.main.video

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.withTimeout
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
    return try {
      VideoFrameExtractionResult(
        tiers = encoder.encode(rotated),
        orientationDegrees = frame.orientationDegrees,
      )
    } finally {
      if (rotated !== frame.bitmap && !rotated.isRecycled) rotated.recycle()
      if (!frame.bitmap.isRecycled) frame.bitmap.recycle()
    }
  }
}

interface VideoFrameDecoder {
  fun decode(sourceUri: Uri): DecodedVideoFrame
}

class MediaMetadataRetrieverFrameDecoder internal constructor(
  private val context: Context,
  private val timeoutMillis: Long,
  private val retrieverFactory: () -> FrameRetriever,
) : VideoFrameDecoder {
  constructor(context: Context) : this(
    context = context,
    timeoutMillis = 30_000L,
    retrieverFactory = { AndroidFrameRetriever(MediaMetadataRetriever()) },
  )

  override fun decode(sourceUri: Uri): DecodedVideoFrame {
    return try {
      runBlocking {
        withTimeout(timeoutMillis) {
          runInterruptible(Dispatchers.IO) {
            decodeBlocking(sourceUri)
          }
        }
      }
    } catch (error: TimeoutCancellationException) {
      throw VideoFrameExtractionTimeoutException("Timed out extracting video frame", error)
    }
  }

  private fun decodeBlocking(sourceUri: Uri): DecodedVideoFrame {
    val retriever = retrieverFactory()
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

internal interface FrameRetriever {
  fun setDataSource(context: Context, sourceUri: Uri)
  fun getFrameAtTime(timeUs: Long, option: Int): Bitmap?
  fun extractMetadata(keyCode: Int): String?
  fun release()
}

private class AndroidFrameRetriever(
  private val delegate: MediaMetadataRetriever,
) : FrameRetriever {
  override fun setDataSource(context: Context, sourceUri: Uri) {
    delegate.setDataSource(context, sourceUri)
  }

  override fun getFrameAtTime(timeUs: Long, option: Int): Bitmap? =
    delegate.getFrameAtTime(timeUs, option)

  override fun extractMetadata(keyCode: Int): String? =
    delegate.extractMetadata(keyCode)

  override fun release() {
    delegate.release()
  }
}

class VideoFrameExtractionTimeoutException(
  message: String,
  cause: Throwable,
) : RuntimeException(message, cause)

data class DecodedVideoFrame(
  val bitmap: Bitmap,
  val orientationDegrees: Int,
)

data class VideoFrameExtractionResult(
  val tiers: EncodedMediaTiers,
  val orientationDegrees: Int,
)
