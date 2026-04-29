package org.mosaic.android.main.bridge

import org.mosaic.android.foundation.GeneratedRustShardApi
import org.mosaic.android.foundation.RustDecryptedShardFfiResult
import org.mosaic.android.foundation.RustEncryptedShardFfiResult
import uniffi.mosaic_uniffi.decryptShardWithEpochHandle as rustDecryptShardWithEpochHandle
import uniffi.mosaic_uniffi.encryptShardWithEpochHandle as rustEncryptShardWithEpochHandle

/** Real implementation of [GeneratedRustShardApi] backed by the Rust UniFFI core. */
class AndroidRustShardApi : GeneratedRustShardApi {

  init {
    AndroidRustCoreLibraryLoader.warmUp()
  }

  override fun encryptShardWithEpochHandle(
    epochKeyHandle: Long,
    plaintext: ByteArray,
    shardIndex: Int,
    tier: Int,
  ): RustEncryptedShardFfiResult {
    require(plaintext.isNotEmpty()) { "shard plaintext must not be empty" }
    require(shardIndex >= 0) { "shard index must not be negative" }
    require(tier in MIN_TIER..MAX_TIER) { "tier must be within [$MIN_TIER, $MAX_TIER]" }
    val result = rustEncryptShardWithEpochHandle(
      handle = epochKeyHandle.toULong(),
      plaintext = plaintext,
      shardIndex = shardIndex.toUInt(),
      tierByte = tier.toUByte(),
    )
    return RustEncryptedShardFfiResult(
      code = result.code.toInt(),
      envelopeBytes = result.envelopeBytes,
      sha256 = result.sha256,
    )
  }

  override fun decryptShardWithEpochHandle(
    epochKeyHandle: Long,
    envelopeBytes: ByteArray,
  ): RustDecryptedShardFfiResult {
    require(envelopeBytes.isNotEmpty()) { "envelope bytes must not be empty" }
    val result = rustDecryptShardWithEpochHandle(epochKeyHandle.toULong(), envelopeBytes)
    return RustDecryptedShardFfiResult(
      code = result.code.toInt(),
      plaintext = result.plaintext,
    )
  }

  companion object {
    private const val MIN_TIER: Int = 1
    private const val MAX_TIER: Int = 3
  }
}
