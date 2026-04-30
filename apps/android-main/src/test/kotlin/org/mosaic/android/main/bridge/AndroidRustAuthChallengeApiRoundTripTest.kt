package org.mosaic.android.main.bridge

import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import java.nio.file.Files
import kotlin.io.path.readText

/**
 * Slice 0C round-trip test for `tests/vectors/auth_challenge.json`.
 *
 * Drives the production [AndroidRustAuthChallengeApi] adapter through JNA
 * into the host-built `mosaic_uniffi` cdylib and asserts byte-equality
 * against the captured vector transcripts and Ed25519 signatures.
 */
class AndroidRustAuthChallengeApiRoundTripTest {

  @Test
  fun buildTranscriptWithoutTimestampMatchesVector() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustAuthChallengeApi()
    val vector = readVector()
    val result = api.buildAuthChallengeTranscriptBytes(vector.username, -1L, vector.challenge)
    assertEquals(0, result.code)
    assertArrayEquals(vector.expectedTranscriptNoTimestamp, result.bytes)
  }

  @Test
  fun buildTranscriptWithTimestampMatchesVector() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustAuthChallengeApi()
    val vector = readVector()
    val result = api.buildAuthChallengeTranscriptBytes(
      vector.username,
      vector.timestampMs,
      vector.challenge,
    )
    assertEquals(0, result.code)
    assertArrayEquals(vector.expectedTranscriptWithTimestamp, result.bytes)
  }

  @Test
  fun signWithoutTimestampMatchesVectorSignature() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustAuthChallengeApi()
    val vector = readVector()
    val result = api.signAuthChallengeWithRawSeed(vector.expectedTranscriptNoTimestamp, vector.authSigningSeed)
    assertEquals(0, result.code)
    assertArrayEquals(vector.expectedSignatureNoTimestamp, result.bytes)
  }

  @Test
  fun signWithTimestampMatchesVectorSignature() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustAuthChallengeApi()
    val vector = readVector()
    val result = api.signAuthChallengeWithRawSeed(vector.expectedTranscriptWithTimestamp, vector.authSigningSeed)
    assertEquals(0, result.code)
    assertArrayEquals(vector.expectedSignatureWithTimestamp, result.bytes)
  }

  @Test
  fun verifyValidSignatureSucceeds() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustAuthChallengeApi()
    val vector = readVector()
    val result = api.verifyAuthChallengeSignature(
      vector.expectedTranscriptNoTimestamp,
      vector.expectedSignatureNoTimestamp,
      vector.authPublicKey,
    )
    assertEquals(0, result.code)
    assertTrue(result.valid)
  }

  @Test
  fun verifyWithWrongPublicKeyReturnsAuthenticationFailed() {
    // negativeCases.wrong-public-key → AUTH_VERIFICATION_FAILED (205)
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustAuthChallengeApi()
    val vector = readVector()
    val flipped = vector.authPublicKey.copyOf()
    flipped[0] = (flipped[0].toInt() xor 0x01).toByte()
    val result = api.verifyAuthChallengeSignature(
      vector.expectedTranscriptNoTimestamp,
      vector.expectedSignatureNoTimestamp,
      flipped,
    )
    // Either code 205 (verify failed) or 212 (invalid pubkey if the flip
    // produces a non-canonical Ed25519 point). Either is a non-zero rejection.
    assertNotEquals("expected non-zero rejection code", 0, result.code)
    assertFalse(result.valid)
  }

  @Test
  fun verifyWithTamperedChallengeReturnsAuthenticationFailed() {
    // negativeCases.tampered-challenge → AUTH_VERIFICATION_FAILED (205)
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustAuthChallengeApi()
    val vector = readVector()
    val tampered = vector.expectedTranscriptNoTimestamp.copyOf()
    tampered[0] = (tampered[0].toInt() xor 0x01).toByte()
    val result = api.verifyAuthChallengeSignature(
      tampered,
      vector.expectedSignatureNoTimestamp,
      vector.authPublicKey,
    )
    assertEquals(205, result.code)
    assertFalse(result.valid)
  }

  @Test
  fun verifyWithTimestampMismatchReturnsAuthenticationFailed() {
    // negativeCases.timestamp-mismatch: verify signatureWithTimestamp
    // against transcriptNoTimestamp → AUTH_VERIFICATION_FAILED (205)
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustAuthChallengeApi()
    val vector = readVector()
    val result = api.verifyAuthChallengeSignature(
      vector.expectedTranscriptNoTimestamp,
      vector.expectedSignatureWithTimestamp,
      vector.authPublicKey,
    )
    assertEquals(205, result.code)
    assertFalse(result.valid)
  }

  @Test
  fun signResultToStringDoesNotLeakSigningSeed() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustAuthChallengeApi()
    val vector = readVector()
    val result = api.signAuthChallengeWithRawSeed(
      vector.expectedTranscriptNoTimestamp,
      vector.authSigningSeed,
    )
    val rendered = result.toString()
    assertFalse(
      "toString must not leak authSigningSeed hex (forbidden output)",
      rendered.contains(vector.authSigningSeedHex),
    )
  }

  // -- corpus parsing --------------------------------------------------------

  private data class AuthChallengeVector(
    val authSigningSeedHex: String,
    val authSigningSeed: ByteArray,
    val authPublicKey: ByteArray,
    val username: String,
    val challenge: ByteArray,
    val timestampMs: Long,
    val expectedTranscriptNoTimestamp: ByteArray,
    val expectedTranscriptWithTimestamp: ByteArray,
    val expectedSignatureNoTimestamp: ByteArray,
    val expectedSignatureWithTimestamp: ByteArray,
  )

  private fun readVector(): AuthChallengeVector {
    val document = corpusFile("auth_challenge.json").readText()
    val seedHex = extractStringField(document, "authSigningSeedHex")
    return AuthChallengeVector(
      authSigningSeedHex = seedHex,
      authSigningSeed = decodeHex(seedHex),
      authPublicKey = decodeHex(extractStringField(document, "authPublicKeyHex")),
      username = extractStringField(document, "username"),
      challenge = decodeHex(extractStringField(document, "challengeHex")),
      timestampMs = extractLongField(document, "timestampMs"),
      expectedTranscriptNoTimestamp = decodeHex(extractStringField(document, "transcriptNoTimestampHex")),
      expectedTranscriptWithTimestamp = decodeHex(extractStringField(document, "transcriptWithTimestampHex")),
      expectedSignatureNoTimestamp = decodeHex(extractStringField(document, "signatureNoTimestampHex")),
      expectedSignatureWithTimestamp = decodeHex(extractStringField(document, "signatureWithTimestampHex")),
    )
  }
}
