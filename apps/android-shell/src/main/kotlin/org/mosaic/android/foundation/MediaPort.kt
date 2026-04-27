package org.mosaic.android.foundation

@JvmInline
value class MediaTierPlanId(val value: String) {
  init {
    require(value.isNotBlank()) { "media tier plan id is required" }
  }
}

data class MediaImportCandidate(
  val stagedSource: StagedMediaReference,
  val contentLengthBytes: Long,
) {
  init {
    require(contentLengthBytes >= 0) { "content length must not be negative" }
  }
}

enum class MediaPlanStatus {
  DEFERRED,
  PLANNED,
}

data class MediaPlanResult(
  val status: MediaPlanStatus,
  val planId: MediaTierPlanId?,
) {
  init {
    require((status == MediaPlanStatus.PLANNED) == (planId != null)) {
      "planned media results require a plan id; deferred results must not include one"
    }
  }
}

interface MediaPort {
  fun planTiers(candidate: MediaImportCandidate): MediaPlanResult
}

object StubMediaPort : MediaPort {
  override fun planTiers(candidate: MediaImportCandidate): MediaPlanResult = MediaPlanResult(
    status = MediaPlanStatus.DEFERRED,
    planId = null,
  )
}
