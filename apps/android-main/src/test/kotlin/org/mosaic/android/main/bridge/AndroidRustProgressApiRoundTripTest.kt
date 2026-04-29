package org.mosaic.android.main.bridge

import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue

class AndroidRustProgressApiRoundTripTest {

  @Test
  fun probeWithoutCancellationCompletesAllSteps() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustProgressApi()
    val result = api.probe(totalSteps = 4, cancelAfter = null)
    assertEquals(0, result.code)
    // Each step emits a checkpoint; final result should include `total` events.
    assertTrue("expected at least one checkpoint", result.checkpoints.isNotEmpty())
    val last = result.checkpoints.last()
    assertEquals(4, last.totalSteps)
  }

  @Test
  fun probeWithCancellationStopsEarly() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustProgressApi()
    val result = api.probe(totalSteps = 10, cancelAfter = 3)
    // 300 = OPERATION_CANCELLED; OK is also acceptable if the probe finished
    // before cancellation took effect.
    assertTrue("expected OK or OPERATION_CANCELLED", result.code == 0 || result.code == 300)
    if (result.code == 300) {
      val lastCompleted = result.checkpoints.lastOrNull()?.completedSteps ?: 0
      assertTrue("cancelled probe must report fewer than total checkpoints", lastCompleted < 10)
    }
  }

  @Test
  fun probeWithZeroStepsCompletesImmediately() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustProgressApi()
    val result = api.probe(totalSteps = 0, cancelAfter = null)
    assertEquals(0, result.code)
  }

  @Test
  fun probeRejectsNegativeTotalSteps() {
    val api = AndroidRustProgressApi()
    val ex = runCatching { api.probe(totalSteps = -1, cancelAfter = null) }.exceptionOrNull()
    assertNotEquals("expected throw on negative total", null, ex)
  }
}
