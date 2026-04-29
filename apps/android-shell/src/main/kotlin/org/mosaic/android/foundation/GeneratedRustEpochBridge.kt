package org.mosaic.android.foundation

object RustEpochStableCode {
  const val OK: Int = 0
  const val INVALID_KEY_LENGTH: Int = 201
  const val INVALID_INPUT_LENGTH: Int = 202
  const val AUTHENTICATION_FAILED: Int = 205
  const val WRAPPED_KEY_TOO_SHORT: Int = 207
  const val SECRET_HANDLE_NOT_FOUND: Int = 400
  const val HANDLE_SPACE_EXHAUSTED: Int = 402
  const val EPOCH_HANDLE_NOT_FOUND: Int = 403
  const val INTERNAL_STATE_POISONED: Int = 500
}

@JvmInline
value class EpochKeyHandle(val value: Long) {
  init {
    require(value > 0) { "epoch key handle must be positive" }
  }

  override fun toString(): String = "EpochKeyHandle(<redacted>)"
}

enum class EpochCreateCode {
  SUCCESS,
  ACCOUNT_HANDLE_NOT_FOUND,
  HANDLE_SPACE_EXHAUSTED,
  INTERNAL_ERROR,
}

enum class EpochOpenCode {
  SUCCESS,
  ACCOUNT_HANDLE_NOT_FOUND,
  AUTHENTICATION_FAILED,
  WRAPPED_KEY_TOO_SHORT,
  INVALID_INPUT_LENGTH,
  HANDLE_SPACE_EXHAUSTED,
  INTERNAL_ERROR,
}

enum class EpochCloseCode {
  SUCCESS,
  NOT_FOUND,
  INTERNAL_ERROR,
}

class EpochCreateResult(
  val code: EpochCreateCode,
  val handle: EpochKeyHandle?,
  val epochId: Int,
  wrappedEpochSeed: ByteArray,
) {
  init {
    require((code == EpochCreateCode.SUCCESS) == (handle != null)) {
      "successful epoch creates require a handle; failures must not include one"
    }
    if (code == EpochCreateCode.SUCCESS) {
      require(epochId >= 0) { "epoch id must not be negative" }
    }
  }

  private val wrappedSeedBytes: ByteArray = wrappedEpochSeed.copyOf()

  val wrappedEpochSeed: ByteArray
    get() = wrappedSeedBytes.copyOf()

  fun wipe() {
    wrappedSeedBytes.fill(0)
  }

  override fun toString(): String =
    "EpochCreateResult(code=$code, handle=$handle, epochId=$epochId, wrappedEpochSeed=<redacted>)"
}

class EpochOpenResult(
  val code: EpochOpenCode,
  val handle: EpochKeyHandle?,
  val epochId: Int,
) {
  init {
    require((code == EpochOpenCode.SUCCESS) == (handle != null)) {
      "successful epoch opens require a handle; failures must not include one"
    }
    if (code == EpochOpenCode.SUCCESS) {
      require(epochId >= 0) { "epoch id must not be negative" }
    }
  }
}

interface RustEpochBridge {
  fun createEpoch(accountKeyHandle: AccountKeyHandle, epochId: Int): EpochCreateResult

  fun openEpoch(wrappedEpochSeed: ByteArray, accountKeyHandle: AccountKeyHandle, epochId: Int): EpochOpenResult

  fun isEpochOpen(handle: EpochKeyHandle): Boolean

  fun closeEpoch(handle: EpochKeyHandle): EpochCloseCode
}

data class RustEpochHandleFfiResult(
  val code: Int,
  val handle: Long,
  val epochId: Int,
  val wrappedEpochSeed: ByteArray,
) {
  init {
    require(code >= 0) { "epoch code must not be negative" }
    require(handle >= 0) { "epoch handle must not be negative" }
    require(epochId >= 0) { "epoch id must not be negative" }
  }

  fun wipe() {
    wrappedEpochSeed.fill(0)
  }

  override fun toString(): String =
    "RustEpochHandleFfiResult(code=$code, handle=<redacted>, epochId=$epochId, wrappedEpochSeed=<redacted>)"

  override fun equals(other: Any?): Boolean {
    if (this === other) return true
    if (other !is RustEpochHandleFfiResult) return false
    return code == other.code &&
      handle == other.handle &&
      epochId == other.epochId &&
      wrappedEpochSeed.contentEquals(other.wrappedEpochSeed)
  }

  override fun hashCode(): Int {
    var result = code
    result = 31 * result + handle.hashCode()
    result = 31 * result + epochId
    result = 31 * result + wrappedEpochSeed.contentHashCode()
    return result
  }
}

data class RustEpochHandleStatusFfiResult(
  val code: Int,
  val isOpen: Boolean,
)

interface GeneratedRustEpochApi {
  fun createEpochKeyHandle(accountKeyHandle: Long, epochId: Int): RustEpochHandleFfiResult

  fun openEpochKeyHandle(
    wrappedEpochSeed: ByteArray,
    accountKeyHandle: Long,
    epochId: Int,
  ): RustEpochHandleFfiResult

  fun epochKeyHandleIsOpen(handle: Long): RustEpochHandleStatusFfiResult

  fun closeEpochKeyHandle(handle: Long): Int
}

class GeneratedRustEpochBridge(
  private val api: GeneratedRustEpochApi,
) : RustEpochBridge {
  override fun createEpoch(accountKeyHandle: AccountKeyHandle, epochId: Int): EpochCreateResult {
    require(epochId >= 0) { "epoch id must not be negative" }
    val result = api.createEpochKeyHandle(accountKeyHandle.value, epochId)
    return try {
      val code = when (result.code) {
        RustEpochStableCode.OK -> EpochCreateCode.SUCCESS
        RustEpochStableCode.SECRET_HANDLE_NOT_FOUND -> EpochCreateCode.ACCOUNT_HANDLE_NOT_FOUND
        RustEpochStableCode.HANDLE_SPACE_EXHAUSTED -> EpochCreateCode.HANDLE_SPACE_EXHAUSTED
        else -> EpochCreateCode.INTERNAL_ERROR
      }
      val handle = if (code == EpochCreateCode.SUCCESS && result.handle > 0) EpochKeyHandle(result.handle) else null
      val safeCode = if (code == EpochCreateCode.SUCCESS && handle == null) EpochCreateCode.INTERNAL_ERROR else code
      EpochCreateResult(
        code = safeCode,
        handle = if (safeCode == EpochCreateCode.SUCCESS) handle else null,
        epochId = result.epochId,
        wrappedEpochSeed = if (safeCode == EpochCreateCode.SUCCESS) result.wrappedEpochSeed else EMPTY_BYTES,
      )
    } finally {
      result.wipe()
    }
  }

  override fun openEpoch(
    wrappedEpochSeed: ByteArray,
    accountKeyHandle: AccountKeyHandle,
    epochId: Int,
  ): EpochOpenResult {
    require(epochId >= 0) { "epoch id must not be negative" }
    val result = api.openEpochKeyHandle(wrappedEpochSeed, accountKeyHandle.value, epochId)
    return try {
      val code = when (result.code) {
        RustEpochStableCode.OK -> EpochOpenCode.SUCCESS
        RustEpochStableCode.SECRET_HANDLE_NOT_FOUND -> EpochOpenCode.ACCOUNT_HANDLE_NOT_FOUND
        RustEpochStableCode.AUTHENTICATION_FAILED -> EpochOpenCode.AUTHENTICATION_FAILED
        RustEpochStableCode.WRAPPED_KEY_TOO_SHORT -> EpochOpenCode.WRAPPED_KEY_TOO_SHORT
        RustEpochStableCode.INVALID_INPUT_LENGTH,
        RustEpochStableCode.INVALID_KEY_LENGTH,
        -> EpochOpenCode.INVALID_INPUT_LENGTH
        RustEpochStableCode.HANDLE_SPACE_EXHAUSTED -> EpochOpenCode.HANDLE_SPACE_EXHAUSTED
        else -> EpochOpenCode.INTERNAL_ERROR
      }
      val handle = if (code == EpochOpenCode.SUCCESS && result.handle > 0) EpochKeyHandle(result.handle) else null
      val safeCode = if (code == EpochOpenCode.SUCCESS && handle == null) EpochOpenCode.INTERNAL_ERROR else code
      EpochOpenResult(
        code = safeCode,
        handle = if (safeCode == EpochOpenCode.SUCCESS) handle else null,
        epochId = result.epochId,
      )
    } finally {
      result.wipe()
    }
  }

  override fun isEpochOpen(handle: EpochKeyHandle): Boolean {
    val status = api.epochKeyHandleIsOpen(handle.value)
    return status.code == RustEpochStableCode.OK && status.isOpen
  }

  override fun closeEpoch(handle: EpochKeyHandle): EpochCloseCode = when (api.closeEpochKeyHandle(handle.value)) {
    RustEpochStableCode.OK -> EpochCloseCode.SUCCESS
    RustEpochStableCode.EPOCH_HANDLE_NOT_FOUND,
    RustEpochStableCode.SECRET_HANDLE_NOT_FOUND,
    -> EpochCloseCode.NOT_FOUND
    else -> EpochCloseCode.INTERNAL_ERROR
  }

  companion object {
    private val EMPTY_BYTES: ByteArray = ByteArray(0)
  }
}

/**
 * Opens an epoch key handle and wipes the caller-owned `wrappedEpochSeed` after
 * the bridge returns, regardless of success or failure. Use this in any flow
 * where the caller will not need the wrapped seed bytes after the call.
 *
 * The wrapped seed is also zeroed inside the bridge's FFI request after Rust
 * marshalling completes; this extension wipes the caller's buffer too so the
 * combined wipe-chain leaves no clear-on-disk references in heap memory.
 */
fun RustEpochBridge.openEpochWipingWrappedSeed(
  wrappedEpochSeed: ByteArray,
  accountKeyHandle: AccountKeyHandle,
  epochId: Int,
): EpochOpenResult =
  try {
    openEpoch(wrappedEpochSeed, accountKeyHandle, epochId)
  } finally {
    wrappedEpochSeed.fill(0)
  }
