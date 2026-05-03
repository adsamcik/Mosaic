package org.mosaic.android.foundation

object RustClientCoreUploadStableCode {
  const val OK: Int = 0
  const val CLIENT_CORE_INVALID_TRANSITION: Int = 700
  const val CLIENT_CORE_MISSING_EVENT_PAYLOAD: Int = 701
  const val CLIENT_CORE_RETRY_BUDGET_EXHAUSTED: Int = 702
  const val CLIENT_CORE_SYNC_PAGE_DID_NOT_ADVANCE: Int = 703
  const val CLIENT_CORE_MANIFEST_OUTCOME_UNKNOWN: Int = 704
  const val CLIENT_CORE_UNSUPPORTED_SNAPSHOT_VERSION: Int = 705
  const val CLIENT_CORE_INVALID_SNAPSHOT: Int = 706
}

class RustClientCoreUploadJobFfiRequest private constructor(
  val jobId: String,
  val albumId: String,
  val assetId: String,
  val idempotencyKey: String,
  val maxRetryCount: Int,
) {
  init {
    require(jobId.isNotBlank()) { "upload job id is required" }
    require(albumId.isNotBlank()) { "album id is required" }
    require(assetId.isNotBlank()) { "asset id is required" }
    require(idempotencyKey.isNotBlank()) { "idempotency key is required" }
    require(maxRetryCount >= 0) { "max retry count must not be negative" }
  }

  override fun toString(): String =
    "RustClientCoreUploadJobFfiRequest(jobId=<opaque>, albumId=<opaque>, assetId=<opaque>, " +
      "idempotencyKey=<opaque>, maxRetryCount=$maxRetryCount)"

  companion object {
    fun from(
      request: ManualUploadClientCoreHandoffRequest,
      nowUnixMs: Long,
      maxRetryCount: Int,
    ): RustClientCoreUploadJobFfiRequest = RustClientCoreUploadJobFfiRequest(
      jobId = request.uploadJobId?.value ?: request.queueRecordId.value,
      albumId = request.albumId.value,
      assetId = request.assetId?.value ?: request.queueRecordId.value,
      idempotencyKey = request.queueRecordId.value,
      maxRetryCount = maxRetryCount,
    )
  }
}

data class RustClientCoreUploadShardRef(
  val tier: Int,
  val shardIndex: Int,
  val shardId: String,
  val sha256: ByteArray,
  val contentLength: Long,
  val envelopeVersion: Int,
  val uploaded: Boolean,
) {
  override fun toString(): String =
    "RustClientCoreUploadShardRef(tier=$tier, shardIndex=$shardIndex, " +
      "shardId=<opaque>, sha256=<redacted-${sha256.size}-bytes>, " +
      "contentLength=$contentLength, envelopeVersion=$envelopeVersion, uploaded=$uploaded)"
}

data class RustClientCoreUploadJobFfiSnapshot(
  val schemaVersion: Int,
  val jobId: String,
  val albumId: String,
  val phase: String,
  val retryCount: Int,
  val maxRetryCount: Int,
  val nextRetryNotBeforeMs: Long,
  val hasNextRetryNotBeforeMs: Boolean,
  val idempotencyKey: String,
  val tieredShards: List<RustClientCoreUploadShardRef>,
  val shardSetHash: ByteArray,
  val snapshotRevision: Long,
  val lastEffectId: String,
  val lastAcknowledgedEffectId: String,
  val lastAppliedEventId: String,
  val failureCode: Int,
) {
  init {
    require(schemaVersion >= 0) { "schema version must not be negative" }
    require(jobId.isNotBlank()) { "upload job id is required" }
    require(albumId.isNotBlank()) { "album id is required" }
    require(phase.isNotBlank()) { "upload phase is required" }
    require(retryCount >= 0) { "retry count must not be negative" }
    require(maxRetryCount >= 0) { "max retry count must not be negative" }
    require(idempotencyKey.isNotBlank()) { "idempotency key is required" }
    require(snapshotRevision >= 0) { "snapshot revision must not be negative" }
  }

  override fun toString(): String =
    "RustClientCoreUploadJobFfiSnapshot(schemaVersion=$schemaVersion, jobId=<opaque>, " +
      "albumId=<opaque>, phase=$phase, retryCount=$retryCount, maxRetryCount=$maxRetryCount, " +
      "nextRetryNotBeforeMs=$nextRetryNotBeforeMs, hasNextRetryNotBeforeMs=$hasNextRetryNotBeforeMs, " +
      "idempotencyKey=<opaque>, tieredShards=${tieredShards.map { it.toString() }}, " +
      "shardSetHash=<redacted-${shardSetHash.size}-bytes>, snapshotRevision=$snapshotRevision, " +
      "lastEffectId=<opaque>, lastAcknowledgedEffectId=<opaque>, " +
      "lastAppliedEventId=<opaque>, failureCode=$failureCode)"

  companion object {
    fun initialFrom(request: RustClientCoreUploadJobFfiRequest): RustClientCoreUploadJobFfiSnapshot =
      RustClientCoreUploadJobFfiSnapshot(
        schemaVersion = 1,
        jobId = request.jobId,
        albumId = request.albumId,
        phase = "Queued",
        retryCount = 0,
        maxRetryCount = request.maxRetryCount,
        nextRetryNotBeforeMs = 0,
        hasNextRetryNotBeforeMs = false,
        idempotencyKey = request.idempotencyKey,
        tieredShards = emptyList(),
        shardSetHash = ByteArray(0),
        snapshotRevision = 0,
        lastEffectId = "",
        lastAcknowledgedEffectId = "",
        lastAppliedEventId = "",
        failureCode = 0,
      )
  }
}

data class RustClientCoreUploadJobFfiEvent(
  val kind: String,
  val effectId: String,
  val tier: Int,
  val shardIndex: Int,
  val shardId: String,
  val sha256: ByteArray,
  val contentLength: Long,
  val envelopeVersion: Int,
  val uploaded: Boolean,
  val tieredShards: List<RustClientCoreUploadShardRef>,
  val shardSetHash: ByteArray,
  val assetId: String,
  val sinceMetadataVersion: Long,
  val recoveryOutcome: String,
  val nowMs: Long,
  val baseBackoffMs: Long,
  val serverRetryAfterMs: Long,
  val hasServerRetryAfterMs: Boolean,
  val hasErrorCode: Boolean,
  val errorCode: Int,
  val targetPhase: String,
) {
  init {
    require(kind.isNotBlank()) { "upload event kind is required" }
    require(effectId.isNotBlank()) { "effect id is required" }
    require(tier >= 0) { "event tier must not be negative" }
    require(shardIndex >= 0) { "event shard index must not be negative" }
    require(contentLength >= 0) { "content length must not be negative" }
    require(envelopeVersion >= 0) { "envelope version must not be negative" }
    require(sinceMetadataVersion >= 0) { "metadata version must not be negative" }
    require(baseBackoffMs >= 0) { "base backoff must not be negative" }
    require(serverRetryAfterMs >= 0) { "server retry after must not be negative" }
    require(errorCode >= 0) { "error code must not be negative" }
  }

  override fun toString(): String =
    "RustClientCoreUploadJobFfiEvent(kind=$kind, effectId=<opaque>, tier=$tier, " +
      "shardIndex=$shardIndex, shardId=<opaque>, sha256=<redacted-${sha256.size}-bytes>, " +
      "contentLength=$contentLength, envelopeVersion=$envelopeVersion, uploaded=$uploaded, " +
      "tieredShards=${tieredShards.map { it.toString() }}, shardSetHash=<redacted-${shardSetHash.size}-bytes>, " +
      "assetId=<opaque>, sinceMetadataVersion=$sinceMetadataVersion, recoveryOutcome=$recoveryOutcome, " +
      "nowMs=$nowMs, baseBackoffMs=$baseBackoffMs, serverRetryAfterMs=$serverRetryAfterMs, " +
      "hasServerRetryAfterMs=$hasServerRetryAfterMs, hasErrorCode=$hasErrorCode, " +
      "errorCode=$errorCode, targetPhase=$targetPhase)"

  companion object {
    fun startRequested(): RustClientCoreUploadJobFfiEvent = RustClientCoreUploadJobFfiEvent(
      kind = "StartRequested",
      effectId = "start-requested",
      tier = 0,
      shardIndex = 0,
      shardId = "",
      sha256 = ByteArray(0),
      contentLength = 0,
      envelopeVersion = 0,
      uploaded = false,
      tieredShards = emptyList(),
      shardSetHash = ByteArray(0),
      assetId = "",
      sinceMetadataVersion = 0,
      recoveryOutcome = "",
      nowMs = 0,
      baseBackoffMs = 0,
      serverRetryAfterMs = 0,
      hasServerRetryAfterMs = false,
      hasErrorCode = false,
      errorCode = 0,
      targetPhase = "",
    )
  }
}

data class RustClientCoreUploadJobFfiEffect(
  val kind: String,
  val effectId: String,
  val tier: Int,
  val shardIndex: Int,
) {
  init {
    require(kind.isNotBlank()) { "upload effect kind is required" }
    require(effectId.isNotBlank()) { "effect id is required" }
    require(tier >= 0) { "effect tier must not be negative" }
    require(shardIndex >= 0) { "effect shard index must not be negative" }
  }

  companion object {
    fun prepareMedia(): RustClientCoreUploadJobFfiEffect = RustClientCoreUploadJobFfiEffect(
      kind = "PrepareMedia",
      effectId = "start-requested",
      tier = 0,
      shardIndex = 0,
    )
  }
}

data class RustClientCoreUploadJobFfiTransition(
  val nextSnapshot: RustClientCoreUploadJobFfiSnapshot,
  val effects: List<RustClientCoreUploadJobFfiEffect>,
) {
  companion object {
    fun awaitingPreparedMedia(
      snapshot: RustClientCoreUploadJobFfiSnapshot,
    ): RustClientCoreUploadJobFfiTransition = RustClientCoreUploadJobFfiTransition(
      nextSnapshot = snapshot.copy(phase = "AwaitingPreparedMedia"),
      effects = listOf(RustClientCoreUploadJobFfiEffect.prepareMedia()),
    )
  }
}

data class RustClientCoreUploadJobFfiResult(
  val code: Int,
  val snapshot: RustClientCoreUploadJobFfiSnapshot,
) {
  init {
    require(code >= 0) { "client-core code must not be negative" }
  }

  override fun toString(): String =
    "RustClientCoreUploadJobFfiResult(code=$code, snapshot=$snapshot)"
}

data class RustClientCoreUploadJobTransitionFfiResult(
  val code: Int,
  val transition: RustClientCoreUploadJobFfiTransition,
) {
  init {
    require(code >= 0) { "client-core code must not be negative" }
  }

  override fun toString(): String =
    "RustClientCoreUploadJobTransitionFfiResult(code=$code, transition=$transition)"
}

interface GeneratedRustUploadApi {
  fun initUploadJob(request: RustClientCoreUploadJobFfiRequest): RustClientCoreUploadJobFfiResult

  fun advanceUploadJob(
    snapshot: RustClientCoreUploadJobFfiSnapshot,
    event: RustClientCoreUploadJobFfiEvent,
  ): RustClientCoreUploadJobTransitionFfiResult
}

class GeneratedRustUploadBridge(
  private val api: GeneratedRustUploadApi,
  private val nowUnixMs: () -> Long = { 0 },
  private val maxRetryCount: Int = 0,
) : ManualUploadClientCoreHandoff {
  init {
    require(maxRetryCount >= 0) { "max retry count must not be negative" }
  }

  override fun prepareManualUpload(
    request: ManualUploadClientCoreHandoffRequest,
  ): ManualUploadClientCoreHandoffResult {
    if (request.stage != ManualUploadHandoffStage.STAGED_SOURCE_READY) {
      return rejected(RustClientCoreUploadStableCode.CLIENT_CORE_INVALID_TRANSITION)
    }

    val initResult = api.initUploadJob(
      RustClientCoreUploadJobFfiRequest.from(
        request = request,
        nowUnixMs = nowUnixMs(),
        maxRetryCount = maxRetryCount,
      ),
    )
    if (initResult.code != RustClientCoreUploadStableCode.OK) {
      return rejected(initResult.code)
    }

    val transitionResult = api.advanceUploadJob(
      snapshot = initResult.snapshot,
      event = RustClientCoreUploadJobFfiEvent.startRequested(),
    )
    if (transitionResult.code != RustClientCoreUploadStableCode.OK) {
      return rejected(transitionResult.code)
    }

    return ManualUploadClientCoreHandoffResult(
      status = ManualUploadClientCoreHandoffStatus.ACCEPTED,
      uploadJobId = ManualUploadJobId(transitionResult.transition.nextSnapshot.jobId),
      acceptedByteCount = request.byteCount,
      stableCode = RustClientCoreUploadStableCode.OK,
      clientCorePhase = transitionResult.transition.nextSnapshot.phase,
      clientCoreEffects = transitionResult.transition.effects.map { it.kind },
    )
  }
}

private fun rejected(code: Int): ManualUploadClientCoreHandoffResult =
  ManualUploadClientCoreHandoffResult(
    status = uploadHandoffStatusFromStableCode(code),
    uploadJobId = null,
    acceptedByteCount = null,
    stableCode = code,
  )

private fun uploadHandoffStatusFromStableCode(code: Int): ManualUploadClientCoreHandoffStatus =
  when (code) {
    RustClientCoreUploadStableCode.CLIENT_CORE_MANIFEST_OUTCOME_UNKNOWN -> ManualUploadClientCoreHandoffStatus.DEFERRED
    else -> ManualUploadClientCoreHandoffStatus.REJECTED
  }
