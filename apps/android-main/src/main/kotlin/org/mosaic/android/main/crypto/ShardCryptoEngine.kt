package org.mosaic.android.main.crypto

import java.io.InputStream
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
    plaintext: InputStream,
    plaintextLength: Long,
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
    plaintext: InputStream,
    plaintextLength: Long,
    tier: Int,
    shardIndex: Int,
  ): ByteArray {
    val frameCount = ((plaintextLength + ShardEncryptionWorker.STREAMING_FRAME_BYTES - 1) /
      ShardEncryptionWorker.STREAMING_FRAME_BYTES).coerceAtLeast(1)
    val encryptor = StreamingEncryptor(
      epochHandleId = epochHandleId.toULong(),
      tier = tier.toUByte(),
      expectedFrameCount = frameCount.toUInt(),
    )
    try {
      val buffer = ByteArray(ShardEncryptionWorker.STREAMING_FRAME_BYTES)
      while (true) {
        val read = plaintext.read(buffer)
        if (read <= 0) break
        encryptor.encryptFrame(buffer.copyOf(read))
      }
      return encryptor.finalize()
    } finally {
      encryptor.close()
    }
  }
}

internal class ShardEncryptionException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)
