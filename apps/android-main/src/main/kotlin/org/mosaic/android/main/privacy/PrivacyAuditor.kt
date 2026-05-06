package org.mosaic.android.main.privacy

import android.database.Cursor
import androidx.sqlite.db.SimpleSQLiteQuery
import java.time.Clock
import java.time.Duration
import java.time.Instant
import kotlinx.coroutines.coroutineScope
import org.mosaic.android.main.db.PrivacyPatternValidator
import org.mosaic.android.main.db.UploadQueueDatabase
import org.mosaic.android.main.staging.AppPrivateStagingManager
import org.mosaic.android.main.staging.StagedFile

class PrivacyAuditor(
  private val staging: AppPrivateStagingManager,
  private val database: UploadQueueDatabase,
  private val logTail: LogTailReader,
  private val clock: Clock = Clock.systemUTC(),
  private val maxStagingAge: Duration = DEFAULT_MAX_STAGING_AGE,
  private val cleanupPolicyInterval: Duration = DEFAULT_CLEANUP_POLICY_INTERVAL,
  private val maxLogLines: Int = DEFAULT_LOG_LINES,
) {
  suspend fun runAudit(): PrivacyAuditReport = coroutineScope {
    val stagedFiles = staging.listStagedFiles()
    val databaseCells = readDatabaseCells()
    val staleStaging = checkStaleStaging(stagedFiles, databaseCells)
    val plaintextInDb = checkPlaintextInDatabase(databaseCells)
    val plaintextInLogs = checkPlaintextInLogs()
    val cleanupRecency = checkCleanupRecency()

    PrivacyAuditReport(
      staleStaging = staleStaging,
      plaintextInDb = plaintextInDb,
      plaintextInLogs = plaintextInLogs,
      cleanupRecency = cleanupRecency,
      timestamp = clock.instant(),
    )
  }

  private fun checkStaleStaging(stagedFiles: List<StagedFile>, databaseCells: List<DatabaseCell>): List<StagedFile> {
    val cutoffMs = clock.instant().minus(maxStagingAge).toEpochMilli()
    val referencedIds = referencedStagingIds(stagedFiles, databaseCells)
    return stagedFiles
      .filter { staged -> staged.lastAccessMs <= cutoffMs && staged.id !in referencedIds }
  }

  private fun checkPlaintextInDatabase(databaseCells: List<DatabaseCell>): List<PlaintextFinding> =
    databaseCells
      .filterNot { cell -> cell.column in CRYPTO_HASH_COLUMNS }
      .flatMap { cell ->
        PrivacyPatternValidator.findPlaintextMarkers(cell.value).map { match ->
          PlaintextFinding(
            source = PlaintextFindingSource.DATABASE,
            location = "${cell.table}.${cell.column}",
            patternName = match.patternName,
            excerpt = match.excerpt,
          )
        }
      }
      .distinct()

  private suspend fun checkPlaintextInLogs(): List<PlaintextFinding> =
    logTail.readLastLines(maxLogLines).flatMapIndexed { lineIndex, line ->
      PrivacyPatternValidator.findPlaintextMarkers(line).map { match ->
        PlaintextFinding(
          source = PlaintextFindingSource.LOGS,
          location = "logcat:${lineIndex + 1}",
          patternName = match.patternName,
          excerpt = match.excerpt,
        )
      }
    }.distinct()

  private suspend fun checkCleanupRecency(): CleanupRecencyResult {
    val lastCleanupAt = staging.lastCleanupAt()
    val now = clock.instant()
    return CleanupRecencyResult(
      lastCleanupAt = lastCleanupAt,
      policyInterval = cleanupPolicyInterval,
      recentEnough = lastCleanupAt != null && !lastCleanupAt.plus(cleanupPolicyInterval).isBefore(now),
    )
  }

  private fun readDatabaseCells(): List<DatabaseCell> {
    val cells = mutableListOf<DatabaseCell>()
    for (table in AUDITED_TABLES) {
      database.openHelper.readableDatabase.query(SimpleSQLiteQuery("SELECT * FROM $table")).use { cursor ->
        while (cursor.moveToNext()) {
          for (index in 0 until cursor.columnCount) {
            cursor.privacyTextAt(index)?.let { value ->
              cells += DatabaseCell(table, cursor.getColumnName(index), value)
            }
          }
        }
      }
    }
    return cells
  }

  private fun referencedStagingIds(stagedFiles: List<StagedFile>, databaseCells: List<DatabaseCell>): Set<String> {
    val values = databaseCells.map { cell -> cell.value }
    val stagedIds = stagedFiles.map { staged -> staged.id }
    return stagedIds.filterTo(mutableSetOf()) { stagedId ->
      values.any { value -> value.contains(stagedId) }
    }
  }

  private fun Cursor.privacyTextAt(index: Int): String? = when (getType(index)) {
    Cursor.FIELD_TYPE_NULL -> null
    Cursor.FIELD_TYPE_STRING -> getString(index)
    Cursor.FIELD_TYPE_INTEGER -> getLong(index).toString()
    Cursor.FIELD_TYPE_FLOAT -> getDouble(index).toString()
    Cursor.FIELD_TYPE_BLOB -> getBlob(index)?.toString(Charsets.UTF_8)
    else -> null
  }

  private data class DatabaseCell(
    val table: String,
    val column: String,
    val value: String,
  )

  companion object {
    val DEFAULT_MAX_STAGING_AGE: Duration = Duration.ofDays(1)
    val DEFAULT_CLEANUP_POLICY_INTERVAL: Duration = Duration.ofDays(7)
    const val DEFAULT_LOG_LINES: Int = 500

    private val AUDITED_TABLES = listOf(
      "upload_queue_records",
      "shard_staging_refs",
      "staged_picker_blobs",
      "upload_job_snapshots",
      "album_sync_snapshots",
    )

    private val CRYPTO_HASH_COLUMNS = setOf("sha256_hex", "shard_set_hash_hex")
  }
}

interface LogTailReader {
  suspend fun readLastLines(maxLines: Int): List<String>
}

class AndroidLogTailReader : LogTailReader {
  override suspend fun readLastLines(maxLines: Int): List<String> =
    runCatching {
      ProcessBuilder("logcat", "-d", "-t", maxLines.coerceAtLeast(1).toString())
        .redirectErrorStream(true)
        .start()
        .inputStream
        .bufferedReader()
        .useLines { lines -> lines.toList().takeLast(maxLines) }
    }.getOrDefault(emptyList())
}

data class PrivacyAuditReport(
  val staleStaging: List<StagedFile>,
  val plaintextInDb: List<PlaintextFinding>,
  val plaintextInLogs: List<PlaintextFinding>,
  val cleanupRecency: CleanupRecencyResult,
  val timestamp: Instant,
) {
  val isClean: Boolean
    get() = staleStaging.isEmpty() &&
      plaintextInDb.isEmpty() &&
      plaintextInLogs.isEmpty() &&
      cleanupRecency.recentEnough
}

data class PlaintextFinding(
  val source: PlaintextFindingSource,
  val location: String,
  val patternName: String,
  val excerpt: String,
)

enum class PlaintextFindingSource {
  DATABASE,
  LOGS,
}

data class CleanupRecencyResult(
  val lastCleanupAt: Instant?,
  val policyInterval: Duration,
  val recentEnough: Boolean,
)
