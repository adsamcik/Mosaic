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
    var uploadUrl = state.uploadUrl?.toHttpUrl()
    var offset = 0L
    if (uploadUrl == null) {
      uploadUrl = initiate(staged, metadata)
    } else {
      when (val resume = resumeOffset(uploadUrl, state.offset)) {
        ResumeDecision.Restart -> {
          stagingManager.writeUploadState(staged, StagedUploadState(uploadUrl = null, offset = 0L, finalized = false))
          uploadUrl = initiate(staged, metadata)
        }
        is ResumeDecision.Resume -> offset = resume.offset
      }
    }
    if (offset > staged.sizeBytes) {
      throw TusUploadException.OffsetMismatch(expectedOffset = staged.sizeBytes, actualOffset = offset)
    }

    val digest = MessageDigest.getInstance("SHA-256")
    RandomAccessFile(staged.file, "r").use { input ->
      val buffer = ByteArray(chunkSizeBytes)
      var hashedBytes = 0L
      while (hashedBytes < offset) {
        val bytesRead = input.read(buffer, 0, minOf(buffer.size.toLong(), offset - hashedBytes).toInt())
        if (bytesRead <= 0) throw TusUploadException.OffsetMismatch(expectedOffset = offset, actualOffset = hashedBytes)
        digest.update(buffer, 0, bytesRead)
        hashedBytes += bytesRead
      }
      while (offset < staged.sizeBytes) {
        input.seek(offset)
        val bytesRead = input.read(buffer, 0, minOf(buffer.size.toLong(), staged.sizeBytes - offset).toInt())
        if (bytesRead <= 0) break
        digest.update(buffer, 0, bytesRead)
        offset = patchWithRetry(uploadUrl, offset, buffer.copyOf(bytesRead))
        stagingManager.writeUploadState(staged, StagedUploadState(uploadUrl.toString(), offset, finalized = false))
      }
    }

    val checksum = sha256Hex(digest)
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

  private fun resumeOffset(uploadUrl: HttpUrl, fallbackOffset: Long): ResumeDecision {
    val request = client.newRequestBuilder(uploadUrl).head().build()
    client.okHttpClient.newCall(request).execute().use { response ->
      if (response.isSuccessful) return ResumeDecision.Resume(response.header("Upload-Offset")?.toLongOrNull() ?: fallbackOffset)
      if (response.code == 404 || response.code == 410) return ResumeDecision.Restart
      throw TusUploadException.HeadFailed(response.code)
    }
  }

  private fun patchWithRetry(uploadUrl: HttpUrl, initialOffset: Long, chunk: ByteArray): Long {
    var attempt = 0
    var offset = initialOffset
    var body = chunk
    var lastFailure: TusUploadException.PatchFailed? = null
    while (attempt < client.maxPatchRetries) {
      client.executePatch(uploadUrl, offset, body.toRequestBody("application/offset+octet-stream".toMediaType())).use { response ->
        if (response.code == 204) return offset + body.size
        lastFailure = TusUploadException.PatchFailed(response.code)
      }

      val serverOffset = headOffset(uploadUrl)
      val chunkEnd = initialOffset + chunk.size
      when {
        serverOffset == chunkEnd -> return serverOffset
        serverOffset in (initialOffset + 1) until chunkEnd -> {
          val consumedBytes = (serverOffset - initialOffset).toInt()
          offset = serverOffset
          body = chunk.copyOfRange(consumedBytes, chunk.size)
        }
        serverOffset == offset -> Unit
        else -> throw TusUploadException.OffsetMismatch(expectedOffset = offset, actualOffset = serverOffset)
      }
      attempt++
    }
    throw requireNotNull(lastFailure)
  }

  private fun headOffset(uploadUrl: HttpUrl): Long {
    val request = client.newRequestBuilder(uploadUrl).head().build()
    client.okHttpClient.newCall(request).execute().use { response ->
      if (!response.isSuccessful) throw TusUploadException.HeadFailed(response.code)
      return response.header("Upload-Offset")?.toLongOrNull()
        ?: throw TusUploadException.MissingUploadOffset(uploadUrl.toString())
    }
  }

  private fun Map<String, String>.toTusMetadata(): String = entries.joinToString(",") { (key, value) ->
    "$key ${java.util.Base64.getEncoder().encodeToString(value.toByteArray(Charsets.UTF_8))}"
  }

  private fun sha256Hex(digest: MessageDigest): String {
    return digest.digest().joinToString("") { byte -> "%02x".format(byte) }
  }

  private sealed interface ResumeDecision {
    data class Resume(val offset: Long) : ResumeDecision
    data object Restart : ResumeDecision
  }
}

data class ShardManifestEntry(
  val uploadUrl: String,
  val sizeBytes: Long,
  val uploadedBytes: Long,
  val sha256: String,
)

sealed class TusUploadException(message: String) : IllegalStateException(message) {
  class HeadFailed(val statusCode: Int) : TusUploadException("Tus HEAD failed with HTTP $statusCode")
  class MissingUploadOffset(val uploadUrl: String) : TusUploadException("Tus HEAD response missing Upload-Offset for $uploadUrl")
  class PatchFailed(val statusCode: Int) : TusUploadException("Tus PATCH failed with HTTP $statusCode")
  class OffsetMismatch(val expectedOffset: Long, val actualOffset: Long) :
    TusUploadException("Tus offset mismatch: expected $expectedOffset but server reported $actualOffset")
}
