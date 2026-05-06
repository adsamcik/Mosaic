package org.mosaic.android.main.tus

import java.net.URL
import java.util.concurrent.TimeUnit
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import org.mosaic.android.main.net.MosaicCertificatePinnerFactory
import org.mosaic.android.main.net.MosaicHttpClient

private const val TUS_VERSION = "1.0.0"

object TusClientFactory {
  fun create(endpointUrl: String, hostname: String): MosaicTusClient = create(
    endpointUrl = endpointUrl.toHttpUrl(),
    okHttpClient = MosaicHttpClient.create(MosaicCertificatePinnerFactory.failClosed(hostname)),
  )

  fun create(endpointUrl: URL, okHttpClient: OkHttpClient): MosaicTusClient = create(
    endpointUrl = endpointUrl.toString().toHttpUrl(),
    okHttpClient = okHttpClient,
  )

  fun create(endpointUrl: HttpUrl, okHttpClient: OkHttpClient): MosaicTusClient {
    return MosaicTusClient(
      okHttpClient = okHttpClient.newBuilder()
        .retryOnConnectionFailure(true)
        .callTimeout(5, TimeUnit.MINUTES)
        .build(),
      endpointUrl = endpointUrl,
      maxPatchRetries = 3,
    )
  }
}

class MosaicTusClient(
  val okHttpClient: OkHttpClient,
  val endpointUrl: HttpUrl,
  val maxPatchRetries: Int,
) {
  fun newRequestBuilder(url: HttpUrl): Request.Builder = Request.Builder()
    .url(url)
    .header("Tus-Resumable", TUS_VERSION)

  fun executePatch(uploadUrl: HttpUrl, offset: Long, body: RequestBody): Response {
    val request = newRequestBuilder(uploadUrl)
      .patch(body)
      .header("Upload-Offset", offset.toString())
      .header("Content-Type", "application/offset+octet-stream")
      .build()
    return okHttpClient.newCall(request).execute()
  }
}
