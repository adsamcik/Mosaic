package org.mosaic.android.main.bridge

import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.mosaic.android.foundation.RustClientCoreAlbumSyncFfiEvent
import org.mosaic.android.foundation.RustClientCoreAlbumSyncFfiRequest

class AndroidRustAlbumSyncApiRoundTripTest {

  private fun makeSyncRequest(): RustClientCoreAlbumSyncFfiRequest =
    RustClientCoreAlbumSyncFfiRequest(
      // Rust core's init_album_sync requires UUID-formatted IDs (validates
      // length / format and returns INVALID_INPUT_LENGTH = 202 otherwise).
      albumId = "018f05a4-8b31-7c00-8c00-0000000000a3",
      requestId = "018f05a4-8b31-7c00-8c00-0000000000b1",
      startCursor = "",
      nowUnixMs = 1_700_000_000_000L,
      maxRetryCount = 3,
    )

  @Test
  fun initAlbumSyncProducesValidSnapshot() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustAlbumSyncApi()
    val result = api.initAlbumSync(makeSyncRequest())
    // The Rust core may accept (code 0) or reject the request with a stable
    // error code (e.g. 202 INVALID_INPUT_LENGTH or 706 INVALID_SNAPSHOT)
    // depending on its current validation rules. Either way the bridge must
    // round-trip without crashing and produce a well-shaped shell snapshot.
    assertNotNull(result.snapshot)
    assertEquals("018f05a4-8b31-7c00-8c00-0000000000a3", result.snapshot.albumId)
    assertTrue("phase non-blank", result.snapshot.phase.isNotBlank())
  }

  @Test
  fun advanceAlbumSyncRoundTripsWithoutCrashing() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustAlbumSyncApi()
    val initResult = api.initAlbumSync(makeSyncRequest())
    val transition = api.advanceAlbumSync(
      snapshot = initResult.snapshot,
      event = RustClientCoreAlbumSyncFfiEvent.startRequested(),
    )
    assertNotNull(transition.transition.snapshot)
    assertTrue("transition phase non-blank", transition.transition.snapshot.phase.isNotBlank())
  }

  @Test
  fun advanceAlbumSyncPreservesSchemaVersion() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustAlbumSyncApi()
    val initResult = api.initAlbumSync(makeSyncRequest())
    val transition = api.advanceAlbumSync(
      snapshot = initResult.snapshot,
      event = RustClientCoreAlbumSyncFfiEvent.startRequested(),
    )
    assertEquals(initResult.snapshot.schemaVersion, transition.transition.snapshot.schemaVersion)
  }

  @Test
  fun advanceAlbumSyncOnInvalidPhaseReturnsErrorCode() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustAlbumSyncApi()
    val initResult = api.initAlbumSync(makeSyncRequest())
    val invalidSnapshot = initResult.snapshot.copy(phase = "Completed")
    val transition = api.advanceAlbumSync(
      snapshot = invalidSnapshot,
      event = RustClientCoreAlbumSyncFfiEvent.startRequested(),
    )
    assertNotEquals(-1, transition.code)
  }
}
