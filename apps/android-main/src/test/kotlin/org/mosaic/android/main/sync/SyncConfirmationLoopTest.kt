package org.mosaic.android.main.sync

import java.time.Clock
import java.time.Instant
import java.time.ZoneId
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.mosaic.android.main.net.dto.AlbumId
import org.mosaic.android.main.net.dto.AlbumSyncResponse
import org.mosaic.android.main.net.sync.AlbumSyncResult

class SyncConfirmationLoopTest {
  private val albumId = AlbumId("album-1")

  @Test
  fun confirmReturnsConfirmedWhenFirstPollReachesExpectedVersion() = runBlocking {
    val loop = loopWithResponses(response(version = 7))

    val result = loop.confirm(albumId, expectedVersion = 7)

    assertEquals(SyncConfirmationResult.Confirmed(syncResponse(version = 7)), result)
  }

  @Test
  fun confirmReturnsConfirmedWhenSecondPollReachesExpectedVersion() = runBlocking {
    val sleeps = mutableListOf<Long>()
    val loop = loopWithResponses(
      response(version = 6),
      response(version = 7),
      sleep = { delayMs -> sleeps += delayMs },
      randomDelayMs = { 250L },
    )

    val result = loop.confirm(albumId, expectedVersion = 7)

    assertEquals(SyncConfirmationResult.Confirmed(syncResponse(version = 7)), result)
    assertEquals(listOf(250L), sleeps)
  }

  @Test
  fun confirmReturnsConfirmedWhenThirdPollReachesExpectedVersion() = runBlocking {
    val sleeps = mutableListOf<Long>()
    val loop = loopWithResponses(
      response(version = 5),
      response(version = 6),
      response(version = 7),
      sleep = { delayMs -> sleeps += delayMs },
      randomDelayMs = { bound -> bound - 1 },
    )

    val result = loop.confirm(albumId, expectedVersion = 7)

    assertEquals(SyncConfirmationResult.Confirmed(syncResponse(version = 7)), result)
    assertEquals(listOf(499L, 999L), sleeps)
  }

  @Test
  fun confirmUsesDecorrelatedJitterWithinUpperHalfOfCurrentBackoffRange() = runBlocking {
    val bounds = mutableListOf<Long>()
    val sleeps = mutableListOf<Long>()
    val loop = loopWithResponses(
      response(version = 1),
      response(version = 1),
      response(version = 3),
      initialDelayMs = 500,
      maxDelayMs = 1_000,
      randomDelayMs = { bound ->
        bounds += bound
        bound - 1
      },
      sleep = { delayMs -> sleeps += delayMs },
    )

    val result = loop.confirm(albumId, expectedVersion = 3)

    assertTrue(result is SyncConfirmationResult.Confirmed)
    assertEquals(listOf(500L, 1_000L), bounds)
    assertEquals(listOf(499L, 999L), sleeps)
    sleeps.zip(bounds).forEach { (delayMs, bound) ->
      assertTrue(delayMs in bound / 2 until bound)
    }
  }

  @Test
  fun confirmCancelsCooperativelyWithoutStartingAnotherFetch() = runBlocking {
    var fetchCount = 0
    val sleepEntered = CompletableDeferred<Unit>()
    val neverCompletes = CompletableDeferred<Unit>()
    val loop = SyncConfirmationLoop(
      fetchSyncState = {
        fetchCount += 1
        response(version = 1)
      },
      clock = MutableClock(),
      initialDelayMs = 500,
      maxDelayMs = 1_000,
      timeoutMs = 60_000,
      randomDelayMs = { 250L },
      sleep = {
        sleepEntered.complete(Unit)
        neverCompletes.await()
      },
    )

    val job = launch {
      loop.confirm(albumId, expectedVersion = 2)
    }
    sleepEntered.await()

    job.cancelAndJoin()

    assertTrue(job.isCancelled)
    assertEquals(1, fetchCount)
  }

  @Test
  fun confirmReturnsTimeoutWhenVersionDoesNotReachExpectedBeforeTimeout() = runBlocking {
    val clock = MutableClock()
    var fetchCount = 0
    val loop = SyncConfirmationLoop(
      fetchSyncState = {
        fetchCount += 1
        response(version = 1)
      },
      clock = clock,
      initialDelayMs = 10,
      maxDelayMs = 10,
      timeoutMs = 25,
        randomDelayMs = { 5L },
      sleep = { delayMs -> clock.advance(delayMs) },
    )

    val result = loop.confirm(albumId, expectedVersion = 2)

    assertEquals(SyncConfirmationResult.Timeout, result)
    assertEquals(5, fetchCount)
  }

  @Test
  fun confirmShortCircuitsNotFoundAndForbidden() = runBlocking {
    val notFound = loopWithResponses(AlbumSyncResult.NotFound)
      .confirm(albumId, expectedVersion = 1)
    val forbidden = loopWithResponses(AlbumSyncResult.Forbidden)
      .confirm(albumId, expectedVersion = 1)

    assertEquals(SyncConfirmationResult.Failed(AlbumSyncResult.NotFound.toString()), notFound)
    assertEquals(SyncConfirmationResult.Failed(AlbumSyncResult.Forbidden.toString()), forbidden)
  }

  @Test
  fun confirmRetriesServerErrorBeforeSuccess() = runBlocking {
    var fetchCount = 0
    val loop = loopWithResponses(
      AlbumSyncResult.ServerError(503),
      response(version = 7),
      sleep = { },
      randomDelayMs = { 250L },
      onFetch = { fetchCount += 1 },
    )

    val result = loop.confirm(albumId, expectedVersion = 7)

    assertEquals(SyncConfirmationResult.Confirmed(syncResponse(version = 7)), result)
    assertEquals(2, fetchCount)
  }

  private fun loopWithResponses(
    vararg responses: AlbumSyncResult,
    initialDelayMs: Long = 500,
    maxDelayMs: Long = 30_000,
    randomDelayMs: (Long) -> Long = { bound -> bound / 2 },
    sleep: suspend (Long) -> Unit = { },
    onFetch: () -> Unit = { },
  ): SyncConfirmationLoop {
    val queue = ArrayDeque(responses.toList())
    return SyncConfirmationLoop(
      fetchSyncState = {
        onFetch()
        queue.removeFirst()
      },
      clock = MutableClock(),
      initialDelayMs = initialDelayMs,
      maxDelayMs = maxDelayMs,
      timeoutMs = 60_000,
      randomDelayMs = randomDelayMs,
      sleep = sleep,
    )
  }

  private fun response(version: Long): AlbumSyncResult.Success = AlbumSyncResult.Success(syncResponse(version))

  private fun syncResponse(version: Long): AlbumSyncResponse = AlbumSyncResponse(
    albumId = albumId.value,
    currentVersion = version,
    manifestId = "manifest-$version",
    manifestUrl = "https://example.invalid/manifests/$version",
    expectedSha256 = "sha256-$version",
  )

  private class MutableClock(
    private var nowMs: Long = 0,
  ) : Clock() {
    override fun getZone(): ZoneId = ZoneId.of("UTC")

    override fun withZone(zone: ZoneId): Clock = this

    override fun instant(): Instant = Instant.ofEpochMilli(nowMs)

    override fun millis(): Long = nowMs

    fun advance(deltaMs: Long) {
      nowMs += deltaMs
    }
  }
}
