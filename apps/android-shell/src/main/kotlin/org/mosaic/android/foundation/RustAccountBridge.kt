package org.mosaic.android.foundation

data class KdfProfile(
  val memoryKiB: Int,
  val iterations: Int,
  val parallelism: Int,
) {
  init {
    require(memoryKiB > 0) { "KDF memory must be positive" }
    require(iterations > 0) { "KDF iterations must be positive" }
    require(parallelism > 0) { "KDF parallelism must be positive" }
  }
}

class AccountUnlockRequest(
  userSalt: ByteArray,
  accountSalt: ByteArray,
  wrappedAccountKey: ByteArray,
  val kdfProfile: KdfProfile,
) {
  val userSalt: ByteArray = userSalt.copyOf()
  val accountSalt: ByteArray = accountSalt.copyOf()
  val wrappedAccountKey: ByteArray = wrappedAccountKey.copyOf()

  fun hasValidSaltLengths(): Boolean = userSalt.size == SALT_LENGTH && accountSalt.size == SALT_LENGTH

  companion object {
    const val SALT_LENGTH: Int = 16
  }
}

enum class AccountUnlockCode {
  SUCCESS,
  AUTHENTICATION_FAILED,
  INVALID_SALT_LENGTH,
  WRAPPED_KEY_TOO_SHORT,
  KDF_PROFILE_TOO_WEAK,
  KDF_PROFILE_TOO_COSTLY,
  INTERNAL_ERROR,
}

data class AccountUnlockResult(
  val code: AccountUnlockCode,
  val handle: AccountKeyHandle?,
) {
  init {
    require((code == AccountUnlockCode.SUCCESS) == (handle != null)) {
      "successful account unlocks require an opaque handle; failures must not include one"
    }
  }
}

enum class AccountCloseCode {
  SUCCESS,
  NOT_FOUND,
  INTERNAL_ERROR,
}

interface RustAccountBridge {
  fun protocolVersion(): String

  /**
   * Unlocks an account-key handle from caller-owned password bytes.
   *
   * Implementations must not retain this buffer. Platform callers should prefer
   * [unlockAccountAndWipePassword] so the Kotlin-owned buffer is wiped after the
   * bridge call returns; Rust can only wipe its received copy.
   */
  fun unlockAccount(password: ByteArray, request: AccountUnlockRequest): AccountUnlockResult

  fun isAccountKeyHandleOpen(handle: AccountKeyHandle): Boolean

  fun closeAccountKeyHandle(handle: AccountKeyHandle): AccountCloseCode
}

fun RustAccountBridge.unlockAccountAndWipePassword(
  password: ByteArray,
  request: AccountUnlockRequest,
): AccountUnlockResult =
  try {
    unlockAccount(password, request)
  } finally {
    password.fill(0)
  }
