package org.mosaic.android.foundation

object RustMetadataSidecarStableCode {
  const val OK: Int = 0
  const val EMPTY_CONTEXT: Int = 200
  const val INVALID_KEY_LENGTH: Int = 201
  const val INVALID_INPUT_LENGTH: Int = 202
  const val RNG_FAILURE: Int = 206
  const val EPOCH_HANDLE_NOT_FOUND: Int = 403
  const val INTERNAL_STATE_POISONED: Int = 500
  const val UNSUPPORTED_MEDIA_FORMAT: Int = 600
  const val INVALID_MEDIA_CONTAINER: Int = 601
  const val INVALID_MEDIA_DIMENSIONS: Int = 602
  const val MEDIA_METADATA_MISMATCH: Int = 604
  const val INVALID_MEDIA_SIDECAR: Int = 605
}

enum class MetadataSidecarBuildCode {
  SUCCESS,
  INVALID_INPUT_LENGTH,
  INVALID_MEDIA_FORMAT,
  INVALID_MEDIA_CONTAINER,
  INVALID_MEDIA_DIMENSIONS,
  MEDIA_METADATA_MISMATCH,
  INVALID_MEDIA_SIDECAR,
  INTERNAL_ERROR,
}

enum class MetadataSidecarEncryptCode {
  SUCCESS,
  EPOCH_HANDLE_NOT_FOUND,
  INVALID_INPUT_LENGTH,
  INVALID_MEDIA_FORMAT,
  INVALID_MEDIA_CONTAINER,
  INVALID_MEDIA_DIMENSIONS,
  MEDIA_METADATA_MISMATCH,
  INVALID_MEDIA_SIDECAR,
  RNG_FAILURE,
  INTERNAL_ERROR,
}

class CanonicalMetadataSidecar(
  bytes: ByteArray,
) {
  init {
    require(bytes.isNotEmpty()) { "canonical metadata sidecar bytes must not be empty" }
  }

  private val bytesCopy: ByteArray = bytes.copyOf()

  val bytes: ByteArray
    get() = bytesCopy.copyOf()

  fun wipe() {
    bytesCopy.fill(0)
  }

  override fun toString(): String = "CanonicalMetadataSidecar(<redacted>)"
}

data class MetadataSidecarBuildResult(
  val code: MetadataSidecarBuildCode,
  val sidecar: CanonicalMetadataSidecar?,
) {
  init {
    require((code == MetadataSidecarBuildCode.SUCCESS) == (sidecar != null)) {
      "successful sidecar builds must include canonical bytes; failures must not"
    }
  }
}

data class MetadataSidecarEncryptResult(
  val code: MetadataSidecarEncryptCode,
  val envelope: EncryptedShardEnvelope?,
) {
  init {
    require((code == MetadataSidecarEncryptCode.SUCCESS) == (envelope != null)) {
      "successful sidecar encryption must include an envelope; failures must not"
    }
  }
}

class CanonicalMetadataSidecarRequest(
  albumId: ByteArray,
  photoId: ByteArray,
  val epochId: Int,
  encodedFields: ByteArray,
) {
  init {
    require(albumId.isNotEmpty()) { "album id must not be empty" }
    require(photoId.isNotEmpty()) { "photo id must not be empty" }
    require(epochId >= 0) { "epoch id must not be negative" }
  }

  private val albumIdBytes: ByteArray = albumId.copyOf()
  private val photoIdBytes: ByteArray = photoId.copyOf()
  private val encodedFieldsBytes: ByteArray = encodedFields.copyOf()

  val albumId: ByteArray
    get() = albumIdBytes.copyOf()

  val photoId: ByteArray
    get() = photoIdBytes.copyOf()

  val encodedFields: ByteArray
    get() = encodedFieldsBytes.copyOf()

  fun wipe() {
    albumIdBytes.fill(0)
    photoIdBytes.fill(0)
    encodedFieldsBytes.fill(0)
  }

  override fun toString(): String =
    "CanonicalMetadataSidecarRequest(albumId=<redacted>, photoId=<redacted>, epochId=$epochId, encodedFields=<redacted>)"
}

class EncryptMetadataSidecarRequest(
  val epochKeyHandle: EpochKeyHandle,
  albumId: ByteArray,
  photoId: ByteArray,
  val epochId: Int,
  encodedFields: ByteArray,
  val shardIndex: Int,
) {
  init {
    require(albumId.isNotEmpty()) { "album id must not be empty" }
    require(photoId.isNotEmpty()) { "photo id must not be empty" }
    require(epochId >= 0) { "epoch id must not be negative" }
    require(shardIndex >= 0) { "shard index must not be negative" }
  }

  private val albumIdBytes: ByteArray = albumId.copyOf()
  private val photoIdBytes: ByteArray = photoId.copyOf()
  private val encodedFieldsBytes: ByteArray = encodedFields.copyOf()

  val albumId: ByteArray
    get() = albumIdBytes.copyOf()

  val photoId: ByteArray
    get() = photoIdBytes.copyOf()

  val encodedFields: ByteArray
    get() = encodedFieldsBytes.copyOf()

  fun wipe() {
    albumIdBytes.fill(0)
    photoIdBytes.fill(0)
    encodedFieldsBytes.fill(0)
  }

  override fun toString(): String =
    "EncryptMetadataSidecarRequest(epochKeyHandle=$epochKeyHandle, albumId=<redacted>, " +
      "photoId=<redacted>, epochId=$epochId, encodedFields=<redacted>, shardIndex=$shardIndex)"
}

class CanonicalMediaMetadataSidecarRequest(
  albumId: ByteArray,
  photoId: ByteArray,
  val epochId: Int,
  mediaBytes: ByteArray,
) {
  init {
    require(albumId.isNotEmpty()) { "album id must not be empty" }
    require(photoId.isNotEmpty()) { "photo id must not be empty" }
    require(epochId >= 0) { "epoch id must not be negative" }
    require(mediaBytes.isNotEmpty()) { "media bytes must not be empty" }
  }

  private val albumIdBytes: ByteArray = albumId.copyOf()
  private val photoIdBytes: ByteArray = photoId.copyOf()
  private val mediaBytesCopy: ByteArray = mediaBytes.copyOf()

  val albumId: ByteArray
    get() = albumIdBytes.copyOf()

  val photoId: ByteArray
    get() = photoIdBytes.copyOf()

  val mediaBytes: ByteArray
    get() = mediaBytesCopy.copyOf()

  fun wipe() {
    albumIdBytes.fill(0)
    photoIdBytes.fill(0)
    mediaBytesCopy.fill(0)
  }

  override fun toString(): String =
    "CanonicalMediaMetadataSidecarRequest(albumId=<redacted>, photoId=<redacted>, epochId=$epochId, mediaBytes=<redacted>)"
}

class EncryptMediaMetadataSidecarRequest(
  val epochKeyHandle: EpochKeyHandle,
  albumId: ByteArray,
  photoId: ByteArray,
  val epochId: Int,
  mediaBytes: ByteArray,
  val shardIndex: Int,
) {
  init {
    require(albumId.isNotEmpty()) { "album id must not be empty" }
    require(photoId.isNotEmpty()) { "photo id must not be empty" }
    require(epochId >= 0) { "epoch id must not be negative" }
    require(mediaBytes.isNotEmpty()) { "media bytes must not be empty" }
    require(shardIndex >= 0) { "shard index must not be negative" }
  }

  private val albumIdBytes: ByteArray = albumId.copyOf()
  private val photoIdBytes: ByteArray = photoId.copyOf()
  private val mediaBytesCopy: ByteArray = mediaBytes.copyOf()

  val albumId: ByteArray
    get() = albumIdBytes.copyOf()

  val photoId: ByteArray
    get() = photoIdBytes.copyOf()

  val mediaBytes: ByteArray
    get() = mediaBytesCopy.copyOf()

  fun wipe() {
    albumIdBytes.fill(0)
    photoIdBytes.fill(0)
    mediaBytesCopy.fill(0)
  }

  override fun toString(): String =
    "EncryptMediaMetadataSidecarRequest(epochKeyHandle=$epochKeyHandle, albumId=<redacted>, " +
      "photoId=<redacted>, epochId=$epochId, mediaBytes=<redacted>, shardIndex=$shardIndex)"
}

interface RustMetadataSidecarBridge {
  fun canonicalMetadataSidecar(request: CanonicalMetadataSidecarRequest): MetadataSidecarBuildResult

  fun encryptMetadataSidecar(request: EncryptMetadataSidecarRequest): MetadataSidecarEncryptResult

  fun canonicalMediaMetadataSidecar(request: CanonicalMediaMetadataSidecarRequest): MetadataSidecarBuildResult

  fun encryptMediaMetadataSidecar(request: EncryptMediaMetadataSidecarRequest): MetadataSidecarEncryptResult
}

interface GeneratedRustMetadataSidecarApi {
  fun canonicalMetadataSidecarBytes(
    albumId: ByteArray,
    photoId: ByteArray,
    epochId: Int,
    encodedFields: ByteArray,
  ): RustBytesFfiResult

  fun encryptMetadataSidecarWithEpochHandle(
    handle: Long,
    albumId: ByteArray,
    photoId: ByteArray,
    epochId: Int,
    encodedFields: ByteArray,
    shardIndex: Int,
  ): RustEncryptedShardFfiResult

  fun canonicalMediaMetadataSidecarBytes(
    albumId: ByteArray,
    photoId: ByteArray,
    epochId: Int,
    mediaBytes: ByteArray,
  ): RustBytesFfiResult

  fun encryptMediaMetadataSidecarWithEpochHandle(
    handle: Long,
    albumId: ByteArray,
    photoId: ByteArray,
    epochId: Int,
    mediaBytes: ByteArray,
    shardIndex: Int,
  ): RustEncryptedShardFfiResult
}

class GeneratedRustMetadataSidecarBridge(
  private val api: GeneratedRustMetadataSidecarApi,
) : RustMetadataSidecarBridge {
  override fun canonicalMetadataSidecar(request: CanonicalMetadataSidecarRequest): MetadataSidecarBuildResult {
    val result = api.canonicalMetadataSidecarBytes(
      albumId = request.albumId,
      photoId = request.photoId,
      epochId = request.epochId,
      encodedFields = request.encodedFields,
    )
    return try {
      mapBuild(result)
    } finally {
      result.wipe()
    }
  }

  override fun encryptMetadataSidecar(request: EncryptMetadataSidecarRequest): MetadataSidecarEncryptResult {
    val result = api.encryptMetadataSidecarWithEpochHandle(
      handle = request.epochKeyHandle.value,
      albumId = request.albumId,
      photoId = request.photoId,
      epochId = request.epochId,
      encodedFields = request.encodedFields,
      shardIndex = request.shardIndex,
    )
    return try {
      mapEncrypt(result)
    } finally {
      result.wipe()
    }
  }

  override fun canonicalMediaMetadataSidecar(request: CanonicalMediaMetadataSidecarRequest): MetadataSidecarBuildResult {
    val result = api.canonicalMediaMetadataSidecarBytes(
      albumId = request.albumId,
      photoId = request.photoId,
      epochId = request.epochId,
      mediaBytes = request.mediaBytes,
    )
    return try {
      mapBuild(result)
    } finally {
      result.wipe()
    }
  }

  override fun encryptMediaMetadataSidecar(request: EncryptMediaMetadataSidecarRequest): MetadataSidecarEncryptResult {
    val result = api.encryptMediaMetadataSidecarWithEpochHandle(
      handle = request.epochKeyHandle.value,
      albumId = request.albumId,
      photoId = request.photoId,
      epochId = request.epochId,
      mediaBytes = request.mediaBytes,
      shardIndex = request.shardIndex,
    )
    return try {
      mapEncrypt(result)
    } finally {
      result.wipe()
    }
  }

  private fun mapBuild(result: RustBytesFfiResult): MetadataSidecarBuildResult {
    val code = buildCodeFor(result.code)
    val sidecar = if (code == MetadataSidecarBuildCode.SUCCESS && result.bytes.isNotEmpty()) {
      runCatching { CanonicalMetadataSidecar(result.bytes) }.getOrNull()
    } else null
    val safeCode = if (code == MetadataSidecarBuildCode.SUCCESS && sidecar == null) {
      MetadataSidecarBuildCode.INTERNAL_ERROR
    } else code
    return MetadataSidecarBuildResult(safeCode, if (safeCode == MetadataSidecarBuildCode.SUCCESS) sidecar else null)
  }

  private fun mapEncrypt(result: RustEncryptedShardFfiResult): MetadataSidecarEncryptResult {
    val code = encryptCodeFor(result.code)
    val envelope = if (code == MetadataSidecarEncryptCode.SUCCESS) {
      runCatching { EncryptedShardEnvelope(result.envelopeBytes, result.sha256) }.getOrNull()
    } else null
    val safeCode = if (code == MetadataSidecarEncryptCode.SUCCESS && envelope == null) {
      MetadataSidecarEncryptCode.INTERNAL_ERROR
    } else code
    return MetadataSidecarEncryptResult(safeCode, if (safeCode == MetadataSidecarEncryptCode.SUCCESS) envelope else null)
  }

  private fun buildCodeFor(code: Int): MetadataSidecarBuildCode = when (code) {
    RustMetadataSidecarStableCode.OK -> MetadataSidecarBuildCode.SUCCESS
    RustMetadataSidecarStableCode.INVALID_INPUT_LENGTH,
    RustMetadataSidecarStableCode.INVALID_KEY_LENGTH,
    RustMetadataSidecarStableCode.EMPTY_CONTEXT,
    -> MetadataSidecarBuildCode.INVALID_INPUT_LENGTH
    RustMetadataSidecarStableCode.UNSUPPORTED_MEDIA_FORMAT -> MetadataSidecarBuildCode.INVALID_MEDIA_FORMAT
    RustMetadataSidecarStableCode.INVALID_MEDIA_CONTAINER -> MetadataSidecarBuildCode.INVALID_MEDIA_CONTAINER
    RustMetadataSidecarStableCode.INVALID_MEDIA_DIMENSIONS -> MetadataSidecarBuildCode.INVALID_MEDIA_DIMENSIONS
    RustMetadataSidecarStableCode.MEDIA_METADATA_MISMATCH -> MetadataSidecarBuildCode.MEDIA_METADATA_MISMATCH
    RustMetadataSidecarStableCode.INVALID_MEDIA_SIDECAR -> MetadataSidecarBuildCode.INVALID_MEDIA_SIDECAR
    else -> MetadataSidecarBuildCode.INTERNAL_ERROR
  }

  private fun encryptCodeFor(code: Int): MetadataSidecarEncryptCode = when (code) {
    RustMetadataSidecarStableCode.OK -> MetadataSidecarEncryptCode.SUCCESS
    RustMetadataSidecarStableCode.EPOCH_HANDLE_NOT_FOUND -> MetadataSidecarEncryptCode.EPOCH_HANDLE_NOT_FOUND
    RustMetadataSidecarStableCode.INVALID_INPUT_LENGTH,
    RustMetadataSidecarStableCode.INVALID_KEY_LENGTH,
    RustMetadataSidecarStableCode.EMPTY_CONTEXT,
    -> MetadataSidecarEncryptCode.INVALID_INPUT_LENGTH
    RustMetadataSidecarStableCode.UNSUPPORTED_MEDIA_FORMAT -> MetadataSidecarEncryptCode.INVALID_MEDIA_FORMAT
    RustMetadataSidecarStableCode.INVALID_MEDIA_CONTAINER -> MetadataSidecarEncryptCode.INVALID_MEDIA_CONTAINER
    RustMetadataSidecarStableCode.INVALID_MEDIA_DIMENSIONS -> MetadataSidecarEncryptCode.INVALID_MEDIA_DIMENSIONS
    RustMetadataSidecarStableCode.MEDIA_METADATA_MISMATCH -> MetadataSidecarEncryptCode.MEDIA_METADATA_MISMATCH
    RustMetadataSidecarStableCode.INVALID_MEDIA_SIDECAR -> MetadataSidecarEncryptCode.INVALID_MEDIA_SIDECAR
    RustMetadataSidecarStableCode.RNG_FAILURE -> MetadataSidecarEncryptCode.RNG_FAILURE
    else -> MetadataSidecarEncryptCode.INTERNAL_ERROR
  }
}
