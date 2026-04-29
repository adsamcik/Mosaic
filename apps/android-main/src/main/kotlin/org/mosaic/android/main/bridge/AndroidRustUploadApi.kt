package org.mosaic.android.main.bridge

import org.mosaic.android.foundation.GeneratedRustUploadApi
import org.mosaic.android.foundation.RustClientCoreManifestReceipt
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiEvent
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiRequest
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiResult
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiSnapshot
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiTransition
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiEffect
import org.mosaic.android.foundation.RustClientCoreUploadJobTransitionFfiResult
import org.mosaic.android.foundation.RustClientCoreUploadShardRef
import uniffi.mosaic_uniffi.ClientCoreManifestReceipt as RustClientCoreManifestReceiptUniFfi
import uniffi.mosaic_uniffi.ClientCoreUploadJobEffect as RustClientCoreUploadJobEffectUniFfi
import uniffi.mosaic_uniffi.ClientCoreUploadJobEvent as RustClientCoreUploadJobEventUniFfi
import uniffi.mosaic_uniffi.ClientCoreUploadJobRequest as RustClientCoreUploadJobRequestUniFfi
import uniffi.mosaic_uniffi.ClientCoreUploadJobSnapshot as RustClientCoreUploadJobSnapshotUniFfi
import uniffi.mosaic_uniffi.ClientCoreUploadShardRef as RustClientCoreUploadShardRefUniFfi
import uniffi.mosaic_uniffi.advanceUploadJob as rustAdvanceUploadJob
import uniffi.mosaic_uniffi.initUploadJob as rustInitUploadJob

/**
 * Real implementation of [GeneratedRustUploadApi] backed by the Rust UniFFI core.
 *
 * Note on `maxRetryCount`: the shell's `RustClientCoreUploadJobFfiSnapshot`
 * does not yet carry `maxRetryCount` (only the `RustClientCoreUploadJobFfiRequest`
 * does). The UniFFI snapshot does. When translating shell snapshot → UniFFI,
 * this adapter therefore defaults `maxRetryCount` to `0`. Once the shell schema
 * is extended to carry it, replace the default with the snapshot field.
 */
class AndroidRustUploadApi : GeneratedRustUploadApi {

  init {
    AndroidRustCoreLibraryLoader.warmUp()
  }

  override fun initUploadJob(request: RustClientCoreUploadJobFfiRequest): RustClientCoreUploadJobFfiResult {
    val uniRequest = RustClientCoreUploadJobRequestUniFfi(
      jobId = request.jobId,
      albumId = request.albumId,
      assetId = request.assetId,
      epochId = request.epochId.toUInt(),
      nowUnixMs = request.nowUnixMs.toULong(),
      maxRetryCount = request.maxRetryCount.toUInt(),
    )
    val uniResult = rustInitUploadJob(uniRequest)
    return RustClientCoreUploadJobFfiResult(
      code = uniResult.code.toInt(),
      snapshot = uniResult.snapshot.toShellSnapshot(),
    )
  }

  override fun advanceUploadJob(
    snapshot: RustClientCoreUploadJobFfiSnapshot,
    event: RustClientCoreUploadJobFfiEvent,
  ): RustClientCoreUploadJobTransitionFfiResult {
    val uniSnapshot = snapshot.toUniFfiSnapshot()
    val uniEvent = event.toUniFfiEvent()
    val uniResult = rustAdvanceUploadJob(uniSnapshot, uniEvent)
    return RustClientCoreUploadJobTransitionFfiResult(
      code = uniResult.code.toInt(),
      transition = RustClientCoreUploadJobFfiTransition(
        snapshot = uniResult.transition.snapshot.toShellSnapshot(),
        effects = uniResult.transition.effects.map { it.toShellEffect() },
      ),
    )
  }

  // -------- shell <-> UniFFI conversions --------

  private fun RustClientCoreUploadJobSnapshotUniFfi.toShellSnapshot(): RustClientCoreUploadJobFfiSnapshot =
    RustClientCoreUploadJobFfiSnapshot(
      schemaVersion = schemaVersion.toInt(),
      jobId = jobId,
      albumId = albumId,
      assetId = assetId,
      epochId = epochId.toInt(),
      phase = phase,
      activeTier = activeTier.toInt(),
      activeShardIndex = activeShardIndex.toInt(),
      completedShards = completedShards.map {
        RustClientCoreUploadShardRef(
          tier = it.tier.toInt(),
          shardIndex = it.shardIndex.toInt(),
          shardId = it.shardId,
          sha256 = it.sha256,
          uploaded = it.uploaded,
        )
      },
      hasManifestReceipt = hasManifestReceipt,
      manifestReceipt = RustClientCoreManifestReceipt(
        manifestId = manifestReceipt.manifestId,
        manifestVersion = manifestReceipt.manifestVersion.toLong(),
      ),
      retryCount = retryCount.toInt(),
      nextRetryUnixMs = nextRetryUnixMs.toLong(),
      lastErrorCode = lastErrorCode.toInt(),
      lastErrorStage = lastErrorStage,
      syncConfirmed = syncConfirmed,
      updatedAtUnixMs = updatedAtUnixMs.toLong(),
    )

  private fun RustClientCoreUploadJobFfiSnapshot.toUniFfiSnapshot(): RustClientCoreUploadJobSnapshotUniFfi =
    RustClientCoreUploadJobSnapshotUniFfi(
      schemaVersion = schemaVersion.toUInt(),
      jobId = jobId,
      albumId = albumId,
      assetId = assetId,
      epochId = epochId.toUInt(),
      phase = phase,
      activeTier = activeTier.toUByte(),
      activeShardIndex = activeShardIndex.toUInt(),
      completedShards = completedShards.map {
        RustClientCoreUploadShardRefUniFfi(
          tier = it.tier.toUByte(),
          shardIndex = it.shardIndex.toUInt(),
          shardId = it.shardId,
          sha256 = it.sha256,
          uploaded = it.uploaded,
        )
      },
      hasManifestReceipt = hasManifestReceipt,
      manifestReceipt = RustClientCoreManifestReceiptUniFfi(
        manifestId = manifestReceipt.manifestId,
        manifestVersion = manifestReceipt.manifestVersion.toULong(),
      ),
      retryCount = retryCount.toUInt(),
      maxRetryCount = 0u,
      nextRetryUnixMs = nextRetryUnixMs.toULong(),
      lastErrorCode = lastErrorCode.toUShort(),
      lastErrorStage = lastErrorStage,
      syncConfirmed = syncConfirmed,
      updatedAtUnixMs = updatedAtUnixMs.toULong(),
    )

  private fun RustClientCoreUploadJobFfiEvent.toUniFfiEvent(): RustClientCoreUploadJobEventUniFfi =
    RustClientCoreUploadJobEventUniFfi(
      kind = kind,
      epochId = 0u,
      tier = tier.toUByte(),
      shardIndex = shardIndex.toUInt(),
      shardId = shardId,
      sha256 = sha256,
      manifestId = manifestId,
      manifestVersion = manifestVersion.toULong(),
      observedAssetId = observedAssetId,
      retryAfterUnixMs = retryAfterUnixMs.toULong(),
      errorCode = errorCode.toUShort(),
    )

  private fun RustClientCoreUploadJobEffectUniFfi.toShellEffect(): RustClientCoreUploadJobFfiEffect =
    RustClientCoreUploadJobFfiEffect(
      kind = kind,
      tier = tier.toInt(),
      shardIndex = shardIndex.toInt(),
    )
}
