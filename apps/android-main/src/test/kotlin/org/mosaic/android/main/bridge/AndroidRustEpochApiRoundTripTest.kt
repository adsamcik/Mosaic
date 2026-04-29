package org.mosaic.android.main.bridge

import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue

class AndroidRustEpochApiRoundTripTest {

  @Test
  fun createEpochWithMissingAccountHandleReturnsErrorCode() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustEpochApi()
    val result = api.createEpochKeyHandle(accountKeyHandle = 0xDEADBEEFL, epochId = 1)
    assertNotEquals(0, result.code)
    assertEquals(0L, result.handle)
  }

  @Test
  fun openEpochWithMissingHandleReturnsErrorCode() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustEpochApi()
    val result = api.openEpochKeyHandle(
      wrappedEpochSeed = ByteArray(48),
      accountKeyHandle = 0xDEADBEEFL,
      epochId = 1,
    )
    assertNotEquals(0, result.code)
  }

  @Test
  fun openEpochRejectsTooShortWrappedSeed() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustEpochApi()
    // 4 bytes is well below the wrapped key minimum (32 bytes + 12 nonce + 16 tag).
    val result = api.openEpochKeyHandle(
      wrappedEpochSeed = ByteArray(4),
      accountKeyHandle = 0xDEADBEEFL,
      epochId = 1,
    )
    assertNotEquals(0, result.code)
  }

  @Test
  fun isEpochOpenForMissingHandleReportsNotOpen() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustEpochApi()
    val status = api.epochKeyHandleIsOpen(handle = 0xCAFEBABEL)
    assertTrue(status.code != 0 || !status.isOpen)
  }

  @Test
  fun closeEpochForMissingHandleReturnsNotFound() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustEpochApi()
    val code = api.closeEpochKeyHandle(handle = 0xCAFEBABEL)
    assertNotEquals(0, code)
  }

  @Test
  fun createEpochRejectsNegativeEpochIdAtBridgeLevel() {
    val api = AndroidRustEpochApi()
    val ex = runCatching {
      api.createEpochKeyHandle(accountKeyHandle = 1L, epochId = -1)
    }.exceptionOrNull()
    assertNotEquals("expected pre-FFI rejection of negative epoch id", null, ex)
  }
}
