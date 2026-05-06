@file:OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)

package org.mosaic.android.main.net.sync

import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.mosaic.android.main.net.dto.AlbumId
import org.mosaic.android.main.net.dto.AlbumSyncResponse

class AlbumSyncFetcher(
  private val httpClient: OkHttpClient,
  private val baseUrl: HttpUrl,
) {
  private val json = Json {
    explicitNulls = false
    ignoreUnknownKeys = true
  }

  suspend fun fetchSyncState(albumId: AlbumId): AlbumSyncResult = withContext(Dispatchers.IO) {
    val req = Request.Builder()
      .url(baseUrl.newBuilder().addPathSegments("api/albums/${albumId.value}/sync").build())
      .get()
      .build()

    httpClient.newCall(req).await().use { response ->
      when (response.code) {
        200 -> AlbumSyncResult.Success(parseResponse(response))
        404 -> AlbumSyncResult.NotFound
        403 -> AlbumSyncResult.Forbidden
        in 500..599 -> AlbumSyncResult.ServerError(response.code)
        else -> AlbumSyncResult.UnexpectedStatus(response.code)
      }
    }
  }

  private fun parseResponse(response: Response): AlbumSyncResponse {
    val payload = requireNotNull(response.body) { "Album sync response missing body" }.string()
    return json.decodeFromString(AlbumSyncResponse.serializer(), payload)
  }
}

sealed interface AlbumSyncResult {
  data class Success(val response: AlbumSyncResponse) : AlbumSyncResult
  data object NotFound : AlbumSyncResult
  data object Forbidden : AlbumSyncResult
  data class ServerError(val statusCode: Int) : AlbumSyncResult
  data class UnexpectedStatus(val statusCode: Int) : AlbumSyncResult
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
