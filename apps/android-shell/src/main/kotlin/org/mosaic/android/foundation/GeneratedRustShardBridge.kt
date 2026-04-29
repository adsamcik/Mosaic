package org.mosaic.android.foundation

object RustShardStableCode {
  const val OK: Int = 0
  const val EMPTY_CONTEXT: Int = 200
  const val INVALID_KEY_LENGTH: Int = 201
  const val INVALID_INPUT_LENGTH: Int = 202
  const val INVALID_ENVELOPE: Int = 203
  const val MISSING_CIPHERTEXT: Int = 204
  const val AUTHENTICATION_FAILED: Int = 205
  const val RNG_FAILURE: Int = 206
  const val EPOCH_HANDLE_NOT_FOUND: Int = 403
  const val INTERNAL_STATE_POISONED: Int = 500
}

enum class ShardEncryptCode {
  SUCCESS,
  EPOCH_HANDLE_NOT_FOUND,
  INVALID_INPUT_LENGTH,
  RNG_FAILURE,
  INTERNAL_ERROR,
}

enum class ShardDecryptCode {
  SUCCESS,
  EPOCH_HANDLE_NOT_FOUND,
  INVALID_ENVELOPE,
  AUTHENTICATION_FAILED,
  INVALID_INPUT_LENGTH,
  INTERNAL_ERROR,
}

class EncryptedShardEnvelope(
  envelopeBytes: ByteArray,
  val sha256: String,
) {
  init {
    require(envelopeBytes.isNotEmpty()) { "envelope bytes must not be empty" }
    require(sha256.length == SHA256_HEX_LENGTH) { "sha256 hex must be $SHA256_HEX_LENGTH characters" }
    require(sha256.all { it.isDigit() || (it in 'a'..'f') || (it in 'A'..'F') }) {
      "sha256 must be lowercase or uppercase hexadecimal"
    }
  }

  private val envelopeBytesCopy: ByteArray = envelopeBytes.copyOf()

  val envelopeBytes: ByteArray
    get() = envelopeBytesCopy.copyOf()

  override fun toString(): String =
    "EncryptedShardEnvelope(envelopeBytes=<redacted>, sha256=$sha256)"

  companion object {
    const val SHA256_HEX_LENGTH: Int = 64
  }
}

data class ShardEncryptResult(
  val code: ShardEncryptCode,
  val envelope: EncryptedShardEnvelope?,
) {
  init {
    require((code == ShardEncryptCode.SUCCESS) == (envelope != null)) {
      "successful shard encryption must include the envelope; failures must not"
    }
  }
}

/**
 * Decrypted shard plaintext. Holds caller-owned plaintext media bytes; intentionally
 * does NOT override toString to avoid printing sensitive content. Wipe via [wipe]
 * before discarding.
 */
class DecryptedShard(
  plaintext: ByteArray,
) {
  init {
    require(plaintext.isNotEmpty()) { "decrypted plaintext must not be empty" }
  }

  private val plaintextBytes: ByteArray = plaintext.copyOf()
  private var wiped: Boolean = false

  val plaintext: ByteArray
    get() {
      check(!wiped) { "decrypted shard plaintext has been wiped" }
      return plaintextBytes.copyOf()
    }

  fun wipe() {
    plaintextBytes.fill(0)
    wiped = true
  }

  override fun toString(): String = "DecryptedShard(<redacted>)"
}

data class ShardDecryptResult(
  val code: ShardDecryptCode,
  val shard: DecryptedShard?,
) {
  init {
    require((code == ShardDecryptCode.SUCCESS) == (shard != null)) {
      "successful shard decryption must include plaintext; failures must not"
    }
  }
}

interface RustShardBridge {
  fun encryptShard(
    epochKeyHandle: EpochKeyHandle,
    plaintext: ByteArray,
    shardIndex: Int,
    tier: Int,
  ): ShardEncryptResult

  fun decryptShard(
    epochKeyHandle: EpochKeyHandle,
    envelopeBytes: ByteArray,
  ): ShardDecryptResult
}

data class RustEncryptedShardFfiResult(
  val code: Int,
  val envelopeBytes: ByteArray,
  val sha256: String,
) {
  init {
    require(code >= 0) { "shard code must not be negative" }
  }

  override fun toString(): String =
    "RustEncryptedShardFfiResult(code=$code, envelopeBytes=<redacted>, sha256=<redacted>)"

  override fun equals(other: Any?): Boolean {
    if (this === other) return true
    if (other !is RustEncryptedShardFfiResult) return false
    return code == other.code && envelopeBytes.contentEquals(other.envelopeBytes) && sha256 == other.sha256
  }

  override fun hashCode(): Int {
    var result = code
    result = 31 * result + envelopeBytes.contentHashCode()
    result = 31 * result + sha256.hashCode()
    return result
  }
}

class RustDecryptedShardFfiResult(
  val code: Int,
  plaintext: ByteArray,
) {
  init {
    require(code >= 0) { "shard code must not be negative" }
  }

  private val plaintextBytes: ByteArray = plaintext.copyOf()

  val plaintext: ByteArray
    get() = plaintextBytes.copyOf()

  fun wipe() {
    plaintextBytes.fill(0)
  }

  override fun toString(): String = "RustDecryptedShardFfiResult(code=$code, plaintext=<redacted>)"
}

interface GeneratedRustShardApi {
  fun encryptShardWithEpochHandle(
    epochKeyHandle: Long,
    plaintext: ByteArray,
    shardIndex: Int,
    tier: Int,
  ): RustEncryptedShardFfiResult

  fun decryptShardWithEpochHandle(
    epochKeyHandle: Long,
    envelopeBytes: ByteArray,
  ): RustDecryptedShardFfiResult
}

class GeneratedRustShardBridge(
  private val api: GeneratedRustShardApi,
) : RustShardBridge {
  override fun encryptShard(
    epochKeyHandle: EpochKeyHandle,
    plaintext: ByteArray,
    shardIndex: Int,
    tier: Int,
  ): ShardEncryptResult {
    require(plaintext.isNotEmpty()) { "shard plaintext must not be empty" }
    require(shardIndex >= 0) { "shard index must not be negative" }
    require(tier in TIER_THUMB..TIER_ORIGINAL) { "tier must be within [$TIER_THUMB, $TIER_ORIGINAL]" }
    val result = api.encryptShardWithEpochHandle(epochKeyHandle.value, plaintext, shardIndex, tier)
    val code = encryptCodeFor(result.code)
    val envelope = if (code == ShardEncryptCode.SUCCESS) {
      runCatching { EncryptedShardEnvelope(result.envelopeBytes, result.sha256) }.getOrNull()
    } else null
    val safeCode = if (code == ShardEncryptCode.SUCCESS && envelope == null) ShardEncryptCode.INTERNAL_ERROR else code
    return ShardEncryptResult(safeCode, if (safeCode == ShardEncryptCode.SUCCESS) envelope else null)
  }

  override fun decryptShard(epochKeyHandle: EpochKeyHandle, envelopeBytes: ByteArray): ShardDecryptResult {
    require(envelopeBytes.isNotEmpty()) { "envelope bytes must not be empty" }
    val result = api.decryptShardWithEpochHandle(epochKeyHandle.value, envelopeBytes)
    return try {
      val code = decryptCodeFor(result.code)
      val shard = if (code == ShardDecryptCode.SUCCESS) {
        runCatching { DecryptedShard(result.plaintext) }.getOrNull()
      } else null
      val safeCode = if (code == ShardDecryptCode.SUCCESS && shard == null) ShardDecryptCode.INTERNAL_ERROR else code
      ShardDecryptResult(safeCode, if (safeCode == ShardDecryptCode.SUCCESS) shard else null)
    } finally {
      result.wipe()
    }
  }

  private fun encryptCodeFor(code: Int): ShardEncryptCode = when (code) {
    RustShardStableCode.OK -> ShardEncryptCode.SUCCESS
    RustShardStableCode.EPOCH_HANDLE_NOT_FOUND -> ShardEncryptCode.EPOCH_HANDLE_NOT_FOUND
    RustShardStableCode.INVALID_INPUT_LENGTH,
    RustShardStableCode.INVALID_KEY_LENGTH,
    RustShardStableCode.EMPTY_CONTEXT,
    -> ShardEncryptCode.INVALID_INPUT_LENGTH
    RustShardStableCode.RNG_FAILURE -> ShardEncryptCode.RNG_FAILURE
    else -> ShardEncryptCode.INTERNAL_ERROR
  }

  private fun decryptCodeFor(code: Int): ShardDecryptCode = when (code) {
    RustShardStableCode.OK -> ShardDecryptCode.SUCCESS
    RustShardStableCode.EPOCH_HANDLE_NOT_FOUND -> ShardDecryptCode.EPOCH_HANDLE_NOT_FOUND
    RustShardStableCode.INVALID_ENVELOPE,
    RustShardStableCode.MISSING_CIPHERTEXT,
    -> ShardDecryptCode.INVALID_ENVELOPE
    RustShardStableCode.AUTHENTICATION_FAILED -> ShardDecryptCode.AUTHENTICATION_FAILED
    RustShardStableCode.INVALID_INPUT_LENGTH,
    RustShardStableCode.INVALID_KEY_LENGTH,
    -> ShardDecryptCode.INVALID_INPUT_LENGTH
    else -> ShardDecryptCode.INTERNAL_ERROR
  }

  companion object {
    const val TIER_THUMB: Int = 1
    const val TIER_PREVIEW: Int = 2
    const val TIER_ORIGINAL: Int = 3
  }
}

/**
 * Encrypts a caller-owned plaintext shard and zeroes the caller's plaintext buffer
 * after the bridge returns, regardless of success or failure. Use this in any flow
 * where the caller will not need the plaintext bytes after the call.
 */
fun RustShardBridge.encryptShardWipingPlaintext(
  epochKeyHandle: EpochKeyHandle,
  plaintext: ByteArray,
  shardIndex: Int,
  tier: Int,
): ShardEncryptResult =
  try {
    encryptShard(epochKeyHandle, plaintext, shardIndex, tier)
  } finally {
    plaintext.fill(0)
  }
