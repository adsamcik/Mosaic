package org.mosaic.android.main.reducer

import androidx.work.ExistingWorkPolicy
import androidx.work.WorkManager
import java.security.SecureRandom
import java.time.Clock
import java.util.UUID
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import org.mosaic.android.foundation.GeneratedRustUploadApi
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiEffect
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiEvent
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiSnapshot
import org.mosaic.android.foundation.RustClientCoreUploadStableCode
import org.mosaic.android.main.crypto.ShardEncryptionScheduler
import org.mosaic.android.main.db.RustSnapshotVersions
import org.mosaic.android.main.db.UploadJobSnapshotRow
import org.mosaic.android.main.db.UploadQueueDatabase
import org.mosaic.android.main.upload.ShardUploadScheduler

class UploadJobReducer(
  private val database: UploadQueueDatabase,
  private val uniffi: MosaicUniffi,
  private val effectDispatcher: EffectDispatcher,
  private val cancellationGateway: UploadWorkCancellationGateway,
  private val clock: Clock = Clock.systemUTC(),
) {
  suspend fun run(jobId: UploadJobId): UploadJobOutcome = coroutineScope {
    val dao = database.uploadJobSnapshotDao()
    var row = dao.get(jobId.value) ?: return@coroutineScope UploadJobOutcome.NotFound

    while (!uniffi.isTerminal(row)) {
      ensureActive()
      val iterationRevision = row.snapshotRevision
      val effect = uniffi.getCurrentEffect(row) ?: break
      val event = try {
        effectDispatcher.dispatch(row, effect)
      } catch (error: EffectDispatchException) {
        retryOrFail(row, effect, error)
      }
      val advanced = uniffi.advanceUploadJob(row, event).withPersistedClock(clock.millis())
      val updated = dao.upsertIfRevisionMatches(advanced, previousRevision = iterationRevision)
      row = if (updated == 1) {
        advanced
      } else {
        dao.get(jobId.value) ?: return@coroutineScope UploadJobOutcome.NotFound
      }
    }

    UploadJobOutcome.from(row, uniffi)
  }

  suspend fun cancel(jobId: UploadJobId): UploadJobOutcome {
    val dao = database.uploadJobSnapshotDao()
    var row = dao.get(jobId.value) ?: return UploadJobOutcome.NotFound
    cancellationGateway.cancelAllForJob(jobId)
    repeat(MAX_CANCEL_CAS_ATTEMPTS) {
      if (uniffi.isTerminal(row)) {
        return UploadJobOutcome.from(row, uniffi)
      }
      val event = UploadJobEvents.cancelRequested(effectId = row.cancelEffectId())
      val cancelled = uniffi.advanceUploadJob(row, event).withPersistedClock(clock.millis())
      val updated = dao.upsertIfRevisionMatches(cancelled, previousRevision = row.snapshotRevision)
      if (updated == 1) {
        return UploadJobOutcome.Cancelled
      }
      row = dao.get(jobId.value) ?: return UploadJobOutcome.NotFound
    }
    return UploadJobOutcome.from(row, uniffi)
  }

  private fun retryOrFail(
    row: UploadJobSnapshotRow,
    effect: RustClientCoreUploadJobFfiEffect,
    error: EffectDispatchException,
  ): RustClientCoreUploadJobFfiEvent {
    val budget = RetryBudget.forEffect(effect)
    // Rust core's RetryableFailure transition compares the pre-increment
    // retry_count with max_retry_count, then increments for the scheduled retry.
    // Keep Android's pre-check aligned so maxRetries means "retries allowed";
    // the following failure after those retries is converted to NonRetryable.
    return if (error.retryable && row.retryCount(uniffi) < budget.maxRetries) {
      UploadJobEvents.retryableFailure(
        effectId = effect.effectId,
        nowMs = clock.millis(),
        baseBackoffMs = budget.baseBackoffMs,
        errorCode = error.stableCode,
      )
    } else {
      UploadJobEvents.nonRetryableFailure(
        effectId = effect.effectId,
        errorCode = RustClientCoreUploadStableCode.CLIENT_CORE_RETRY_BUDGET_EXHAUSTED,
      )
    }
  }

  private companion object {
    const val MAX_CANCEL_CAS_ATTEMPTS = 8
  }
}

@JvmInline
value class UploadJobId(val value: String) {
  init {
    require(value.isNotBlank()) { "upload job id is required" }
  }
}

sealed interface UploadJobOutcome {
  data object NotFound : UploadJobOutcome
  data object WaitingForExternalEvent : UploadJobOutcome
  data object Finalized : UploadJobOutcome
  data object Failed : UploadJobOutcome
  data object Cancelled : UploadJobOutcome
  data class Running(val phase: String) : UploadJobOutcome

  companion object {
    fun from(row: UploadJobSnapshotRow, uniffi: MosaicUniffi): UploadJobOutcome {
      val phase = uniffi.snapshotPhase(row)
      return when (phase) {
        "Confirmed", "Finalized", "Completed" -> Finalized
        "Failed" -> Failed
        "Cancelled" -> Cancelled
        else -> if (uniffi.getCurrentEffect(row) == null) WaitingForExternalEvent else Running(phase)
      }
    }
  }
}

interface MosaicUniffi {
  fun getCurrentEffect(snapshot: UploadJobSnapshotRow): RustClientCoreUploadJobFfiEffect?
  fun advanceUploadJob(
    snapshot: UploadJobSnapshotRow,
    event: RustClientCoreUploadJobFfiEvent,
  ): UploadJobSnapshotRow

  fun isTerminal(snapshot: UploadJobSnapshotRow): Boolean
  fun snapshotPhase(snapshot: UploadJobSnapshotRow): String
  fun snapshotRetryCount(snapshot: UploadJobSnapshotRow): Int
}

class AndroidMosaicUniffi(
  private val uploadApi: GeneratedRustUploadApi,
  private val codec: UploadJobSnapshotCodec = UploadJobSnapshotCodec,
) : MosaicUniffi {
  override fun getCurrentEffect(snapshot: UploadJobSnapshotRow): RustClientCoreUploadJobFfiEffect? {
    val shell = codec.decode(snapshot.canonicalCborBytes)
    val effectId = shell.lastAcknowledgedEffectId.ifBlank { shell.lastAppliedEventId.ifBlank { shell.jobId } }
    return when (shell.phase) {
      "AwaitingPreparedMedia" -> effect("PrepareMedia", effectId)
      "AwaitingEpochHandle" -> effect("AcquireEpochHandle", effectId)
      "EncryptingShard" -> shell.tieredShards.firstOrNull { !it.uploaded }?.let {
        effect("EncryptShard", effectId, it.tier, it.shardIndex)
      }
      "CreatingShardUpload" -> shell.tieredShards.firstOrNull { !it.uploaded }?.let {
        effect("CreateShardUpload", effectId, it.tier, it.shardIndex)
      }
      "UploadingShard" -> shell.tieredShards.firstOrNull { !it.uploaded }?.let {
        effect("UploadShard", effectId, it.tier, it.shardIndex)
      }
      "CreatingManifest" -> effect("CreateManifest", effectId)
      "AwaitingSyncConfirmation" -> effect("AwaitSyncConfirmation", effectId)
      "RetryWaiting" -> effect("ScheduleRetry", effectId)
      else -> null
    }
  }

  override fun advanceUploadJob(
    snapshot: UploadJobSnapshotRow,
    event: RustClientCoreUploadJobFfiEvent,
  ): UploadJobSnapshotRow {
    val shell = codec.decode(snapshot.canonicalCborBytes)
    val transition = uploadApi.advanceUploadJob(shell, event)
    require(transition.code == RustClientCoreUploadStableCode.OK) {
      "upload reducer transition failed with stable code ${transition.code}"
    }
    val next = transition.transition.nextSnapshot
    return snapshot.copy(
      schemaVersion = next.schemaVersion,
      canonicalCborBytes = codec.encode(next),
      snapshotRevision = next.snapshotRevision,
    )
  }

  override fun isTerminal(snapshot: UploadJobSnapshotRow): Boolean = snapshotPhase(snapshot) in TERMINAL_PHASES

  override fun snapshotPhase(snapshot: UploadJobSnapshotRow): String = codec.decode(snapshot.canonicalCborBytes).phase

  override fun snapshotRetryCount(snapshot: UploadJobSnapshotRow): Int = codec.decode(snapshot.canonicalCborBytes).retryCount

  private fun effect(kind: String, effectId: String, tier: Int = 0, shardIndex: Int = 0) =
    RustClientCoreUploadJobFfiEffect(kind = kind, effectId = effectId, tier = tier, shardIndex = shardIndex)

  private companion object {
    val TERMINAL_PHASES = setOf("Confirmed", "Finalized", "Completed", "Failed", "Cancelled")
  }
}

interface EffectDispatcher {
  @Throws(EffectDispatchException::class)
  suspend fun dispatch(
    snapshot: UploadJobSnapshotRow,
    effect: RustClientCoreUploadJobFfiEffect,
  ): RustClientCoreUploadJobFfiEvent
}

class WorkManagerEffectDispatcher(
  private val workManager: WorkManager,
  private val resolver: EffectInputResolver,
  private val observer: EffectCompletionObserver,
  private val manifestCommitter: ManifestCommitEffectHandler,
  private val syncConfirmation: SyncConfirmationEffectHandler,
) : EffectDispatcher {
  override suspend fun dispatch(
    snapshot: UploadJobSnapshotRow,
    effect: RustClientCoreUploadJobFfiEffect,
  ): RustClientCoreUploadJobFfiEvent = when (effect.kind) {
    "EncryptShard" -> {
      val input = resolver.encryptShard(snapshot, effect)
      workManager.enqueueUniqueWork(
        uniqueWorkName(snapshot.jobId, effect),
        ExistingWorkPolicy.KEEP,
        ShardEncryptionScheduler.buildRequest(
          jobId = snapshot.jobId,
          stagingUri = input.stagingUri,
          epochHandleId = input.epochHandleId,
          tier = effect.tier,
          shardIndex = effect.shardIndex,
        ),
      )
      observer.await(effect)
    }
    "UploadShard", "CreateShardUpload" -> {
      val input = resolver.uploadShard(snapshot, effect)
      workManager.enqueueUniqueWork(
        uniqueWorkName(snapshot.jobId, effect),
        ExistingWorkPolicy.KEEP,
        ShardUploadScheduler.buildRequest(
          jobId = snapshot.jobId,
          shardId = input.shardId,
          tusEndpoint = input.tusEndpoint,
          metadataSignature = input.metadataSignature,
        ),
      )
      observer.await(effect)
    }
    "CommitManifest", "CreateManifest" -> manifestCommitter.commit(snapshot, effect)
    "WaitForSync", "AwaitSyncConfirmation" -> syncConfirmation.confirm(snapshot, effect)
    "ScheduleRetry" -> observer.await(effect)
    "PrepareMedia", "AcquireEpochHandle" -> observer.await(effect)
    else -> throw EffectDispatchException("unsupported upload effect kind", retryable = false)
  }

  private fun uniqueWorkName(jobId: String, effect: RustClientCoreUploadJobFfiEffect): String =
    "upload-job-$jobId-effect-${effect.effectId}-${effect.kind}-${effect.tier}-${effect.shardIndex}"
}

interface EffectInputResolver {
  fun encryptShard(snapshot: UploadJobSnapshotRow, effect: RustClientCoreUploadJobFfiEffect): EncryptShardWorkInput
  fun uploadShard(snapshot: UploadJobSnapshotRow, effect: RustClientCoreUploadJobFfiEffect): UploadShardWorkInput
}

data class EncryptShardWorkInput(
  val stagingUri: String,
  val epochHandleId: Long,
)

data class UploadShardWorkInput(
  val shardId: String,
  val tusEndpoint: String,
  val metadataSignature: String?,
)

interface EffectCompletionObserver {
  suspend fun await(effect: RustClientCoreUploadJobFfiEffect): RustClientCoreUploadJobFfiEvent
}

interface ManifestCommitEffectHandler {
  suspend fun commit(
    snapshot: UploadJobSnapshotRow,
    effect: RustClientCoreUploadJobFfiEffect,
  ): RustClientCoreUploadJobFfiEvent
}

interface SyncConfirmationEffectHandler {
  suspend fun confirm(
    snapshot: UploadJobSnapshotRow,
    effect: RustClientCoreUploadJobFfiEffect,
  ): RustClientCoreUploadJobFfiEvent
}

interface UploadWorkCancellationGateway {
  suspend fun cancelAllForJob(jobId: UploadJobId)
}

class WorkManagerUploadCancellationGateway(
  private val workManager: WorkManager,
) : UploadWorkCancellationGateway {
  override suspend fun cancelAllForJob(jobId: UploadJobId) {
    workManager.cancelAllWorkByTag(ShardEncryptionScheduler.uploadJobTag(jobId.value))
  }
}

class EffectDispatchException(
  message: String,
  val retryable: Boolean,
  val stableCode: Int = RustClientCoreUploadStableCode.CLIENT_CORE_MANIFEST_OUTCOME_UNKNOWN,
  cause: Throwable? = null,
) : Exception(message, cause)

data class RetryBudget(
  val maxRetries: Int,
  val baseBackoffMs: Long = 1_000L,
) {
  companion object {
    fun forEffect(effect: RustClientCoreUploadJobFfiEffect): RetryBudget = when (effect.kind) {
      "EncryptShard" -> RetryBudget(maxRetries = 3)
      "UploadShard", "CreateShardUpload" -> RetryBudget(maxRetries = 5)
      "CommitManifest", "CreateManifest" -> RetryBudget(maxRetries = 5)
      "WaitForSync", "AwaitSyncConfirmation" -> RetryBudget(maxRetries = 1)
      else -> RetryBudget(maxRetries = 1)
    }
  }
}

private fun UploadJobSnapshotRow.retryCount(uniffi: MosaicUniffi): Int = uniffi.snapshotRetryCount(this)

private fun UploadJobSnapshotRow.cancelEffectId(): String = generateUuidV7()

private fun UploadJobSnapshotRow.withPersistedClock(nowMs: Long): UploadJobSnapshotRow = copy(updatedAtMs = nowMs)

private val cancelEffectIdRandom = SecureRandom()

private fun generateUuidV7(nowMs: Long = System.currentTimeMillis()): String {
  val randomA = cancelEffectIdRandom.nextLong() and 0x0fffL
  val randomB = cancelEffectIdRandom.nextLong() and 0x3fff_ffff_ffff_ffffL
  val mostSignificantBits = ((nowMs and 0x0000_ffff_ffff_ffffL) shl 16) or 0x7000L or randomA
  val leastSignificantBits = Long.MIN_VALUE or randomB
  return UUID(mostSignificantBits, leastSignificantBits).toString()
}

object UploadJobEvents {
  fun effectAck(effectId: String): RustClientCoreUploadJobFfiEvent = event(kind = "EffectAck", effectId = effectId)

  fun cancelRequested(effectId: String): RustClientCoreUploadJobFfiEvent = event(kind = "CancelRequested", effectId = effectId)

  fun nonRetryableFailure(effectId: String, errorCode: Int): RustClientCoreUploadJobFfiEvent = event(
    kind = "NonRetryableFailure",
    effectId = effectId,
    hasErrorCode = true,
    errorCode = errorCode,
  )

  fun retryableFailure(
    effectId: String,
    nowMs: Long,
    baseBackoffMs: Long,
    errorCode: Int,
  ): RustClientCoreUploadJobFfiEvent = event(
    kind = "RetryableFailure",
    effectId = effectId,
    nowMs = nowMs,
    baseBackoffMs = baseBackoffMs,
    hasErrorCode = true,
    errorCode = errorCode,
  )

  fun shardEncrypted(
    effectId: String,
    tier: Int,
    shardIndex: Int,
    shardId: String,
    sha256: ByteArray,
    contentLength: Long,
    envelopeVersion: Int,
  ): RustClientCoreUploadJobFfiEvent = event(
    kind = "ShardEncrypted",
    effectId = effectId,
    tier = tier,
    shardIndex = shardIndex,
    shardId = shardId,
    sha256 = sha256,
    contentLength = contentLength,
    envelopeVersion = envelopeVersion,
  )

  fun shardUploadCreated(effectId: String, shard: org.mosaic.android.foundation.RustClientCoreUploadShardRef): RustClientCoreUploadJobFfiEvent = event(
    kind = "ShardUploadCreated",
    effectId = effectId,
    tier = shard.tier,
    shardIndex = shard.shardIndex,
    shardId = shard.shardId,
    sha256 = shard.sha256,
    contentLength = shard.contentLength,
    envelopeVersion = shard.envelopeVersion,
    uploaded = shard.uploaded,
  )

  fun shardUploaded(effectId: String, shard: org.mosaic.android.foundation.RustClientCoreUploadShardRef): RustClientCoreUploadJobFfiEvent = event(
    kind = "ShardUploaded",
    effectId = effectId,
    tier = shard.tier,
    shardIndex = shard.shardIndex,
    shardId = shard.shardId,
    sha256 = shard.sha256,
    contentLength = shard.contentLength,
    envelopeVersion = shard.envelopeVersion,
    uploaded = true,
  )

  fun manifestCreated(effectId: String): RustClientCoreUploadJobFfiEvent = event(kind = "ManifestCreated", effectId = effectId)

  fun syncConfirmed(effectId: String): RustClientCoreUploadJobFfiEvent = event(kind = "SyncConfirmed", effectId = effectId)

  fun retryTimerElapsed(effectId: String, targetPhase: String): RustClientCoreUploadJobFfiEvent = event(
    kind = "RetryTimerElapsed",
    effectId = effectId,
    targetPhase = targetPhase,
  )

  fun mediaPrepared(
    effectId: String,
    tieredShards: List<org.mosaic.android.foundation.RustClientCoreUploadShardRef>,
    shardSetHash: ByteArray,
  ): RustClientCoreUploadJobFfiEvent = event(
    kind = "MediaPrepared",
    effectId = effectId,
    tieredShards = tieredShards,
    shardSetHash = shardSetHash,
  )

  fun epochHandleAcquired(effectId: String): RustClientCoreUploadJobFfiEvent = event(kind = "EpochHandleAcquired", effectId = effectId)

  private fun event(
    kind: String,
    effectId: String,
    tier: Int = 0,
    shardIndex: Int = 0,
    shardId: String = "",
    sha256: ByteArray = ByteArray(0),
    contentLength: Long = 0,
    envelopeVersion: Int = 0,
    uploaded: Boolean = false,
    tieredShards: List<org.mosaic.android.foundation.RustClientCoreUploadShardRef> = emptyList(),
    shardSetHash: ByteArray = ByteArray(0),
    nowMs: Long = 0,
    baseBackoffMs: Long = 0,
    hasErrorCode: Boolean = false,
    errorCode: Int = 0,
    targetPhase: String = "",
  ): RustClientCoreUploadJobFfiEvent = RustClientCoreUploadJobFfiEvent(
    kind = kind,
    effectId = effectId,
    tier = tier,
    shardIndex = shardIndex,
    shardId = shardId,
    sha256 = sha256,
    contentLength = contentLength,
    envelopeVersion = envelopeVersion,
    uploaded = uploaded,
    tieredShards = tieredShards,
    shardSetHash = shardSetHash,
    assetId = "",
    sinceMetadataVersion = 0,
    recoveryOutcome = "",
    nowMs = nowMs,
    baseBackoffMs = baseBackoffMs,
    serverRetryAfterMs = 0,
    hasServerRetryAfterMs = false,
    hasErrorCode = hasErrorCode,
    errorCode = errorCode,
    targetPhase = targetPhase,
  )
}

fun RustClientCoreUploadJobFfiSnapshot.toUploadJobSnapshotRow(updatedAtMs: Long): UploadJobSnapshotRow = UploadJobSnapshotRow(
  jobId = jobId,
  schemaVersion = schemaVersion,
  canonicalCborBytes = UploadJobSnapshotCodec.encode(this),
  updatedAtMs = updatedAtMs,
  snapshotRevision = snapshotRevision,
)

fun UploadJobSnapshotRow.decodeUploadSnapshot(): RustClientCoreUploadJobFfiSnapshot =
  UploadJobSnapshotCodec.decode(canonicalCborBytes)

