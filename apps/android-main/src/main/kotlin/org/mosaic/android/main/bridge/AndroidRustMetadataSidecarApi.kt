package org.mosaic.android.main.bridge

import org.mosaic.android.foundation.GeneratedRustMetadataSidecarApi
import org.mosaic.android.foundation.RustBytesFfiResult
import org.mosaic.android.foundation.RustEncryptedShardFfiResult
import uniffi.mosaic_uniffi.canonicalMediaMetadataSidecarBytes as rustCanonicalMediaMetadataSidecarBytes
import uniffi.mosaic_uniffi.canonicalMetadataSidecarBytes as rustCanonicalMetadataSidecarBytes
import uniffi.mosaic_uniffi.encryptMediaMetadataSidecarWithEpochHandle as rustEncryptMediaMetadataSidecarWithEpochHandle
import uniffi.mosaic_uniffi.encryptMetadataSidecarWithEpochHandle as rustEncryptMetadataSidecarWithEpochHandle

/** Real implementation of [GeneratedRustMetadataSidecarApi] backed by the Rust UniFFI core. */
class AndroidRustMetadataSidecarApi : GeneratedRustMetadataSidecarApi {

  init {
    AndroidRustCoreLibraryLoader.warmUp()
  }

  override fun canonicalMetadataSidecarBytes(
    albumId: ByteArray,
    photoId: ByteArray,
    epochId: Int,
    encodedFields: ByteArray,
  ): RustBytesFfiResult {
    require(epochId >= 0) { "epoch id must not be negative" }
    val result = rustCanonicalMetadataSidecarBytes(albumId, photoId, epochId.toUInt(), encodedFields)
    return RustBytesFfiResult(code = result.code.toInt(), bytes = result.bytes)
  }

  override fun encryptMetadataSidecarWithEpochHandle(
    handle: Long,
    albumId: ByteArray,
    photoId: ByteArray,
    epochId: Int,
    encodedFields: ByteArray,
    shardIndex: Int,
  ): RustEncryptedShardFfiResult {
    require(epochId >= 0) { "epoch id must not be negative" }
    require(shardIndex >= 0) { "shard index must not be negative" }
    val result = rustEncryptMetadataSidecarWithEpochHandle(
      handle = handle.toULong(),
      albumId = albumId,
      photoId = photoId,
      epochId = epochId.toUInt(),
      encodedFields = encodedFields,
      shardIndex = shardIndex.toUInt(),
    )
    return RustEncryptedShardFfiResult(
      code = result.code.toInt(),
      envelopeBytes = result.envelopeBytes,
      sha256 = result.sha256,
    )
  }

  override fun canonicalMediaMetadataSidecarBytes(
    albumId: ByteArray,
    photoId: ByteArray,
    epochId: Int,
    mediaBytes: ByteArray,
  ): RustBytesFfiResult {
    require(epochId >= 0) { "epoch id must not be negative" }
    val result = rustCanonicalMediaMetadataSidecarBytes(albumId, photoId, epochId.toUInt(), mediaBytes)
    return RustBytesFfiResult(code = result.code.toInt(), bytes = result.bytes)
  }

  override fun encryptMediaMetadataSidecarWithEpochHandle(
    handle: Long,
    albumId: ByteArray,
    photoId: ByteArray,
    epochId: Int,
    mediaBytes: ByteArray,
    shardIndex: Int,
  ): RustEncryptedShardFfiResult {
    require(epochId >= 0) { "epoch id must not be negative" }
    require(shardIndex >= 0) { "shard index must not be negative" }
    val result = rustEncryptMediaMetadataSidecarWithEpochHandle(
      handle = handle.toULong(),
      albumId = albumId,
      photoId = photoId,
      epochId = epochId.toUInt(),
      mediaBytes = mediaBytes,
      shardIndex = shardIndex.toUInt(),
    )
    return RustEncryptedShardFfiResult(
      code = result.code.toInt(),
      envelopeBytes = result.envelopeBytes,
      sha256 = result.sha256,
    )
  }
}
