@file:OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)

package org.mosaic.android.main.net.manifest

import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.mosaic.android.main.net.dto.ManifestFinalizeErrorBody
import org.mosaic.android.main.net.dto.ManifestFinalizeRequest
import org.mosaic.android.main.net.dto.ManifestFinalizeResponse
import org.mosaic.android.main.net.dto.ManifestId

class ManifestCommitClient(
  private val httpClient: OkHttpClient,
  private val baseUrl: HttpUrl,
) {
  private val json = Json {
    encodeDefaults = true
    explicitNulls = false
    ignoreUnknownKeys = true
  }

  suspend fun finalize(
    manifestId: ManifestId,
    request: ManifestFinalizeRequest,
    idempotencyKey: String,
  ): ManifestFinalizeResult = withContext(Dispatchers.IO) {
    val body = json.encodeToString(ManifestFinalizeRequest.serializer(), request)
      .toRequestBody("application/json".toMediaType())
    val req = Request.Builder()
      .url(baseUrl.newBuilder().addPathSegments("api/manifests/${manifestId.value}/finalize").build())
      .post(body)
      .header("Idempotency-Key", idempotencyKey)
      .build()

    httpClient.newCall(req).await().use { response ->
      when (response.code) {
        200, 201 -> ManifestFinalizeResult.Success(parseResponse(response))
        409 -> parseConflict(response)
        400 -> ManifestFinalizeResult.InvalidSignature
        422 -> ManifestFinalizeResult.TranscriptMismatch
        in 500..599 -> ManifestFinalizeResult.ServerError(response.code)
        else -> ManifestFinalizeResult.UnexpectedStatus(response.code)
      }
    }
  }

  private fun parseConflict(response: Response): ManifestFinalizeResult {
    if (response.header("Idempotency-Replayed") == "true") {
      return ManifestFinalizeResult.IdempotencyReplay(parseResponse(response))
    }

    val payload = response.body?.string().orEmpty()
    val error = runCatching {
      json.decodeFromString(ManifestFinalizeErrorBody.serializer(), payload)
    }.getOrNull()
    return ManifestFinalizeResult.AlreadyFinalized(
      manifestId = ManifestId(error?.manifestId.orEmpty()),
      detail = error?.detail ?: "manifest already finalized",
    )
  }

  private fun parseResponse(response: Response): ManifestFinalizeResponse {
    val payload = requireNotNull(response.body) { "Manifest finalize response missing body" }.string()
    return json.decodeFromString(ManifestFinalizeResponse.serializer(), payload)
  }
}

sealed interface ManifestFinalizeResult {
  data class Success(val response: ManifestFinalizeResponse) : ManifestFinalizeResult
  data class IdempotencyReplay(val response: ManifestFinalizeResponse) : ManifestFinalizeResult
  data class AlreadyFinalized(val manifestId: ManifestId, val detail: String) : ManifestFinalizeResult
  data object InvalidSignature : ManifestFinalizeResult
  data object TranscriptMismatch : ManifestFinalizeResult
  data class ServerError(val statusCode: Int) : ManifestFinalizeResult
  data class UnexpectedStatus(val statusCode: Int) : ManifestFinalizeResult
}

private suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
  continuation.invokeOnCancellation { cancel() }
  enqueue(
    object : Callback {
      override fun onFailure(call: Call, e: java.io.IOException) {
        if (!continuation.isCancelled) continuation.resumeWithException(e)
      }

      override fun onResponse(call: Call, response: Response) {
        continuation.resume(response)
      }
    },
  )
}
