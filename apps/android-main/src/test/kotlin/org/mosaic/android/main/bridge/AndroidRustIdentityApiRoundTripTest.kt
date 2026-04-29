package org.mosaic.android.main.bridge

import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull

class AndroidRustIdentityApiRoundTripTest {

  // All identity operations require a valid account-key handle. Without a real
  // unlock (which needs a properly-wrapped account key), every call here must
  // fail with SECRET_HANDLE_NOT_FOUND (400) or similar. We assert the FFI
  // marshalling correctly propagates that failure rather than crashing.

  @Test
  fun createIdentityWithMissingAccountHandleReturnsErrorCode() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustIdentityApi()
    val result = api.createIdentityHandle(accountKeyHandle = 0xDEADBEEFL)
    assertNotEquals(0, result.code)
    assertEquals(0L, result.handle)
  }

  @Test
  fun openIdentityWithMissingHandleReturnsErrorCode() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustIdentityApi()
    val result = api.openIdentityHandle(
      wrappedSeed = ByteArray(64),
      accountKeyHandle = 0xDEADBEEFL,
    )
    assertNotEquals(0, result.code)
  }

  @Test
  fun signingPubkeyForMissingHandleReturnsErrorCode() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustIdentityApi()
    val result = api.identitySigningPubkey(handle = 0xCAFEBABEL)
    assertNotEquals(0, result.code)
  }

  @Test
  fun encryptionPubkeyForMissingHandleReturnsErrorCode() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustIdentityApi()
    val result = api.identityEncryptionPubkey(handle = 0xCAFEBABEL)
    assertNotEquals(0, result.code)
  }

  @Test
  fun signManifestWithMissingHandleReturnsErrorCode() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustIdentityApi()
    val result = api.signManifestWithIdentity(handle = 0xCAFEBABEL, transcriptBytes = ByteArray(48))
    assertNotEquals(0, result.code)
    assertNotNull(result.bytes)
  }

  @Test
  fun closeIdentityForMissingHandleReturnsNotFound() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustIdentityApi()
    val code = api.closeIdentityHandle(handle = 0xCAFEBABEL)
    assertNotEquals(0, code)
  }

  @Test
  fun bytesResultArrayIsImmutableAcrossCalls() {
    // The FFI marshalling must produce an isolated ByteArray per call (no
    // shared mutable buffer between invocations). This is a basic regression
    // guard against returning a JNA-owned pointer wrapped as a non-copying
    // ByteArray.
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustIdentityApi()
    val first = api.identitySigningPubkey(0xCAFEBABEL)
    val second = api.identitySigningPubkey(0xCAFEBABEL)
    // Both should fail identically; their byte arrays must not be the SAME
    // instance (or if they are, mutating one must not affect the other).
    if (first.bytes.isNotEmpty()) {
      first.bytes[0] = 0x42
      assertNotEquals(0x42.toByte(), second.bytes.getOrNull(0))
    }
  }
}
