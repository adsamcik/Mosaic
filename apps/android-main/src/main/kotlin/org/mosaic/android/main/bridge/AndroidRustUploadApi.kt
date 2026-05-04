package org.mosaic.android.main.bridge

import org.mosaic.android.foundation.GeneratedRustUploadApi
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiEffect
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiEvent
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiRequest
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiResult
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiSnapshot
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiTransition
import org.mosaic.android.foundation.RustClientCoreUploadJobTransitionFfiResult
import org.mosaic.android.foundation.RustClientCoreUploadShardRef
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
 * Keeps the Android shell DTOs aligned with the UniFFI client-core upload schema
 * while preserving the shell-facing names consumed by view models.
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
      idempotencyKey = request.idempotencyKey,
      maxRetryCount = request.maxRetryCount.toUByte(),
    )
    val uniResult = rustInitUploadJob(uniRequest)
    val rustCode = uniResult.code.toInt()
    return if (rustCode == 0) {
      RustClientCoreUploadJobFfiResult(
        code = rustCode,
        snapshot = uniResult.snapshot.toShellSnapshot(),
      )
    } else {
      RustClientCoreUploadJobFfiResult(
        code = rustCode,
        snapshot = RustClientCoreUploadJobFfiSnapshot(
          schemaVersion = 1,
          jobId = request.jobId,
          albumId = request.albumId,
          phase = "Rejected",
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
          failureCode = rustCode,
        ),
      )
    }
  }

  override fun advanceUploadJob(
    snapshot: RustClientCoreUploadJobFfiSnapshot,
    event: RustClientCoreUploadJobFfiEvent,
  ): RustClientCoreUploadJobTransitionFfiResult {
    val uniSnapshot = snapshot.toUniFfiSnapshot()
    val uniEvent = event.toUniFfiEvent()
    val uniResult = rustAdvanceUploadJob(uniSnapshot, uniEvent)
    val rustCode = uniResult.code.toInt()
    return if (rustCode == 0) {
      RustClientCoreUploadJobTransitionFfiResult(
        code = rustCode,
        transition = RustClientCoreUploadJobFfiTransition(
          nextSnapshot = uniResult.transition.nextSnapshot.toShellSnapshot(),
          effects = uniResult.transition.effects.map { it.toShellEffect() },
        ),
      )
    } else {
      RustClientCoreUploadJobTransitionFfiResult(
        code = rustCode,
        transition = RustClientCoreUploadJobFfiTransition(
          nextSnapshot = snapshot,
          effects = emptyList(),
        ),
      )
    }
  }

  internal fun RustClientCoreUploadJobSnapshotUniFfi.toShellSnapshot(): RustClientCoreUploadJobFfiSnapshot =
    RustClientCoreUploadJobFfiSnapshot(
      schemaVersion = schemaVersion.toInt(),
      jobId = jobId,
      albumId = albumId,
      phase = phase,
      retryCount = retryCount.toInt(),
      maxRetryCount = maxRetryCount.toInt(),
      nextRetryNotBeforeMs = nextRetryNotBeforeMs,
      hasNextRetryNotBeforeMs = hasNextRetryNotBeforeMs,
      idempotencyKey = idempotencyKey,
      tieredShards = tieredShards.map {
        RustClientCoreUploadShardRef(
          tier = it.tier.toInt(),
          shardIndex = it.shardIndex.toInt(),
          shardId = it.shardId,
          sha256 = it.sha256,
          contentLength = it.contentLength.toLong(),
          envelopeVersion = it.envelopeVersion.toInt(),
          uploaded = it.uploaded,
        )
      },
      shardSetHash = shardSetHash,
      snapshotRevision = snapshotRevision.toLong(),
      lastEffectId = lastEffectId,
      lastAcknowledgedEffectId = lastAcknowledgedEffectId,
      lastAppliedEventId = lastAppliedEventId,
      failureCode = failureCode.toInt(),
    )

  internal fun RustClientCoreUploadJobFfiSnapshot.toUniFfiSnapshot(): RustClientCoreUploadJobSnapshotUniFfi =
    RustClientCoreUploadJobSnapshotUniFfi(
      schemaVersion = schemaVersion.toUInt(),
      jobId = jobId,
      albumId = albumId,
      phase = phase,
      retryCount = retryCount.toUInt(),
      maxRetryCount = maxRetryCount.toUByte(),
      nextRetryNotBeforeMs = nextRetryNotBeforeMs,
      hasNextRetryNotBeforeMs = hasNextRetryNotBeforeMs,
      idempotencyKey = idempotencyKey,
      tieredShards = tieredShards.map { it.toUniFfiShardRef() },
      shardSetHash = shardSetHash,
      snapshotRevision = snapshotRevision.toULong(),
      lastEffectId = lastEffectId,
      lastAcknowledgedEffectId = lastAcknowledgedEffectId,
      lastAppliedEventId = lastAppliedEventId,
      failureCode = failureCode.toUShort(),
    )

  internal fun RustClientCoreUploadJobFfiEvent.toUniFfiEvent(): RustClientCoreUploadJobEventUniFfi =
    RustClientCoreUploadJobEventUniFfi(
      kind = kind,
      effectId = effectId,
      tier = tier.toUByte(),
      shardIndex = shardIndex.toUInt(),
      shardId = shardId,
      sha256 = sha256,
      contentLength = contentLength.toULong(),
      envelopeVersion = envelopeVersion.toUByte(),
      uploaded = uploaded,
      tieredShards = tieredShards.map { it.toUniFfiShardRef() },
      shardSetHash = shardSetHash,
      assetId = assetId,
      sinceMetadataVersion = sinceMetadataVersion.toULong(),
      recoveryOutcome = recoveryOutcome,
      nowMs = nowMs,
      baseBackoffMs = baseBackoffMs.toULong(),
      serverRetryAfterMs = serverRetryAfterMs.toULong(),
      hasServerRetryAfterMs = hasServerRetryAfterMs,
      hasErrorCode = hasErrorCode,
      errorCode = errorCode.toUShort(),
      targetPhase = targetPhase,
    )

  internal fun RustClientCoreUploadJobEffectUniFfi.toShellEffect(): RustClientCoreUploadJobFfiEffect =
    RustClientCoreUploadJobFfiEffect(
      kind = kind,
      effectId = effectId,
      tier = tier.toInt(),
      shardIndex = shardIndex.toInt(),
    )

  private fun RustClientCoreUploadShardRef.toUniFfiShardRef(): RustClientCoreUploadShardRefUniFfi =
    RustClientCoreUploadShardRefUniFfi(
      tier = tier.toUByte(),
      shardIndex = shardIndex.toUInt(),
      shardId = shardId,
      sha256 = sha256,
      contentLength = contentLength.toULong(),
      envelopeVersion = envelopeVersion.toUByte(),
      uploaded = uploaded,
    )
}
