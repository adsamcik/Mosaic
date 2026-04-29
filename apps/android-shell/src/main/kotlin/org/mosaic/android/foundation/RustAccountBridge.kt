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
    require(memoryKiB <= MAX_MEMORY_KIB) { "KDF memory must not exceed $MAX_MEMORY_KIB" }
    require(iterations <= MAX_ITERATIONS) { "KDF iterations must not exceed $MAX_ITERATIONS" }
    require(parallelism <= MAX_PARALLELISM) { "KDF parallelism must not exceed $MAX_PARALLELISM" }
  }

  companion object {
    /** Mosaic resource-exhaustion guardrail: 256 MiB. Mirrors Rust `MAX_KDF_MEMORY_KIB`. */
    const val MAX_MEMORY_KIB: Int = 262_144

    /** Mosaic resource-exhaustion guardrail: 10. Mirrors Rust `MAX_KDF_ITERATIONS`. */
    const val MAX_ITERATIONS: Int = 10

    /** Mosaic resource-exhaustion guardrail: 4. Mirrors Rust `MAX_KDF_PARALLELISM`. */
    const val MAX_PARALLELISM: Int = 4
  }
}

class AccountUnlockRequest(
  userSalt: ByteArray,
  accountSalt: ByteArray,
  wrappedAccountKey: ByteArray,
  val kdfProfile: KdfProfile,
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

  fun hasValidSaltLengths(): Boolean = userSaltBytes.size == SALT_LENGTH && accountSaltBytes.size == SALT_LENGTH

  /**
   * Zeroes out internal salt and wrapped-key buffers in place. After calling
   * this, accessor properties still return ByteArrays of the original length
   * but filled with zero bytes. Idempotent. Safe to call after the request
   * has been forwarded to the Rust core.
   */
  fun wipe() {
    userSaltBytes.fill(0)
    accountSaltBytes.fill(0)
    wrappedAccountKeyBytes.fill(0)
  }

  override fun toString(): String =
    "AccountUnlockRequest(userSalt=<redacted>, accountSalt=<redacted>, " +
      "wrappedAccountKey=<redacted>, kdfProfile=$kdfProfile)"

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

/**
 * Convenience wrapper that wipes BOTH the caller-owned password buffer AND the
 * [AccountUnlockRequest]'s internal salt/wrapped-key buffers after the unlock
 * call returns (success or failure). Use this when the request will be
 * discarded after the call.
 */
fun RustAccountBridge.unlockAccountWipingAll(
  password: ByteArray,
  request: AccountUnlockRequest,
): AccountUnlockResult =
  try {
    unlockAccount(password, request)
  } finally {
    password.fill(0)
    request.wipe()
  }
