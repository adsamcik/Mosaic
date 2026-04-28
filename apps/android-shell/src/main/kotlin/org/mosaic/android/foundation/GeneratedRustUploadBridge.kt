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
  val epochId: Int,
  val nowUnixMs: Long,
  val maxRetryCount: Int,
) {
  init {
    require(jobId.isNotBlank()) { "upload job id is required" }
    require(albumId.isNotBlank()) { "album id is required" }
    require(assetId.isNotBlank()) { "asset id is required" }
    require(epochId >= 0) { "epoch id must not be negative" }
    require(nowUnixMs >= 0) { "timestamp must not be negative" }
    require(maxRetryCount >= 0) { "max retry count must not be negative" }
  }

  override fun toString(): String =
    "RustClientCoreUploadJobFfiRequest(jobId=<opaque>, albumId=<opaque>, assetId=<opaque>, " +
      "epochId=$epochId, nowUnixMs=$nowUnixMs, maxRetryCount=$maxRetryCount)"

  companion object {
    fun from(
      request: ManualUploadClientCoreHandoffRequest,
      nowUnixMs: Long,
      maxRetryCount: Int,
    ): RustClientCoreUploadJobFfiRequest = RustClientCoreUploadJobFfiRequest(
      jobId = request.uploadJobId?.value ?: request.queueRecordId.value,
      albumId = request.albumId.value,
      assetId = request.assetId?.value ?: request.queueRecordId.value,
      epochId = 0,
      nowUnixMs = nowUnixMs,
      maxRetryCount = maxRetryCount,
    )
  }
}

data class RustClientCoreUploadShardRef(
  val tier: Int,
  val shardIndex: Int,
  val shardId: String,
  val sha256: String,
  val uploaded: Boolean,
) {
  override fun toString(): String =
    "RustClientCoreUploadShardRef(tier=$tier, shardIndex=$shardIndex, " +
      "shardId=<opaque>, sha256=<redacted>, uploaded=$uploaded)"
}

data class RustClientCoreManifestReceipt(
  val manifestId: String,
  val manifestVersion: Long,
) {
  override fun toString(): String =
    "RustClientCoreManifestReceipt(manifestId=<opaque>, manifestVersion=$manifestVersion)"

  companion object {
    val Empty: RustClientCoreManifestReceipt = RustClientCoreManifestReceipt(
      manifestId = "",
      manifestVersion = 0,
    )
  }
}

data class RustClientCoreUploadJobFfiSnapshot(
  val schemaVersion: Int,
  val jobId: String,
  val albumId: String,
  val assetId: String,
  val epochId: Int,
  val phase: String,
  val activeTier: Int,
  val activeShardIndex: Int,
  val completedShards: List<RustClientCoreUploadShardRef>,
  val hasManifestReceipt: Boolean,
  val manifestReceipt: RustClientCoreManifestReceipt,
  val retryCount: Int,
  val nextRetryUnixMs: Long,
  val lastErrorCode: Int,
  val lastErrorStage: String,
  val syncConfirmed: Boolean,
  val updatedAtUnixMs: Long,
) {
  init {
    require(schemaVersion >= 0) { "schema version must not be negative" }
    require(jobId.isNotBlank()) { "upload job id is required" }
    require(albumId.isNotBlank()) { "album id is required" }
    require(assetId.isNotBlank()) { "asset id is required" }
    require(epochId >= 0) { "epoch id must not be negative" }
    require(phase.isNotBlank()) { "upload phase is required" }
    require(activeTier >= 0) { "active tier must not be negative" }
    require(activeShardIndex >= 0) { "active shard index must not be negative" }
    require(retryCount >= 0) { "retry count must not be negative" }
    require(nextRetryUnixMs >= 0) { "next retry timestamp must not be negative" }
    require(lastErrorCode >= 0) { "last error code must not be negative" }
    require(updatedAtUnixMs >= 0) { "updated timestamp must not be negative" }
  }

  override fun toString(): String =
    "RustClientCoreUploadJobFfiSnapshot(schemaVersion=$schemaVersion, jobId=<opaque>, " +
      "albumId=<opaque>, assetId=<opaque>, epochId=$epochId, phase=$phase, " +
      "activeTier=$activeTier, activeShardIndex=$activeShardIndex, " +
      "completedShards=${completedShards.map { it.toString() }}, hasManifestReceipt=$hasManifestReceipt, " +
      "manifestReceipt=$manifestReceipt, retryCount=$retryCount, " +
      "nextRetryUnixMs=$nextRetryUnixMs, lastErrorCode=$lastErrorCode, " +
      "lastErrorStage=$lastErrorStage, syncConfirmed=$syncConfirmed, updatedAtUnixMs=$updatedAtUnixMs)"

  companion object {
    fun initialFrom(request: RustClientCoreUploadJobFfiRequest): RustClientCoreUploadJobFfiSnapshot =
      RustClientCoreUploadJobFfiSnapshot(
        schemaVersion = 1,
        jobId = request.jobId,
        albumId = request.albumId,
        assetId = request.assetId,
        epochId = request.epochId,
        phase = "Queued",
        activeTier = 0,
        activeShardIndex = 0,
        completedShards = emptyList(),
        hasManifestReceipt = false,
        manifestReceipt = RustClientCoreManifestReceipt.Empty,
        retryCount = 0,
        nextRetryUnixMs = 0,
        lastErrorCode = 0,
        lastErrorStage = "",
        syncConfirmed = false,
        updatedAtUnixMs = request.nowUnixMs,
      )
  }
}

data class RustClientCoreUploadJobFfiEvent(
  val kind: String,
  val tier: Int,
  val shardIndex: Int,
  val shardId: String,
  val sha256: String,
  val manifestId: String,
  val manifestVersion: Long,
  val observedAssetId: String,
  val retryAfterUnixMs: Long,
  val errorCode: Int,
) {
  init {
    require(kind.isNotBlank()) { "upload event kind is required" }
    require(tier >= 0) { "event tier must not be negative" }
    require(shardIndex >= 0) { "event shard index must not be negative" }
    require(manifestVersion >= 0) { "manifest version must not be negative" }
    require(retryAfterUnixMs >= 0) { "retry timestamp must not be negative" }
    require(errorCode >= 0) { "error code must not be negative" }
  }

  override fun toString(): String =
    "RustClientCoreUploadJobFfiEvent(kind=$kind, tier=$tier, shardIndex=$shardIndex, " +
      "shardId=<opaque>, sha256=<redacted>, manifestId=<opaque>, manifestVersion=$manifestVersion, " +
      "observedAssetId=<opaque>, retryAfterUnixMs=$retryAfterUnixMs, errorCode=$errorCode)"

  companion object {
    fun startRequested(): RustClientCoreUploadJobFfiEvent = RustClientCoreUploadJobFfiEvent(
      kind = "StartRequested",
      tier = 0,
      shardIndex = 0,
      shardId = "",
      sha256 = "",
      manifestId = "",
      manifestVersion = 0,
      observedAssetId = "",
      retryAfterUnixMs = 0,
      errorCode = 0,
    )
  }
}

data class RustClientCoreUploadJobFfiEffect(
  val kind: String,
  val tier: Int,
  val shardIndex: Int,
) {
  init {
    require(kind.isNotBlank()) { "upload effect kind is required" }
    require(tier >= 0) { "effect tier must not be negative" }
    require(shardIndex >= 0) { "effect shard index must not be negative" }
  }

  companion object {
    fun prepareMedia(): RustClientCoreUploadJobFfiEffect = RustClientCoreUploadJobFfiEffect(
      kind = "PrepareMedia",
      tier = 0,
      shardIndex = 0,
    )
  }
}

data class RustClientCoreUploadJobFfiTransition(
  val snapshot: RustClientCoreUploadJobFfiSnapshot,
  val effects: List<RustClientCoreUploadJobFfiEffect>,
) {
  companion object {
    fun awaitingPreparedMedia(
      snapshot: RustClientCoreUploadJobFfiSnapshot,
    ): RustClientCoreUploadJobFfiTransition = RustClientCoreUploadJobFfiTransition(
      snapshot = snapshot.copy(phase = "AwaitingPreparedMedia"),
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
      uploadJobId = ManualUploadJobId(transitionResult.transition.snapshot.jobId),
      acceptedByteCount = request.byteCount,
      stableCode = RustClientCoreUploadStableCode.OK,
      clientCorePhase = transitionResult.transition.snapshot.phase,
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
