package org.mosaic.android.main.tus

import okhttp3.OkHttpClient
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
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

    client.executePatch(server.url("/uploads/1"), 0L, "abc".toRequestBody()).use { response ->
      assertEquals(204, response.code)
    }

    val request = server.takeRequest()
    assertEquals("PATCH", request.method)
    assertEquals("1.0.0", request.getHeader("Tus-Resumable"))
    assertEquals("0", request.getHeader("Upload-Offset"))
    assertEquals("abc", request.body.readUtf8())
  }
}
