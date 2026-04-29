package org.mosaic.android.main.bridge

import org.mosaic.android.foundation.GeneratedRustAccountApi
import org.mosaic.android.foundation.RustAccountKeyHandleStatusFfiResult
import org.mosaic.android.foundation.RustAccountUnlockFfiRequest
import org.mosaic.android.foundation.RustAccountUnlockFfiResult
import uniffi.mosaic_uniffi.AccountUnlockRequest as RustAccountUnlockRequest
import uniffi.mosaic_uniffi.accountKeyHandleIsOpen as rustAccountKeyHandleIsOpen
import uniffi.mosaic_uniffi.closeAccountKeyHandle as rustCloseAccountKeyHandle
import uniffi.mosaic_uniffi.protocolVersion as rustProtocolVersion
import uniffi.mosaic_uniffi.unlockAccountKey as rustUnlockAccountKey

/**
 * Real implementation of [GeneratedRustAccountApi] that delegates to the generated
 * `uniffi.mosaic_uniffi` top-level functions. The shell module's high-level
 * `RustAccountBridge` consumer pairs this adapter with `GeneratedRustAccountBridge`.
 *
 * This adapter performs only mechanical translation between unsigned/signed integer
 * widths and the shell-side / generated DTO shapes. It never logs, retains, or
 * inspects sensitive material; the password buffer is forwarded byte-for-byte to
 * the Rust core which is responsible for zeroizing its received copy.
 */
class AndroidRustAccountApi : GeneratedRustAccountApi {

  init {
    AndroidRustCoreLibraryLoader.warmUp()
  }

  override fun protocolVersion(): String = rustProtocolVersion()

  override fun unlockAccountKey(
    password: ByteArray,
    request: RustAccountUnlockFfiRequest,
  ): RustAccountUnlockFfiResult {
    val uniRequest = RustAccountUnlockRequest(
      userSalt = request.userSalt,
      accountSalt = request.accountSalt,
      wrappedAccountKey = request.wrappedAccountKey,
      kdfMemoryKib = request.kdfMemoryKiB.toUInt(),
      kdfIterations = request.kdfIterations.toUInt(),
      kdfParallelism = request.kdfParallelism.toUInt(),
    )
    val result = rustUnlockAccountKey(password, uniRequest)
    return RustAccountUnlockFfiResult(
      code = result.code.toInt(),
      handle = result.handle.toLong(),
    )
  }

  override fun accountKeyHandleIsOpen(handle: Long): RustAccountKeyHandleStatusFfiResult {
    val result = rustAccountKeyHandleIsOpen(handle.toULong())
    return RustAccountKeyHandleStatusFfiResult(
      code = result.code.toInt(),
      isOpen = result.isOpen,
    )
  }

  override fun closeAccountKeyHandle(handle: Long): Int =
    rustCloseAccountKeyHandle(handle.toULong()).toInt()
}
