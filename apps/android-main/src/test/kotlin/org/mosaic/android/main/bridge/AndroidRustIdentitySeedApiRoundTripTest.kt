package org.mosaic.android.main.bridge

import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import java.nio.file.Files
import kotlin.io.path.readText

/**
 * Slice 0C round-trip test for `tests/vectors/identity.json`.
 *
 * Drives the test-only [AndroidRustIdentitySeedApi] adapter through JNA
 * into the host-built `mosaic_uniffi` cdylib and asserts byte-equality
 * against the captured vector outputs.
 */
class AndroidRustIdentitySeedApiRoundTripTest {

  @Test
  fun deriveIdentityFromVectorSeedMatchesExpectedBytes() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustIdentitySeedApi()
    val vector = readVector()
    val result = api.deriveIdentityFromRawSeed(vector.identitySeed, vector.identityMessage)

    assertEquals("expected SUCCESS code 0", 0, result.code)
    assertArrayEquals(vector.expectedSigningPubkey, result.signingPubkey)
    assertArrayEquals(vector.expectedEncryptionPubkey, result.encryptionPubkey)
    assertArrayEquals(vector.expectedSignature, result.signature)
  }

  @Test
  fun deriveIdentityFromShortSeedReturnsInvalidKeyLength() {
    // negativeCases.short-seed → INVALID_KEY_LENGTH (201)
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustIdentitySeedApi()
    val truncated = ByteArray(31)
    val result = api.deriveIdentityFromRawSeed(truncated, ByteArray(0))
    assertEquals("expected code 201 for short seed", 201, result.code)
    assertEquals(0, result.signingPubkey.size)
    assertEquals(0, result.encryptionPubkey.size)
    assertEquals(0, result.signature.size)
  }

  @Test
  fun deriveIdentityToStringDoesNotLeakSeed() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustIdentitySeedApi()
    val vector = readVector()
    val result = api.deriveIdentityFromRawSeed(vector.identitySeed, vector.identityMessage)
    val rendered = result.toString()
    assertFalse(
      "toString must not leak identity_seed hex (forbidden output)",
      rendered.contains(vector.identitySeedHex),
    )
  }

  // -- corpus parsing --------------------------------------------------------

  private data class IdentityVector(
    val identitySeedHex: String,
    val identitySeed: ByteArray,
    val identityMessage: ByteArray,
    val expectedSigningPubkey: ByteArray,
    val expectedEncryptionPubkey: ByteArray,
    val expectedSignature: ByteArray,
  )

  private fun readVector(): IdentityVector {
    val document = corpusFile("identity.json").readText()
    val identitySeedHex = extractStringField(document, "identitySeedHex")
    return IdentityVector(
      identitySeedHex = identitySeedHex,
      identitySeed = decodeHex(identitySeedHex),
      identityMessage = decodeHex(extractStringField(document, "identityMessageHex")),
      expectedSigningPubkey = decodeHex(extractStringField(document, "signingPubkeyHex")),
      expectedEncryptionPubkey = decodeHex(extractStringField(document, "encryptionPubkeyHex")),
      expectedSignature = decodeHex(extractStringField(document, "signatureHex")),
    )
  }
}
