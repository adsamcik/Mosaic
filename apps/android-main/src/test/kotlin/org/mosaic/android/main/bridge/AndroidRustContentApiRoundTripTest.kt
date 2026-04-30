package org.mosaic.android.main.bridge

import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import java.nio.file.Files
import kotlin.io.path.readText

/**
 * Slice 0C round-trip test for `tests/vectors/content_encrypt.json`.
 *
 * Drives the production [AndroidRustContentApi] adapter through JNA into
 * the host-built `mosaic_uniffi` cdylib and asserts byte-equality on the
 * decrypt direction (encrypt is non-deterministic due to random nonce).
 */
class AndroidRustContentApiRoundTripTest {

  @Test
  fun decryptVectorCiphertextMatchesExpectedPlaintext() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustContentApi()
    val vector = readVector()
    val result = api.decryptContentWithRawKey(
      contentKey = vector.contentKey,
      nonce = vector.nonce,
      ciphertext = vector.ciphertext,
      epochId = vector.epochId,
    )
    assertEquals("expected SUCCESS", 0, result.code)
    assertArrayEquals(vector.expectedPlaintext, result.plaintext)
  }

  @Test
  fun decryptWithWrongEpochIdReturnsAuthenticationFailed() {
    // negativeCases.wrong-epoch-id → AUTHENTICATION_FAILED (205)
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustContentApi()
    val vector = readVector()
    val result = api.decryptContentWithRawKey(
      contentKey = vector.contentKey,
      nonce = vector.nonce,
      ciphertext = vector.ciphertext,
      epochId = vector.epochId + 1,
    )
    assertEquals(205, result.code)
    assertEquals(0, result.plaintext.size)
  }

  @Test
  fun decryptWithTamperedCiphertextReturnsAuthenticationFailed() {
    // negativeCases.tampered-ciphertext → AUTHENTICATION_FAILED (205)
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustContentApi()
    val vector = readVector()
    val tampered = vector.ciphertext.copyOf()
    tampered[0] = (tampered[0].toInt() xor 0x01).toByte()
    val result = api.decryptContentWithRawKey(
      contentKey = vector.contentKey,
      nonce = vector.nonce,
      ciphertext = tampered,
      epochId = vector.epochId,
    )
    assertEquals(205, result.code)
    assertEquals(0, result.plaintext.size)
  }

  @Test
  fun decryptWithShortKeyReturnsInvalidKeyLength() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustContentApi()
    val vector = readVector()
    val result = api.decryptContentWithRawKey(
      contentKey = ByteArray(31),
      nonce = vector.nonce,
      ciphertext = vector.ciphertext,
      epochId = vector.epochId,
    )
    assertEquals(201, result.code)
  }

  @Test
  fun decryptWithShortNonceReturnsInvalidInputLength() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustContentApi()
    val vector = readVector()
    val result = api.decryptContentWithRawKey(
      contentKey = vector.contentKey,
      nonce = ByteArray(23),
      ciphertext = vector.ciphertext,
      epochId = vector.epochId,
    )
    assertEquals(202, result.code)
  }

  @Test
  fun decryptResultToStringDoesNotLeakPlaintextOrKey() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustContentApi()
    val vector = readVector()
    val result = api.decryptContentWithRawKey(
      contentKey = vector.contentKey,
      nonce = vector.nonce,
      ciphertext = vector.ciphertext,
      epochId = vector.epochId,
    )
    val rendered = result.toString()
    assertFalse(
      "toString must not leak plaintext hex (forbidden output)",
      rendered.contains(vector.expectedPlaintextHex),
    )
    assertFalse(
      "toString must not leak content_key hex (forbidden output)",
      rendered.contains(vector.contentKeyHex),
    )
  }

  // -- corpus parsing --------------------------------------------------------

  private data class ContentEncryptVector(
    val contentKeyHex: String,
    val contentKey: ByteArray,
    val nonce: ByteArray,
    val ciphertext: ByteArray,
    val expectedPlaintextHex: String,
    val expectedPlaintext: ByteArray,
    val epochId: Int,
  )

  private fun readVector(): ContentEncryptVector {
    val document = corpusFile("content_encrypt.json").readText()
    val keyHex = extractStringField(document, "contentKeyHex")
    val plaintextHex = extractStringField(document, "decryptedHex")
    return ContentEncryptVector(
      contentKeyHex = keyHex,
      contentKey = decodeHex(keyHex),
      nonce = decodeHex(extractStringField(document, "nonceHex")),
      ciphertext = decodeHex(extractStringField(document, "ciphertextHex")),
      expectedPlaintextHex = plaintextHex,
      expectedPlaintext = decodeHex(plaintextHex),
      epochId = extractIntegerField(document, "epochId"),
    )
  }
}
