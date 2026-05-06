package org.mosaic.android.main.net

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.mosaic.android.main.net.dto.ManifestId
import org.mosaic.android.main.net.manifest.ManifestCommitClient
import org.mosaic.android.main.net.manifest.ManifestFinalizeResult
import org.mosaic.android.main.net.manifest.MosaicIdempotencyKeys

class ManifestCommitClientTest {
  private val server = MockWebServer()

  @After
  fun tearDown() {
    server.shutdown()
  }

  @Test
  fun finalizeReturnsSuccessForHttp200AndPostsIdempotentJsonBody() = runBlocking {
    server.enqueue(MockResponse().setResponseCode(200).setBody(ManifestFinalizeFixtures.responseJson))
    server.start()
    val client = ManifestCommitClient(OkHttpClient(), server.url("/"))

    val result = client.finalize(
      ManifestId(ManifestFinalizeFixtures.manifestId),
      ManifestFinalizeFixtures.request,
      MosaicIdempotencyKeys.forManifestFinalize(ManifestFinalizeFixtures.uploadJobId),
    )

    assertTrue(result is ManifestFinalizeResult.Success)
    assertEquals(ManifestFinalizeFixtures.manifestId, (result as ManifestFinalizeResult.Success).response.manifestId)
    val request = server.takeRequest()
    assertEquals("POST", request.method)
    assertEquals("/api/manifests/${ManifestFinalizeFixtures.manifestId}/finalize", request.path)
    assertEquals(
      "mosaic-finalize-${ManifestFinalizeFixtures.uploadJobId.value}",
      request.getHeader("Idempotency-Key"),
    )
    val posted = Json.parseToJsonElement(request.body.readUtf8())
    assertEquals(1, posted.jsonObjectValue("protocolVersion").toInt())
    assertEquals(ManifestFinalizeFixtures.albumId, posted.jsonObjectValue("albumId"))
    assertEquals("Image", posted.jsonObjectValue("assetType"))
  }

  @Test
  fun finalizeReturnsIdempotencyReplayForHttp409() = runBlocking {
    server.enqueue(
      MockResponse()
        .setResponseCode(409)
        .setHeader("Idempotency-Replayed", "true")
        .setBody(ManifestFinalizeFixtures.responseJson),
    )
    server.start()
    val client = ManifestCommitClient(OkHttpClient(), server.url("/"))

    val result = client.finalize(ManifestId(ManifestFinalizeFixtures.manifestId), ManifestFinalizeFixtures.request, "retry-key")

    assertTrue(result is ManifestFinalizeResult.IdempotencyReplay)
    assertEquals(ManifestFinalizeFixtures.manifestId, (result as ManifestFinalizeResult.IdempotencyReplay).response.manifestId)
  }

  @Test
  fun finalizeReturnsAlreadyFinalizedForControllerHttp409() = runBlocking {
    server.enqueue(
      MockResponse()
        .setResponseCode(409)
        .setBody(
          """
          {
            "error": "manifest_already_finalized",
            "detail": "manifest is already finalized",
            "manifestId": "${ManifestFinalizeFixtures.manifestId}"
          }
          """.trimIndent(),
        ),
    )
    server.start()
    val client = ManifestCommitClient(OkHttpClient(), server.url("/"))

    val result = client.finalize(ManifestId(ManifestFinalizeFixtures.manifestId), ManifestFinalizeFixtures.request, "retry-key")

    assertTrue(result is ManifestFinalizeResult.AlreadyFinalized)
    val conflict = result as ManifestFinalizeResult.AlreadyFinalized
    assertEquals(ManifestFinalizeFixtures.manifestId, conflict.manifestId.value)
    assertEquals("manifest is already finalized", conflict.detail)
  }

  @Test
  fun finalizeReturnsInvalidSignatureForHttp400() = runBlocking {
    server.enqueue(MockResponse().setResponseCode(400))
    server.start()
    val client = ManifestCommitClient(OkHttpClient(), server.url("/"))

    val result = client.finalize(ManifestId(ManifestFinalizeFixtures.manifestId), ManifestFinalizeFixtures.request, "bad-signature")

    assertTrue(result is ManifestFinalizeResult.InvalidSignature)
  }

  @Test
  fun finalizeReturnsTranscriptMismatchForHttp422() = runBlocking {
    server.enqueue(MockResponse().setResponseCode(422))
    server.start()
    val client = ManifestCommitClient(OkHttpClient(), server.url("/"))

    val result = client.finalize(ManifestId(ManifestFinalizeFixtures.manifestId), ManifestFinalizeFixtures.request, "mismatch")

    assertTrue(result is ManifestFinalizeResult.TranscriptMismatch)
  }

  @Test
  fun finalizeReturnsServerErrorFor5xx() = runBlocking {
    server.enqueue(MockResponse().setResponseCode(503))
    server.start()
    val client = ManifestCommitClient(OkHttpClient(), server.url("/"))

    val result = client.finalize(ManifestId(ManifestFinalizeFixtures.manifestId), ManifestFinalizeFixtures.request, "server-error")

    assertEquals(ManifestFinalizeResult.ServerError(503), result)
  }
}
