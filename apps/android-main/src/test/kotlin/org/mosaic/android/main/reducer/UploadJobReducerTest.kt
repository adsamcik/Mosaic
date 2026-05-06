package org.mosaic.android.main.reducer

import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiEffect
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiEvent
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiSnapshot
import org.mosaic.android.foundation.RustClientCoreUploadShardRef
import org.mosaic.android.foundation.RustClientCoreUploadStableCode
import org.mosaic.android.main.db.UploadJobSnapshotRow
import org.mosaic.android.main.db.UploadQueueDatabase
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class UploadJobReducerTest {
  private val database = UploadQueueDatabase.createInMemoryForTests(ApplicationProvider.getApplicationContext())
  private val uniffi = FakeMosaicUniffi()
  private val cancellationGateway = RecordingCancellationGateway()

  @After
  fun closeDb() {
    database.close()
  }

  @Test
  fun happyPath_encryptUploadCommitSync_finalizes() = runBlocking {
    seed(snapshot("AwaitingPreparedMedia"))
    val dispatcher = ScriptedDispatcher()
    val reducer = reducer(dispatcher)

    val outcome = reducer.run(UploadJobId(JOB_ID))

    assertEquals(UploadJobOutcome.Finalized, outcome)
    assertEquals("Confirmed", persisted().decodeUploadSnapshot().phase)
    assertEquals(listOf("PrepareMedia", "AcquireEpochHandle", "EncryptShard", "CreateShardUpload", "UploadShard", "CreateManifest", "AwaitSyncConfirmation"), dispatcher.kinds)
  }

  @Test
  fun happyPath_multipleShards_loopsUntilEveryShardUploaded() = runBlocking {
    seed(snapshot("EncryptingShard", shards = listOf(shard(0, uploaded = false), shard(1, uploaded = false))))
    val dispatcher = ScriptedDispatcher()

    val outcome = reducer(dispatcher).run(UploadJobId(JOB_ID))

    assertEquals(UploadJobOutcome.Finalized, outcome)
    assertEquals(2, dispatcher.kinds.count { it == "EncryptShard" })
    assertTrue(persisted().decodeUploadSnapshot().tieredShards.all { it.uploaded })
  }

  @Test
  fun happyPath_commitManifestAliasesAreDispatched() = runBlocking {
    seed(snapshot("CreatingManifest", shards = listOf(shard(0, uploaded = true))))
    val dispatcher = ScriptedDispatcher()

    val outcome = reducer(dispatcher).run(UploadJobId(JOB_ID))

    assertEquals(UploadJobOutcome.Finalized, outcome)
    assertEquals(listOf("CreateManifest", "AwaitSyncConfirmation"), dispatcher.kinds)
  }

  @Test
  fun noCurrentEffect_returnsWaitingForExternalEventWithoutMutatingSnapshot() = runBlocking {
    val row = snapshot("Queued").toUploadJobSnapshotRow(100)
    seed(row.decodeUploadSnapshot())

    val outcome = reducer(ScriptedDispatcher()).run(UploadJobId(JOB_ID))

    assertEquals(UploadJobOutcome.WaitingForExternalEvent, outcome)
    assertArrayEquals(row.canonicalCborBytes, persisted().canonicalCborBytes)
  }

  @Test
  fun terminalFailedSnapshot_returnsFailedWithoutDispatch() = runBlocking {
    seed(snapshot("Failed"))
    val dispatcher = ScriptedDispatcher()

    val outcome = reducer(dispatcher).run(UploadJobId(JOB_ID))

    assertEquals(UploadJobOutcome.Failed, outcome)
    assertTrue(dispatcher.kinds.isEmpty())
  }

  @Test
  fun crashReplay_midEncryption_reusesExistingUniqueWork() = runBlocking {
    seed(snapshot("EncryptingShard", shards = listOf(shard(0, uploaded = false))))
    val dispatcher = ReplayDispatcher("EncryptShard")
    val firstReducer = reducer(dispatcher)
    val firstRun = launch { firstReducer.run(UploadJobId(JOB_ID)) }
    yield()
    firstRun.cancelAndJoin()

    val outcome = reducer(dispatcher).run(UploadJobId(JOB_ID))

    assertEquals(UploadJobOutcome.Finalized, outcome)
    assertEquals(1, dispatcher.uniqueEnqueueCount("EncryptShard"))
  }

  @Test
  fun crashReplay_midUpload_reusesExistingUniqueWork() = runBlocking {
    seed(snapshot("UploadingShard", shards = listOf(shard(0, uploaded = false))))
    val dispatcher = ReplayDispatcher("UploadShard")
    val firstRun = launch { reducer(dispatcher).run(UploadJobId(JOB_ID)) }
    yield()
    firstRun.cancelAndJoin()

    val outcome = reducer(dispatcher).run(UploadJobId(JOB_ID))

    assertEquals(UploadJobOutcome.Finalized, outcome)
    assertEquals(1, dispatcher.uniqueEnqueueCount("UploadShard"))
  }

  @Test
  fun crashReplay_waitForSync_reusesInFlightConfirmation() = runBlocking {
    seed(snapshot("AwaitingSyncConfirmation", shards = listOf(shard(0, uploaded = true))))
    val dispatcher = ReplayDispatcher("AwaitSyncConfirmation")
    val firstRun = launch { reducer(dispatcher).run(UploadJobId(JOB_ID)) }
    yield()
    firstRun.cancelAndJoin()

    val outcome = reducer(dispatcher).run(UploadJobId(JOB_ID))

    assertEquals(UploadJobOutcome.Finalized, outcome)
    assertEquals(1, dispatcher.uniqueEnqueueCount("AwaitSyncConfirmation"))
  }

  @Test
  fun retryBudget_encryptShardExhausted_transitionsFailed() = runBlocking {
    seed(snapshot("EncryptingShard", retryCount = 3, shards = listOf(shard(0, uploaded = false))))
    val dispatcher = FailingDispatcher(retryable = true)

    val outcome = reducer(dispatcher).run(UploadJobId(JOB_ID))

    assertEquals(UploadJobOutcome.Failed, outcome)
    assertEquals("Failed", persisted().decodeUploadSnapshot().phase)
  }

  @Test
  fun retryBudget_uploadShardExhausted_transitionsFailed() = runBlocking {
    seed(snapshot("UploadingShard", retryCount = 5, shards = listOf(shard(0, uploaded = false))))

    val outcome = reducer(FailingDispatcher(retryable = true)).run(UploadJobId(JOB_ID))

    assertEquals(UploadJobOutcome.Failed, outcome)
  }

  @Test
  fun retryBudget_waitForSyncExhausted_transitionsFailed() = runBlocking {
    seed(snapshot("AwaitingSyncConfirmation", retryCount = 1, shards = listOf(shard(0, uploaded = true))))

    val outcome = reducer(FailingDispatcher(retryable = true)).run(UploadJobId(JOB_ID))

    assertEquals(UploadJobOutcome.Failed, outcome)
  }

  @Test
  fun retryBudget_retryableFailureWithinBudgetSchedulesRetry() = runBlocking {
    seed(snapshot("UploadingShard", retryCount = 4, shards = listOf(shard(0, uploaded = false))))

    val outcome = reducer(FailingDispatcher(retryable = true)).run(UploadJobId(JOB_ID))

    assertEquals(UploadJobOutcome.WaitingForExternalEvent, outcome)
    assertEquals("RetryWaiting", persisted().decodeUploadSnapshot().phase)
    assertEquals(5, persisted().decodeUploadSnapshot().retryCount)
  }

  @Test
  fun cancellation_cancelJob_cancelsTaggedWorkAndPersistsCancelled() = runBlocking {
    seed(snapshot("UploadingShard", shards = listOf(shard(0, uploaded = false))))

    val outcome = reducer(ScriptedDispatcher()).cancel(UploadJobId(JOB_ID))

    assertEquals(UploadJobOutcome.Cancelled, outcome)
    assertEquals(listOf(JOB_ID), cancellationGateway.cancelledJobIds)
    assertEquals("Cancelled", persisted().decodeUploadSnapshot().phase)
  }

  @Test
  fun cancellation_missingJob_returnsNotFoundAndDoesNotCancelWorkers() = runBlocking {
    val outcome = reducer(ScriptedDispatcher()).cancel(UploadJobId(JOB_ID))

    assertEquals(UploadJobOutcome.NotFound, outcome)
    assertTrue(cancellationGateway.cancelledJobIds.isEmpty())
  }

  @Test
  fun crossPlatformContract_decodesCanonicalRustCborAndUsesSameTerminalRule() {
    val row = UploadJobSnapshotRow(
      jobId = JOB_ID,
      schemaVersion = 1,
      canonicalCborBytes = RUST_R_C5_AWAITING_SYNC_CBOR,
      updatedAtMs = 1,
      snapshotRevision = 3,
    )

    val decoded = row.decodeUploadSnapshot()

    assertEquals("AwaitingSyncConfirmation", decoded.phase)
    assertEquals("018f05a4-8b31-7c00-8c00-0000000000d1", decoded.lastAcknowledgedEffectId)
    assertEquals(false, uniffi.isTerminal(row))
    assertEquals("AwaitSyncConfirmation", uniffi.getCurrentEffect(row)?.kind)
  }

  private fun reducer(dispatcher: EffectDispatcher) = UploadJobReducer(
    database = database,
    uniffi = uniffi,
    effectDispatcher = dispatcher,
    cancellationGateway = cancellationGateway,
  )

  private fun seed(snapshot: RustClientCoreUploadJobFfiSnapshot) {
    database.uploadJobSnapshotDao().upsert(snapshot.toUploadJobSnapshotRow(updatedAtMs = 1_700_000_000_000L))
  }

  private fun persisted(): UploadJobSnapshotRow = requireNotNull(database.uploadJobSnapshotDao().get(JOB_ID))

  private class ScriptedDispatcher : EffectDispatcher {
    val kinds = mutableListOf<String>()

    override suspend fun dispatch(
      snapshot: UploadJobSnapshotRow,
      effect: RustClientCoreUploadJobFfiEffect,
    ): RustClientCoreUploadJobFfiEvent {
      kinds += effect.kind
      val current = snapshot.decodeUploadSnapshot()
      return when (effect.kind) {
        "PrepareMedia" -> UploadJobEvents.mediaPrepared(effect.effectId, listOf(shard(0, uploaded = false)), ByteArray(32) { 7 })
        "AcquireEpochHandle" -> UploadJobEvents.epochHandleAcquired(effect.effectId)
        "EncryptShard" -> UploadJobEvents.shardEncrypted(effect.effectId, effect.tier, effect.shardIndex, shard(effect.shardIndex).shardId, ByteArray(32) { effect.shardIndex.toByte() }, 42, 1)
        "CreateShardUpload" -> UploadJobEvents.shardUploadCreated(effect.effectId, current.tieredShards.first { it.shardIndex == effect.shardIndex })
        "UploadShard" -> UploadJobEvents.shardUploaded(effect.effectId, current.tieredShards.first { it.shardIndex == effect.shardIndex })
        "CreateManifest" -> UploadJobEvents.manifestCreated(effect.effectId)
        "AwaitSyncConfirmation" -> UploadJobEvents.syncConfirmed(effect.effectId)
        "ScheduleRetry" -> UploadJobEvents.retryTimerElapsed(effect.effectId, "UploadingShard")
        else -> UploadJobEvents.effectAck(effect.effectId)
      }
    }
  }

  private class ReplayDispatcher(private val blockingKind: String) : EffectDispatcher {
    private val enqueued = linkedSetOf<String>()
    private var blockedOnce = false

    override suspend fun dispatch(
      snapshot: UploadJobSnapshotRow,
      effect: RustClientCoreUploadJobFfiEffect,
    ): RustClientCoreUploadJobFfiEvent {
      enqueued += effect.kind
      if (effect.kind == blockingKind && !blockedOnce) {
        blockedOnce = true
        awaitCancellation()
      }
      return ScriptedDispatcher().dispatch(snapshot, effect)
    }

    fun uniqueEnqueueCount(kind: String): Int = if (enqueued.contains(kind)) 1 else 0
  }

  private class FailingDispatcher(private val retryable: Boolean) : EffectDispatcher {
    override suspend fun dispatch(
      snapshot: UploadJobSnapshotRow,
      effect: RustClientCoreUploadJobFfiEffect,
    ): RustClientCoreUploadJobFfiEvent {
      throw EffectDispatchException("failed", retryable = retryable)
    }
  }

  private class RecordingCancellationGateway : UploadWorkCancellationGateway {
    val cancelledJobIds = mutableListOf<String>()
    override suspend fun cancelAllForJob(jobId: UploadJobId) {
      cancelledJobIds += jobId.value
    }
  }

  private class FakeMosaicUniffi : MosaicUniffi {
    override fun getCurrentEffect(snapshot: UploadJobSnapshotRow): RustClientCoreUploadJobFfiEffect? {
      val shell = snapshot.decodeUploadSnapshot()
      val first = shell.tieredShards.firstOrNull { !it.uploaded }
      val effectId = EFFECT_ID
      return when (shell.phase) {
        "AwaitingPreparedMedia" -> effect("PrepareMedia", effectId)
        "AwaitingEpochHandle" -> effect("AcquireEpochHandle", effectId)
        "EncryptingShard" -> first?.let { effect("EncryptShard", effectId, it.tier, it.shardIndex) }
        "CreatingShardUpload" -> first?.let { effect("CreateShardUpload", effectId, it.tier, it.shardIndex) }
        "UploadingShard" -> first?.let { effect("UploadShard", effectId, it.tier, it.shardIndex) }
        "CreatingManifest" -> effect("CreateManifest", effectId)
        "AwaitingSyncConfirmation" -> effect("AwaitSyncConfirmation", effectId)
        else -> null
      }
    }

    override fun advanceUploadJob(
      snapshot: UploadJobSnapshotRow,
      event: RustClientCoreUploadJobFfiEvent,
    ): UploadJobSnapshotRow {
      val shell = snapshot.decodeUploadSnapshot()
      val next = when (event.kind) {
        "MediaPrepared" -> shell.copy(phase = "AwaitingEpochHandle", tieredShards = event.tieredShards, shardSetHash = event.shardSetHash, snapshotRevision = shell.snapshotRevision + 1)
        "EpochHandleAcquired" -> shell.copy(phase = "EncryptingShard", snapshotRevision = shell.snapshotRevision + 1)
        "ShardEncrypted" -> shell.copy(phase = "CreatingShardUpload", tieredShards = replaceShard(shell, event, uploaded = false), snapshotRevision = shell.snapshotRevision + 1)
        "ShardUploadCreated" -> shell.copy(phase = "UploadingShard", snapshotRevision = shell.snapshotRevision + 1)
        "ShardUploaded" -> {
          val replaced = replaceShard(shell, event, uploaded = true)
          shell.copy(phase = if (replaced.any { !it.uploaded }) "EncryptingShard" else "CreatingManifest", tieredShards = replaced, snapshotRevision = shell.snapshotRevision + 1)
        }
        "ManifestCreated" -> shell.copy(phase = "AwaitingSyncConfirmation", snapshotRevision = shell.snapshotRevision + 1)
        "SyncConfirmed" -> shell.copy(phase = "Confirmed", snapshotRevision = shell.snapshotRevision + 1)
        "RetryableFailure" -> shell.copy(phase = "RetryWaiting", retryCount = shell.retryCount + 1, snapshotRevision = shell.snapshotRevision + 1)
        "NonRetryableFailure" -> shell.copy(phase = "Failed", failureCode = event.errorCode, snapshotRevision = shell.snapshotRevision + 1)
        "CancelRequested" -> shell.copy(phase = "Cancelled", failureCode = RustClientCoreUploadStableCode.CLIENT_CORE_INVALID_TRANSITION, snapshotRevision = shell.snapshotRevision + 1)
        else -> shell.copy(snapshotRevision = shell.snapshotRevision + 1)
      }
      return next.toUploadJobSnapshotRow(snapshot.updatedAtMs)
    }

    override fun isTerminal(snapshot: UploadJobSnapshotRow): Boolean = snapshotPhase(snapshot) in setOf("Confirmed", "Finalized", "Completed", "Failed", "Cancelled")

    override fun snapshotPhase(snapshot: UploadJobSnapshotRow): String = snapshot.decodeUploadSnapshot().phase

    override fun snapshotRetryCount(snapshot: UploadJobSnapshotRow): Int = snapshot.decodeUploadSnapshot().retryCount

    private fun replaceShard(
      shell: RustClientCoreUploadJobFfiSnapshot,
      event: RustClientCoreUploadJobFfiEvent,
      uploaded: Boolean,
    ): List<RustClientCoreUploadShardRef> = shell.tieredShards.map { existing ->
      if (existing.shardIndex == event.shardIndex && existing.tier == event.tier) {
        existing.copy(
          shardId = event.shardId.ifBlank { existing.shardId },
          sha256 = if (event.sha256.isEmpty()) existing.sha256 else event.sha256,
          contentLength = if (event.contentLength == 0L) existing.contentLength else event.contentLength,
          envelopeVersion = if (event.envelopeVersion == 0) existing.envelopeVersion else event.envelopeVersion,
          uploaded = uploaded,
        )
      } else {
        existing
      }
    }

    private fun effect(kind: String, effectId: String, tier: Int = 0, shardIndex: Int = 0) =
      RustClientCoreUploadJobFfiEffect(kind, effectId, tier, shardIndex)
  }

  companion object {
    private const val JOB_ID = "018f05a4-8b31-7c00-8c00-0000000000e1"
    private const val ALBUM_ID = "018f05a4-8b31-7c00-8c00-0000000000a3"
    private const val IDEMPOTENCY_KEY = "018f05a4-8b31-7c00-8c00-0000000000c1"
    private const val EFFECT_ID = "018f05a4-8b31-7c00-8c00-0000000000d1"

    private val RUST_R_C5_AWAITING_SYNC_CBOR = byteArrayOf(
      0xae.toByte(), 0x00.toByte(), 0x01.toByte(), 0x01.toByte(), 0x50.toByte(), 0x01.toByte(), 0x8f.toByte(), 0x05.toByte(),
      0xa4.toByte(), 0x8b.toByte(), 0x31.toByte(), 0x7c.toByte(), 0x00.toByte(), 0x8c.toByte(), 0x00.toByte(), 0x00.toByte(),
      0x00.toByte(), 0x00.toByte(), 0x00.toByte(), 0x00.toByte(), 0xe1.toByte(), 0x02.toByte(), 0x50.toByte(), 0x01.toByte(),
      0x8f.toByte(), 0x05.toByte(), 0xa4.toByte(), 0x8b.toByte(), 0x31.toByte(), 0x7c.toByte(), 0x00.toByte(), 0x8c.toByte(),
      0x00.toByte(), 0x00.toByte(), 0x00.toByte(), 0x00.toByte(), 0x00.toByte(), 0x00.toByte(), 0xa3.toByte(), 0x03.toByte(),
      0x08.toByte(), 0x04.toByte(), 0x00.toByte(), 0x05.toByte(), 0x05.toByte(), 0x06.toByte(), 0xf6.toByte(), 0x07.toByte(),
      0x50.toByte(), 0x01.toByte(), 0x8f.toByte(), 0x05.toByte(), 0xa4.toByte(), 0x8b.toByte(), 0x31.toByte(), 0x7c.toByte(),
      0x00.toByte(), 0x8c.toByte(), 0x00.toByte(), 0x00.toByte(), 0x00.toByte(), 0x00.toByte(), 0x00.toByte(), 0x00.toByte(),
      0xc1.toByte(), 0x08.toByte(), 0x80.toByte(), 0x09.toByte(), 0xf6.toByte(), 0x0a.toByte(), 0x03.toByte(), 0x0b.toByte(),
      0x50.toByte(), 0x01.toByte(), 0x8f.toByte(), 0x05.toByte(), 0xa4.toByte(), 0x8b.toByte(), 0x31.toByte(), 0x7c.toByte(),
      0x00.toByte(), 0x8c.toByte(), 0x00.toByte(), 0x00.toByte(), 0x00.toByte(), 0x00.toByte(), 0x00.toByte(), 0x00.toByte(),
      0xd1.toByte(), 0x0c.toByte(), 0xf6.toByte(), 0x0d.toByte(), 0xf6.toByte(),
    )

    private fun snapshot(
      phase: String,
      retryCount: Int = 0,
      shards: List<RustClientCoreUploadShardRef> = emptyList(),
    ): RustClientCoreUploadJobFfiSnapshot = RustClientCoreUploadJobFfiSnapshot(
      schemaVersion = 1,
      jobId = JOB_ID,
      albumId = ALBUM_ID,
      phase = phase,
      retryCount = retryCount,
      maxRetryCount = 5,
      nextRetryNotBeforeMs = 0,
      hasNextRetryNotBeforeMs = false,
      idempotencyKey = IDEMPOTENCY_KEY,
      tieredShards = shards,
      shardSetHash = if (shards.isEmpty()) ByteArray(0) else ByteArray(32) { 9 },
      snapshotRevision = 0,
      lastEffectId = "",
      lastAcknowledgedEffectId = EFFECT_ID,
      lastAppliedEventId = "",
      failureCode = 0,
    )

    private fun shard(index: Int, uploaded: Boolean = false): RustClientCoreUploadShardRef = RustClientCoreUploadShardRef(
      tier = 2,
      shardIndex = index,
      shardId = "018f05a4-8b31-7c00-8c00-0000000001${index.toString().padStart(2, '0')}",
      sha256 = ByteArray(32) { index.toByte() },
      contentLength = 42,
      envelopeVersion = 1,
      uploaded = uploaded,
    )
  }
}
