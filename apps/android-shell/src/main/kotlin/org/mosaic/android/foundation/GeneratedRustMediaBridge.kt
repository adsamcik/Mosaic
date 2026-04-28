package org.mosaic.android.foundation

object RustMediaPlanStableCode {
  const val OK: Int = 0
  const val DEFERRED: Int = 450
  const val UNSUPPORTED: Int = 451
  const val INTERNAL_ERROR: Int = 500
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

interface GeneratedRustMediaApi {
  fun planMediaTiers(request: RustMediaPlanFfiRequest): RustMediaPlanFfiResult
}

class GeneratedRustMediaBridge(
  private val api: GeneratedRustMediaApi,
) : MediaPort {
  override fun planTiers(candidate: MediaImportCandidate): MediaPlanResult {
    val result = api.planMediaTiers(RustMediaPlanFfiRequest.from(candidate))
    return result.toMediaPlanResult()
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
