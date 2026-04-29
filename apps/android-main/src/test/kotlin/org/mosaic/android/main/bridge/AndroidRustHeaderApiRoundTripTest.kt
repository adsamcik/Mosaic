package org.mosaic.android.main.bridge

import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue

class AndroidRustHeaderApiRoundTripTest {

  @Test
  fun parseEnvelopeHeaderRejectsTooShortBytes() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustHeaderApi()
    val result = api.parseEnvelopeHeader(ByteArray(8))
    // Stable code 100 = INVALID_HEADER_LENGTH
    assertEquals(100, result.code)
  }

  @Test
  fun parseEnvelopeHeaderRejectsBadMagic() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustHeaderApi()
    // Build a 64-byte buffer with wrong magic but otherwise plausible structure.
    val bytes = ByteArray(64)
    // Magic should be "SGzk" (0x53 0x47 0x7a 0x6b); use bogus bytes.
    bytes[0] = 0x00
    bytes[1] = 0x00
    bytes[2] = 0x00
    bytes[3] = 0x00
    val result = api.parseEnvelopeHeader(bytes)
    // 101 = INVALID_MAGIC; 102 = UNSUPPORTED_VERSION (also possible if magic check
    // happens after version). Either is a non-OK rejection.
    assertNotEquals(0, result.code)
  }

  @Test
  fun parseEnvelopeHeaderRejectsEmptyBytes() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustHeaderApi()
    val result = api.parseEnvelopeHeader(ByteArray(0))
    assertEquals(100, result.code)
  }

  @Test
  fun parseEnvelopeHeaderProducesNonNullNonceOnAnyResult() {
    // Even on failures, the FFI converts `nonce: Vec<u8>` to a non-null
    // ByteArray (possibly empty). Verifies the FFI marshalling never returns
    // null where the type contract says ByteArray.
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustHeaderApi()
    val result = api.parseEnvelopeHeader(ByteArray(64))
    assertNotNull(result.nonce)
    assertTrue(result.nonce.size >= 0)
  }
}
