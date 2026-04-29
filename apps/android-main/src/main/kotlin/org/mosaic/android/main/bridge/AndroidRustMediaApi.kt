package org.mosaic.android.main.bridge

import org.mosaic.android.foundation.GeneratedRustMediaApi
import org.mosaic.android.foundation.RustMediaInspectionStableCode
import org.mosaic.android.foundation.RustMediaMetadataFfiResult
import org.mosaic.android.foundation.RustMediaPlanFfiRequest
import org.mosaic.android.foundation.RustMediaPlanFfiResult
import org.mosaic.android.foundation.RustMediaPlanStableCode
import org.mosaic.android.foundation.RustMediaTierDimensionsFfi
import org.mosaic.android.foundation.RustMediaTierLayoutFfiResult
import uniffi.mosaic_uniffi.inspectMediaImage as rustInspectMediaImage
import uniffi.mosaic_uniffi.planMediaTierLayout as rustPlanMediaTierLayout

/**
 * Real implementation of [GeneratedRustMediaApi] backed by the Rust UniFFI core.
 *
 * Two of the three methods (`inspectMediaImage`, `planMediaTierLayout`) directly
 * call the Rust core. The third — `planMediaTiers` — represents a higher-level
 * composite operation (URI → staged read → tier plan id) that has not yet been
 * surfaced through UniFFI; this adapter therefore returns `DEFERRED` for it,
 * matching the existing `StubMediaPort` contract until the composite operation
 * lands in `mosaic-uniffi`.
 */
class AndroidRustMediaApi : GeneratedRustMediaApi {

  init {
    AndroidRustCoreLibraryLoader.warmUp()
  }

  override fun planMediaTiers(request: RustMediaPlanFfiRequest): RustMediaPlanFfiResult =
    RustMediaPlanFfiResult(code = RustMediaPlanStableCode.DEFERRED, planId = null)

  override fun inspectMediaImage(bytes: ByteArray): RustMediaMetadataFfiResult {
    require(bytes.isNotEmpty()) { "media bytes must not be empty" }
    val result = rustInspectMediaImage(bytes)
    return RustMediaMetadataFfiResult(
      code = result.code.toInt(),
      format = result.format,
      mimeType = result.mimeType,
      width = result.width.toInt(),
      height = result.height.toInt(),
      orientation = result.orientation.toInt(),
    )
  }

  override fun planMediaTierLayout(width: Int, height: Int): RustMediaTierLayoutFfiResult {
    require(width >= 0) { "width must not be negative" }
    require(height >= 0) { "height must not be negative" }
    val result = rustPlanMediaTierLayout(width.toUInt(), height.toUInt())
    return RustMediaTierLayoutFfiResult(
      code = result.code.toInt(),
      thumbnail = RustMediaTierDimensionsFfi(
        tier = result.thumbnail.tier.toInt(),
        width = result.thumbnail.width.toInt(),
        height = result.thumbnail.height.toInt(),
      ),
      preview = RustMediaTierDimensionsFfi(
        tier = result.preview.tier.toInt(),
        width = result.preview.width.toInt(),
        height = result.preview.height.toInt(),
      ),
      original = RustMediaTierDimensionsFfi(
        tier = result.original.tier.toInt(),
        width = result.original.width.toInt(),
        height = result.original.height.toInt(),
      ),
    )
  }

  @Suppress("unused")
  private val unusedConstantHook: Int = RustMediaInspectionStableCode.OK
}
