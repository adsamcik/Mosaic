package org.mosaic.android.main.bridge

import org.mosaic.android.foundation.GeneratedRustProgressApi
import org.mosaic.android.foundation.RustProgressFfiCheckpoint
import org.mosaic.android.foundation.RustProgressFfiResult
import uniffi.mosaic_uniffi.androidProgressProbe as rustAndroidProgressProbe

/** Real implementation of [GeneratedRustProgressApi] backed by the Rust UniFFI core. */
class AndroidRustProgressApi : GeneratedRustProgressApi {

  init {
    AndroidRustCoreLibraryLoader.warmUp()
  }

  override fun probe(totalSteps: Int, cancelAfter: Int?): RustProgressFfiResult {
    require(totalSteps >= 0) { "total steps must not be negative" }
    val result = rustAndroidProgressProbe(totalSteps.toUInt(), cancelAfter?.toUInt())
    return RustProgressFfiResult(
      code = result.code.toInt(),
      checkpoints = result.events.map { event ->
        RustProgressFfiCheckpoint(
          completedSteps = event.completedSteps.toInt(),
          totalSteps = event.totalSteps.toInt(),
        )
      },
    )
  }
}
