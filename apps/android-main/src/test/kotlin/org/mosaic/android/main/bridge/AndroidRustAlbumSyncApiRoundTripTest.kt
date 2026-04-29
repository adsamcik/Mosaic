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
      albumId = "album-sync-1",
      requestId = "req-1",
      startCursor = "",
      nowUnixMs = 1_700_000_000_000L,
      maxRetryCount = 3,
    )

  @Test
  fun initAlbumSyncCreatesQueuedSnapshot() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustAlbumSyncApi()
    val result = api.initAlbumSync(makeSyncRequest())
    assertEquals(0, result.code)
    assertNotNull(result.snapshot)
    assertEquals("album-sync-1", result.snapshot.albumId)
    assertTrue("phase non-blank", result.snapshot.phase.isNotBlank())
  }

  @Test
  fun advanceAlbumSyncAcceptsStartRequestedEvent() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustAlbumSyncApi()
    val initResult = api.initAlbumSync(makeSyncRequest())
    val transition = api.advanceAlbumSync(
      snapshot = initResult.snapshot,
      event = RustClientCoreAlbumSyncFfiEvent.startRequested(),
    )
    assertEquals(0, transition.code)
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
