package org.mosaic.android.foundation

object RustProgressStableCode {
  const val OK: Int = 0
  const val OPERATION_CANCELLED: Int = 300
}

enum class ProgressProbeCode {
  SUCCESS,
  CANCELLED,
  INTERNAL_ERROR,
}

data class ProgressCheckpoint(
  val completedSteps: Int,
  val totalSteps: Int,
) {
  init {
    require(completedSteps >= 0) { "completed steps must not be negative" }
    require(totalSteps >= 0) { "total steps must not be negative" }
    require(completedSteps <= totalSteps) { "completed steps must not exceed total steps" }
  }
}

data class ProgressProbeResult(
  val code: ProgressProbeCode,
  val checkpoints: List<ProgressCheckpoint>,
)

interface RustProgressBridge {
  /**
   * Runs the cross-language progress probe defined by `mosaic-uniffi` and returns the
   * checkpoints emitted before optional cancellation. Used as a smoke test that the
   * Rust↔Kotlin event channel is wired correctly; not used in production photo flows.
   */
  fun probe(totalSteps: Int, cancelAfter: Int?): ProgressProbeResult
}

data class RustProgressFfiCheckpoint(
  val completedSteps: Int,
  val totalSteps: Int,
)

data class RustProgressFfiResult(
  val code: Int,
  val checkpoints: List<RustProgressFfiCheckpoint>,
) {
  init {
    require(code >= 0) { "progress code must not be negative" }
  }
}

interface GeneratedRustProgressApi {
  fun probe(totalSteps: Int, cancelAfter: Int?): RustProgressFfiResult
}

class GeneratedRustProgressBridge(
  private val api: GeneratedRustProgressApi,
) : RustProgressBridge {
  override fun probe(totalSteps: Int, cancelAfter: Int?): ProgressProbeResult {
    require(totalSteps >= 0) { "total steps must not be negative" }
    if (cancelAfter != null) {
      require(cancelAfter >= 0) { "cancel-after must not be negative" }
    }
    val result = api.probe(totalSteps, cancelAfter)
    val code = when (result.code) {
      RustProgressStableCode.OK -> ProgressProbeCode.SUCCESS
      RustProgressStableCode.OPERATION_CANCELLED -> ProgressProbeCode.CANCELLED
      else -> ProgressProbeCode.INTERNAL_ERROR
    }
    val checkpoints = result.checkpoints.map { ProgressCheckpoint(it.completedSteps, it.totalSteps) }
    return ProgressProbeResult(code, checkpoints)
  }
}
