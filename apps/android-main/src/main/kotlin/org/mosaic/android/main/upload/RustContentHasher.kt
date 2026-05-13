package org.mosaic.android.main.upload

import org.mosaic.android.main.bridge.AndroidRustCoreLibraryLoader
import uniffi.mosaic_uniffi.sha256OfBytes as rustSha256OfBytes
import java.io.File
import java.security.MessageDigest

object RustContentHasher {
  private const val SHA256_BYTES: Int = 32
  private const val MAX_SINGLE_SHOT_BYTES: Long = 32L * 1024L * 1024L
  private const val STREAM_BUFFER_BYTES: Int = 1024 * 1024
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

  fun sha256Hex(file: File): String =
    if (file.length() <= MAX_SINGLE_SHOT_BYTES) {
      sha256Hex(file.readBytes())
    } else {
      sha256HexStreaming(file)
    }

  private fun sha256HexStreaming(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().buffered().use { input ->
      val buffer = ByteArray(STREAM_BUFFER_BYTES)
      while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        if (read > 0) digest.update(buffer, 0, read)
      }
    }
    return digest.digest().toLowerHex()
  }

  private fun ByteArray.toLowerHex(): String = buildString(size * 2) {
    for (byte in this@toLowerHex) {
      val v = byte.toInt() and 0xff
      append(HEX_DIGITS[v ushr 4])
      append(HEX_DIGITS[v and 0x0f])
    }
  }
}
