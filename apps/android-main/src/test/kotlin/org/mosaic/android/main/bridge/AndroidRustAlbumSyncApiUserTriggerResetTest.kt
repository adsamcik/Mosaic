package org.mosaic.android.main.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test
import org.mosaic.android.foundation.RustClientCoreAlbumSyncFfiEvent
import org.mosaic.android.foundation.RustClientCoreAlbumSyncFfiSnapshot

/**
 * v1.0.1 s31 regression: a user-initiated sync trigger (`StartRequested`)
 * must reset the snapshot's retry budget so the next failure is treated as
 * attempt #1, not attempt #N from a prior session. Automatic retry events
 * (e.g. `PageFailed`) must leave the budget untouched.
 *
 * This exercises `AndroidRustAlbumSyncApi.normalizeSnapshotForUserTrigger`
 * directly so it can run without the Rust UniFFI native library loaded.
 */
class AndroidRustAlbumSyncApiUserTriggerResetTest {

  @Test
  fun startRequested_drainedBudget_resetsRetryCountAndNextRetry() {
    val drained = exhaustedBudgetSnapshot()

    val normalized = AndroidRustAlbumSyncApi.normalizeSnapshotForUserTrigger(
      snapshot = drained,
      event = RustClientCoreAlbumSyncFfiEvent.startRequested(),
    )

    assertEquals("retry budget must reset on user trigger", 0, normalized.retryCount)
    assertEquals("next retry deadline must clear on user trigger", 0L, normalized.nextRetryUnixMs)
    assertEquals("max retry count must be preserved", drained.maxRetryCount, normalized.maxRetryCount)
    assertEquals("phase must be preserved", drained.phase, normalized.phase)
    assertEquals("active cursor must be preserved", drained.activeCursor, normalized.activeCursor)
    assertEquals("pending cursor must be preserved", drained.pendingCursor, normalized.pendingCursor)
    assertEquals("last error code must be preserved", drained.lastErrorCode, normalized.lastErrorCode)
  }

  @Test
  fun startRequested_freshSnapshot_returnsSnapshotInstanceUnchanged() {
    val fresh = exhaustedBudgetSnapshot().copy(retryCount = 0, nextRetryUnixMs = 0)

    val normalized = AndroidRustAlbumSyncApi.normalizeSnapshotForUserTrigger(
      snapshot = fresh,
      event = RustClientCoreAlbumSyncFfiEvent.startRequested(),
    )

    // No mutation needed → identical reference (defensive against accidental copies).
    assertSame("fresh snapshot must round-trip without allocation", fresh, normalized)
  }

  @Test
  fun pageFetched_drainedBudget_preservesRetryCount() {
    val drained = exhaustedBudgetSnapshot()

    val normalized = AndroidRustAlbumSyncApi.normalizeSnapshotForUserTrigger(
      snapshot = drained,
      event = RustClientCoreAlbumSyncFfiEvent(
        kind = "PageFetched",
        fetchedCursor = "cursor",
        nextCursor = "next",
        appliedCount = 1,
        observedAssetIds = emptyList(),
        retryAfterUnixMs = 0,
        errorCode = 0,
        hasErrorCode = false,
      ),
    )

    assertEquals("automatic events must not reset budget", drained.retryCount, normalized.retryCount)
    assertEquals(drained.nextRetryUnixMs, normalized.nextRetryUnixMs)
  }

  @Test
  fun pageFailed_drainedBudget_preservesRetryCount() {
    val drained = exhaustedBudgetSnapshot()

    val normalized = AndroidRustAlbumSyncApi.normalizeSnapshotForUserTrigger(
      snapshot = drained,
      event = RustClientCoreAlbumSyncFfiEvent(
        kind = "PageFailed",
        fetchedCursor = "",
        nextCursor = "",
        appliedCount = 0,
        observedAssetIds = emptyList(),
        retryAfterUnixMs = 1_700_000_000_000L,
        errorCode = 503,
        hasErrorCode = true,
      ),
    )

    assertEquals(
      "PageFailed (automatic retry) must not reset budget",
      drained.retryCount,
      normalized.retryCount,
    )
  }

  private fun exhaustedBudgetSnapshot(): RustClientCoreAlbumSyncFfiSnapshot =
    RustClientCoreAlbumSyncFfiSnapshot(
      schemaVersion = 1,
      albumId = "018f05a4-8b31-7c00-8c00-0000000000a3",
      phase = "FetchingPage",
      activeCursor = "cursor-a",
      pendingCursor = "cursor-b",
      rerunRequested = false,
      retryCount = 3,
      maxRetryCount = 3,
      nextRetryUnixMs = 1_700_000_000_000L,
      lastErrorCode = 503,
      lastErrorStage = "fetch",
      updatedAtUnixMs = 1_700_000_000_000L,
    )
}
