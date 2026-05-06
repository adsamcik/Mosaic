package org.mosaic.android.main.crypto

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest

internal class ShardEnvelopeStore(
  private val context: Context,
) {
  fun readStagingBytes(stagingUri: String): ByteArray {
    return openStagingInputStream(stagingUri).use { input -> input.readBytes() }
  }

  fun openStagingInputStream(stagingUri: String): InputStream {
    val uri = Uri.parse(stagingUri)
    return when (uri.scheme) {
      ContentResolver.SCHEME_FILE -> File(requireNotNull(uri.path) { "file staging uri must include a path" }).inputStream()
      MOSAIC_STAGED_SCHEME -> stagedFileFor(uri).inputStream()
      null, "" -> File(stagingUri).inputStream()
      else -> requireNotNull(context.contentResolver.openInputStream(uri)) { "unable to open staging uri" }
    }
  }

  fun stagingLength(stagingUri: String): Long {
    val uri = Uri.parse(stagingUri)
    return when (uri.scheme) {
      ContentResolver.SCHEME_FILE -> File(requireNotNull(uri.path) { "file staging uri must include a path" }).length()
      MOSAIC_STAGED_SCHEME -> stagedFileFor(uri).length()
      null, "" -> File(stagingUri).length()
      else -> requireNotNull(context.contentResolver.openAssetFileDescriptor(uri, "r")) {
        "unable to stat staging uri"
      }.use { descriptor -> descriptor.length }
    }
  }

  fun existingEnvelopeUri(input: ShardEnvelopeInput): String? {
    val file = envelopeFile(input)
    return if (file.exists()) Uri.fromFile(file).toString() else null
  }

  fun persistEnvelope(input: ShardEnvelopeInput, envelope: ByteArray): PersistedEnvelope {
    val file = envelopeFile(input)
    if (file.exists()) return PersistedEnvelope(Uri.fromFile(file).toString(), sha256Hex(file.inputStream()))
    file.parentFile?.mkdirs()
    val partial = File(file.parentFile, "${file.name}.partial")
    val digest = MessageDigest.getInstance("SHA-256")
    partial.outputStream().use { output ->
      output.writeAndHash(envelope, digest)
    }
    if (!partial.renameTo(file)) {
      partial.copyTo(file, overwrite = true)
      partial.delete()
    }
    return PersistedEnvelope(
      uri = Uri.fromFile(file).toString(),
      sha256Hex = digest.digest().joinToString("") { byte -> "%02x".format(byte) },
    )
  }

  fun sha256HexForUri(uriString: String): String = sha256Hex(openStagingInputStream(uriString))

  private fun envelopeFile(input: ShardEnvelopeInput): File =
    File(envelopeDir(), "${input.cacheKey()}.envelope")

  private fun envelopeDir(): File = File(context.filesDir, ENVELOPE_DIR_NAME).also { it.mkdirs() }

  private fun stagedFileFor(uri: Uri): File {
    val id = requireNotNull(uri.authority) { "mosaic-staged uri must include an id authority" }
    return File(context.filesDir, "staging${File.separator}$id.blob")
  }

  private fun ShardEnvelopeInput.cacheKey(): String = sha256Hex(
    listOf(stagingUri, epochHandleId.toString(), tier.toString(), shardIndex.toString(), plaintextSha256Hex)
      .joinToString(separator = "\u001f")
      .toByteArray(Charsets.UTF_8),
  )

  companion object {
    private const val MOSAIC_STAGED_SCHEME = "mosaic-staged"
    private const val ENVELOPE_DIR_NAME = "encrypted-shards"

    fun sha256Hex(bytes: ByteArray): String =
      MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { byte -> "%02x".format(byte) }

    fun sha256Hex(input: InputStream): String {
      val digest = MessageDigest.getInstance("SHA-256")
      input.use { stream ->
        val buffer = ByteArray(64 * 1024)
        while (true) {
          val read = stream.read(buffer)
          if (read <= 0) break
          digest.update(buffer, 0, read)
        }
      }
      return digest.digest().joinToString("") { byte -> "%02x".format(byte) }
    }
  }
}

private fun OutputStream.writeAndHash(bytes: ByteArray, digest: MessageDigest) {
  write(bytes)
  digest.update(bytes)
}

internal data class ShardEnvelopeInput(
  val stagingUri: String,
  val epochHandleId: Long,
  val tier: Int,
  val shardIndex: Int,
  val plaintextSha256Hex: String,
)

internal data class PersistedEnvelope(
  val uri: String,
  val sha256Hex: String,
)
