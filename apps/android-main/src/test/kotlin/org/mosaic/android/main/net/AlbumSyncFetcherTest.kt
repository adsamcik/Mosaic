package org.mosaic.android.main.net

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.mosaic.android.main.net.dto.AlbumId
import org.mosaic.android.main.net.sync.AlbumSyncFetcher
import org.mosaic.android.main.net.sync.AlbumSyncResult

class AlbumSyncFetcherTest {
  private val server = MockWebServer()

  @After
  fun tearDown() {
    server.shutdown()
  }

  @Test
  fun fetchSyncStateReturnsSuccessForHttp200() = runBlocking {
    server.enqueue(MockResponse().setResponseCode(200).setBody(AlbumSyncFixtures.responseJson))
    server.start()
    val fetcher = AlbumSyncFetcher(OkHttpClient(), server.url("/"))

    val result = fetcher.fetchSyncState(AlbumId(AlbumSyncFixtures.albumId))

    assertTrue(result is AlbumSyncResult.Success)
    assertEquals(42L, (result as AlbumSyncResult.Success).response.currentVersion)
    val request = server.takeRequest()
    assertEquals("GET", request.method)
    assertEquals("/api/albums/${AlbumSyncFixtures.albumId}/sync", request.path)
  }

  @Test
  fun fetchSyncStateReturnsNotFoundForHttp404() = runBlocking {
    server.enqueue(MockResponse().setResponseCode(404))
    server.start()
    val fetcher = AlbumSyncFetcher(OkHttpClient(), server.url("/"))

    val result = fetcher.fetchSyncState(AlbumId(AlbumSyncFixtures.albumId))

    assertTrue(result is AlbumSyncResult.NotFound)
  }

  @Test
  fun fetchSyncStateReturnsForbiddenForHttp403() = runBlocking {
    server.enqueue(MockResponse().setResponseCode(403))
    server.start()
    val fetcher = AlbumSyncFetcher(OkHttpClient(), server.url("/"))

    val result = fetcher.fetchSyncState(AlbumId(AlbumSyncFixtures.albumId))

    assertTrue(result is AlbumSyncResult.Forbidden)
  }

  @Test
  fun fetchSyncStateReturnsServerErrorFor5xx() = runBlocking {
    server.enqueue(MockResponse().setResponseCode(502))
    server.start()
    val fetcher = AlbumSyncFetcher(OkHttpClient(), server.url("/"))

    val result = fetcher.fetchSyncState(AlbumId(AlbumSyncFixtures.albumId))

    assertEquals(AlbumSyncResult.ServerError(502), result)
  }
}
