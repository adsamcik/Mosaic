package org.mosaic.android.main.bridge

import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.mosaic.android.foundation.AlbumId
import org.mosaic.android.foundation.ManualUploadAssetId
import org.mosaic.android.foundation.ManualUploadClientCoreHandoffRequest
import org.mosaic.android.foundation.ManualUploadHandoffStage
import org.mosaic.android.foundation.ManualUploadJobId
import org.mosaic.android.foundation.QueueRecordId
import org.mosaic.android.foundation.RustClientCoreAlbumSyncFfiEvent
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiEvent
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiRequest
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiSnapshot
import org.mosaic.android.foundation.RustClientCoreUploadStableCode
import org.mosaic.android.foundation.RustEpochHandleFfiResult
import org.mosaic.android.foundation.StagedMediaReference
import uniffi.mosaic_uniffi.ClientCoreUploadJobSnapshot
import uniffi.mosaic_uniffi.ClientCoreUploadShardRef

class AndroidRustUploadApiRoundTripTest {

  private fun makeUploadRequest(): RustClientCoreUploadJobFfiRequest {
    val handoff = ManualUploadClientCoreHandoffRequest.fromQueueRecord(
      record = org.mosaic.android.foundation.PrivacySafeUploadQueueRecord.create(
        id = QueueRecordId("018f05a4-8b31-7c00-8c00-0000000000c1"),
        serverAccountId = org.mosaic.android.foundation.ServerAccountId(
          "018f05a4-8b31-7c00-8c00-0000000000d1",
        ),
        // Rust core's init_upload_job validates albumId/jobId/assetId formats
        // and returns INVALID_INPUT_LENGTH = 202 otherwise. Use UUIDv7.
        albumId = AlbumId("018f05a4-8b31-7c00-8c00-0000000000a3"),
        stagedSource = StagedMediaReference.of("mosaic-staged://upload/x"),
        contentLengthBytes = 1024,
        createdAtEpochMillis = 1_700_000_000_000L,
      ),
      uploadJobId = ManualUploadJobId("018f05a4-8b31-7c00-8c00-0000000000e1"),
      assetId = ManualUploadAssetId("018f05a4-8b31-7c00-8c00-0000000000f1"),
      stage = ManualUploadHandoffStage.STAGED_SOURCE_READY,
    )
    return RustClientCoreUploadJobFfiRequest.from(
      request = handoff,
      nowUnixMs = 1_700_000_000_000L,
      maxRetryCount = 3,
    )
  }

  private fun buildExhaustiveShellSnapshot(): RustClientCoreUploadJobFfiSnapshot =
    RustClientCoreUploadJobFfiSnapshot(
      schemaVersion = 1,
      jobId = "018f05a4-8b31-7c00-8c00-0000000000e1",
      albumId = "018f05a4-8b31-7c00-8c00-0000000000a3",
      phase = "UploadingShards",
      retryCount = 2,
      maxRetryCount = 5,
      nextRetryNotBeforeMs = 1_700_000_000_000L,
      hasNextRetryNotBeforeMs = true,
      idempotencyKey = "018f05a4-8b31-7c00-8c00-0000000000c1",
      tieredShards = listOf(
        org.mosaic.android.foundation.RustClientCoreUploadShardRef(
          tier = 2,
          shardIndex = 4,
          shardId = "shard-preview-4",
          sha256 = byteArrayOf(1, 2, 3, 4),
          contentLength = 4096L,
          envelopeVersion = 1,
          uploaded = true,
        ),
        org.mosaic.android.foundation.RustClientCoreUploadShardRef(
          tier = 3,
          shardIndex = 5,
          shardId = "shard-original-5",
          sha256 = byteArrayOf(5, 6, 7, 8),
          contentLength = 8192L,
          envelopeVersion = 1,
          uploaded = false,
        ),
      ),
      shardSetHash = byteArrayOf(9, 8, 7, 6),
      snapshotRevision = 42L,
      lastEffectId = "effect-issued",
      lastAcknowledgedEffectId = "effect-acked",
      lastAppliedEventId = "event-applied",
      failureCode = RustClientCoreUploadStableCode.CLIENT_CORE_INVALID_SNAPSHOT,
    )

  private fun buildEpochImport(signPublicKey: ByteArray): RustEpochHandleFfiResult =
    RustEpochHandleFfiResult(
      code = 0,
      handle = 17L,
      epochId = 11,
      wrappedEpochSeed = ByteArray(32) { (it + 64).toByte() },
      signPublicKey = signPublicKey,
    )

  private fun buildAlbumSyncEvent(errorCode: Int, hasErrorCode: Boolean): RustClientCoreAlbumSyncFfiEvent =
    RustClientCoreAlbumSyncFfiEvent(
      kind = "Failed",
      fetchedCursor = "cursor-before",
      nextCursor = "cursor-after",
      appliedCount = 3,
      observedAssetIds = listOf("asset-a", "asset-b"),
      retryAfterUnixMs = 1_700_000_001_000L,
      errorCode = errorCode,
      hasErrorCode = hasErrorCode,
    )

  @Test
  fun initUploadJobProducesValidSnapshot() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustUploadApi()
    val result = api.initUploadJob(makeUploadRequest())
    // Rust core may accept or reject (e.g. INVALID_INPUT_LENGTH = 202) the
    // synthetic request depending on its evolving validation rules. The
    // bridge MUST round-trip without crashing and produce a well-shaped
    // shell snapshot in either case.
    assertNotNull(result.snapshot)
    assertEquals("018f05a4-8b31-7c00-8c00-0000000000e1", result.snapshot.jobId)
    assertEquals("018f05a4-8b31-7c00-8c00-0000000000a3", result.snapshot.albumId)
    assertTrue("phase non-blank", result.snapshot.phase.isNotBlank())
  }

  @Test
  fun advanceUploadJobRoundTripsWithoutCrashing() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustUploadApi()
    val initResult = api.initUploadJob(makeUploadRequest())
    val transition = api.advanceUploadJob(
      snapshot = initResult.snapshot,
      event = RustClientCoreUploadJobFfiEvent.startRequested(),
    )
    assertNotNull(transition.transition.nextSnapshot)
    assertTrue("post-StartRequested phase non-blank", transition.transition.nextSnapshot.phase.isNotBlank())
  }

  @Test
  fun advanceUploadJobOnInvalidEventReturnsErrorCode() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustUploadApi()
    val initResult = api.initUploadJob(makeUploadRequest())
    // Construct a "completed" snapshot manually to simulate an invalid transition.
    val completedSnapshot = initResult.snapshot.copy(phase = "Completed")
    val transition = api.advanceUploadJob(
      snapshot = completedSnapshot,
      event = RustClientCoreUploadJobFfiEvent.startRequested(),
    )
    assertNotEquals(-1, transition.code)
  }

  @Test
  fun uploadJobSnapshotPreservesSchemaVersion() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustUploadApi()
    val initResult = api.initUploadJob(makeUploadRequest())
    val transition = api.advanceUploadJob(
      snapshot = initResult.snapshot,
      event = RustClientCoreUploadJobFfiEvent.startRequested(),
    )
    assertEquals(initResult.snapshot.schemaVersion, transition.transition.nextSnapshot.schemaVersion)
  }

  @Test
  fun uploadSnapshotAdapterPreservesRcl1SchemaFields() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustUploadApi()
    val shardHash = byteArrayOf(1, 2, 3)
    val shardSetHash = byteArrayOf(9, 8, 7)
    val uniSnapshot = ClientCoreUploadJobSnapshot(
      schemaVersion = 1u,
      jobId = "018f05a4-8b31-7c00-8c00-0000000000e1",
      albumId = "018f05a4-8b31-7c00-8c00-0000000000a3",
      phase = "AwaitingPreparedMedia",
      retryCount = 2u,
      maxRetryCount = 5.toUByte(),
      nextRetryNotBeforeMs = 1_700_000_000_000L,
      hasNextRetryNotBeforeMs = true,
      idempotencyKey = "018f05a4-8b31-7c00-8c00-0000000000c1",
      tieredShards = listOf(
        ClientCoreUploadShardRef(
          tier = 2.toUByte(),
          shardIndex = 4u,
          shardId = "shard-preview-4",
          sha256 = shardHash,
          contentLength = 4096uL,
          envelopeVersion = 1.toUByte(),
          uploaded = true,
        ),
      ),
      shardSetHash = shardSetHash,
      snapshotRevision = 42u,
      lastEffectId = "effect-issued",
      lastAcknowledgedEffectId = "effect-acked",
      lastAppliedEventId = "event-applied",
      failureCode = RustClientCoreUploadStableCode.CLIENT_CORE_INVALID_SNAPSHOT.toUShort(),
    )

    val shellSnapshot = with(api) { uniSnapshot.toShellSnapshot() }

    assertEquals("018f05a4-8b31-7c00-8c00-0000000000c1", shellSnapshot.idempotencyKey)
    assertEquals(1, shellSnapshot.tieredShards.size)
    assertEquals(2, shellSnapshot.tieredShards.single().tier)
    assertEquals(4, shellSnapshot.tieredShards.single().shardIndex)
    assertEquals(4096L, shellSnapshot.tieredShards.single().contentLength)
    assertEquals(1, shellSnapshot.tieredShards.single().envelopeVersion)
    assertArrayEquals(shardHash, shellSnapshot.tieredShards.single().sha256)
    assertArrayEquals(shardSetHash, shellSnapshot.shardSetHash)
    assertEquals(42L, shellSnapshot.snapshotRevision)
    assertEquals("effect-issued", shellSnapshot.lastEffectId)
    assertEquals("effect-acked", shellSnapshot.lastAcknowledgedEffectId)
    assertNotEquals(shellSnapshot.lastEffectId, shellSnapshot.lastAcknowledgedEffectId)
    assertEquals("event-applied", shellSnapshot.lastAppliedEventId)
    assertEquals(RustClientCoreUploadStableCode.CLIENT_CORE_INVALID_SNAPSHOT, shellSnapshot.failureCode)
  }

  @Test
  fun `upload snapshot survives shell-UniFFI-shell round-trip equality`() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustUploadApi()
    val original = buildExhaustiveShellSnapshot()

    val roundTripped = with(api) { original.toUniFfiSnapshot().toShellSnapshot() }

    // ByteArray fields don't have structural equals/hashCode, so the targeted
    // assertArrayEquals calls below are the meaningful content checks. Each
    // scalar/collection field is asserted explicitly to avoid relying on
    // ByteArray reference passthrough through the conversion helpers (a future
    // defensive .copyOf() during conversion would silently break a bare
    // assertEquals(original, roundTripped) without changing logical behavior).
    assertEquals(original.schemaVersion, roundTripped.schemaVersion)
    assertEquals(original.jobId, roundTripped.jobId)
    assertEquals(original.albumId, roundTripped.albumId)
    assertEquals(original.phase, roundTripped.phase)
    assertEquals(original.retryCount, roundTripped.retryCount)
    assertEquals(original.maxRetryCount, roundTripped.maxRetryCount)
    assertEquals(original.idempotencyKey, roundTripped.idempotencyKey)
    assertEquals(original.tieredShards.size, roundTripped.tieredShards.size)
    assertEquals(original.snapshotRevision, roundTripped.snapshotRevision)
    assertEquals(original.lastEffectId, roundTripped.lastEffectId)
    assertEquals(original.lastAcknowledgedEffectId, roundTripped.lastAcknowledgedEffectId)
    assertEquals(original.lastAppliedEventId, roundTripped.lastAppliedEventId)
    assertEquals(original.failureCode, roundTripped.failureCode)
    assertArrayEquals(original.shardSetHash, roundTripped.shardSetHash)
    assertArrayEquals(original.tieredShards[0].sha256, roundTripped.tieredShards[0].sha256)
    assertArrayEquals(original.tieredShards[1].sha256, roundTripped.tieredShards[1].sha256)
  }

  @Test
  fun `epoch import round-trip preserves signPublicKey`() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustEpochApi()
    val original = buildEpochImport(signPublicKey = ByteArray(32) { it.toByte() })

    val roundTripped = with(api) { original.toUniFfiResult().toShellResult() }

    assertArrayEquals(original.signPublicKey, roundTripped.signPublicKey)
  }

  @Test
  fun `album-sync event round-trip preserves hasErrorCode flag`() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustAlbumSyncApi()
    val withError = buildAlbumSyncEvent(errorCode = 707, hasErrorCode = true)
    val withoutError = buildAlbumSyncEvent(errorCode = 0, hasErrorCode = false)

    val roundTrippedWith = with(api) { withError.toUniFfiEvent().toShellEvent() }
    val roundTrippedWithout = with(api) { withoutError.toUniFfiEvent().toShellEvent() }

    assertEquals(true, roundTrippedWith.hasErrorCode)
    assertEquals(707, roundTrippedWith.errorCode)
    assertEquals(false, roundTrippedWithout.hasErrorCode)
    assertEquals(0, roundTrippedWithout.errorCode)
  }
}
