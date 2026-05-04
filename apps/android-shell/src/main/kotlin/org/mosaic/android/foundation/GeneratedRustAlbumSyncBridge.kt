package org.mosaic.android.foundation

object RustClientCoreSyncStableCode {
  const val OK: Int = 0
  const val CLIENT_CORE_INVALID_TRANSITION: Int = 700
  const val CLIENT_CORE_MISSING_EVENT_PAYLOAD: Int = 701
  const val CLIENT_CORE_RETRY_BUDGET_EXHAUSTED: Int = 702
  const val CLIENT_CORE_SYNC_PAGE_DID_NOT_ADVANCE: Int = 703
  const val CLIENT_CORE_UNSUPPORTED_SNAPSHOT_VERSION: Int = 705
  const val CLIENT_CORE_INVALID_SNAPSHOT: Int = 706
}

@JvmInline
value class AlbumSyncRequestId(val value: String) {
  init {
    require(value.isNotBlank()) { "album sync request id is required" }
    require(value.length <= MAX_ALBUM_SYNC_REQUEST_ID_LENGTH) {
      "album sync request id must be at most $MAX_ALBUM_SYNC_REQUEST_ID_LENGTH characters"
    }
  }

  override fun toString(): String = "AlbumSyncRequestId(<redacted>)"

  companion object {
    const val MAX_ALBUM_SYNC_REQUEST_ID_LENGTH: Int = 256
  }
}

@JvmInline
value class AlbumSyncCursor(val value: String) {
  init {
    require(value.length <= MAX_ALBUM_SYNC_CURSOR_LENGTH) {
      "album sync cursor must be at most $MAX_ALBUM_SYNC_CURSOR_LENGTH characters"
    }
  }

  override fun toString(): String = "AlbumSyncCursor(<redacted>)"

  companion object {
    const val MAX_ALBUM_SYNC_CURSOR_LENGTH: Int = 1024
  }
}

class AlbumSyncStartRequest(
  val albumId: AlbumId,
  val requestId: AlbumSyncRequestId,
  val startCursor: AlbumSyncCursor,
  val nowUnixMs: Long,
  val maxRetryCount: Int,
) {
  init {
    require(nowUnixMs >= 0) { "timestamp must not be negative" }
    require(maxRetryCount >= 0) { "max retry count must not be negative" }
  }

  override fun toString(): String =
    "AlbumSyncStartRequest(albumId=$albumId, requestId=$requestId, startCursor=$startCursor, " +
      "nowUnixMs=$nowUnixMs, maxRetryCount=$maxRetryCount)"
}

enum class AlbumSyncHandoffStage {
  START_REQUESTED,
  PAGE_FETCHED,
  PAGE_APPLIED,
  PAGE_FAILED,
  COMPLETED,
}

enum class AlbumSyncHandoffCode {
  ACCEPTED,
  INVALID_TRANSITION,
  MISSING_EVENT_PAYLOAD,
  RETRY_BUDGET_EXHAUSTED,
  PAGE_DID_NOT_ADVANCE,
  UNSUPPORTED_SNAPSHOT_VERSION,
  INVALID_SNAPSHOT,
  INTERNAL_ERROR,
}

data class AlbumSyncHandoffResult(
  val code: AlbumSyncHandoffCode,
  val phase: String,
  val activeCursor: AlbumSyncCursor?,
  val pendingCursor: AlbumSyncCursor?,
  val rerunRequested: Boolean,
  val retryCount: Int,
  val nextRetryUnixMs: Long,
) {
  init {
    require(retryCount >= 0) { "retry count must not be negative" }
    require(nextRetryUnixMs >= 0) { "next retry timestamp must not be negative" }
    require((code == AlbumSyncHandoffCode.ACCEPTED) == phase.isNotBlank()) {
      "accepted album sync results require a phase; failures must not include one"
    }
  }
}

interface AlbumSyncClientCoreHandoff {
  /**
   * Initialize an album sync state machine. The Rust core retains the snapshot in-memory
   * keyed by request id; subsequent calls advance the same job via [advanceWithStartEvent]
   * and other event helpers. This adapter only emits `START_REQUESTED` here; richer
   * event APIs land in follow-up slices.
   */
  fun startAlbumSync(request: AlbumSyncStartRequest): AlbumSyncHandoffResult
}

data class RustClientCoreAlbumSyncFfiRequest(
  val albumId: String,
  val requestId: String,
  val startCursor: String,
  val nowUnixMs: Long,
  val maxRetryCount: Int,
) {
  init {
    require(albumId.isNotBlank()) { "album id is required" }
    require(requestId.isNotBlank()) { "request id is required" }
    require(nowUnixMs >= 0) { "timestamp must not be negative" }
    require(maxRetryCount >= 0) { "max retry count must not be negative" }
  }

  override fun toString(): String =
    "RustClientCoreAlbumSyncFfiRequest(albumId=<opaque>, requestId=<opaque>, " +
      "startCursor=<redacted>, nowUnixMs=$nowUnixMs, maxRetryCount=$maxRetryCount)"
}

data class RustClientCoreAlbumSyncFfiSnapshot(
  val schemaVersion: Int,
  val albumId: String,
  val phase: String,
  val activeCursor: String,
  val pendingCursor: String,
  val rerunRequested: Boolean,
  val retryCount: Int,
  val maxRetryCount: Int,
  val nextRetryUnixMs: Long,
  val lastErrorCode: Int,
  val lastErrorStage: String,
  val updatedAtUnixMs: Long,
) {
  init {
    require(schemaVersion >= 0) { "schema version must not be negative" }
    require(albumId.isNotBlank()) { "album id is required" }
    require(phase.isNotBlank()) { "phase is required" }
    require(retryCount >= 0) { "retry count must not be negative" }
    require(maxRetryCount >= 0) { "max retry count must not be negative" }
    require(nextRetryUnixMs >= 0) { "next retry timestamp must not be negative" }
    require(lastErrorCode >= 0) { "last error code must not be negative" }
    require(updatedAtUnixMs >= 0) { "updated timestamp must not be negative" }
  }

  override fun toString(): String =
    "RustClientCoreAlbumSyncFfiSnapshot(schemaVersion=$schemaVersion, albumId=<opaque>, phase=$phase, " +
      "activeCursor=<redacted>, pendingCursor=<redacted>, rerunRequested=$rerunRequested, " +
      "retryCount=$retryCount, maxRetryCount=$maxRetryCount, nextRetryUnixMs=$nextRetryUnixMs, " +
      "lastErrorCode=$lastErrorCode, lastErrorStage=$lastErrorStage, updatedAtUnixMs=$updatedAtUnixMs)"
}

data class RustClientCoreAlbumSyncFfiEvent(
  val kind: String,
  val fetchedCursor: String,
  val nextCursor: String,
  val appliedCount: Int,
  val observedAssetIds: List<String>,
  val retryAfterUnixMs: Long,
  val errorCode: Int,
  val hasErrorCode: Boolean,
) {
  init {
    require(kind.isNotBlank()) { "event kind is required" }
    require(appliedCount >= 0) { "applied count must not be negative" }
    require(retryAfterUnixMs >= 0) { "retry timestamp must not be negative" }
    require(errorCode >= 0) { "error code must not be negative" }
  }

  override fun toString(): String =
    "RustClientCoreAlbumSyncFfiEvent(kind=$kind, fetchedCursor=<redacted>, nextCursor=<redacted>, " +
      "appliedCount=$appliedCount, observedAssetIds=<redacted>, " +
      "retryAfterUnixMs=$retryAfterUnixMs, hasErrorCode=$hasErrorCode, errorCode=$errorCode)"

  companion object {
    fun startRequested(): RustClientCoreAlbumSyncFfiEvent = RustClientCoreAlbumSyncFfiEvent(
      kind = "StartRequested",
      fetchedCursor = "",
      nextCursor = "",
      appliedCount = 0,
      observedAssetIds = emptyList(),
      retryAfterUnixMs = 0,
      errorCode = 0,
      hasErrorCode = false,
    )
  }
}

data class RustClientCoreAlbumSyncFfiEffect(
  val kind: String,
  val cursor: String,
) {
  init {
    require(kind.isNotBlank()) { "effect kind is required" }
  }

  override fun toString(): String = "RustClientCoreAlbumSyncFfiEffect(kind=$kind, cursor=<redacted>)"
}

data class RustClientCoreAlbumSyncFfiTransition(
  val snapshot: RustClientCoreAlbumSyncFfiSnapshot,
  val effects: List<RustClientCoreAlbumSyncFfiEffect>,
)

data class RustClientCoreAlbumSyncFfiResult(
  val code: Int,
  val snapshot: RustClientCoreAlbumSyncFfiSnapshot,
) {
  init {
    require(code >= 0) { "client-core sync code must not be negative" }
  }
}

data class RustClientCoreAlbumSyncTransitionFfiResult(
  val code: Int,
  val transition: RustClientCoreAlbumSyncFfiTransition,
) {
  init {
    require(code >= 0) { "client-core sync code must not be negative" }
  }
}

interface GeneratedRustAlbumSyncApi {
  fun initAlbumSync(request: RustClientCoreAlbumSyncFfiRequest): RustClientCoreAlbumSyncFfiResult

  fun advanceAlbumSync(
    snapshot: RustClientCoreAlbumSyncFfiSnapshot,
    event: RustClientCoreAlbumSyncFfiEvent,
  ): RustClientCoreAlbumSyncTransitionFfiResult
}

class GeneratedRustAlbumSyncBridge(
  private val api: GeneratedRustAlbumSyncApi,
) : AlbumSyncClientCoreHandoff {
  override fun startAlbumSync(request: AlbumSyncStartRequest): AlbumSyncHandoffResult {
    val initResult = api.initAlbumSync(
      RustClientCoreAlbumSyncFfiRequest(
        albumId = request.albumId.value,
        requestId = request.requestId.value,
        startCursor = request.startCursor.value,
        nowUnixMs = request.nowUnixMs,
        maxRetryCount = request.maxRetryCount,
      ),
    )
    if (initResult.code != RustClientCoreSyncStableCode.OK) {
      return rejected(initResult.code)
    }

    val transitionResult = api.advanceAlbumSync(
      snapshot = initResult.snapshot,
      event = RustClientCoreAlbumSyncFfiEvent.startRequested(),
    )
    if (transitionResult.code != RustClientCoreSyncStableCode.OK) {
      return rejected(transitionResult.code)
    }

    val snapshot = transitionResult.transition.snapshot
    return AlbumSyncHandoffResult(
      code = AlbumSyncHandoffCode.ACCEPTED,
      phase = snapshot.phase,
      activeCursor = if (snapshot.activeCursor.isEmpty()) null else AlbumSyncCursor(snapshot.activeCursor),
      pendingCursor = if (snapshot.pendingCursor.isEmpty()) null else AlbumSyncCursor(snapshot.pendingCursor),
      rerunRequested = snapshot.rerunRequested,
      retryCount = snapshot.retryCount,
      nextRetryUnixMs = snapshot.nextRetryUnixMs,
    )
  }

  private fun rejected(code: Int): AlbumSyncHandoffResult = AlbumSyncHandoffResult(
    code = albumSyncCodeFromStable(code),
    phase = "",
    activeCursor = null,
    pendingCursor = null,
    rerunRequested = false,
    retryCount = 0,
    nextRetryUnixMs = 0,
  )

  private fun albumSyncCodeFromStable(code: Int): AlbumSyncHandoffCode = when (code) {
    RustClientCoreSyncStableCode.CLIENT_CORE_INVALID_TRANSITION -> AlbumSyncHandoffCode.INVALID_TRANSITION
    RustClientCoreSyncStableCode.CLIENT_CORE_MISSING_EVENT_PAYLOAD -> AlbumSyncHandoffCode.MISSING_EVENT_PAYLOAD
    RustClientCoreSyncStableCode.CLIENT_CORE_RETRY_BUDGET_EXHAUSTED -> AlbumSyncHandoffCode.RETRY_BUDGET_EXHAUSTED
    RustClientCoreSyncStableCode.CLIENT_CORE_SYNC_PAGE_DID_NOT_ADVANCE -> AlbumSyncHandoffCode.PAGE_DID_NOT_ADVANCE
    RustClientCoreSyncStableCode.CLIENT_CORE_UNSUPPORTED_SNAPSHOT_VERSION -> AlbumSyncHandoffCode.UNSUPPORTED_SNAPSHOT_VERSION
    RustClientCoreSyncStableCode.CLIENT_CORE_INVALID_SNAPSHOT -> AlbumSyncHandoffCode.INVALID_SNAPSHOT
    else -> AlbumSyncHandoffCode.INTERNAL_ERROR
  }
}
