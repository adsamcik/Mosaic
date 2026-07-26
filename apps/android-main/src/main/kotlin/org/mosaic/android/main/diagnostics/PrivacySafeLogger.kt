package org.mosaic.android.main.diagnostics

import android.util.Log

/**
 * The only production Android boundary allowed to write to logcat.
 *
 * Callers provide a closed [PrivacySafeDiagnosticEvent], never an arbitrary
 * message, identifier, path, URL, or [Throwable]. This keeps upload and
 * account data out of diagnostics while retaining actionable lifecycle
 * signals. Numeric migration counters are accepted through a dedicated API
 * because they cannot identify a user or disclose encrypted content.
 */
internal object PrivacySafeLogger {
  fun record(event: PrivacySafeDiagnosticEvent) {
    when (event.level) {
      PrivacySafeDiagnosticLevel.INFO -> Log.i(event.tag, event.message)
      PrivacySafeDiagnosticLevel.WARNING -> Log.w(event.tag, event.message)
    }
  }

  fun recordEnvelopeMigrationSummary(
    moved: Int,
    orphaned: Int,
    errors: Int,
  ) {
    require(moved >= 0) { "moved must be non-negative" }
    require(orphaned >= 0) { "orphaned must be non-negative" }
    require(errors >= 0) { "errors must be non-negative" }
    Log.i(
      PrivacySafeDiagnosticEvent.ENVELOPE_LAYOUT_MIGRATION_COMPLETED.tag,
      "Envelope layout migration complete (moved=$moved, orphaned=$orphaned, errors=$errors)",
    )
  }
}

internal enum class PrivacySafeDiagnosticEvent(
  internal val level: PrivacySafeDiagnosticLevel,
  internal val tag: String,
  internal val message: String,
) {
  FIRST_LAUNCH_CLEANUP_FAILED(
    PrivacySafeDiagnosticLevel.WARNING,
    "MosaicApplication",
    "A-pre-1 cleanup failed",
  ),
  ENVELOPE_LAYOUT_MIGRATION_SCHEDULING_FAILED(
    PrivacySafeDiagnosticLevel.WARNING,
    "MosaicApplication",
    "Envelope layout migration scheduling failed",
  ),
  PRIVACY_AUDIT_SCHEDULING_FAILED(
    PrivacySafeDiagnosticLevel.WARNING,
    "MosaicApplication",
    "Privacy audit daily enqueue failed",
  ),
  ENVELOPE_LAYOUT_MIGRATION_ABORTED(
    PrivacySafeDiagnosticLevel.WARNING,
    "EnvelopeLayoutMigrator",
    "Envelope layout migration aborted",
  ),
  ENVELOPE_LAYOUT_MIGRATION_COMPLETED(
    PrivacySafeDiagnosticLevel.INFO,
    "EnvelopeLayoutMigrator",
    "Envelope layout migration complete",
  ),
  REMOTE_ALBUM_STATE_PURGED(
    PrivacySafeDiagnosticLevel.INFO,
    "AlbumPurger",
    "Purged local album state after remote deletion",
  ),
  REMOTE_PHOTO_STATE_PURGED(
    PrivacySafeDiagnosticLevel.INFO,
    "AlbumPurger",
    "Purged local photo state after remote deletion",
  ),
  SHARD_STAGING_CLEANUP_FAILED(
    PrivacySafeDiagnosticLevel.WARNING,
    "ShardUploadWorker",
    "Shard upload succeeded but staging cleanup failed",
  ),
}

internal enum class PrivacySafeDiagnosticLevel {
  INFO,
  WARNING,
}
