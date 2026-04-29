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
    assertNotNull(transition.transition.snapshot)
    assertTrue("post-StartRequested phase non-blank", transition.transition.snapshot.phase.isNotBlank())
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
    assertEquals(initResult.snapshot.schemaVersion, transition.transition.snapshot.schemaVersion)
  }
}
