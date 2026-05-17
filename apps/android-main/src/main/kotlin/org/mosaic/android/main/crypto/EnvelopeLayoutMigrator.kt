package org.mosaic.android.main.crypto

import android.content.Context
import androidx.work.Logger
import java.io.File
import org.mosaic.android.main.db.UploadQueueDatabase

/**
 * One-shot migrator that moves pre-v1.0.1 envelope files from the flat
 * content-addressed layout (`filesDir/encrypted-shards/<sha256>.envelope`)
 * into the per-album subdirectory layout introduced by v1.0.1 s34
 * (`filesDir/encrypted-shards/<albumId>/<sha256>.envelope`).
 *
 * The per-album layout lets [org.mosaic.android.main.sync.AlbumPurger] drop
 * an album's envelope set with a single recursive delete, closing the gap
 * that would become a multi-account exposure when logout/multi-account
 * lands. See `docs/RELEASE.md` v1.0.1 changelog.
 *
 * The migrator is gated by [PREF_KEY_MIGRATED] in [SHARED_PREFS_NAME]; once a
 * run reports success the flag is set so subsequent launches no-op. Failures
 * leave the flag unset so the next launch retries.
 *
 * Orphaned envelopes (no `shard_staging_refs.sha256_hex` row in the upload
 * queue DB) are deleted: they cannot be assigned to an album and would
 * otherwise leak space. Errors are collected, never thrown to the caller —
 * the migrator must not block app startup.
 */
internal object EnvelopeLayoutMigrator {
  internal const val SHARED_PREFS_NAME = "mosaic.envelope_layout"
  internal const val PREF_KEY_MIGRATED = "envelope_layout_migrated_v1_0_1"
  private const val TAG = "EnvelopeLayoutMigrator"
  private val LEGACY_FILENAME_PATTERN = Regex("^[0-9a-f]{64}\\.envelope$")

  data class MigrationResult(
    val moved: Int,
    val orphaned: Int,
    val errors: List<String>,
  ) {
    val isFullSuccess: Boolean get() = errors.isEmpty()

    companion object {
      val NoOp = MigrationResult(moved = 0, orphaned = 0, errors = emptyList())
    }
  }

  /**
   * Runs the migration if the idempotency flag is not yet set. Returns the
   * outcome of the migration (or [MigrationResult.NoOp] when already
   * migrated). The flag is persisted only on full success so retries are
   * naturally idempotent.
   */
  fun migrateIfNeeded(context: Context, database: UploadQueueDatabase): MigrationResult {
    val prefs = context.getSharedPreferences(SHARED_PREFS_NAME, Context.MODE_PRIVATE)
    if (prefs.getBoolean(PREF_KEY_MIGRATED, false)) return MigrationResult.NoOp

    val result = runCatching { migrateLegacyEnvelopes(context, database) }
      .getOrElse { throwable ->
        Logger.get().warning(TAG, "Envelope layout migration aborted", throwable)
        return MigrationResult(moved = 0, orphaned = 0, errors = listOf(throwable.javaClass.simpleName))
      }

    if (result.isFullSuccess) {
      prefs.edit().putBoolean(PREF_KEY_MIGRATED, true).apply()
    }
    Logger.get().info(
      TAG,
      "Envelope layout migration complete (moved=${result.moved}, orphaned=${result.orphaned}, errors=${result.errors.size})",
    )
    return result
  }

  /**
   * Direct entry point exposed for tests. Production callers should use
   * [migrateIfNeeded] so the idempotency flag is honoured.
   */
  internal fun migrateLegacyEnvelopes(context: Context, database: UploadQueueDatabase): MigrationResult {
    val root = File(context.filesDir, ShardEnvelopeStore.ENVELOPE_DIR_NAME)
    if (!root.isDirectory) return MigrationResult.NoOp

    val legacyFiles = root.listFiles { file ->
      file.isFile && LEGACY_FILENAME_PATTERN.matches(file.name)
    }.orEmpty()
    if (legacyFiles.isEmpty()) return MigrationResult.NoOp

    val uploadQueueDao = database.uploadQueueDao()
    var moved = 0
    var orphaned = 0
    val errors = mutableListOf<String>()

    for (file in legacyFiles) {
      val sha256Hex = file.nameWithoutExtension
      val albumId = uploadQueueDao.albumIdForEnvelopeSha256(sha256Hex)
      if (albumId == null) {
        if (file.delete()) {
          orphaned++
        } else {
          errors += "delete_orphan_failed"
        }
        continue
      }
      val targetDir = File(root, albumId)
      if (!targetDir.exists() && !targetDir.mkdirs()) {
        errors += "mkdir_failed"
        continue
      }
      val target = File(targetDir, file.name)
      if (target.exists()) {
        // A per-album envelope already exists for this sha256 (e.g. partial
        // prior run). Drop the legacy duplicate rather than overwrite — both
        // files have the same plaintext-derived content key so contents are
        // equivalent under the v1.0.1 envelope format.
        if (file.delete()) {
          moved++
        } else {
          errors += "delete_after_dedup_failed"
        }
        continue
      }
      if (file.renameTo(target)) {
        moved++
      } else {
        // renameTo can fail across filesystem boundaries; fall back to copy + delete.
        try {
          file.copyTo(target, overwrite = false)
          if (file.delete()) {
            moved++
          } else {
            errors += "delete_after_copy_failed"
          }
        } catch (e: Exception) {
          errors += "copy_failed:${e.javaClass.simpleName}"
        }
      }
    }
    return MigrationResult(moved = moved, orphaned = orphaned, errors = errors)
  }
}
