package org.mosaic.android.main.upload

import org.mosaic.android.main.bridge.AndroidRustCoreLibraryLoader
import uniffi.mosaic_uniffi.sha256OfBytes as rustSha256OfBytes

object RustContentHasher {
  private const val SHA256_BYTES: Int = 32
  private val HEX_DIGITS = charArrayOf(
    '0', '1', '2', '3', '4', '5', '6', '7',
    '8', '9', 'a', 'b', 'c', 'd', 'e', 'f',
  )

  fun sha256Hex(bytes: ByteArray): String {
    AndroidRustCoreLibraryLoader.warmUp()
    val digest = rustSha256OfBytes(bytes)
    check(digest.size == SHA256_BYTES) { "Rust SHA-256 returned ${digest.size} bytes" }
    return digest.toLowerHex()
  }

  private fun ByteArray.toLowerHex(): String = buildString(size * 2) {
    for (byte in this@toLowerHex) {
      val v = byte.toInt() and 0xff
      append(HEX_DIGITS[v ushr 4])
      append(HEX_DIGITS[v and 0x0f])
    }
  }
}
