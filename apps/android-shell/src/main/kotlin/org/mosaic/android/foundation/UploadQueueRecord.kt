package org.mosaic.android.foundation

@JvmInline
value class AlbumId(val value: String) {
  init {
    require(value.isNotBlank()) { "album id is required" }
  }
}

@JvmInline
value class QueueRecordId(val value: String) {
  init {
    require(value.isNotBlank()) { "queue record id is required" }
  }
}

class StagedMediaReference private constructor(val value: String) {
  override fun equals(other: Any?): Boolean = other is StagedMediaReference && value == other.value

  override fun hashCode(): Int = value.hashCode()

  override fun toString(): String = "StagedMediaReference(<redacted>)"

  companion object {
    private const val REQUIRED_SCHEME = "mosaic-staged://"

    fun of(value: String): StagedMediaReference {
      require(value.startsWith(REQUIRED_SCHEME)) { "staged media reference must be app-private" }
      require(!value.drop(REQUIRED_SCHEME.length).contains("://")) {
        "staged media reference must not embed other URI schemes"
      }
      require(!value.contains("content://")) { "staged media reference must not contain raw picker URIs" }
      require(!value.contains("file://")) { "staged media reference must not contain file URIs" }
      require(value.length > REQUIRED_SCHEME.length) { "staged media reference id is required" }
      return StagedMediaReference(value)
    }
  }
}

data class ProhibitedQueuePayload(
  val filename: String? = null,
  val caption: String? = null,
  val exif: Map<String, String> = emptyMap(),
  val gps: String? = null,
  val deviceMetadata: Map<String, String> = emptyMap(),
  val rawKeys: List<ByteArray> = emptyList(),
  val decryptedMetadata: Map<String, String> = emptyMap(),
  val rawUri: String? = null,
) {
  override fun toString(): String = "ProhibitedQueuePayload(<redacted>)"

  fun validateEmpty() {
    val violations = mutableListOf<String>()
    if (!filename.isNullOrBlank()) violations += "filename"
    if (!caption.isNullOrBlank()) violations += "caption"
    if (exif.isNotEmpty()) violations += "EXIF"
    if (!gps.isNullOrBlank()) violations += "GPS"
    if (deviceMetadata.isNotEmpty()) violations += "device metadata"
    if (rawKeys.isNotEmpty()) violations += "raw keys"
    if (decryptedMetadata.isNotEmpty()) violations += "decrypted metadata"
    if (!rawUri.isNullOrBlank()) violations += "raw URI"

    require(violations.isEmpty()) {
      "upload queue records forbid privacy-sensitive fields: ${violations.joinToString()}"
    }
  }

  companion object {
    val None: ProhibitedQueuePayload = ProhibitedQueuePayload()
  }
}

enum class QueueRecordState {
  PENDING,
  RUNNING,
  RETRY_WAITING,
  FAILED,
  COMPLETED,
}

class PrivacySafeUploadQueueRecord private constructor(
  val id: QueueRecordId,
  val serverAccountId: ServerAccountId,
  val albumId: AlbumId,
  val stagedSource: StagedMediaReference,
  val contentLengthBytes: Long,
  val createdAtEpochMillis: Long,
  val retryCount: Int,
  val state: QueueRecordState,
) {
  override fun toString(): String =
    "PrivacySafeUploadQueueRecord(id=$id, serverAccountId=$serverAccountId, albumId=$albumId, " +
      "stagedSource=<redacted>, contentLengthBytes=$contentLengthBytes, " +
      "createdAtEpochMillis=$createdAtEpochMillis, retryCount=$retryCount, state=$state)"

  companion object {
    fun create(
      id: QueueRecordId,
      serverAccountId: ServerAccountId,
      albumId: AlbumId,
      stagedSource: StagedMediaReference,
      contentLengthBytes: Long,
      createdAtEpochMillis: Long,
      retryCount: Int = 0,
      state: QueueRecordState = QueueRecordState.PENDING,
      prohibited: ProhibitedQueuePayload = ProhibitedQueuePayload.None,
    ): PrivacySafeUploadQueueRecord {
      prohibited.validateEmpty()
      require(contentLengthBytes >= 0) { "content length must not be negative" }
      require(createdAtEpochMillis >= 0) { "created timestamp must not be negative" }
      require(retryCount >= 0) { "retry count must not be negative" }

      return PrivacySafeUploadQueueRecord(
        id = id,
        serverAccountId = serverAccountId,
        albumId = albumId,
        stagedSource = stagedSource,
        contentLengthBytes = contentLengthBytes,
        createdAtEpochMillis = createdAtEpochMillis,
        retryCount = retryCount,
        state = state,
      )
    }
  }
}
