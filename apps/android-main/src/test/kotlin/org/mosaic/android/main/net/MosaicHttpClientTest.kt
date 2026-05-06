package org.mosaic.android.main.net

import java.security.cert.Certificate
import javax.net.ssl.SSLPeerUnverifiedException
import okhttp3.CertificatePinner
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.TlsVersion
import okhttp3.logging.HttpLoggingInterceptor
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.tls.HeldCertificate
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class MosaicHttpClientTest {
  @Test
  fun createRejectsEmptyCertificatePinner() {
    val exception = assertThrows(IllegalArgumentException::class.java) {
      MosaicHttpClient.create(CertificatePinner.Builder().build())
    }

    assertTrue(exception.message!!.contains("Refusing to build OkHttpClient without pins"))
  }

  @Test
  fun connectionSpecsAllowOnlyTls12OrNewer() {
    val client = MosaicHttpClient.create(MosaicCertificatePinnerFactory.failClosed("mosaic.example.com"))
    val tlsVersions = client.connectionSpecs.flatMap { spec -> spec.tlsVersions.orEmpty() }.toSet()

    assertTrue(TlsVersion.TLS_1_2 in tlsVersions)
    assertTrue(TlsVersion.TLS_1_3 in tlsVersions)
    assertTrue(tlsVersions.all { version -> version == TlsVersion.TLS_1_2 || version == TlsVersion.TLS_1_3 })
  }

  @Test
  fun certificatePinnerRejectsUnknownCa() {
    val trustedBackup = HeldCertificate.Builder().commonName("backup-ca").certificateAuthority(0).build()
    val serverCertificate = HeldCertificate.Builder().commonName("mosaic.example.com").build()
    val pinner = CertificatePinner.Builder()
      .add("mosaic.example.com", CertificatePinner.pin(trustedBackup.certificate))
      .build()

    assertThrows(SSLPeerUnverifiedException::class.java) {
      pinner.check("mosaic.example.com", listOf<Certificate>(serverCertificate.certificate))
    }
  }

  @Test
  fun mosaicClientUsesCertificatePinnerAndNoBodyLoggingInterceptor() {
    val pinner = MosaicCertificatePinnerFactory.failClosed("mosaic.example.com")
    val client = MosaicHttpClient.create(pinner)

    assertTrue(client.certificatePinner.pins.isNotEmpty())
    assertTrue(client.interceptors.any { it is NoBodyLoggingInterceptor })
  }

  @Test
  fun failClosedFactoryBuildsClientWithExpectedPinner() {
    val hostname = "mosaic.example.com"
    val client = MosaicHttpClient.create(MosaicCertificatePinnerFactory.failClosed(hostname))

    assertTrue(client.certificatePinner.pins.any { pin -> pin.pattern == hostname })
  }

  @Test
  fun createRejectsDefaultCertificatePinner() {
    val exception = assertThrows(IllegalArgumentException::class.java) {
      MosaicHttpClient.create(CertificatePinner.DEFAULT)
    }

    assertTrue(exception.message!!.contains("Refusing to build OkHttpClient without pins"))
  }

  @Test
  fun noBodyLoggingSuppressesRequestAndResponseBodiesWithAppLevelLogging() {
    val logs = mutableListOf<String>()
    val logging = HttpLoggingInterceptor { message -> logs += message }
      .setLevel(HttpLoggingInterceptor.Level.BODY)
    val terminal = Interceptor { chain ->
      Response.Builder()
        .request(chain.request())
        .protocol(Protocol.HTTP_1_1)
        .code(200)
        .message("OK")
        .header("Content-Encoding", "mosaic-redacted")
        .body("response-secret".toResponseBody("text/plain".toMediaType()))
        .build()
    }
    val client = MosaicHttpClient.create(MosaicCertificatePinnerFactory.failClosed("mosaic.example.com"))
      .newBuilder()
      .addInterceptor(logging)
      .addInterceptor(terminal)
      .build()
    val request = Request.Builder()
      .url("https://mosaic.example.test/upload")
      .post("request-secret".toRequestBody("application/octet-stream".toMediaType()))
      .build()

    client.newCall(request).execute().use { response ->
      assertTrue(response.isSuccessful)
    }

    val joinedLogs = logs.joinToString("\n")
    assertFalse(joinedLogs.contains("request-secret"))
    assertFalse(joinedLogs.contains("response-secret"))
    assertTrue(joinedLogs.contains("body omitted"))
  }
}
