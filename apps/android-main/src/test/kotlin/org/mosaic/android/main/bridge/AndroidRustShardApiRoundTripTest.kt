package org.mosaic.android.main.bridge

import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull

class AndroidRustShardApiRoundTripTest {

  @Test
  fun encryptShardWithMissingHandleReturnsErrorCode() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustShardApi()
    val result = api.encryptShardWithEpochHandle(
      epochKeyHandle = 0xDEADBEEFL,
      plaintext = ByteArray(64) { it.toByte() },
      shardIndex = 0,
      tier = 1,
    )
    assertNotEquals(0, result.code)
    assertNotNull(result.envelopeBytes)
  }

  @Test
  fun decryptShardWithMissingHandleReturnsErrorCode() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustShardApi()
    val result = api.decryptShardWithEpochHandle(
      epochKeyHandle = 0xDEADBEEFL,
      envelopeBytes = ByteArray(128) { it.toByte() },
    )
    assertNotEquals(0, result.code)
  }

  @Test
  fun decryptShardWithMalformedEnvelopeReturnsInvalidEnvelopeOrAuthFail() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustShardApi()
    val result = api.decryptShardWithEpochHandle(
      epochKeyHandle = 0xDEADBEEFL,
      envelopeBytes = ByteArray(8),
    )
    assertNotEquals(0, result.code)
  }

  @Test
  fun encryptShardRejectsBadTierByteAtBridgeLevel() {
    val api = AndroidRustShardApi()
    val ex = runCatching {
      api.encryptShardWithEpochHandle(
        epochKeyHandle = 1L,
        plaintext = ByteArray(8),
        shardIndex = 0,
        tier = 256,
      )
    }.exceptionOrNull()
    assertNotEquals("expected bridge-level tier validation", null, ex)
  }

  @Test
  fun encryptShardRejectsNegativeShardIndexAtBridgeLevel() {
    val api = AndroidRustShardApi()
    val ex = runCatching {
      api.encryptShardWithEpochHandle(
        epochKeyHandle = 1L,
        plaintext = ByteArray(8),
        shardIndex = -1,
        tier = 1,
      )
    }.exceptionOrNull()
    assertNotEquals(null, ex)
  }
}
