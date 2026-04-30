package org.mosaic.android.foundation

object RustClientStableCode {
  const val OK: Int = 0
  const val AUTHENTICATION_FAILED: Int = 205
  const val WRAPPED_KEY_TOO_SHORT: Int = 207
  const val KDF_PROFILE_TOO_WEAK: Int = 208
  const val INVALID_SALT_LENGTH: Int = 209
  const val KDF_PROFILE_TOO_COSTLY: Int = 214
  const val SECRET_HANDLE_NOT_FOUND: Int = 400
}

class RustAccountUnlockFfiRequest private constructor(
  userSalt: ByteArray,
  accountSalt: ByteArray,
  wrappedAccountKey: ByteArray,
  val kdfMemoryKiB: Int,
  val kdfIterations: Int,
  val kdfParallelism: Int,
) {
  private val userSaltBytes: ByteArray = userSalt.copyOf()
  private val accountSaltBytes: ByteArray = accountSalt.copyOf()
  private val wrappedAccountKeyBytes: ByteArray = wrappedAccountKey.copyOf()

  val userSalt: ByteArray
    get() = userSaltBytes.copyOf()

  val accountSalt: ByteArray
    get() = accountSaltBytes.copyOf()

  val wrappedAccountKey: ByteArray
    get() = wrappedAccountKeyBytes.copyOf()

  override fun toString(): String =
    "RustAccountUnlockFfiRequest(userSalt=<redacted>, accountSalt=<redacted>, " +
      "wrappedAccountKey=<redacted>, kdfMemoryKiB=$kdfMemoryKiB, " +
      "kdfIterations=$kdfIterations, kdfParallelism=$kdfParallelism)"

  companion object {
    fun from(request: AccountUnlockRequest): RustAccountUnlockFfiRequest = RustAccountUnlockFfiRequest(
      userSalt = request.userSalt,
      accountSalt = request.accountSalt,
      wrappedAccountKey = request.wrappedAccountKey,
      kdfMemoryKiB = request.kdfProfile.memoryKiB,
      kdfIterations = request.kdfProfile.iterations,
      kdfParallelism = request.kdfProfile.parallelism,
    )
  }
}

data class RustAccountUnlockFfiResult(
  val code: Int,
  val handle: Long,
) {
  // Redacts the raw account-key handle Long. Per SPEC-CrossPlatformHardening
  // "Android shell" checklist: DTO toString methods must redact handles. The
  // handle is an opaque capability; logging its raw value would leak the same
  // information `AccountKeyHandle.toString()` already redacts.
  override fun toString(): String =
    "RustAccountUnlockFfiResult(code=$code, handle=<redacted>)"
}

data class RustAccountKeyHandleStatusFfiResult(
  val code: Int,
  val isOpen: Boolean,
)

interface GeneratedRustAccountApi {
  fun protocolVersion(): String

  fun unlockAccountKey(
    password: ByteArray,
    request: RustAccountUnlockFfiRequest,
  ): RustAccountUnlockFfiResult

  fun accountKeyHandleIsOpen(handle: Long): RustAccountKeyHandleStatusFfiResult

  fun closeAccountKeyHandle(handle: Long): Int
}

class GeneratedRustAccountBridge(
  private val api: GeneratedRustAccountApi,
) : RustAccountBridge {
  override fun protocolVersion(): String {
    val version = api.protocolVersion()
    require(version.isNotBlank()) { "Rust protocol version is required" }
    return version
  }

  override fun unlockAccount(password: ByteArray, request: AccountUnlockRequest): AccountUnlockResult {
    val result = api.unlockAccountKey(password, RustAccountUnlockFfiRequest.from(request))
    val code = accountUnlockCodeFromStableCode(result.code)
    return if (code == AccountUnlockCode.SUCCESS && result.handle > 0) {
      AccountUnlockResult(AccountUnlockCode.SUCCESS, AccountKeyHandle(result.handle))
    } else {
      AccountUnlockResult(
        code = if (code == AccountUnlockCode.SUCCESS) AccountUnlockCode.INTERNAL_ERROR else code,
        handle = null,
      )
    }
  }

  override fun isAccountKeyHandleOpen(handle: AccountKeyHandle): Boolean {
    val status = api.accountKeyHandleIsOpen(handle.value)
    return status.code == RustClientStableCode.OK && status.isOpen
  }

  override fun closeAccountKeyHandle(handle: AccountKeyHandle): AccountCloseCode =
    when (api.closeAccountKeyHandle(handle.value)) {
      RustClientStableCode.OK -> AccountCloseCode.SUCCESS
      RustClientStableCode.SECRET_HANDLE_NOT_FOUND -> AccountCloseCode.NOT_FOUND
      else -> AccountCloseCode.INTERNAL_ERROR
    }
}

private fun accountUnlockCodeFromStableCode(code: Int): AccountUnlockCode =
  when (code) {
    RustClientStableCode.OK -> AccountUnlockCode.SUCCESS
    RustClientStableCode.AUTHENTICATION_FAILED -> AccountUnlockCode.AUTHENTICATION_FAILED
    RustClientStableCode.WRAPPED_KEY_TOO_SHORT -> AccountUnlockCode.WRAPPED_KEY_TOO_SHORT
    RustClientStableCode.KDF_PROFILE_TOO_WEAK -> AccountUnlockCode.KDF_PROFILE_TOO_WEAK
    RustClientStableCode.INVALID_SALT_LENGTH -> AccountUnlockCode.INVALID_SALT_LENGTH
    RustClientStableCode.KDF_PROFILE_TOO_COSTLY -> AccountUnlockCode.KDF_PROFILE_TOO_COSTLY
    else -> AccountUnlockCode.INTERNAL_ERROR
  }