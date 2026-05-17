package org.mosaic.android.main.e2e

import android.content.Context
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.time.Clock
import java.time.Duration
import kotlinx.coroutines.CancellationException
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.mosaic.android.foundation.AlbumId as FoundationAlbumId
import org.mosaic.android.foundation.ManualUploadAssetId
import org.mosaic.android.foundation.ManualUploadClientCoreHandoffRequest
import org.mosaic.android.foundation.ManualUploadHandoffStage
import org.mosaic.android.foundation.ManualUploadJobId
import org.mosaic.android.foundation.QueueRecordId
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiRequest
import org.mosaic.android.foundation.RustClientCoreUploadStableCode
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiEffect
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiEvent
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiSnapshot
import org.mosaic.android.foundation.RustClientCoreUploadShardRef
import org.mosaic.android.foundation.ServerAccountId
import org.mosaic.android.foundation.StagedMediaReference
import org.mosaic.android.main.bridge.AndroidRustUploadApi
import org.mosaic.android.main.db.UploadQueueDatabase
import org.mosaic.android.main.db.UploadJobSnapshotRow
import org.mosaic.android.main.net.dto.AlbumId
import org.mosaic.android.main.net.dto.ManifestId
import org.mosaic.android.main.net.dto.ManifestFinalizeRequest
import org.mosaic.android.main.net.dto.TieredShardInfo
import org.mosaic.android.main.net.manifest.ManifestCommitClient
import org.mosaic.android.main.net.manifest.ManifestFinalizeResult
import org.mosaic.android.main.net.manifest.MosaicIdempotencyKeys
import org.mosaic.android.main.net.sync.AlbumSyncFetcher
import org.mosaic.android.main.net.sync.AlbumSyncResult
import org.mosaic.android.main.picker.PhotoPickerStagingAdapter
import org.mosaic.android.main.picker.StagedItem
import org.mosaic.android.main.privacy.LogTailReader
import org.mosaic.android.main.privacy.PrivacyAuditReport
import org.mosaic.android.main.privacy.PrivacyAuditor
import org.mosaic.android.main.reducer.AndroidMosaicUniffi
import org.mosaic.android.main.reducer.EffectDispatchException
import org.mosaic.android.main.reducer.EffectDispatcher
import org.mosaic.android.main.reducer.UploadJobEvents
import org.mosaic.android.main.reducer.UploadJobId
import org.mosaic.android.main.reducer.UploadJobOutcome
import org.mosaic.android.main.reducer.UploadJobReducer
import org.mosaic.android.main.reducer.UploadWorkCancellationGateway
import org.mosaic.android.main.reducer.decodeUploadSnapshot
import org.mosaic.android.main.reducer.toUploadJobSnapshotRow
import org.mosaic.android.main.staging.AppPrivateStagingManager
import org.mosaic.android.main.staging.StagedFile
import org.mosaic.android.main.sync.AlbumPurger
import org.mosaic.android.main.tus.TusClientFactory
import org.mosaic.android.main.tus.TusUploadException
import org.mosaic.android.main.tus.TusUploadSession

abstract class E2ETestSupport {
  protected lateinit var context: Context
  protected lateinit var database: UploadQueueDatabase
  protected lateinit var staging: AppPrivateStagingManager
  protected lateinit var backend: ContractBackendServer
  protected lateinit var user: SeededTestUser
  private lateinit var rustApi: AndroidRustUploadApi

  @Before
  fun setUpE2E() {
    context = ApplicationProvider.getApplicationContext()
    staging = AppPrivateStagingManager(context)
    cleanupPrivateStaging()
    database = UploadQueueDatabase.createInMemoryForTests(context)
    backend = ContractBackendServer().also { it.start() }
    user = SeededTestUser.bypassLogin()
    rustApi = AndroidRustUploadApi()
  }

  @After
  fun tearDownE2E() {
    if (::database.isInitialized) database.close()
    if (::backend.isInitialized) backend.shutdown()
    if (::staging.isInitialized) cleanupPrivateStaging()
  }

  protected fun reducer(dispatcher: EffectDispatcher): UploadJobReducer =
    UploadJobReducer(
      database = database,
      uniffi = AndroidMosaicUniffi(rustApi),
      effectDispatcher = dispatcher,
      cancellationGateway = RecordingCancellationGateway(),
    )

  protected fun seedSnapshot(phase: String = "AwaitingPreparedMedia", shards: List<RustClientCoreUploadShardRef> = emptyList(), retryCount: Int = 0) {
    val seeded = if (phase == "AwaitingPreparedMedia" && shards.isEmpty() && retryCount == 0) realStartedSnapshot() else snapshot(phase = phase, shards = shards, retryCount = retryCount)
    database.uploadJobSnapshotDao().upsert(seeded.toUploadJobSnapshotRow(updatedAtMs = NOW_MS))
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

  protected fun readCoverageSpecAsset(): String =
    context.assets.open("SPEC-E2ECoverageMatrix.md").bufferedReader().use { it.readText() }

  protected fun uploadAdapter(): E2EUploadAdapter = E2EUploadAdapter(reducer(NetworkUploadPipelineDispatcher(backend, staging, database)))

  private fun realStartedSnapshot(): RustClientCoreUploadJobFfiSnapshot {
    val init = rustApi.initUploadJob(uploadRequest())
    require(init.code == RustClientCoreUploadStableCode.OK) { "real Rust init failed with ${init.code}" }
    val started = rustApi.advanceUploadJob(init.snapshot, startRequestedEvent())
    require(started.code == RustClientCoreUploadStableCode.OK) { "real Rust start failed with ${started.code}" }
    return started.transition.nextSnapshot
  }

  private fun uploadRequest(): RustClientCoreUploadJobFfiRequest {
    val stagedUri = staging.listStagedFiles().firstOrNull()?.uri?.toString() ?: "mosaic-staged://android-e2e"
    val handoff = ManualUploadClientCoreHandoffRequest.fromQueueRecord(
      record = org.mosaic.android.foundation.PrivacySafeUploadQueueRecord.create(
        id = QueueRecordId(IDEMPOTENCY_KEY),
        serverAccountId = ServerAccountId("018f05a4-8b31-7c00-8c00-0000000000b1"),
        albumId = FoundationAlbumId(ALBUM_ID),
        stagedSource = StagedMediaReference.of(stagedUri),
        contentLengthBytes = 1024,
        createdAtEpochMillis = NOW_MS,
      ),
      uploadJobId = ManualUploadJobId(JOB_ID),
      assetId = ManualUploadAssetId(ASSET_ID),
      stage = ManualUploadHandoffStage.STAGED_SOURCE_READY,
    )
    return RustClientCoreUploadJobFfiRequest.from(handoff, NOW_MS, maxRetryCount = 5)
  }

  private fun startRequestedEvent(): RustClientCoreUploadJobFfiEvent = RustClientCoreUploadJobFfiEvent(
    kind = "StartRequested",
    effectId = EFFECT_ID,
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

  companion object {
    const val JOB_ID = "018f05a4-8b31-7c00-8c00-0000000000e1"
    const val ALBUM_ID = "018f05a4-8b31-7c00-8c00-0000000000a3"
    const val ASSET_ID = "018f05a4-8b31-7c00-8c00-0000000000f1"
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

class ContractBackendServer {
  private val server = MockWebServer()
  val uploadedShardIds = mutableListOf<String>()
  val encryptedShardIds = mutableListOf<String>()
  var manifestFinalizeCalls = 0
  var syncConfirmations = 0
  var alreadyFinalizedRecovered = false
  var albumDeleted = false
  var failFirstPatchWithDisconnect = false
  var manifestUnknownThenAlreadyFinalized = false
  var deleteAlbumAfterFirstPatch = false
  var patchAttempts = 0
  private var disconnectedPatch = false
  private var manifestUnknownOnce = false

  fun start() {
    server.dispatcher = object : Dispatcher() {
      override fun dispatch(request: RecordedRequest): MockResponse = this@ContractBackendServer.dispatch(request)
    }
    server.start()
  }

  fun baseUrl(): okhttp3.HttpUrl = server.url("/")

  fun tusEndpoint(): okhttp3.HttpUrl = server.url("/files")

  fun shutdown() {
    server.shutdown()
  }

  fun recordEncrypted(shard: RustClientCoreUploadShardRef) {
    encryptedShardIds += shard.shardId
  }

  fun confirmSync() = Unit

  private fun dispatch(request: RecordedRequest): MockResponse {
    val path = request.path.orEmpty()
    return when {
      request.method == "POST" && path == "/files" -> MockResponse()
        .setResponseCode(201)
        .setHeader("Location", "/uploads/${shardIdFromTusMetadata(request)}")
      request.method == "HEAD" && path.startsWith("/uploads/") -> MockResponse()
        .setResponseCode(200)
        .setHeader("Upload-Offset", "0")
      request.method == "PATCH" && path.startsWith("/uploads/") -> patch(path)
      request.method == "POST" && path.startsWith("/api/v1/manifests/") && path.endsWith("/finalize") -> finalize()
      request.method == "GET" && path.startsWith("/api/v1/albums/") && path.endsWith("/sync") -> sync()
      else -> MockResponse().setResponseCode(404)
    }
  }

  private fun patch(path: String): MockResponse {
    patchAttempts += 1
    if (deleteAlbumAfterFirstPatch && patchAttempts > 1) {
      albumDeleted = true
      return MockResponse().setResponseCode(410)
    }
    if (failFirstPatchWithDisconnect && !disconnectedPatch) {
      disconnectedPatch = true
      return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_DURING_REQUEST_BODY)
    }
    uploadedShardIds += path.substringAfterLast("/")
    return MockResponse()
      .setResponseCode(204)
      .setHeader("Upload-Offset", "45")
  }

  private fun finalize(): MockResponse {
    manifestFinalizeCalls += 1
    if (albumDeleted) return MockResponse().setResponseCode(410)
    if (manifestUnknownThenAlreadyFinalized && !manifestUnknownOnce) {
      manifestUnknownOnce = true
      return MockResponse()
        .setResponseCode(200)
        .setBody(manifestFinalizeJson())
        .setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY)
    }
    if (manifestUnknownThenAlreadyFinalized) {
      alreadyFinalizedRecovered = true
      return MockResponse()
        .setResponseCode(409)
        .setBody("""{"error":"manifest_already_finalized","detail":"manifest is already finalized","manifestId":"${E2ETestSupport.JOB_ID}"}""")
    }
    return MockResponse().setResponseCode(200).setBody(manifestFinalizeJson())
  }

  private fun sync(): MockResponse {
    syncConfirmations += 1
    if (albumDeleted) return MockResponse().setResponseCode(410)
    return MockResponse().setResponseCode(200).setBody(albumSyncJson())
  }

  private fun shardIdFromTusMetadata(request: RecordedRequest): String {
    val metadata = request.getHeader("Upload-Metadata").orEmpty()
    return metadata.split(',').mapNotNull { entry ->
      val parts = entry.trim().split(' ', limit = 2)
      if (parts.size == 2 && parts[0] == "shardId") {
        String(android.util.Base64.decode(parts[1], android.util.Base64.DEFAULT))
      } else {
        null
      }
    }.firstOrNull() ?: "shard-${patchAttempts + 1}"
  }

  private fun manifestFinalizeJson(): String =
    """{"protocolVersion":1,"manifestId":"${E2ETestSupport.JOB_ID}","metadataVersion":1,"createdAt":"2025-01-02T03:04:05Z","tieredShards":${tieredShardsJson()}}"""

  private fun albumSyncJson(): String =
    """{"albumId":"${E2ETestSupport.ALBUM_ID}","currentVersion":1,"manifestId":"${E2ETestSupport.JOB_ID}","manifestUrl":"/api/v1/manifests/${E2ETestSupport.JOB_ID}","expectedSha256":"${"d".repeat(64)}","manifests":[{"id":"${E2ETestSupport.JOB_ID}","albumId":"${E2ETestSupport.ALBUM_ID}","versionCreated":1,"isDeleted":false,"encryptedMeta":"ZW5jcnlwdGVkLW1ldGE=","signature":"c2lnbmF0dXJl","signerPubkey":"cHVia2V5","shardIds":[],"shards":${tieredShardsJson()}}],"currentEpochId":7,"albumVersion":1,"hasMore":false}"""

  private fun tieredShardsJson(): String = E2ETestSupport.allTierShards(uploaded = true).joinToString(prefix = "[", postfix = "]") { shard ->
    """{"shardId":"${shard.shardId}","tier":${shard.tier},"shardIndex":${shard.shardIndex},"sha256":"${shard.sha256.toHex()}","contentLength":${shard.contentLength},"envelopeVersion":${shard.envelopeVersion}}"""
  }
}

class NetworkUploadPipelineDispatcher(
  private val backend: ContractBackendServer,
  private val staging: AppPrivateStagingManager,
  private val database: UploadQueueDatabase,
  private val shards: List<RustClientCoreUploadShardRef> = E2ETestSupport.allTierShards(),
) : EffectDispatcher {
  val kinds = mutableListOf<String>()
  var uploadAttempts = 0
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
        try {
          uploadShardOverTus(shard)
          UploadJobEvents.shardUploaded(effect.effectId, shard)
        } catch (error: TusUploadException.PatchFailed) {
          if (error.statusCode == 410) {
            albumDeleted(effect.effectId)
          } else {
            retryTargetPhase = "UploadingShard"
            throw EffectDispatchException("Tus PATCH failed", retryable = true, cause = error)
          }
        } catch (error: IOException) {
          retryTargetPhase = "UploadingShard"
          throw EffectDispatchException("Tus PATCH network failure", retryable = true, cause = error)
        }
      }
      "CreateManifest" -> {
        when (val result = finalizeManifest(current)) {
          is ManifestFinalizeResult.Success, is ManifestFinalizeResult.IdempotencyReplay, is ManifestFinalizeResult.AlreadyFinalized -> UploadJobEvents.manifestCreated(effect.effectId)
          else -> {
            retryTargetPhase = "CreatingManifest"
            throw EffectDispatchException("finalize returned $result", retryable = true)
          }
        }
      }
      "AwaitSyncConfirmation" -> {
        when (val result = AlbumSyncFetcher(OkHttpClient(), backend.baseUrl()).fetchSyncState(AlbumId(E2ETestSupport.ALBUM_ID))) {
          is AlbumSyncResult.Success -> {
            backend.confirmSync()
            UploadJobEvents.syncConfirmed(effect.effectId)
          }
          is AlbumSyncResult.Gone -> {
            AlbumPurger(database).purgeRemoteAlbumDeletion(result.albumId)
            albumDeleted(effect.effectId)
          }
          else -> throw EffectDispatchException("sync failed with $result", retryable = true)
        }
      }
      "ScheduleRetry" -> UploadJobEvents.retryTimerElapsed(effect.effectId, targetPhase = retryTargetPhase)
      else -> UploadJobEvents.effectAck(effect.effectId)
    }
  }

  private fun uploadShardOverTus(shard: RustClientCoreUploadShardRef) {
    val file = File(stagingRoot(), "${shard.shardId}.bin")
    file.parentFile?.mkdirs()
    file.writeBytes(ByteArray(shard.contentLength.toInt()) { shard.tier.toByte() })
    val now = System.currentTimeMillis()
    val staged = StagedFile(
      id = "upload-${shard.shardId.sha256Hex()}",
      uri = Uri.fromFile(file),
      file = file,
      displayName = file.name,
      sizeBytes = file.length(),
      createdAtMs = now,
      lastAccessMs = now,
    )
    val client = TusClientFactory.create(backend.tusEndpoint(), OkHttpClient())
    try {
      TusUploadSession(client, staging).upload(
        staged,
        metadata = mapOf("shardId" to shard.shardId, "expectedSha256" to shard.sha256.toHex(), "content-sha256" to shard.sha256.toHex()),
        uploadJobId = org.mosaic.android.main.net.dto.UploadJobId(E2ETestSupport.JOB_ID),
        shardId = org.mosaic.android.main.net.dto.ShardId(shard.shardId),
      )
    } finally {
      staging.unstage(staged)
    }
  }

  private suspend fun finalizeManifest(current: RustClientCoreUploadJobFfiSnapshot): ManifestFinalizeResult {
    return try {
      ManifestCommitClient(OkHttpClient(), backend.baseUrl()).finalize(
        ManifestId(E2ETestSupport.JOB_ID),
        ManifestFinalizeRequest(
          albumId = current.albumId,
          assetType = "Image",
          encryptedMeta = "ZW5jcnlwdGVkLW1ldGE=",
          encryptedMetaSidecar = "ZW5jcnlwdGVkLXNpZGVjYXI=",
          signature = "c2lnbmF0dXJl",
          signerPubkey = "cHVia2V5",
          tieredShards = current.tieredShards.map { TieredShardInfo(it.shardId, it.tier, it.shardIndex, it.sha256.toHex(), it.contentLength, it.envelopeVersion) },
        ),
        MosaicIdempotencyKeys.forManifestFinalize(org.mosaic.android.main.net.dto.UploadJobId(current.jobId)),
      )
    } catch (error: IOException) {
      retryTargetPhase = "CreatingManifest"
      throw EffectDispatchException("finalize response lost after server commit", retryable = true, stableCode = RustClientCoreUploadStableCode.CLIENT_CORE_MANIFEST_OUTCOME_UNKNOWN, cause = error)
    }
  }

  private fun albumDeleted(effectId: String): RustClientCoreUploadJobFfiEvent = RustClientCoreUploadJobFfiEvent(
    kind = "AlbumDeleted",
    effectId = effectId,
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

  private fun stagingRoot(): File {
    val parent = staging.listStagedFiles().firstOrNull()?.file?.parentFile
      ?: File(ApplicationProvider.getApplicationContext<Context>().filesDir, "staging")
    return File(parent, "e2e-upload")
  }
}

class BlockingOnceDispatcher(
  private val delegate: NetworkUploadPipelineDispatcher,
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

object EmptyLogTailReader : LogTailReader {
  override suspend fun readLastLines(maxLines: Int): List<String> = emptyList()
}

fun UploadJobOutcome.assertFinalized() {
  assertTrue("expected finalized outcome, got $this", this == UploadJobOutcome.Finalized)
}

class E2EUploadAdapter(private val reducer: UploadJobReducer) {
  suspend fun submit(jobId: UploadJobId): UploadJobOutcome = reducer.run(jobId)
}

private fun ByteArray.toHex(): String = joinToString("") { byte -> "%02x".format(byte) }

private fun String.sha256Hex(): String = MessageDigest.getInstance("SHA-256").digest(toByteArray()).toHex()
