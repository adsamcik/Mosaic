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
    require(shardIndex >= 0) { "shard index must not be negative" }
    require(tier in 0..255) { "tier byte must fit in u8" }
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
    val result = rustDecryptShardWithEpochHandle(epochKeyHandle.toULong(), envelopeBytes)
    return RustDecryptedShardFfiResult(
      code = result.code.toInt(),
      plaintext = result.plaintext,
    )
  }
}
