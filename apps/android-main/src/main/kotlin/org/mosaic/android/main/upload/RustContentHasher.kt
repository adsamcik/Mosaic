package org.mosaic.android.main.upload

import org.mosaic.android.main.bridge.AndroidRustCoreLibraryLoader
import uniffi.mosaic_uniffi.Sha256Hasher
import uniffi.mosaic_uniffi.sha256OfBytes as rustSha256OfBytes
import java.io.File
import java.io.InputStream

object RustContentHasher {
  private const val SHA256_BYTES: Int = 32
  private const val STREAM_BUFFER_BYTES: Int = 64 * 1024
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

  fun sha256Hex(file: File): String = file.inputStream().use { input -> sha256Hex(input) }

  fun sha256Hex(input: InputStream): String {
    AndroidRustCoreLibraryLoader.warmUp()
    val hasher = Sha256Hasher()
    try {
      input.buffered().use { stream ->
        val buffer = ByteArray(STREAM_BUFFER_BYTES)
        var read = stream.read(buffer)
        while (read >= 0) {
          if (read > 0) hasher.update(buffer.copyOf(read))
          read = stream.read(buffer)
        }
      }
      return hasher.finalizeHex()
    } finally {
      hasher.close()
    }
  }

  fun sha256Bytes(input: InputStream): ByteArray {
    AndroidRustCoreLibraryLoader.warmUp()
    val hasher = Sha256Hasher()
    try {
      input.buffered().use { stream ->
        val buffer = ByteArray(STREAM_BUFFER_BYTES)
        var read = stream.read(buffer)
        while (read >= 0) {
          if (read > 0) hasher.update(buffer.copyOf(read))
          read = stream.read(buffer)
        }
      }
      return hasher.finalizeBytes()
    } finally {
      hasher.close()
    }
  }

  private fun ByteArray.toLowerHex(): String = buildString(size * 2) {
    for (byte in this@toLowerHex) {
      val v = byte.toInt() and 0xff
      append(HEX_DIGITS[v ushr 4])
      append(HEX_DIGITS[v and 0x0f])
    }
  }
}
