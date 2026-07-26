package org.mosaic.android.main.crypto

import java.io.InputStream
import org.mosaic.android.foundation.RustShardStableCode
import org.mosaic.android.main.bridge.AndroidRustShardApi
import org.mosaic.android.main.security.useZeroized
import org.mosaic.android.main.security.zeroize
import uniffi.mosaic_uniffi.StreamingEncryptor


internal class EncryptedShardEnvelope private constructor(
  val bytes: ByteArray,
  val envelopeVersion: Int,
  val blobFormatVersion: Int,
) {
  companion object {
    fun fromBytes(bytes: ByteArray): EncryptedShardEnvelope =
      EncryptedShardEnvelope(
        bytes,
        ShardEnvelopeVersions.fromEnvelopeBytes(bytes),
        ShardBlobFormatVersions.CURRENT,
      )
  }
}

internal object ShardBlobFormatVersions {
  const val CURRENT: Int = 1
}

internal object ShardEnvelopeVersions {
  const val V03: Int = 0x03
  const val V04: Int = 0x04

  private const val VERSION_OFFSET: Int = 4
  private const val HEADER_PREFIX_BYTES: Int = VERSION_OFFSET + 1
  private val MAGIC: ByteArray = byteArrayOf(
    'S'.code.toByte(),
    'G'.code.toByte(),
    'z'.code.toByte(),
    'k'.code.toByte(),
  )

  fun fromEnvelopeBytes(envelope: ByteArray): Int {
    require(envelope.size >= HEADER_PREFIX_BYTES) { "encrypted shard is missing its envelope prefix" }
    require(MAGIC.indices.all { envelope[it] == MAGIC[it] }) { "encrypted shard has an invalid envelope magic" }
    val version = envelope[VERSION_OFFSET].toInt() and 0xff
    require(isSupported(version)) { "encrypted shard has an unsupported envelope version" }
    return version
  }

  fun readVersion(input: InputStream): Int {
    val prefix = ByteArray(HEADER_PREFIX_BYTES)
    var offset = 0
    while (offset < prefix.size) {
      val read = input.read(prefix, offset, prefix.size - offset)
      if (read > 0) {
        offset += read
      } else {
        val next = input.read()
        require(next >= 0) { "encrypted shard is missing its envelope prefix" }
        prefix[offset] = next.toByte()
        offset += 1
      }
    }
    return fromEnvelopeBytes(prefix)
  }

  fun isSupported(version: Int): Boolean = version == V03 || version == V04
}

internal interface ShardCryptoEngine {
  fun encryptShardWithEpochHandle(
    epochHandleId: Long,
    plaintext: ByteArray,
    tier: Int,
    shardIndex: Int,
  ): EncryptedShardEnvelope

  fun encryptStreamingShard(
    epochHandleId: Long,
    plaintext: InputStream,
    plaintextLength: Long,
    tier: Int,
    shardIndex: Int,
  ): EncryptedShardEnvelope
}

internal class AndroidShardCryptoEngine(
  private val rustShardApi: AndroidRustShardApi = AndroidRustShardApi(),
) : ShardCryptoEngine {
  override fun encryptShardWithEpochHandle(
    epochHandleId: Long,
    plaintext: ByteArray,
    tier: Int,
    shardIndex: Int,
  ): EncryptedShardEnvelope {
    val result = rustShardApi.encryptShardWithEpochHandle(
      epochKeyHandle = epochHandleId.toULong(),
      plaintext = plaintext,
      shardIndex = shardIndex,
      tier = tier,
    )
    return try {
      if (result.code != RustShardStableCode.OK) {
        throw ShardEncryptionException("single-shot shard encryption failed with stable code ${result.code}")
      }
      EncryptedShardEnvelope.fromBytes(result.envelopeBytes.copyOf())
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
  ): EncryptedShardEnvelope {
    val frameCount = ((plaintextLength + ShardEncryptionWorker.STREAMING_FRAME_BYTES - 1) /
      ShardEncryptionWorker.STREAMING_FRAME_BYTES).coerceAtLeast(1)
    val encryptor = StreamingEncryptor(
      epochHandleId = epochHandleId.toULong(),
      tier = tier.toUByte(),
      expectedFrameCount = frameCount.toUInt(),
    )
    try {
      val buffer = ByteArray(ShardEncryptionWorker.STREAMING_FRAME_BYTES)
      try {
        while (true) {
          val read = plaintext.read(buffer)
          if (read <= 0) break
          buffer.copyOf(read).useZeroized { frame ->
            encryptor.encryptFrame(frame)
          }
        }
      } finally {
        buffer.zeroize()
      }
      return EncryptedShardEnvelope.fromBytes(encryptor.finalize())
    } finally {
      encryptor.close()
    }
  }
}

internal class ShardEncryptionException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)
