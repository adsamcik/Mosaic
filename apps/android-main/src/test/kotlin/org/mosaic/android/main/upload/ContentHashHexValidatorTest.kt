package org.mosaic.android.main.upload

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * v1.0.x s47-y5: bypass-resistance tests for the content-hash hex validator.
 * Each named test corresponds to one bypass attempt that must be rejected.
 */
class ContentHashHexValidatorTest {
  private val canonical = "a".repeat(64)

  @Test
  fun acceptsCanonicalLowercaseSha256Hex() {
    assertTrue(ContentHashHex.isValid(canonical))
    assertTrue(ContentHashHex.isValid("0123456789abcdef".repeat(4)))
  }

  @Test
  fun rejectsNullOrEmpty() {
    assertFalse(ContentHashHex.isValid(null))
    assertFalse(ContentHashHex.isValid(""))
  }

  @Test
  fun rejectsUppercaseHex() {
    assertFalse(ContentHashHex.isValid("A".repeat(64)))
    assertFalse(ContentHashHex.isValid("DEADBEEF".repeat(8)))
  }

  @Test
  fun rejectsMixedCaseHex() {
    assertFalse(ContentHashHex.isValid("aA".repeat(32)))
    assertFalse(ContentHashHex.isValid("deadbeef".repeat(7) + "DEADBEEF"))
  }

  @Test
  fun rejectsLeadingWhitespace() {
    assertFalse(ContentHashHex.isValid(" " + "a".repeat(63)))
    assertFalse(ContentHashHex.isValid("\t" + "a".repeat(63)))
    assertFalse(ContentHashHex.isValid(" $canonical"))
  }

  @Test
  fun rejectsTrailingWhitespace() {
    assertFalse(ContentHashHex.isValid("a".repeat(63) + " "))
    assertFalse(ContentHashHex.isValid("a".repeat(63) + "\n"))
    assertFalse(ContentHashHex.isValid("$canonical "))
    assertFalse(ContentHashHex.isValid("$canonical\n"))
    assertFalse(ContentHashHex.isValid("$canonical\r\n"))
  }

  @Test
  fun rejectsEmbeddedWhitespace() {
    assertFalse(ContentHashHex.isValid("a".repeat(32) + " " + "a".repeat(31)))
    assertFalse(ContentHashHex.isValid("a".repeat(32) + "\t" + "a".repeat(31)))
  }

  @Test
  fun rejectsWrongLength() {
    assertFalse(ContentHashHex.isValid("a".repeat(63)))
    assertFalse(ContentHashHex.isValid("a".repeat(65)))
    assertFalse(ContentHashHex.isValid("a".repeat(128)))
  }

  @Test
  fun rejectsNonHexCharacters() {
    assertFalse(ContentHashHex.isValid("g".repeat(64)))
    assertFalse(ContentHashHex.isValid("z".repeat(64)))
    assertFalse(ContentHashHex.isValid("a".repeat(63) + "!"))
    assertFalse(ContentHashHex.isValid("a".repeat(63) + "/"))
  }
}
