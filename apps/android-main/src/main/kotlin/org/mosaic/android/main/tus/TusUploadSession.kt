package org.mosaic.android.main.tus

import java.io.RandomAccessFile
import java.security.MessageDigest
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.mosaic.android.main.staging.AppPrivateStagingManager
import org.mosaic.android.main.staging.StagedFile
import org.mosaic.android.main.staging.StagedUploadState

class TusUploadSession(
  private val client: MosaicTusClient,
  private val stagingManager: AppPrivateStagingManager,
  private val chunkSizeBytes: Int = 1024 * 1024,
) {
  init {
    require(chunkSizeBytes > 0) { "chunk size must be positive" }
  }

  fun upload(staged: StagedFile, metadata: Map<String, String> = emptyMap()): ShardManifestEntry {
    val state = stagingManager.readUploadState(staged)
    val uploadUrl = state.uploadUrl?.toHttpUrl() ?: initiate(staged, metadata)
    var offset = if (state.uploadUrl == null) 0L else resumeOffset(uploadUrl, state.offset)

    RandomAccessFile(staged.file, "r").use { input ->
      val buffer = ByteArray(chunkSizeBytes)
      while (offset < staged.sizeBytes) {
        input.seek(offset)
        val bytesRead = input.read(buffer, 0, minOf(buffer.size, (staged.sizeBytes - offset).toInt()))
        if (bytesRead <= 0) break
        patchWithRetry(uploadUrl, offset, buffer.copyOf(bytesRead))
        offset += bytesRead
        stagingManager.writeUploadState(staged, StagedUploadState(uploadUrl.toString(), offset, finalized = false))
      }
    }

    val checksum = sha256Hex(staged.file.readBytes())
    stagingManager.writeUploadState(staged, StagedUploadState(uploadUrl.toString(), offset, finalized = true))
    return ShardManifestEntry(uploadUrl = uploadUrl.toString(), sizeBytes = staged.sizeBytes, uploadedBytes = offset, sha256 = checksum)
  }

  private fun initiate(staged: StagedFile, metadata: Map<String, String>): HttpUrl {
    val request = client.newRequestBuilder(client.endpointUrl)
      .post(ByteArray(0).toRequestBody(null))
      .header("Upload-Length", staged.sizeBytes.toString())
      .apply {
        if (metadata.isNotEmpty()) header("Upload-Metadata", metadata.toTusMetadata())
      }
      .build()

    client.okHttpClient.newCall(request).execute().use { response ->
      require(response.code == 201) { "Tus init failed with HTTP ${response.code}" }
      val location = requireNotNull(response.header("Location")) { "Tus init response missing Location" }
      val url = client.endpointUrl.resolve(location) ?: location.toHttpUrl()
      stagingManager.writeUploadState(staged, StagedUploadState(url.toString(), 0L, finalized = false))
      return url
    }
  }

  private fun resumeOffset(uploadUrl: HttpUrl, fallbackOffset: Long): Long {
    val request = client.newRequestBuilder(uploadUrl).head().build()
    client.okHttpClient.newCall(request).execute().use { response ->
      if (response.isSuccessful) return response.header("Upload-Offset")?.toLongOrNull() ?: fallbackOffset
    }
    return fallbackOffset
  }

  private fun patchWithRetry(uploadUrl: HttpUrl, offset: Long, chunk: ByteArray) {
    var attempt = 0
    var lastFailure: IllegalStateException? = null
    while (attempt < client.maxPatchRetries) {
      client.executePatch(uploadUrl, offset, chunk.toRequestBody("application/offset+octet-stream".toMediaType())).use { response ->
        if (response.code == 204) return
        lastFailure = IllegalStateException("Tus PATCH failed with HTTP ${response.code}")
      }
      attempt++
    }
    throw requireNotNull(lastFailure)
  }

  private fun Map<String, String>.toTusMetadata(): String = entries.joinToString(",") { (key, value) ->
    "$key ${java.util.Base64.getEncoder().encodeToString(value.toByteArray(Charsets.UTF_8))}"
  }

  private fun sha256Hex(bytes: ByteArray): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
    return digest.joinToString("") { byte -> "%02x".format(byte) }
  }
}

data class ShardManifestEntry(
  val uploadUrl: String,
  val sizeBytes: Long,
  val uploadedBytes: Long,
  val sha256: String,
)
