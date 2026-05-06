package org.mosaic.android.main.sync

import java.time.Clock
import kotlin.random.Random
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay as coroutineDelay
import kotlinx.coroutines.ensureActive
import org.mosaic.android.main.net.dto.AlbumId
import org.mosaic.android.main.net.dto.AlbumSyncResponse
import org.mosaic.android.main.net.sync.AlbumSyncFetcher
import org.mosaic.android.main.net.sync.AlbumSyncResult

class SyncConfirmationLoop internal constructor(
  private val fetchSyncState: suspend (AlbumId) -> AlbumSyncResult,
  private val clock: Clock,
  private val initialDelayMs: Long,
  private val maxDelayMs: Long,
  private val timeoutMs: Long,
  private val randomDelayMs: (Long) -> Long,
  private val sleep: suspend (Long) -> Unit,
) {
  constructor(
    fetcher: AlbumSyncFetcher,
    clock: Clock = Clock.systemUTC(),
    initialDelayMs: Long = 500,
    maxDelayMs: Long = 30_000,
    timeoutMs: Long = 5 * 60_000,
  ) : this(
    fetchSyncState = fetcher::fetchSyncState,
    clock = clock,
    initialDelayMs = initialDelayMs,
    maxDelayMs = maxDelayMs,
    timeoutMs = timeoutMs,
    randomDelayMs = { bound ->
      val baseDelay = bound / 2
      val jitterRange = bound - baseDelay
      baseDelay + Random.nextLong(jitterRange)
    },
    sleep = { delayMs -> coroutineDelay(delayMs) },
  )

  init {
    require(initialDelayMs > 0) { "initialDelayMs must be positive" }
    require(maxDelayMs > 0) { "maxDelayMs must be positive" }
    require(timeoutMs >= 0) { "timeoutMs must not be negative" }
  }

  suspend fun confirm(
    albumId: AlbumId,
    expectedVersion: Long,
  ): SyncConfirmationResult = coroutineScope {
    val start = clock.millis()
    var delayMs = initialDelayMs

    while (clock.millis() - start < timeoutMs) {
      ensureActive()

      when (val result = fetchSyncState(albumId)) {
        is AlbumSyncResult.Success -> {
          if (result.response.currentVersion >= expectedVersion) {
            return@coroutineScope SyncConfirmationResult.Confirmed(result.response)
          }
        }
        is AlbumSyncResult.NotFound -> return@coroutineScope SyncConfirmationResult.Failed(result.toString())
        is AlbumSyncResult.Forbidden -> return@coroutineScope SyncConfirmationResult.Failed(result.toString())
        is AlbumSyncResult.ServerError -> Unit
        is AlbumSyncResult.UnexpectedStatus -> return@coroutineScope SyncConfirmationResult.Failed(result.toString())
      }

      val sleepMs = randomDelayMs(delayMs)
      require(sleepMs in delayMs / 2 until delayMs) { "jitter delay must be in [currentDelayMs / 2, currentDelayMs)" }
      sleep(sleepMs)
      delayMs = (delayMs * 2).coerceAtMost(maxDelayMs)
    }

    SyncConfirmationResult.Timeout
  }
}

sealed interface SyncConfirmationResult {
  data class Confirmed(val response: AlbumSyncResponse) : SyncConfirmationResult
  data class Failed(val reason: String) : SyncConfirmationResult
  data object Timeout : SyncConfirmationResult
}
