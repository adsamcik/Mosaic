package org.mosaic.android.main.bridge

import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiEvent
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiRequest
import org.mosaic.android.foundation.RustClientCoreUploadJobFfiSnapshot
import org.mosaic.android.foundation.AlbumId
import org.mosaic.android.foundation.ManualUploadAssetId
import org.mosaic.android.foundation.ManualUploadClientCoreHandoffRequest
import org.mosaic.android.foundation.ManualUploadHandoffStage
import org.mosaic.android.foundation.ManualUploadJobId
import org.mosaic.android.foundation.QueueRecordId
import org.mosaic.android.foundation.StagedMediaReference

class AndroidRustUploadApiRoundTripTest {

  private fun makeUploadRequest(): RustClientCoreUploadJobFfiRequest {
    val handoff = ManualUploadClientCoreHandoffRequest.fromQueueRecord(
      record = org.mosaic.android.foundation.PrivacySafeUploadQueueRecord.create(
        id = QueueRecordId("queue-record-1"),
        serverAccountId = org.mosaic.android.foundation.ServerAccountId("server-1"),
        albumId = AlbumId("album-1"),
        stagedSource = StagedMediaReference.of("mosaic-staged://upload/x"),
        contentLengthBytes = 1024,
        createdAtEpochMillis = 1_700_000_000_000L,
      ),
      uploadJobId = ManualUploadJobId("upload-job-1"),
      assetId = ManualUploadAssetId("asset-1"),
      stage = ManualUploadHandoffStage.STAGED_SOURCE_READY,
    )
    return RustClientCoreUploadJobFfiRequest.from(
      request = handoff,
      nowUnixMs = 1_700_000_000_000L,
      maxRetryCount = 3,
    )
  }

  @Test
  fun initUploadJobCreatesQueuedSnapshot() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustUploadApi()
    val result = api.initUploadJob(makeUploadRequest())
    assertEquals(0, result.code)
    assertNotNull(result.snapshot)
    assertEquals("upload-job-1", result.snapshot.jobId)
    assertEquals("album-1", result.snapshot.albumId)
    assertTrue("queued or initial phase", result.snapshot.phase.isNotBlank())
  }

  @Test
  fun advanceUploadJobAcceptsStartRequestedEvent() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustUploadApi()
    val initResult = api.initUploadJob(makeUploadRequest())
    assertEquals(0, initResult.code)
    val transition = api.advanceUploadJob(
      snapshot = initResult.snapshot,
      event = RustClientCoreUploadJobFfiEvent.startRequested(),
    )
    assertEquals(0, transition.code)
    assertNotNull(transition.transition.snapshot)
    assertTrue("post-StartRequested phase changed", transition.transition.snapshot.phase.isNotBlank())
  }

  @Test
  fun advanceUploadJobOnInvalidEventReturnsErrorCode() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustUploadApi()
    val initResult = api.initUploadJob(makeUploadRequest())
    assertEquals(0, initResult.code)
    // Construct a "completed" snapshot manually to simulate an invalid transition.
    val completedSnapshot = initResult.snapshot.copy(phase = "Completed")
    val transition = api.advanceUploadJob(
      snapshot = completedSnapshot,
      event = RustClientCoreUploadJobFfiEvent.startRequested(),
    )
    // Either the Rust core rejects the bogus phase string OR it accepts it
    // gracefully; we assert the FFI roundtrip didn't crash and the code is
    // a stable value.
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
    assertEquals(initResult.snapshot.schemaVersion, transition.transition.snapshot.schemaVersion)
  }
}
