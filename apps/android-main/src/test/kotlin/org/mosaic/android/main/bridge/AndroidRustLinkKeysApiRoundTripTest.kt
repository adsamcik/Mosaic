package org.mosaic.android.main.bridge

import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import java.nio.file.Files
import kotlin.io.path.readText
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Slice 0C round-trip test for `tests/vectors/link_keys.json`.
 *
 * Drives the production [AndroidRustLinkKeysApi] adapter through JNA into
 * the host-built `mosaic_uniffi` cdylib and asserts the public link ID plus
 * the opaque Rust link-handle contract.
 */
class AndroidRustLinkKeysApiRoundTripTest {

  @Test
  fun deriveLinkKeysFromVectorMatchesExpectedPublicFieldsAndHandle() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustLinkKeysApi()
    val vector = readVector("link_keys.json")
    val linkSecret = vector.linkSecret
    val expectedLinkId = vector.expectedLinkId
    val result = api.deriveLinkKeysFromRawSecret(linkSecret)

    assertEquals("expected SUCCESS code 0", 0, result.code)
    assertArrayEquals(expectedLinkId, result.linkId)
    assertNotEquals("successful derivation must return an opaque link handle", 0UL, result.linkHandleId)
  }

  @Test
  fun deriveLinkKeysFromShortSecretReturnsInvalidKeyLength() {
    // negativeCases.short-link-secret → INVALID_KEY_LENGTH (201)
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustLinkKeysApi()
    val truncated = ByteArray(31)
    val result = api.deriveLinkKeysFromRawSecret(truncated)
    assertEquals("expected code 201 for short link secret", 201, result.code)
    assertEquals(0, result.linkId.size)
    assertEquals(0UL, result.linkHandleId)
  }

  @Test
  fun deriveLinkKeysToStringDoesNotLeakSecretFields() {
    assumeTrue(NativeLibraryAvailability.isAvailable)
    val api = AndroidRustLinkKeysApi()
    val vector = readVector("link_keys.json")
    val result = api.deriveLinkKeysFromRawSecret(vector.linkSecret)
    val rendered = result.toString()
    assertFalse(
      "toString must not leak link_secret hex (forbidden output)",
      rendered.contains(vector.linkSecretHex),
    )
    assertFalse(
      "toString must not leak wrapping_key hex (forbidden output)",
      rendered.contains(vector.expectedWrappingKeyHex),
    )
  }

  // -- corpus parsing helpers ------------------------------------------------

  private data class LinkKeysVector(
    val linkSecretHex: String,
    val linkSecret: ByteArray,
    val expectedLinkId: ByteArray,
    val expectedWrappingKeyHex: String,
  )

  private fun readVector(name: String): LinkKeysVector {
    val document = corpusFile(name).readText()
    val linkSecretHex = extractStringField(document, "linkSecretHex")
    val linkIdHex = extractStringField(document, "linkIdHex")
    val wrappingKeyHex = extractStringField(document, "wrappingKeyHex")
    return LinkKeysVector(
      linkSecretHex = linkSecretHex,
      linkSecret = decodeHex(linkSecretHex),
      expectedLinkId = decodeHex(linkIdHex),
      expectedWrappingKeyHex = wrappingKeyHex,
    )
  }
}

internal fun corpusFile(name: String): Path {
  var cursor = Paths.get("").toAbsolutePath()
  repeat(10) {
    val candidate = cursor.resolve("tests").resolve("vectors").resolve(name)
    if (Files.exists(candidate)) return candidate
    cursor = cursor.parent ?: throw IllegalStateException("could not locate tests/vectors/$name")
  }
  throw IllegalStateException("could not locate tests/vectors/$name after 10 hops upward")
}

internal fun extractStringField(document: String, name: String): String {
  val needle = "\"$name\""
  val nameIdx = document.indexOf(needle)
  if (nameIdx < 0) throw IllegalStateException("field `$name` not found in vector document")
  var cursor = nameIdx + needle.length
  while (cursor < document.length && document[cursor] != ':') cursor++
  cursor++
  while (cursor < document.length && document[cursor].isWhitespace()) cursor++
  if (cursor >= document.length || document[cursor] != '"') {
    throw IllegalStateException("field `$name` is not a string in vector document")
  }
  cursor++
  val start = cursor
  while (cursor < document.length && document[cursor] != '"') {
    if (document[cursor] == '\\') cursor++
    cursor++
  }
  return document.substring(start, cursor)
}

internal fun extractIntegerField(document: String, name: String): Int {
  val needle = "\"$name\""
  val nameIdx = document.indexOf(needle)
  if (nameIdx < 0) throw IllegalStateException("field `$name` not found")
  var cursor = nameIdx + needle.length
  while (cursor < document.length && document[cursor] != ':') cursor++
  cursor++
  while (cursor < document.length && document[cursor].isWhitespace()) cursor++
  val start = cursor
  while (cursor < document.length && (document[cursor].isDigit() || document[cursor] == '-')) cursor++
  return document.substring(start, cursor).toInt()
}

internal fun extractLongField(document: String, name: String): Long {
  val needle = "\"$name\""
  val nameIdx = document.indexOf(needle)
  if (nameIdx < 0) throw IllegalStateException("field `$name` not found")
  var cursor = nameIdx + needle.length
  while (cursor < document.length && document[cursor] != ':') cursor++
  cursor++
  while (cursor < document.length && document[cursor].isWhitespace()) cursor++
  val start = cursor
  while (cursor < document.length && (document[cursor].isDigit() || document[cursor] == '-')) cursor++
  return document.substring(start, cursor).toLong()
}

internal fun extractBooleanField(document: String, name: String): Boolean {
  val needle = "\"$name\""
  val nameIdx = document.indexOf(needle)
  if (nameIdx < 0) throw IllegalStateException("field `$name` not found")
  var cursor = nameIdx + needle.length
  while (cursor < document.length && document[cursor] != ':') cursor++
  cursor++
  while (cursor < document.length && document[cursor].isWhitespace()) cursor++
  return when {
    document.startsWith("true", cursor) -> true
    document.startsWith("false", cursor) -> false
    else -> throw IllegalStateException("field `$name` is not a boolean")
  }
}

internal fun decodeHex(hex: String): ByteArray {
  if (hex.length % 2 != 0) throw IllegalStateException("invalid hex length")
  val out = ByteArray(hex.length / 2)
  for (i in out.indices) {
    val high = Character.digit(hex[i * 2], 16)
    val low = Character.digit(hex[i * 2 + 1], 16)
    if (high < 0 || low < 0) throw IllegalStateException("invalid hex character at $i")
    out[i] = ((high shl 4) or low).toByte()
  }
  return out
}
