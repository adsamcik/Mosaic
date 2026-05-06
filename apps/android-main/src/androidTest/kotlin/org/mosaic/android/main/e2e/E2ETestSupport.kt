package org.mosaic.android.main.e2e

import android.content.Context
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.time.Clock
import java.time.Duration
import kotlinx.coroutines.CancellationException
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiEffect
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiEvent
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiSnapshot
import org.mosaic.android.foundation.RustClientCoreUploadShardRef
import org.mosaic.android.main.db.UploadQueueDatabase
import org.mosaic.android.main.db.UploadJobSnapshotRow
import org.mosaic.android.main.picker.PhotoPickerStagingAdapter
import org.mosaic.android.main.picker.StagedItem
import org.mosaic.android.main.privacy.LogTailReader
import org.mosaic.android.main.privacy.PrivacyAuditReport
import org.mosaic.android.main.privacy.PrivacyAuditor
import org.mosaic.android.main.reducer.EffectDispatchException
import org.mosaic.android.main.reducer.EffectDispatcher
import org.mosaic.android.main.reducer.MosaicUniffi
import org.mosaic.android.main.reducer.UploadJobEvents
import org.mosaic.android.main.reducer.UploadJobId
import org.mosaic.android.main.reducer.UploadJobOutcome
import org.mosaic.android.main.reducer.UploadJobReducer
import org.mosaic.android.main.reducer.UploadWorkCancellationGateway
import org.mosaic.android.main.reducer.decodeUploadSnapshot
import org.mosaic.android.main.reducer.toUploadJobSnapshotRow
import org.mosaic.android.main.staging.AppPrivateStagingManager

abstract class E2ETestSupport {
  protected lateinit var context: Context
  protected lateinit var database: UploadQueueDatabase
  protected lateinit var staging: AppPrivateStagingManager
  protected lateinit var backend: MockMosaicBackend
  protected lateinit var user: SeededTestUser

  @Before
  fun setUpE2E() {
    context = ApplicationProvider.getApplicationContext()
    staging = AppPrivateStagingManager(context)
    cleanupPrivateStaging()
    database = UploadQueueDatabase.createInMemoryForTests(context)
    backend = MockMosaicBackend().also { it.start() }
    user = SeededTestUser.bypassLogin()
  }

  @After
  fun tearDownE2E() {
    if (::database.isInitialized) database.close()
    if (::backend.isInitialized) backend.shutdown()
    if (::staging.isInitialized) cleanupPrivateStaging()
  }

  protected fun reducer(dispatcher: EffectDispatcher, uniffi: MosaicUniffi = E2EUploadStateMachine()): UploadJobReducer =
    UploadJobReducer(
      database = database,
      uniffi = uniffi,
      effectDispatcher = dispatcher,
      cancellationGateway = RecordingCancellationGateway(),
    )

  protected fun seedSnapshot(phase: String = "AwaitingPreparedMedia", shards: List<RustClientCoreUploadShardRef> = emptyList(), retryCount: Int = 0) {
    database.uploadJobSnapshotDao().upsert(snapshot(phase = phase, shards = shards, retryCount = retryCount).toUploadJobSnapshotRow(updatedAtMs = NOW_MS))
  }

  protected fun persistedSnapshot(): RustClientCoreUploadJobFfiSnapshot =
    requireNotNull(database.uploadJobSnapshotDao().get(JOB_ID)).decodeUploadSnapshot()

  protected suspend fun stageFixture(assetName: String): List<StagedItem> {
    val source = File(context.cacheDir, assetName)
    context.assets.open(assetName).use { input -> source.outputStream().use(input::copyTo) }
    return PhotoPickerStagingAdapter(staging, context.contentResolver).stagePickedItems(listOf(Uri.fromFile(source)))
  }

  protected fun cleanupPrivateStaging() {
    staging.listStagedFiles().forEach(staging::unstage)
    staging.cleanup(0)
  }

  protected suspend fun runPrivacyAudit(): PrivacyAuditReport = PrivacyAuditor(
    staging = staging,
    database = database,
    logTail = EmptyLogTailReader,
    clock = Clock.systemUTC(),
    maxStagingAge = Duration.ZERO,
    cleanupPolicyInterval = Duration.ofDays(7),
  ).runAudit()

  companion object {
    const val JOB_ID = "018f05a4-8b31-7c00-8c00-0000000000e1"
    const val ALBUM_ID = "018f05a4-8b31-7c00-8c00-0000000000a3"
    const val IDEMPOTENCY_KEY = "018f05a4-8b31-7c00-8c00-0000000000c1"
    const val EFFECT_ID = "018f05a4-8b31-7c00-8c00-0000000000d1"
    const val NOW_MS = 1_700_000_000_000L

    fun snapshot(
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

    fun tierShard(tier: Int, uploaded: Boolean = false): RustClientCoreUploadShardRef = RustClientCoreUploadShardRef(
      tier = tier,
      shardIndex = tier - 1,
      shardId = "018f05a4-8b31-7c00-8c00-0000000001${tier.toString().padStart(2, '0')}",
      sha256 = ByteArray(32) { tier.toByte() },
      contentLength = 42L + tier,
      envelopeVersion = 1,
      uploaded = uploaded,
    )

    fun allTierShards(uploaded: Boolean = false): List<RustClientCoreUploadShardRef> = listOf(1, 2, 3).map { tierShard(it, uploaded) }
  }
}

data class SeededTestUser(val userId: String, val displayName: String) {
  companion object {
    fun bypassLogin(): SeededTestUser = SeededTestUser("instrumented-user", "Instrumented User")
  }
}

class MockMosaicBackend {
  private val server = MockWebServer()
  val uploadedShardIds = mutableListOf<String>()
  val encryptedShardIds = mutableListOf<String>()
  var manifestFinalizeCalls = 0
  var syncConfirmations = 0
  var alreadyFinalizedRecovered = false
  var albumDeleted = false

  fun start() {
    server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
    server.start()
  }

  fun baseUrl(): String = server.url("/").toString()

  fun shutdown() {
    server.shutdown()
  }

  fun recordEncrypted(shard: RustClientCoreUploadShardRef) {
    encryptedShardIds += shard.shardId
  }

  fun upload(shard: RustClientCoreUploadShardRef): UploadServerReply {
    if (albumDeleted) return UploadServerReply.Gone
    uploadedShardIds += shard.shardId
    return UploadServerReply.Uploaded
  }

  fun finalizeManifest(alreadyFinalized: Boolean = false): ManifestServerReply {
    manifestFinalizeCalls += 1
    if (alreadyFinalized) {
      alreadyFinalizedRecovered = true
      return ManifestServerReply.AlreadyFinalized
    }
    return ManifestServerReply.Finalized
  }

  fun confirmSync() {
    syncConfirmations += 1
  }
}

enum class UploadServerReply { Uploaded, Gone }
enum class ManifestServerReply { Finalized, AlreadyFinalized }

class FullUploadPipelineDispatcher(
  private val backend: MockMosaicBackend,
  private val shards: List<RustClientCoreUploadShardRef> = E2ETestSupport.allTierShards(),
  private val failFirstUpload: Boolean = false,
  private val manifestUnknownThenAlreadyFinalized: Boolean = false,
) : EffectDispatcher {
  val kinds = mutableListOf<String>()
  var uploadAttempts = 0
  private var failedUploadOnce = false
  private var manifestUnknownOnce = false
  private var retryTargetPhase = "UploadingShard"

  override suspend fun dispatch(snapshot: UploadJobSnapshotRow, effect: RustClientCoreUploadJobFfiEffect): RustClientCoreUploadJobFfiEvent {
    kinds += effect.kind
    val current = snapshot.decodeUploadSnapshot()
    return when (effect.kind) {
      "PrepareMedia" -> UploadJobEvents.mediaPrepared(effect.effectId, shards, ByteArray(32) { 7 })
      "AcquireEpochHandle" -> UploadJobEvents.epochHandleAcquired(effect.effectId)
      "EncryptShard" -> {
        val shard = current.tieredShards.first { it.shardIndex == effect.shardIndex && it.tier == effect.tier }
        backend.recordEncrypted(shard)
        UploadJobEvents.shardEncrypted(effect.effectId, effect.tier, effect.shardIndex, shard.shardId, ByteArray(32) { effect.tier.toByte() }, shard.contentLength, shard.envelopeVersion)
      }
      "CreateShardUpload" -> UploadJobEvents.shardUploadCreated(effect.effectId, current.tieredShards.first { !it.uploaded })
      "UploadShard" -> {
        uploadAttempts += 1
        val shard = current.tieredShards.first { it.shardIndex == effect.shardIndex && it.tier == effect.tier }
        if (failFirstUpload && !failedUploadOnce) {
          failedUploadOnce = true
          retryTargetPhase = "UploadingShard"
          throw EffectDispatchException("mock PATCH returned 502", retryable = true)
        }
        when (backend.upload(shard)) {
          UploadServerReply.Uploaded -> UploadJobEvents.shardUploaded(effect.effectId, shard)
          UploadServerReply.Gone -> UploadJobEvents.cancelRequested(effect.effectId)
        }
      }
      "CreateManifest" -> {
        if (manifestUnknownThenAlreadyFinalized && !manifestUnknownOnce) {
          manifestUnknownOnce = true
          backend.finalizeManifest()
          retryTargetPhase = "CreatingManifest"
          throw EffectDispatchException("finalize response lost after server commit", retryable = true)
        }
        backend.finalizeManifest(alreadyFinalized = manifestUnknownThenAlreadyFinalized)
        UploadJobEvents.manifestCreated(effect.effectId)
      }
      "AwaitSyncConfirmation" -> {
        backend.confirmSync()
        UploadJobEvents.syncConfirmed(effect.effectId)
      }
      "ScheduleRetry" -> UploadJobEvents.retryTimerElapsed(effect.effectId, targetPhase = retryTargetPhase)
      else -> UploadJobEvents.effectAck(effect.effectId)
    }
  }
}

class BlockingOnceDispatcher(
  private val delegate: FullUploadPipelineDispatcher,
  private val blockingKind: String,
) : EffectDispatcher {
  val kinds: List<String> get() = delegate.kinds
  private var blocked = false

  override suspend fun dispatch(snapshot: UploadJobSnapshotRow, effect: RustClientCoreUploadJobFfiEffect): RustClientCoreUploadJobFfiEvent {
    if (effect.kind == blockingKind && !blocked) {
      blocked = true
      throw CancellationException("simulated process death before ${effect.kind} completed")
    }
    return delegate.dispatch(snapshot, effect)
  }
}

class RecordingCancellationGateway : UploadWorkCancellationGateway {
  val cancelled = mutableListOf<String>()
  override suspend fun cancelAllForJob(jobId: UploadJobId) {
    cancelled += jobId.value
  }
}

class E2EUploadStateMachine : MosaicUniffi {
  override fun getCurrentEffect(snapshot: UploadJobSnapshotRow): RustClientCoreUploadJobFfiEffect? {
    val shell = snapshot.decodeUploadSnapshot()
    val first = shell.tieredShards.firstOrNull { !it.uploaded }
    return when (shell.phase) {
      "AwaitingPreparedMedia" -> effect("PrepareMedia")
      "AwaitingEpochHandle" -> effect("AcquireEpochHandle")
      "EncryptingShard" -> first?.let { effect("EncryptShard", it.tier, it.shardIndex) }
      "CreatingShardUpload" -> first?.let { effect("CreateShardUpload", it.tier, it.shardIndex) }
      "UploadingShard" -> first?.let { effect("UploadShard", it.tier, it.shardIndex) }
      "CreatingManifest", "ManifestCommitUnknown" -> effect("CreateManifest")
      "AwaitingSyncConfirmation" -> effect("AwaitSyncConfirmation")
      "RetryWaiting" -> effect("ScheduleRetry")
      else -> null
    }
  }

  override fun advanceUploadJob(snapshot: UploadJobSnapshotRow, event: RustClientCoreUploadJobFfiEvent): UploadJobSnapshotRow {
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
      "RetryTimerElapsed" -> shell.copy(phase = event.targetPhase.ifBlank { "UploadingShard" }, snapshotRevision = shell.snapshotRevision + 1)
      "CancelRequested" -> shell.copy(phase = "Cancelled", snapshotRevision = shell.snapshotRevision + 1)
      "NonRetryableFailure" -> shell.copy(phase = "Failed", failureCode = event.errorCode, snapshotRevision = shell.snapshotRevision + 1)
      else -> shell.copy(snapshotRevision = shell.snapshotRevision + 1)
    }
    return next.toUploadJobSnapshotRow(snapshot.updatedAtMs)
  }

  override fun isTerminal(snapshot: UploadJobSnapshotRow): Boolean = snapshotPhase(snapshot) in setOf("Confirmed", "Finalized", "Completed", "Failed", "Cancelled")

  override fun snapshotPhase(snapshot: UploadJobSnapshotRow): String = snapshot.decodeUploadSnapshot().phase

  override fun snapshotRetryCount(snapshot: UploadJobSnapshotRow): Int = snapshot.decodeUploadSnapshot().retryCount

  private fun effect(kind: String, tier: Int = 0, shardIndex: Int = 0): RustClientCoreUploadJobFfiEffect = RustClientCoreUploadJobFfiEffect(kind, E2ETestSupport.EFFECT_ID, tier, shardIndex)

  private fun replaceShard(shell: RustClientCoreUploadJobFfiSnapshot, event: RustClientCoreUploadJobFfiEvent, uploaded: Boolean): List<RustClientCoreUploadShardRef> =
    shell.tieredShards.map { existing ->
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
}

object EmptyLogTailReader : LogTailReader {
  override suspend fun readLastLines(maxLines: Int): List<String> = emptyList()
}

fun UploadJobOutcome.assertFinalized() {
  assertTrue("expected finalized outcome, got $this", this == UploadJobOutcome.Finalized)
}
