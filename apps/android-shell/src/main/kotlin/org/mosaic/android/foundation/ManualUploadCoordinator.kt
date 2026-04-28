package org.mosaic.android.foundation

enum class ManualUploadStatus {
  READY_TO_QUEUE,
  QUEUED,
  NEEDS_AUTH,
  NEEDS_CRYPTO_UNLOCK,
  NEEDS_ALBUM,
  INVALID_SELECTION,
  INTERNAL_ERROR,
}

fun interface ManualUploadQueueRecordIdFactory {
  fun nextQueueRecordId(receipt: PhotoPickerReadReceipt, albumId: AlbumId): QueueRecordId
}

interface ManualUploadQueueStore {
  fun createOrReturn(record: PrivacySafeUploadQueueRecord): PrivacySafeUploadQueueRecord
}

object PassthroughManualUploadQueueStore : ManualUploadQueueStore {
  override fun createOrReturn(record: PrivacySafeUploadQueueRecord): PrivacySafeUploadQueueRecord = record
}

class AndroidManualUploadCoordinator(
  private val idFactory: ManualUploadQueueRecordIdFactory,
  private val queueStore: ManualUploadQueueStore = PassthroughManualUploadQueueStore,
) {
  fun readiness(
    sessionState: ShellSessionState,
    destinationAlbumId: AlbumId?,
  ): ManualUploadStatus =
    when {
      !sessionState.isServerAuthenticated -> ManualUploadStatus.NEEDS_AUTH
      !sessionState.isCryptoUnlocked -> ManualUploadStatus.NEEDS_CRYPTO_UNLOCK
      destinationAlbumId == null -> ManualUploadStatus.NEEDS_ALBUM
      else -> ManualUploadStatus.READY_TO_QUEUE
    }

  fun queueOnePhoto(
    sessionState: ShellSessionState,
    destinationAlbumId: AlbumId?,
    receipt: PhotoPickerReadReceipt?,
  ): ManualUploadQueueResult {
    val readiness = readiness(sessionState, destinationAlbumId)
    if (readiness != ManualUploadStatus.READY_TO_QUEUE) {
      return ManualUploadQueueResult.notQueued(readiness)
    }

    val safeReceipt = receipt ?: return ManualUploadQueueResult.notQueued(ManualUploadStatus.INVALID_SELECTION)
    val authenticated = sessionState.serverAuthState as? ServerAuthState.Authenticated
      ?: return ManualUploadQueueResult.notQueued(ManualUploadStatus.NEEDS_AUTH)
    val albumId = destinationAlbumId ?: return ManualUploadQueueResult.notQueued(ManualUploadStatus.NEEDS_ALBUM)

    val queueRecordId = try {
      idFactory.nextQueueRecordId(safeReceipt, albumId)
    } catch (_: RuntimeException) {
      return ManualUploadQueueResult.notQueued(ManualUploadStatus.INTERNAL_ERROR)
    }

    val queueRecord = try {
      PrivacySafeUploadQueueRecord.create(
        id = queueRecordId,
        serverAccountId = authenticated.accountId,
        albumId = albumId,
        stagedSource = safeReceipt.stagedSource,
        contentLengthBytes = safeReceipt.contentLengthBytes,
        createdAtEpochMillis = safeReceipt.stagedAtEpochMillis,
      )
    } catch (_: IllegalArgumentException) {
      return ManualUploadQueueResult.notQueued(ManualUploadStatus.INVALID_SELECTION)
    }

    return try {
      val storedRecord = queueStore.createOrReturn(queueRecord)
      ManualUploadQueueResult.queued(
        queueRecord = storedRecord,
        clientCoreHandoffRequest = ManualUploadClientCoreHandoffRequest.fromQueueRecord(storedRecord),
      )
    } catch (_: RuntimeException) {
      ManualUploadQueueResult.notQueued(ManualUploadStatus.INTERNAL_ERROR)
    }
  }
}

class ManualUploadQueueResult private constructor(
  val status: ManualUploadStatus,
  val queueRecord: PrivacySafeUploadQueueRecord?,
  val clientCoreHandoffRequest: ManualUploadClientCoreHandoffRequest?,
) {
  init {
    require((status == ManualUploadStatus.QUEUED) == (queueRecord != null && clientCoreHandoffRequest != null)) {
      "manual upload result must match its queue status"
    }
  }

  override fun toString(): String {
    val record = queueRecord
    return if (record == null) {
      "ManualUploadQueueResult(status=$status, queueRecordId=<none>, albumId=<none>, stagedSource=<none>)"
    } else {
      "ManualUploadQueueResult(status=$status, queueRecordId=${record.id}, albumId=${record.albumId}, " +
        "stagedSource=<redacted>, byteCount=${record.contentLengthBytes})"
    }
  }

  companion object {
    fun notQueued(status: ManualUploadStatus): ManualUploadQueueResult {
      require(status != ManualUploadStatus.QUEUED) { "queued results require a queue record" }
      return ManualUploadQueueResult(
        status = status,
        queueRecord = null,
        clientCoreHandoffRequest = null,
      )
    }

    fun queued(
      queueRecord: PrivacySafeUploadQueueRecord,
      clientCoreHandoffRequest: ManualUploadClientCoreHandoffRequest,
    ): ManualUploadQueueResult = ManualUploadQueueResult(
      status = ManualUploadStatus.QUEUED,
      queueRecord = queueRecord,
      clientCoreHandoffRequest = clientCoreHandoffRequest,
    )
  }
}

@JvmInline
value class ManualUploadJobId(val value: String) {
  init {
    require(value.isNotBlank()) { "upload job id is required" }
  }
}

@JvmInline
value class ManualUploadAssetId(val value: String) {
  init {
    require(value.isNotBlank()) { "asset id is required" }
  }
}

enum class ManualUploadHandoffStage {
  STAGED_SOURCE_READY,
  QUEUED_FOR_ENCRYPTION,
}

class ManualUploadClientCoreHandoffRequest private constructor(
  val uploadJobId: ManualUploadJobId?,
  val albumId: AlbumId,
  val assetId: ManualUploadAssetId?,
  val queueRecordId: QueueRecordId,
  val stagedSource: StagedMediaReference,
  val byteCount: Long,
  val stage: ManualUploadHandoffStage,
) {
  init {
    require(byteCount >= 0) { "byte count must not be negative" }
  }

  override fun toString(): String =
    "ManualUploadClientCoreHandoffRequest(uploadJobId=<opaque>, albumId=<opaque>, assetId=<opaque>, " +
      "queueRecordId=<opaque>, stagedSource=<redacted>, byteCount=$byteCount, stage=$stage)"

  override fun equals(other: Any?): Boolean =
    other is ManualUploadClientCoreHandoffRequest &&
      uploadJobId == other.uploadJobId &&
      albumId == other.albumId &&
      assetId == other.assetId &&
      queueRecordId == other.queueRecordId &&
      stagedSource == other.stagedSource &&
      byteCount == other.byteCount &&
      stage == other.stage

  override fun hashCode(): Int {
    var result = uploadJobId?.hashCode() ?: 0
    result = 31 * result + albumId.hashCode()
    result = 31 * result + (assetId?.hashCode() ?: 0)
    result = 31 * result + queueRecordId.hashCode()
    result = 31 * result + stagedSource.hashCode()
    result = 31 * result + byteCount.hashCode()
    result = 31 * result + stage.hashCode()
    return result
  }

  companion object {
    fun fromQueueRecord(
      record: PrivacySafeUploadQueueRecord,
      uploadJobId: ManualUploadJobId? = null,
      assetId: ManualUploadAssetId? = null,
      stage: ManualUploadHandoffStage = ManualUploadHandoffStage.STAGED_SOURCE_READY,
      prohibited: ProhibitedQueuePayload = ProhibitedQueuePayload.None,
    ): ManualUploadClientCoreHandoffRequest {
      require(!prohibited.hasForbiddenUploadFields()) { "handoff DTO accepts opaque upload fields only" }
      return ManualUploadClientCoreHandoffRequest(
        uploadJobId = uploadJobId,
        albumId = record.albumId,
        assetId = assetId,
        queueRecordId = record.id,
        stagedSource = record.stagedSource,
        byteCount = record.contentLengthBytes,
        stage = stage,
      )
    }
  }
}

enum class ManualUploadClientCoreHandoffStatus {
  ACCEPTED,
  DEFERRED,
  REJECTED,
}

data class ManualUploadClientCoreHandoffResult(
  val status: ManualUploadClientCoreHandoffStatus,
  val uploadJobId: ManualUploadJobId?,
  val acceptedByteCount: Long?,
) {
  init {
    require(acceptedByteCount == null || acceptedByteCount >= 0) { "accepted byte count must not be negative" }
  }
}

interface ManualUploadClientCoreHandoff {
  fun prepareManualUpload(request: ManualUploadClientCoreHandoffRequest): ManualUploadClientCoreHandoffResult
}

object DeferredManualUploadClientCoreHandoff : ManualUploadClientCoreHandoff {
  override fun prepareManualUpload(
    request: ManualUploadClientCoreHandoffRequest,
  ): ManualUploadClientCoreHandoffResult = ManualUploadClientCoreHandoffResult(
    status = ManualUploadClientCoreHandoffStatus.DEFERRED,
    uploadJobId = null,
    acceptedByteCount = null,
  )
}

private fun ProhibitedQueuePayload.hasForbiddenUploadFields(): Boolean =
  !filename.isNullOrBlank() ||
    !caption.isNullOrBlank() ||
    exif.isNotEmpty() ||
    !gps.isNullOrBlank() ||
    deviceMetadata.isNotEmpty() ||
    rawKeys.isNotEmpty() ||
    decryptedMetadata.isNotEmpty() ||
    !rawUri.isNullOrBlank()
