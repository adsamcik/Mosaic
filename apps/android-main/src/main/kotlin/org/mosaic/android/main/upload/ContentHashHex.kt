package org.mosaic.android.main.upload

/**
 * Strict validator for SHA-256 content-hash hex strings used by the Android
 * upload pipeline and dedup tables.
 *
 * v1.0.x s47-y5: previously the validator was an ad-hoc `Regex("^[0-9a-f]{64}$")`
 * scattered through the worker. A pasted hash containing uppercase characters,
 * leading/trailing whitespace, or embedded whitespace could in some flows slip
 * through because callers used `find()` or trimmed before checking. This object
 * centralises the contract: any hex that does not match the canonical form
 * exactly — 64 lowercase characters in `[0-9a-f]`, no whitespace anywhere — is
 * rejected. The validator never trims, never lower-cases, and never tolerates
 * trailing newlines.
 */
internal object ContentHashHex {
  /** Canonical length of a SHA-256 hex digest. */
  const val LENGTH: Int = 64

  /**
   * Anchored regex using `\A` and `\z` (Java strict anchors) so the pattern can
   * NEVER admit a trailing line terminator the way `$` permits in non-multiline
   * mode. Combined with `Regex.matches` (full-input match) this is doubly safe.
   */
  private val STRICT_HEX_REGEX: Regex = Regex("""\A[0-9a-f]{64}\z""")

  /** Returns `true` iff [value] is exactly 64 lowercase hex characters. */
  fun isValid(value: String?): Boolean {
    if (value == null) return false
    if (value.length != LENGTH) return false
    for (i in 0 until LENGTH) {
      val c = value[i]
      val lowercaseHex = (c in '0'..'9') || (c in 'a'..'f')
      if (!lowercaseHex) return false
    }
    return STRICT_HEX_REGEX.matches(value)
  }
}
