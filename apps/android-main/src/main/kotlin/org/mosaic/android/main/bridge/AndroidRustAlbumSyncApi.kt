package org.mosaic.android.main.bridge

import org.mosaic.android.foundation.GeneratedRustAlbumSyncApi
import org.mosaic.android.foundation.RustClientCoreAlbumSyncFfiEffect
import org.mosaic.android.foundation.RustClientCoreAlbumSyncFfiEvent
import org.mosaic.android.foundation.RustClientCoreAlbumSyncFfiRequest
import org.mosaic.android.foundation.RustClientCoreAlbumSyncFfiResult
import org.mosaic.android.foundation.RustClientCoreAlbumSyncFfiSnapshot
import org.mosaic.android.foundation.RustClientCoreAlbumSyncFfiTransition
import org.mosaic.android.foundation.RustClientCoreAlbumSyncTransitionFfiResult
import uniffi.mosaic_uniffi.ClientCoreAlbumSyncEffect as RustClientCoreAlbumSyncEffectUniFfi
import uniffi.mosaic_uniffi.ClientCoreAlbumSyncEvent as RustClientCoreAlbumSyncEventUniFfi
import uniffi.mosaic_uniffi.ClientCoreAlbumSyncRequest as RustClientCoreAlbumSyncRequestUniFfi
import uniffi.mosaic_uniffi.ClientCoreAlbumSyncSnapshot as RustClientCoreAlbumSyncSnapshotUniFfi
import uniffi.mosaic_uniffi.advanceAlbumSync as rustAdvanceAlbumSync
import uniffi.mosaic_uniffi.initAlbumSync as rustInitAlbumSync

/**
 * Real implementation of [GeneratedRustAlbumSyncApi] backed by the Rust UniFFI core.
 *
 * Note: the shell's `RustClientCoreAlbumSyncFfiSnapshot` does not carry
 * `maxRetryCount` (only the request does). When converting shell→UniFFI this
 * adapter defaults `maxRetryCount` to `0`. Once the shell schema is extended
 * to carry it, replace the default with the snapshot field.
 */
class AndroidRustAlbumSyncApi : GeneratedRustAlbumSyncApi {

  init {
    AndroidRustCoreLibraryLoader.warmUp()
  }

  override fun initAlbumSync(request: RustClientCoreAlbumSyncFfiRequest): RustClientCoreAlbumSyncFfiResult {
    val uniRequest = RustClientCoreAlbumSyncRequestUniFfi(
      albumId = request.albumId,
      requestId = request.requestId,
      startCursor = request.startCursor,
      nowUnixMs = request.nowUnixMs.toULong(),
      maxRetryCount = request.maxRetryCount.toUInt(),
    )
    val uniResult = rustInitAlbumSync(uniRequest)
    return RustClientCoreAlbumSyncFfiResult(
      code = uniResult.code.toInt(),
      snapshot = uniResult.snapshot.toShellSnapshot(),
    )
  }

  override fun advanceAlbumSync(
    snapshot: RustClientCoreAlbumSyncFfiSnapshot,
    event: RustClientCoreAlbumSyncFfiEvent,
  ): RustClientCoreAlbumSyncTransitionFfiResult {
    val uniSnapshot = snapshot.toUniFfiSnapshot()
    val uniEvent = event.toUniFfiEvent()
    val uniResult = rustAdvanceAlbumSync(uniSnapshot, uniEvent)
    return RustClientCoreAlbumSyncTransitionFfiResult(
      code = uniResult.code.toInt(),
      transition = RustClientCoreAlbumSyncFfiTransition(
        snapshot = uniResult.transition.snapshot.toShellSnapshot(),
        effects = uniResult.transition.effects.map { it.toShellEffect() },
      ),
    )
  }

  private fun RustClientCoreAlbumSyncSnapshotUniFfi.toShellSnapshot(): RustClientCoreAlbumSyncFfiSnapshot =
    RustClientCoreAlbumSyncFfiSnapshot(
      schemaVersion = schemaVersion.toInt(),
      albumId = albumId,
      phase = phase,
      activeCursor = activeCursor,
      pendingCursor = pendingCursor,
      rerunRequested = rerunRequested,
      retryCount = retryCount.toInt(),
      maxRetryCount = maxRetryCount.toInt(),
      nextRetryUnixMs = nextRetryUnixMs.toLong(),
      lastErrorCode = lastErrorCode.toInt(),
      lastErrorStage = lastErrorStage,
      updatedAtUnixMs = updatedAtUnixMs.toLong(),
    )

  private fun RustClientCoreAlbumSyncFfiSnapshot.toUniFfiSnapshot(): RustClientCoreAlbumSyncSnapshotUniFfi =
    RustClientCoreAlbumSyncSnapshotUniFfi(
      schemaVersion = schemaVersion.toUInt(),
      albumId = albumId,
      phase = phase,
      activeCursor = activeCursor,
      pendingCursor = pendingCursor,
      rerunRequested = rerunRequested,
      retryCount = retryCount.toUInt(),
      maxRetryCount = maxRetryCount.toUInt(),
      nextRetryUnixMs = nextRetryUnixMs.toULong(),
      lastErrorCode = lastErrorCode.toUShort(),
      lastErrorStage = lastErrorStage,
      updatedAtUnixMs = updatedAtUnixMs.toULong(),
    )

  private fun RustClientCoreAlbumSyncFfiEvent.toUniFfiEvent(): RustClientCoreAlbumSyncEventUniFfi =
    RustClientCoreAlbumSyncEventUniFfi(
      kind = kind,
      fetchedCursor = fetchedCursor,
      nextCursor = nextCursor,
      appliedCount = appliedCount.toUInt(),
      observedAssetIds = observedAssetIds,
      retryAfterUnixMs = retryAfterUnixMs.toULong(),
      errorCode = errorCode.toUShort(),
    )

  private fun RustClientCoreAlbumSyncEffectUniFfi.toShellEffect(): RustClientCoreAlbumSyncFfiEffect =
    RustClientCoreAlbumSyncFfiEffect(
      kind = kind,
      cursor = cursor,
    )
}
