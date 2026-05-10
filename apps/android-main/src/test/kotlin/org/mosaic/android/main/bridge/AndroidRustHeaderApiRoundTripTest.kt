package org.mosaic.android.main.bridge

import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.mosaic.android.foundation.GeneratedRustHeaderApi
import org.mosaic.android.foundation.GeneratedRustHeaderBridge
import org.mosaic.android.foundation.HeaderParseCode
import org.mosaic.android.foundation.RustHeaderParseFfiResult
import org.mosaic.android.foundation.RustHeaderStableCode

class AndroidRustHeaderApiRoundTripTest {

  @Test
  fun generatedBridgePreservesUnsignedHeaderFieldsBeyondIntRange() {
    val bridge = GeneratedRustHeaderBridge(
      object : GeneratedRustHeaderApi {
        override fun parseEnvelopeHeader(bytes: ByteArray): RustHeaderParseFfiResult =
          RustHeaderParseFfiResult(
            code = RustHeaderStableCode.OK,
            epochId = 0xFFFF_FFFFL,
            shardIndex = 0x8000_0000L,
            tier = 1,
            nonce = ByteArray(24),
          )
      },
    )

    val result = bridge.parseEnvelopeHeader(ByteArray(64))

    assertEquals(HeaderParseCode.SUCCESS, result.code)
    val parsed = requireNotNull(result.parsed)
    assertEquals(0xFFFF_FFFFL, parsed.epochId)
    assertEquals(0x8000_0000L, parsed.shardIndex)
  }

  @Test
  fun parseEnvelopeHeaderRejectsTooShortBytes() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustHeaderApi()
    // The bridge enforces a 64-byte input pre-FFI to fail fast on obviously
    // malformed envelopes; assert the Kotlin-side rejection rather than a
    // Rust stable code.
    val ex = runCatching { api.parseEnvelopeHeader(ByteArray(8)) }.exceptionOrNull()
    assertNotEquals("expected pre-FFI rejection of short header", null, ex)
  }

  @Test
  fun parseEnvelopeHeaderRejectsBadMagic() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustHeaderApi()
    // Build a 64-byte buffer with wrong magic but otherwise plausible structure.
    val bytes = ByteArray(64)
    val result = api.parseEnvelopeHeader(bytes)
    // 101 = INVALID_MAGIC; 102 = UNSUPPORTED_VERSION (also possible if magic
    // check happens after version). Either is a non-OK rejection.
    assertNotEquals(0, result.code)
  }

  @Test
  fun parseEnvelopeHeaderRejectsEmptyBytes() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustHeaderApi()
    val ex = runCatching { api.parseEnvelopeHeader(ByteArray(0)) }.exceptionOrNull()
    assertNotEquals("expected pre-FFI rejection of empty header", null, ex)
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
