package org.mosaic.android.main.bridge

import org.junit.Test
import org.junit.Assert.assertNotEquals

class AndroidRustMetadataSidecarApiRoundTripTest {

  // canonicalMetadataSidecarBytes does not need an account-key handle; it just
  // builds plaintext sidecar bytes from the encoded fields parameter. We assert
  // it succeeds OR returns a stable error code (no crash, no UnsatisfiedLink).

  @Test
  fun canonicalMetadataSidecarBytesProducesNonNullResult() {
    NativeLibraryAvailability.assumeAvailableOrFailInCi()
    val api = AndroidRustMetadataSidecarApi()
    val result = api.canonicalMetadataSidecarBytes(
      albumId = ByteArray(16) { it.toByte() },
      photoId = ByteArray(16) { it.toByte() },
      epochId = 1,
      encodedFields = ByteArray(0),
    )
    // 0 = OK, otherwise a stable error code. Both paths exercise the FFI.
    assertNotEquals(-1, result.code)
  }

  @Test
  fun encryptMetadataSidecarWithMissingHandleReturnsErrorCode() {
    NativeLibraryAvailability.assumeAvailableOrFailInCi()
    val api = AndroidRustMetadataSidecarApi()
    val result = api.encryptMetadataSidecarWithEpochHandle(
      handle = 0xDEADBEEFUL,
      albumId = ByteArray(16) { it.toByte() },
      photoId = ByteArray(16) { it.toByte() },
      epochId = 1,
      encodedFields = ByteArray(0),
      shardIndex = 0,
    )
    assertNotEquals(0, result.code)
  }

  @Test
  fun canonicalMediaMetadataSidecarBytesRejectsBadMediaBytes() {
    NativeLibraryAvailability.assumeAvailableOrFailInCi()
    val api = AndroidRustMetadataSidecarApi()
    val result = api.canonicalMediaMetadataSidecarBytes(
      albumId = ByteArray(16) { it.toByte() },
      photoId = ByteArray(16) { it.toByte() },
      epochId = 1,
      mediaBytes = ByteArray(64) { it.toByte() },
    )
    assertNotEquals(0, result.code)
  }

  @Test
  fun encryptMediaMetadataSidecarWithMissingHandleReturnsErrorCode() {
    NativeLibraryAvailability.assumeAvailableOrFailInCi()
    val api = AndroidRustMetadataSidecarApi()
    val result = api.encryptMediaMetadataSidecarWithEpochHandle(
      handle = 0xDEADBEEFUL,
      albumId = ByteArray(16) { it.toByte() },
      photoId = ByteArray(16) { it.toByte() },
      epochId = 1,
      mediaBytes = ByteArray(64) { it.toByte() },
      shardIndex = 0,
    )
    assertNotEquals(0, result.code)
  }
}
