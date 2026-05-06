package org.mosaic.android.main.crypto

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import java.io.File
import java.security.MessageDigest

internal class ShardEnvelopeStore(
  private val context: Context,
) {
  fun readStagingBytes(stagingUri: String): ByteArray {
    val uri = Uri.parse(stagingUri)
    return when (uri.scheme) {
      ContentResolver.SCHEME_FILE -> File(requireNotNull(uri.path) { "file staging uri must include a path" }).readBytes()
      MOSAIC_STAGED_SCHEME -> stagedFileFor(uri).readBytes()
      null, "" -> File(stagingUri).readBytes()
      else -> context.contentResolver.openInputStream(uri).use { input ->
        requireNotNull(input) { "unable to open staging uri" }.readBytes()
      }
    }
  }

  fun existingEnvelopeUri(input: ShardEnvelopeInput): String? {
    val file = envelopeFile(input)
    return if (file.exists()) Uri.fromFile(file).toString() else null
  }

  fun persistEnvelope(input: ShardEnvelopeInput, envelope: ByteArray): String {
    val file = envelopeFile(input)
    if (file.exists()) return Uri.fromFile(file).toString()
    file.parentFile?.mkdirs()
    val partial = File(file.parentFile, "${file.name}.partial")
    partial.writeBytes(envelope)
    if (!partial.renameTo(file)) {
      partial.copyTo(file, overwrite = true)
      partial.delete()
    }
    return Uri.fromFile(file).toString()
  }

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
  }
}

internal data class ShardEnvelopeInput(
  val stagingUri: String,
  val epochHandleId: Long,
  val tier: Int,
  val shardIndex: Int,
  val plaintextSha256Hex: String,
)
