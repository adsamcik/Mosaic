package org.mosaic.android.main.crypto

import org.mosaic.android.foundation.RustShardStableCode
import org.mosaic.android.main.bridge.AndroidRustShardApi
import uniffi.mosaic_uniffi.StreamingEncryptor

internal interface ShardCryptoEngine {
  fun encryptShardWithEpochHandle(
    epochHandleId: Long,
    plaintext: ByteArray,
    tier: Int,
    shardIndex: Int,
  ): ByteArray

  fun encryptStreamingShard(
    epochHandleId: Long,
    plaintext: ByteArray,
    tier: Int,
    shardIndex: Int,
  ): ByteArray
}

internal class AndroidShardCryptoEngine(
  private val rustShardApi: AndroidRustShardApi = AndroidRustShardApi(),
) : ShardCryptoEngine {
  override fun encryptShardWithEpochHandle(
    epochHandleId: Long,
    plaintext: ByteArray,
    tier: Int,
    shardIndex: Int,
  ): ByteArray {
    val result = rustShardApi.encryptShardWithEpochHandle(
      epochKeyHandle = epochHandleId,
      plaintext = plaintext,
      shardIndex = shardIndex,
      tier = tier,
    )
    return try {
      if (result.code != RustShardStableCode.OK) {
        throw ShardEncryptionException("single-shot shard encryption failed with stable code ${result.code}")
      }
      result.envelopeBytes.copyOf()
    } finally {
      result.wipe()
    }
  }

  override fun encryptStreamingShard(
    epochHandleId: Long,
    plaintext: ByteArray,
    tier: Int,
    shardIndex: Int,
  ): ByteArray {
    val frameCount = ((plaintext.size + ShardEncryptionWorker.STREAMING_FRAME_BYTES - 1) /
      ShardEncryptionWorker.STREAMING_FRAME_BYTES).coerceAtLeast(1)
    val encryptor = StreamingEncryptor(
      epochHandleId = epochHandleId.toULong(),
      tier = tier.toUByte(),
      expectedFrameCount = frameCount.toUInt(),
    )
    try {
      var offset = 0
      while (offset < plaintext.size) {
        val end = minOf(offset + ShardEncryptionWorker.STREAMING_FRAME_BYTES, plaintext.size)
        encryptor.encryptFrame(plaintext.copyOfRange(offset, end))
        offset = end
      }
      return encryptor.finalize()
    } finally {
      encryptor.close()
    }
  }
}

internal class ShardEncryptionException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)
