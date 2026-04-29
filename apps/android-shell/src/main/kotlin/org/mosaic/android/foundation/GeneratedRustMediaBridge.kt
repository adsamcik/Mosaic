package org.mosaic.android.foundation

object RustMediaPlanStableCode {
  const val OK: Int = 0
  const val DEFERRED: Int = 450
  const val UNSUPPORTED: Int = 451
  const val INTERNAL_ERROR: Int = 500
}

object RustMediaInspectionStableCode {
  const val OK: Int = 0
  const val INVALID_INPUT_LENGTH: Int = 202
  const val INTERNAL_STATE_POISONED: Int = 500
  const val UNSUPPORTED_MEDIA_FORMAT: Int = 600
  const val INVALID_MEDIA_CONTAINER: Int = 601
  const val INVALID_MEDIA_DIMENSIONS: Int = 602
}

enum class MediaInspectionCode {
  SUCCESS,
  UNSUPPORTED_MEDIA_FORMAT,
  INVALID_MEDIA_CONTAINER,
  INVALID_MEDIA_DIMENSIONS,
  INVALID_INPUT_LENGTH,
  INTERNAL_ERROR,
}

enum class MediaTierLayoutCode {
  SUCCESS,
  INVALID_MEDIA_DIMENSIONS,
  INVALID_INPUT_LENGTH,
  INTERNAL_ERROR,
}

data class MediaImageMetadata(
  val format: String,
  val mimeType: String,
  val width: Int,
  val height: Int,
  val orientation: Int,
) {
  init {
    require(format.isNotBlank()) { "format is required" }
    require(mimeType.isNotBlank()) { "mime type is required" }
    require(width > 0) { "width must be positive" }
    require(height > 0) { "height must be positive" }
    require(orientation in MIN_ORIENTATION..MAX_ORIENTATION) {
      "orientation must be within [$MIN_ORIENTATION, $MAX_ORIENTATION]"
    }
  }

  override fun toString(): String =
    "MediaImageMetadata(format=$format, mimeType=$mimeType, width=$width, height=$height, orientation=$orientation)"

  companion object {
    const val MIN_ORIENTATION: Int = 1
    const val MAX_ORIENTATION: Int = 8
  }
}

data class MediaInspectionResult(
  val code: MediaInspectionCode,
  val metadata: MediaImageMetadata?,
) {
  init {
    require((code == MediaInspectionCode.SUCCESS) == (metadata != null)) {
      "successful inspections require metadata; failures must not include any"
    }
  }
}

data class MediaTierDimensions(
  val tier: Int,
  val width: Int,
  val height: Int,
) {
  init {
    require(tier in MIN_TIER..MAX_TIER) { "tier must be within [$MIN_TIER, $MAX_TIER]" }
    require(width > 0) { "width must be positive" }
    require(height > 0) { "height must be positive" }
  }

  companion object {
    const val MIN_TIER: Int = 1
    const val MAX_TIER: Int = 3
  }
}

data class MediaTierLayout(
  val thumbnail: MediaTierDimensions,
  val preview: MediaTierDimensions,
  val original: MediaTierDimensions,
) {
  init {
    require(thumbnail.tier == 1) { "thumbnail tier must be 1" }
    require(preview.tier == 2) { "preview tier must be 2" }
    require(original.tier == 3) { "original tier must be 3" }
  }
}

data class MediaTierLayoutResult(
  val code: MediaTierLayoutCode,
  val layout: MediaTierLayout?,
) {
  init {
    require((code == MediaTierLayoutCode.SUCCESS) == (layout != null)) {
      "successful tier layouts require dimensions; failures must not include any"
    }
  }
}

interface MediaInspectionPort {
  /**
   * Inspects an image without decoding pixels. Returns format, MIME type, dimensions, and
   * EXIF orientation. Caller-supplied bytes are NOT retained or logged.
   */
  fun inspectMediaImage(bytes: ByteArray): MediaInspectionResult

  /**
   * Plans the canonical thumbnail/preview/original tier dimensions for an image of the
   * given dimensions.
   */
  fun planMediaTierLayout(width: Int, height: Int): MediaTierLayoutResult
}

class RustMediaPlanFfiRequest private constructor(
  val stagedSource: StagedMediaReference,
  val contentLengthBytes: Long,
) {
  init {
    require(contentLengthBytes >= 0) { "content length must not be negative" }
  }

  override fun toString(): String =
    "RustMediaPlanFfiRequest(stagedSource=<redacted>, contentLengthBytes=$contentLengthBytes)"

  companion object {
    fun from(candidate: MediaImportCandidate): RustMediaPlanFfiRequest = RustMediaPlanFfiRequest(
      stagedSource = candidate.stagedSource,
      contentLengthBytes = candidate.contentLengthBytes,
    )
  }
}

data class RustMediaPlanFfiResult(
  val code: Int,
  val planId: String?,
) {
  override fun toString(): String =
    "RustMediaPlanFfiResult(code=$code, planId=<redacted>)"
}

data class RustMediaMetadataFfiResult(
  val code: Int,
  val format: String,
  val mimeType: String,
  val width: Int,
  val height: Int,
  val orientation: Int,
) {
  init {
    require(code >= 0) { "media metadata code must not be negative" }
    require(width >= 0) { "width must not be negative" }
    require(height >= 0) { "height must not be negative" }
    require(orientation >= 0) { "orientation must not be negative" }
  }
}

data class RustMediaTierDimensionsFfi(
  val tier: Int,
  val width: Int,
  val height: Int,
) {
  init {
    require(tier >= 0) { "tier must not be negative" }
    require(width >= 0) { "width must not be negative" }
    require(height >= 0) { "height must not be negative" }
  }
}

data class RustMediaTierLayoutFfiResult(
  val code: Int,
  val thumbnail: RustMediaTierDimensionsFfi,
  val preview: RustMediaTierDimensionsFfi,
  val original: RustMediaTierDimensionsFfi,
) {
  init {
    require(code >= 0) { "tier layout code must not be negative" }
  }
}

interface GeneratedRustMediaApi {
  fun planMediaTiers(request: RustMediaPlanFfiRequest): RustMediaPlanFfiResult

  fun inspectMediaImage(bytes: ByteArray): RustMediaMetadataFfiResult

  fun planMediaTierLayout(width: Int, height: Int): RustMediaTierLayoutFfiResult
}

class GeneratedRustMediaBridge(
  private val api: GeneratedRustMediaApi,
) : MediaPort, MediaInspectionPort {
  override fun planTiers(candidate: MediaImportCandidate): MediaPlanResult {
    val result = api.planMediaTiers(RustMediaPlanFfiRequest.from(candidate))
    return result.toMediaPlanResult()
  }

  override fun inspectMediaImage(bytes: ByteArray): MediaInspectionResult {
    require(bytes.isNotEmpty()) { "media bytes must not be empty" }
    val result = api.inspectMediaImage(bytes)
    val code = inspectionCodeFor(result.code)
    val metadata = if (code == MediaInspectionCode.SUCCESS) {
      runCatching {
        MediaImageMetadata(
          format = result.format,
          mimeType = result.mimeType,
          width = result.width,
          height = result.height,
          orientation = result.orientation,
        )
      }.getOrNull()
    } else null
    val safeCode = if (code == MediaInspectionCode.SUCCESS && metadata == null) {
      MediaInspectionCode.INTERNAL_ERROR
    } else code
    return MediaInspectionResult(safeCode, if (safeCode == MediaInspectionCode.SUCCESS) metadata else null)
  }

  override fun planMediaTierLayout(width: Int, height: Int): MediaTierLayoutResult {
    require(width > 0) { "width must be positive" }
    require(height > 0) { "height must be positive" }
    val result = api.planMediaTierLayout(width, height)
    val code = layoutCodeFor(result.code)
    val layout = if (code == MediaTierLayoutCode.SUCCESS) {
      runCatching {
        MediaTierLayout(
          thumbnail = MediaTierDimensions(result.thumbnail.tier, result.thumbnail.width, result.thumbnail.height),
          preview = MediaTierDimensions(result.preview.tier, result.preview.width, result.preview.height),
          original = MediaTierDimensions(result.original.tier, result.original.width, result.original.height),
        )
      }.getOrNull()
    } else null
    val safeCode = if (code == MediaTierLayoutCode.SUCCESS && layout == null) {
      MediaTierLayoutCode.INTERNAL_ERROR
    } else code
    return MediaTierLayoutResult(safeCode, if (safeCode == MediaTierLayoutCode.SUCCESS) layout else null)
  }

  private fun inspectionCodeFor(code: Int): MediaInspectionCode = when (code) {
    RustMediaInspectionStableCode.OK -> MediaInspectionCode.SUCCESS
    RustMediaInspectionStableCode.UNSUPPORTED_MEDIA_FORMAT -> MediaInspectionCode.UNSUPPORTED_MEDIA_FORMAT
    RustMediaInspectionStableCode.INVALID_MEDIA_CONTAINER -> MediaInspectionCode.INVALID_MEDIA_CONTAINER
    RustMediaInspectionStableCode.INVALID_MEDIA_DIMENSIONS -> MediaInspectionCode.INVALID_MEDIA_DIMENSIONS
    RustMediaInspectionStableCode.INVALID_INPUT_LENGTH -> MediaInspectionCode.INVALID_INPUT_LENGTH
    else -> MediaInspectionCode.INTERNAL_ERROR
  }

  private fun layoutCodeFor(code: Int): MediaTierLayoutCode = when (code) {
    RustMediaInspectionStableCode.OK -> MediaTierLayoutCode.SUCCESS
    RustMediaInspectionStableCode.INVALID_MEDIA_DIMENSIONS -> MediaTierLayoutCode.INVALID_MEDIA_DIMENSIONS
    RustMediaInspectionStableCode.INVALID_INPUT_LENGTH -> MediaTierLayoutCode.INVALID_INPUT_LENGTH
    else -> MediaTierLayoutCode.INTERNAL_ERROR
  }
}

private fun RustMediaPlanFfiResult.toMediaPlanResult(): MediaPlanResult =
  when (code) {
    RustMediaPlanStableCode.OK -> {
      val plannedId = planId?.takeIf { it.isNotBlank() } ?: return MediaPlanResult(
        status = MediaPlanStatus.DEFERRED,
        planId = null,
      )
      MediaPlanResult(
        status = MediaPlanStatus.PLANNED,
        planId = MediaTierPlanId(plannedId),
      )
    }
    RustMediaPlanStableCode.DEFERRED,
    RustMediaPlanStableCode.UNSUPPORTED,
    RustMediaPlanStableCode.INTERNAL_ERROR,
    -> MediaPlanResult(
      status = MediaPlanStatus.DEFERRED,
      planId = null,
    )
    else -> MediaPlanResult(
      status = MediaPlanStatus.DEFERRED,
      planId = null,
    )
  }
