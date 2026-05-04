package org.mosaic.android.main.bridge

import org.mosaic.android.foundation.GeneratedRustEpochApi
import org.mosaic.android.foundation.RustEpochHandleFfiResult
import org.mosaic.android.foundation.RustEpochHandleStatusFfiResult
import uniffi.mosaic_uniffi.closeEpochKeyHandle as rustCloseEpochKeyHandle
import uniffi.mosaic_uniffi.createEpochKeyHandle as rustCreateEpochKeyHandle
import uniffi.mosaic_uniffi.epochKeyHandleIsOpen as rustEpochKeyHandleIsOpen
import uniffi.mosaic_uniffi.openEpochKeyHandle as rustOpenEpochKeyHandle

/** Real implementation of [GeneratedRustEpochApi] backed by the Rust UniFFI core. */
class AndroidRustEpochApi : GeneratedRustEpochApi {

  init {
    AndroidRustCoreLibraryLoader.warmUp()
  }

  override fun createEpochKeyHandle(accountKeyHandle: Long, epochId: Int): RustEpochHandleFfiResult {
    require(epochId >= 0) { "epoch id must not be negative" }
    val result = rustCreateEpochKeyHandle(accountKeyHandle.toULong(), epochId.toUInt())
    return RustEpochHandleFfiResult(
      code = result.code.toInt(),
      handle = result.handle.toLong(),
      epochId = result.epochId.toInt(),
      wrappedEpochSeed = result.wrappedEpochSeed,
      signPublicKey = result.signPublicKey,
    )
  }

  override fun openEpochKeyHandle(
    wrappedEpochSeed: ByteArray,
    accountKeyHandle: Long,
    epochId: Int,
  ): RustEpochHandleFfiResult {
    require(epochId >= 0) { "epoch id must not be negative" }
    val result = rustOpenEpochKeyHandle(wrappedEpochSeed, accountKeyHandle.toULong(), epochId.toUInt())
    return RustEpochHandleFfiResult(
      code = result.code.toInt(),
      handle = result.handle.toLong(),
      epochId = result.epochId.toInt(),
      wrappedEpochSeed = result.wrappedEpochSeed,
      signPublicKey = result.signPublicKey,
    )
  }

  override fun epochKeyHandleIsOpen(handle: Long): RustEpochHandleStatusFfiResult {
    val result = rustEpochKeyHandleIsOpen(handle.toULong())
    return RustEpochHandleStatusFfiResult(code = result.code.toInt(), isOpen = result.isOpen)
  }

  override fun closeEpochKeyHandle(handle: Long): Int =
    rustCloseEpochKeyHandle(handle.toULong()).toInt()
}
