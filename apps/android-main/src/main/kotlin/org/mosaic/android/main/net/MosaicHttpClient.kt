package org.mosaic.android.main.net

import java.util.concurrent.TimeUnit
import okhttp3.CertificatePinner
import okhttp3.ConnectionSpec
import okhttp3.Interceptor
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.RequestBody
import okhttp3.Response
import okhttp3.TlsVersion
import okio.BufferedSink

object MosaicHttpClient {
  fun create(certPinner: CertificatePinner): OkHttpClient {
    require(certPinner.pins.isNotEmpty()) {
      "Refusing to build OkHttpClient without pins. Use failClosed(hostname) factory."
    }

    return OkHttpClient.Builder()
      .connectTimeout(30, TimeUnit.SECONDS)
      .readTimeout(60, TimeUnit.SECONDS)
      .writeTimeout(60, TimeUnit.SECONDS)
      .protocols(listOf(Protocol.HTTP_2, Protocol.HTTP_1_1))
      .connectionSpecs(
        listOf(
          ConnectionSpec.Builder(ConnectionSpec.MODERN_TLS)
            .tlsVersions(TlsVersion.TLS_1_3, TlsVersion.TLS_1_2)
            .build(),
        ),
      )
      .certificatePinner(certPinner)
      .addInterceptor(NoBodyLoggingInterceptor())
      .build()
  }
}

object MosaicCertificatePinnerFactory {
  const val UNCONFIGURED_PIN: String = "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

  fun failClosed(hostname: String): CertificatePinner = CertificatePinner.Builder()
    .add(hostname, UNCONFIGURED_PIN)
    .build()
}

class NoBodyLoggingInterceptor : Interceptor {
  override fun intercept(chain: Interceptor.Chain): Response {
    val request = chain.request()
    val requestBody = request.body
    val sanitizedRequest = if (requestBody == null || requestBody.isOneShot()) {
      request
    } else {
      request.newBuilder().method(request.method, OneShotRequestBody(requestBody)).build()
    }
    return chain.proceed(sanitizedRequest)
  }
}

private class OneShotRequestBody(private val delegate: RequestBody) : RequestBody() {
  override fun contentType(): MediaType? = delegate.contentType()

  override fun contentLength(): Long = delegate.contentLength()

  override fun isDuplex(): Boolean = delegate.isDuplex()

  override fun isOneShot(): Boolean = true

  override fun writeTo(sink: BufferedSink) {
    delegate.writeTo(sink)
  }
}
