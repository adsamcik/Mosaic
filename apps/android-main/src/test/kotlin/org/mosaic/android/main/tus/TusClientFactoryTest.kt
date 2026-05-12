package org.mosaic.android.main.tus

import androidx.test.core.app.ApplicationProvider
import okhttp3.OkHttpClient
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class TusClientFactoryTest {
  private val server = MockWebServer()

  @After
  fun tearDown() {
    server.shutdown()
  }

  @Test
  fun factoryCreatesClientThatCanPatchMockServer() {
    server.enqueue(MockResponse().setResponseCode(204).setHeader("Upload-Offset", "3"))
    server.start()
    val client = TusClientFactory.create(server.url("/uploads/1"), OkHttpClient())

    client.executePatch(server.url("/uploads/1"), 0L, "abc".toRequestBody(), "test-idempotency-key").use { response ->
      assertEquals(204, response.code)
    }

    val request = server.takeRequest()
    assertEquals("PATCH", request.method)
    assertEquals("1.0.0", request.getHeader("Tus-Resumable"))
    assertEquals("test-idempotency-key", request.getHeader("Idempotency-Key"))
    assertEquals("0", request.getHeader("Upload-Offset"))
    assertEquals("abc", request.body.readUtf8())
  }

  @Test
  fun usesFromAdr019PinsForCertPinner() {
    val exception = assertThrows(IllegalStateException::class.java) {
      TusClientFactory.create(
        endpointUrl = "https://mosaic.example.com/uploads/1",
        context = ApplicationProvider.getApplicationContext(),
        releasePinsRequired = true,
      )
    }

    assertTrue(exception.message!!.isNotBlank())
  }
}
